/**
 * Apply a natural-language change to the mapper worktree (file writes only).
 * Git branch / commit / push / PR is deferred to a later phase.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { getEnvOptional, paths } from "../src/config/env.js";
import { loadRegistry, type MapperEntry } from "../src/registry/loadRegistry.js";
import { createModelProvider, HttpModelProvider, isModelConfigured } from "./model/index.js";

const APPLY_CHANGE_PROMPT = `You edit Java mapper source files according to a user change request.

You receive:
- intent: what to change
- allowedPaths: repo-relative paths you may modify
- files: current contents of those paths

Return JSON only (no markdown fences):
{
  "summary": "one short sentence of what changed",
  "files": [{"path":"<one of allowedPaths>","content":"<full new file contents>"}]
}

Rules:
- Only include files that actually change. Paths MUST be exact members of allowedPaths.
- Return the FULL file content for each changed file (not a diff).
- Preserve package/imports/style unless the intent requires otherwise.
- Keep the code compiling: update call sites / tests in allowed files when renaming methods.
- Do not invent new files or paths outside allowedPaths.
- If the intent cannot be applied safely, return {"summary":"...","files":[]} with summary explaining why.`;

export interface ApplyChangeOptions {
  mapperId: string;
  intent: string;
  worktree: string;
  registryPath?: string;
}

export interface ApplyChangeResult {
  changedFiles: string[];
  summary: string;
  worktree: string;
  /** True when model echoed current files — intent already satisfied. */
  alreadyApplied?: boolean;
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
): Promise<ModelEditResponse> {
  if (!isModelConfigured()) {
    throw new Error("MODEL_API_KEY not configured");
  }
  const provider = createModelProvider() as HttpModelProvider;
  const userPayload = JSON.stringify({
    intent,
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

  const allowedList = resolveAllowedPaths(worktree, mapper);
  const allowed = new Set(allowedList);

  const fileContents: Record<string, string> = {};
  for (const rel of allowedList) {
    fileContents[rel] = readFileSync(join(worktree, rel), "utf8");
  }

  const proposal = await proposeEdits(intent, allowedList, fileContents);
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

  // Same prompt re-run after a successful edit → model echoes current files.
  if (validated.length === 0) {
    return {
      changedFiles: [],
      summary:
        proposal.summary?.trim() ||
        `No file changes needed — worktree already matches this intent` +
          (unchangedPaths.length ? ` (${unchangedPaths.join(", ")})` : ""),
      worktree,
      alreadyApplied: true,
    };
  }

  for (const file of validated) {
    const abs = join(worktree, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf8");
  }

  return {
    changedFiles: validated.map((f) => f.path),
    summary: proposal.summary?.trim() || `Updated ${validated.length} file(s)`,
    worktree,
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
