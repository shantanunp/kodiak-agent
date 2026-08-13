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
import type { SharedHelperRef } from "../analyzer/sharedHelpers.js";

export type SharedHelperMode = "apply-all" | "fork";

const APPLY_CHANGE_PROMPT_BASE = `You edit Java mapper source for ONE target field only (POC scope).

You receive:
- intent: what to change
- focusFields: business target field path(s) in scope (schema paths for the field shown in the UI)
- pipelineHint: labeled pipeline / reason for that field (helpers mentioned there are the edit scope)
- sharedHelpers: Java helpers in this field's closure that other fields also call (name + other fields)
- sharedHelperMode: how to treat those shared helpers (absent | apply-all | fork)
- allowedPaths: repo-relative paths you may modify
- files: current contents of those paths

Return JSON only (no markdown fences):
{
  "summary": "one short sentence of what changed",
  "files": [{"path":"<one of allowedPaths>","content":"<full new file contents>"}]
}

CRITICAL scope rules:
- Change ONLY the private helpers / methods used by focusFields (from pipelineHint).
- Return the FULL file content for each changed file (not a diff).
- Paths MUST be exact members of allowedPaths.
- Keep the code compiling; update tests in allowed files only when they cover focusFields.
- If already satisfied, return the current file contents unchanged (or files: []).
- If the intent cannot be applied safely within this field scope, return {"summary":"...","files":[]}.`;

/** Extra prompt rules when the focused field shares Java helpers with other mappings. */
export function sharedHelperScopeRules(
  mode: SharedHelperMode | undefined,
  helpers: SharedHelperRef[],
): string {
  if (helpers.length === 0) {
    return (
      "- Do NOT modify unrelated field mappings or shared helpers used by other fields.\n" +
      "- Do NOT change shared helpers that other fields use unless the intent explicitly requires it AND the helper is only for focusFields."
    );
  }
  const listed = helpers
    .map((h) => `${h.name} (also ${h.fields.join(", ")})`)
    .join("; ");
  if (mode === "apply-all") {
    return (
      `- Shared helpers in scope (edit these IN PLACE): ${listed}.\n` +
      "- You MAY modify those listed shared helpers; other listed fields will be re-labeled.\n" +
      "- Do NOT modify helpers that are not in that shared list and are used only by unrelated fields."
    );
  }
  if (mode === "fork") {
    return (
      `- Shared helpers that MUST NOT be edited in place: ${listed}.\n` +
      "- Extract a private copy of each listed helper (new private method) used only by focusFields, then apply the intent to the copy.\n" +
      "- Leave the original shared helper bodies unchanged so other fields keep their current behavior."
    );
  }
  return (
    `- Shared helpers (do not edit in place): ${listed}.\n` +
    "- Do NOT modify those shared helpers. If the intent requires changing them, return files: [] and say so in summary."
  );
}

function applyChangePrompt(
  mode: SharedHelperMode | undefined,
  helpers: SharedHelperRef[],
): string {
  return `${APPLY_CHANGE_PROMPT_BASE}\n\n${sharedHelperScopeRules(mode, helpers)}`;
}

export interface ApplyChangeOptions {
  mapperId: string;
  intent: string;
  worktree: string;
  registryPath?: string;
  /** Schema target field(s) to scope the edit (from label --fields / current UI tab). */
  focusFields?: string[];
  /** Short pipeline / reason text from the current view for those fields. */
  pipelineHint?: string;
  /** How to treat helpers shared with other fields (from the viewer's confirm dialog). */
  sharedHelperMode?: SharedHelperMode;
  /** Authoritative shared-helper list for focusFields (from the analyzer, not the client). */
  sharedHelpers?: SharedHelperRef[];
}

export interface ApplyChangeResult {
  changedFiles: string[];
  summary: string;
  worktree: string;
  /** True when model echoed current files — intent already satisfied. */
  alreadyApplied?: boolean;
  focusFields?: string[];
  sharedHelperMode?: SharedHelperMode;
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
  sharedHelperMode: SharedHelperMode | undefined,
  sharedHelpers: SharedHelperRef[],
): Promise<ModelEditResponse> {
  if (!isModelConfigured()) {
    throw new Error("MODEL_API_KEY not configured");
  }
  const provider = createModelProvider() as HttpModelProvider;
  const userPayload = JSON.stringify({
    intent,
    focusFields,
    pipelineHint,
    sharedHelperMode: sharedHelperMode ?? null,
    sharedHelpers,
    allowedPaths,
    files: allowedPaths.map((path) => ({ path, content: fileContents[path] ?? "" })),
  });
  const text = await provider.generate(
    applyChangePrompt(sharedHelperMode, sharedHelpers),
    userPayload,
  );
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
      "focusFields required. Run npm run label -- --fields <schema.target.path> first, then Build with AI on that field.",
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
    options.sharedHelperMode,
    options.sharedHelpers ?? [],
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
      sharedHelperMode: options.sharedHelperMode,
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
    sharedHelperMode: options.sharedHelperMode,
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
