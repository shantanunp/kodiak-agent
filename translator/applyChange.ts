/**
 * Apply a natural-language change to the mapper worktree (file writes only).
 * Scoped to the field currently shown in the pipeline viewer (POC: label --fields → Build with AI).
 * Git branch / commit / push / PR is deferred to a later phase.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { getEnvOptional, paths } from "../src/config/env.js";
import { loadRegistry, type MapperEntry } from "../src/registry/loadRegistry.js";
import { createModelProvider, HttpModelProvider, isModelConfigured } from "./model/index.js";

const APPLY_CHANGE_PROMPT = `You edit Java mapper source for ONE target field only (POC scope).

You receive:
- intent: what to change
- focusFields: business target field path(s) in scope (e.g. MESSAGE.DEAL.COLLATERAL.PostalCode)
- pipelineHint: labeled pipeline / reason for that field (helpers mentioned there are the edit scope)
- allowedPaths: repo-relative paths you may modify
- files: current contents of those paths

Return JSON only (no markdown fences):
{
  "summary": "one short sentence of what changed",
  "files": [{"path":"<one of allowedPaths>","content":"<full new file contents>"}]
}

CRITICAL scope rules:
- Change ONLY the private helpers / methods used by focusFields (from pipelineHint: e.g. mapPostalCodeViaFunctions, trimPostal, keepDigits, guardPostalLength).
- Do NOT modify unrelated mappings (StateCode, Party, Loan, constants, etc.).
- Do NOT change shared helpers that other fields use unless the intent explicitly requires it AND the helper is only for focusFields.
- Return the FULL file content for each changed file (not a diff).
- Paths MUST be exact members of allowedPaths.
- Keep the code compiling; update tests in allowed files only when they cover focusFields.
- If already satisfied, return the current file contents unchanged (or files: []).
- If the intent cannot be applied safely within this field scope, return {"summary":"...","files":[]}.`;

export interface ApplyChangeOptions {
  mapperId: string;
  intent: string;
  worktree: string;
  registryPath?: string;
  /** Schema target field(s) to scope the edit (from label --fields / current UI tab). */
  focusFields?: string[];
  /** Short pipeline / reason text from the current view for those fields. */
  pipelineHint?: string;
}

export interface ApplyChangeResult {
  changedFiles: string[];
  summary: string;
  worktree: string;
  /** True when model echoed current files — intent already satisfied. */
  alreadyApplied?: boolean;
  focusFields?: string[];
}

interface ModelFileEdit {
  path: string;
  content: string;
}

interface ModelEditResponse {
  summary?: string;
  files?: ModelFileEdit[];
}

/** Allowlist: mapper sourceFile + goldenTests that exist under worktree. */
function resolveAllowedPaths(worktree: string, mapper: MapperEntry): string[] {
  const root = resolve(worktree);
  const out: string[] = [];
  for (const rel of [mapper.sourceFile, mapper.goldenTests]) {
    if (!rel) continue;
    const abs = resolve(worktree, rel);
    if (!abs.startsWith(root + sep) && abs !== root) {
      throw new Error(`Path escapes worktree: ${rel}`);
    }
    if (!existsSync(abs)) {
      if (rel === mapper.sourceFile) {
        throw new Error(`Mapper source not found: ${abs}`);
      }
      continue;
    }
    out.push(rel.replace(/\\/g, "/"));
  }
  if (out.length === 0) {
    throw new Error(`No editable files for mapper ${mapper.id}`);
  }
  return [...new Set(out)];
}

function assertPathAllowed(relPath: string, allowed: Set<string>, worktree: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!allowed.has(normalized)) {
    throw new Error(`Model proposed disallowed path: ${relPath}. Allowed: ${[...allowed].join(", ")}`);
  }
  const abs = resolve(worktree, normalized);
  const root = resolve(worktree);
  if (!abs.startsWith(root + sep) && abs !== root) {
    throw new Error(`Path escapes worktree: ${relPath}`);
  }
  return normalized;
}

function unwrapJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

async function proposeEdits(
  intent: string,
  allowedPaths: string[],
  fileContents: Record<string, string>,
  focusFields: string[],
  pipelineHint: string,
): Promise<ModelEditResponse> {
  if (!isModelConfigured()) {
    throw new Error("MODEL_API_KEY not configured");
  }
  const provider = createModelProvider() as HttpModelProvider;
  const userPayload = JSON.stringify({
    intent,
    focusFields,
    pipelineHint,
    allowedPaths,
    files: allowedPaths.map((path) => ({ path, content: fileContents[path] ?? "" })),
  });
  const text = await provider.generate(APPLY_CHANGE_PROMPT, userPayload);
  try {
    return JSON.parse(unwrapJson(text)) as ModelEditResponse;
  } catch {
    throw new Error(`Model returned invalid JSON: ${text.slice(0, 300)}`);
  }
}

/**
 * Edit mapper files from natural-language intent (writes only; no git/PR).
 * When focusFields is set, the model is instructed to touch only that field's helpers.
 */
export async function applyChangeToMapper(options: ApplyChangeOptions): Promise<ApplyChangeResult> {
  const intent = options.intent.trim();
  if (!intent) {
    throw new Error("intent is required");
  }

  const worktree = resolve(options.worktree.trim());
  if (!existsSync(worktree)) {
    throw new Error(`MAPPER_WORKTREE does not exist: ${worktree}`);
  }

  const registry = loadRegistry(options.registryPath ?? paths.registry);
  const mapper = registry.mappers.find((m) => m.id === options.mapperId);
  if (!mapper) {
    throw new Error(`Unknown mapper: ${options.mapperId}`);
  }

  const focusFields = (options.focusFields ?? [])
    .map((f) => f.trim())
    .filter(Boolean);
  if (focusFields.length === 0) {
    throw new Error(
      "focusFields required. Run npm run label -- --fields <MESSAGE.…> first, then Build with AI on that field.",
    );
  }

  const allowedList = resolveAllowedPaths(worktree, mapper);
  const allowed = new Set(allowedList);

  const fileContents: Record<string, string> = {};
  for (const rel of allowedList) {
    fileContents[rel] = readFileSync(join(worktree, rel), "utf8");
  }

  const proposal = await proposeEdits(
    intent,
    allowedList,
    fileContents,
    focusFields,
    options.pipelineHint?.trim() || "",
  );
  const edits = Array.isArray(proposal.files) ? proposal.files : [];
  if (edits.length === 0) {
    throw new Error(proposal.summary?.trim() || "Model proposed no file changes for that intent.");
  }

  const validated: Array<{ path: string; content: string }> = [];
  const unchangedPaths: string[] = [];
  for (const file of edits) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new Error("Model returned a malformed file edit");
    }
    const path = assertPathAllowed(file.path, allowed, worktree);
    if (file.content === fileContents[path]) {
      unchangedPaths.push(path);
      continue;
    }
    validated.push({ path, content: file.content });
  }

  if (validated.length === 0) {
    return {
      changedFiles: [],
      summary:
        proposal.summary?.trim() ||
        `No file changes needed — already matches intent for ${focusFields.join(", ")}` +
          (unchangedPaths.length ? ` (${unchangedPaths.join(", ")})` : ""),
      worktree,
      alreadyApplied: true,
      focusFields,
    };
  }

  for (const file of validated) {
    const abs = join(worktree, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf8");
  }

  return {
    changedFiles: validated.map((f) => f.path),
    summary: proposal.summary?.trim() || `Updated ${validated.length} file(s) for ${focusFields.join(", ")}`,
    worktree,
    focusFields,
  };
}

/** Resolve worktree from request / env. */
export function resolveMapperWorktree(explicit?: string): string {
  const wt =
    explicit?.trim() ||
    getEnvOptional("MAPPER_WORKTREE") ||
    getEnvOptional("LABEL_WORKTREE");
  if (!wt) {
    throw new Error("MAPPER_WORKTREE is required (set in .env or pass worktree in the request).");
  }
  return resolve(wt);
}
