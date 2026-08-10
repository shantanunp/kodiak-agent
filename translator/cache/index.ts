import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../../src/config/env.js";

/** Bump when discovery/label prompts or merge rules change (invalidates pipeline cache). */
export const PIPELINE_CACHE_VERSION = "10";

const labelCacheRoot = resolve(dirname(fileURLToPath(import.meta.url)), "cache", "labels");

function labelKeyFor(sourceText: string, model: string): string {
  return createHash("sha256").update(`${model}:${sourceText}`).digest("hex");
}

export interface LabelCacheEntry {
  sourceText: string;
  model: string;
  response: unknown;
  cachedAt: string;
}

export function getLabelCache(sourceText: string, model: string): LabelCacheEntry | null {
  const file = join(labelCacheRoot, `${labelKeyFor(sourceText, model)}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as LabelCacheEntry;
}

export function setLabelCache(entry: LabelCacheEntry): void {
  mkdirSync(labelCacheRoot, { recursive: true });
  const file = join(labelCacheRoot, `${labelKeyFor(entry.sourceText, entry.model)}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

export function clearLabelCache(): number {
  if (!existsSync(labelCacheRoot)) return 0;
  const files = readdirSync(labelCacheRoot).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    rmSync(join(labelCacheRoot, f), { force: true });
  }
  return files.length;
}

// ── Pipeline cache (full mapper business mapping) ───────────────────────────

export interface PipelineCacheEntry {
  fingerprint: string;
  mapperId: string;
  mapping: Array<{ targetField: string; pipeline: unknown[] }>;
  labeledAt: string;
  labelModel: string;
  discoveryMeta?: {
    aiTargets: number;
    mergedTargets: number;
  };
  cachedAt: string;
}

function pipelineDir(mapperId?: string): string {
  const root = join(paths.cacheDir, "pipelines");
  return mapperId ? join(root, mapperId) : root;
}

export function computePipelineFingerprint(parts: {
  sourceJava: string;
  schemaJson: string;
  model: string;
  version?: string;
}): string {
  const payload = [
    parts.version ?? PIPELINE_CACHE_VERSION,
    parts.model,
    parts.schemaJson,
    parts.sourceJava,
  ].join("\n---\n");
  return createHash("sha256").update(payload).digest("hex");
}

export function getPipelineCache(
  mapperId: string,
  fingerprint: string,
): PipelineCacheEntry | null {
  const file = join(pipelineDir(mapperId), `${fingerprint}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as PipelineCacheEntry;
}

export function setPipelineCache(entry: PipelineCacheEntry): void {
  const dir = pipelineDir(entry.mapperId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${entry.fingerprint}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

/** Clear pipeline cache for one mapper, or all mappers if omitted. Returns files removed. */
export function clearPipelineCache(mapperId?: string): number {
  const root = pipelineDir();
  if (!existsSync(root)) return 0;

  if (mapperId) {
    const dir = pipelineDir(mapperId);
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    rmSync(dir, { recursive: true, force: true });
    return files.length;
  }

  let count = 0;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      count += files.length;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // skip non-dirs
    }
  }
  return count;
}

export interface DiscoveryCacheEntry {
  fingerprint: string;
  mapperId: string;
  hits: Array<{ javaTargetHint: string; codeSnippet: string; note?: string }>;
  cachedAt: string;
}

function discoveryDir(mapperId?: string): string {
  const root = join(paths.cacheDir, "discovery");
  return mapperId ? join(root, mapperId) : root;
}

export function getDiscoveryCache(
  mapperId: string,
  fingerprint: string,
): DiscoveryCacheEntry | null {
  const file = join(discoveryDir(mapperId), `${fingerprint}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as DiscoveryCacheEntry;
}

export function setDiscoveryCache(entry: DiscoveryCacheEntry): void {
  const dir = discoveryDir(entry.mapperId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${entry.fingerprint}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

export function clearDiscoveryCache(mapperId?: string): number {
  const root = discoveryDir();
  if (!existsSync(root)) return 0;
  if (mapperId) {
    const dir = discoveryDir(mapperId);
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    rmSync(dir, { recursive: true, force: true });
    return files.length;
  }
  let count = 0;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      count += files.length;
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // skip
    }
  }
  return count;
}

// ── Field-level business mapping cache ──────────────────────────────────────

export interface FieldPipelineCacheEntry {
  fingerprint: string;
  mapperId: string;
  javaTargetField: string;
  mapping: { targetField: string; pipeline: unknown[] };
  labeledAt: string;
  labelModel: string;
  cachedAt: string;
  /** Confidence badge — how this label was produced. */
  provenance?: string;
  /** Tool-loop investigation trace (replayable evidence). */
  toolTrace?: Array<{ tool: string; input?: unknown; output?: unknown }>;
}

function fieldsDir(mapperId: string, fingerprint?: string): string {
  const root = join(paths.cacheDir, "fields", mapperId);
  return fingerprint ? join(root, fingerprint) : root;
}

function fieldFileKey(javaTargetField: string): string {
  return createHash("sha256").update(javaTargetField).digest("hex").slice(0, 32);
}

export function getFieldPipelineCache(
  mapperId: string,
  fingerprint: string,
  javaTargetField: string,
): FieldPipelineCacheEntry | null {
  const file = join(fieldsDir(mapperId, fingerprint), `${fieldFileKey(javaTargetField)}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as FieldPipelineCacheEntry;
}

export function setFieldPipelineCache(entry: FieldPipelineCacheEntry): void {
  const dir = fieldsDir(entry.mapperId, entry.fingerprint);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${fieldFileKey(entry.javaTargetField)}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

/** List all field cache entries for a mapper fingerprint. */
export function listFieldPipelineCaches(
  mapperId: string,
  fingerprint: string,
): FieldPipelineCacheEntry[] {
  const dir = fieldsDir(mapperId, fingerprint);
  if (!existsSync(dir)) return [];
  const out: FieldPipelineCacheEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as FieldPipelineCacheEntry);
    } catch {
      // skip corrupt
    }
  }
  return out;
}

/**
 * Most recently written fingerprint dir under `.cache/fields/<mapperId>/` that actually
 * has cached field entries. Used by `--from-cache-only` so a stale/unreproducible content
 * fingerprint (e.g. computed against a source snapshot that no longer exists locally, like a
 * deleted temp worktree) doesn't hide field labels that were legitimately imported earlier.
 */
export function findLatestFieldFingerprint(mapperId: string): string | null {
  const dir = fieldsDir(mapperId);
  if (!existsSync(dir)) return null;
  let best: { name: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name);
    try {
      const stat = statSync(sub);
      if (!stat.isDirectory()) continue;
      if (readdirSync(sub).filter((f) => f.endsWith(".json")).length === 0) continue;
      if (!best || stat.mtimeMs > best.mtime) best = { name, mtime: stat.mtimeMs };
    } catch {
      // skip unreadable entries
    }
  }
  return best?.name ?? null;
}

export function clearFieldPipelineCache(mapperId?: string): number {
  const root = join(paths.cacheDir, "fields");
  if (!existsSync(root)) return 0;

  function countAndRemove(dir: string): number {
    let n = 0;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name.endsWith(".json")) {
        n += 1;
        continue;
      }
      try {
        n += countAndRemove(p);
      } catch {
        // skip
      }
    }
    rmSync(dir, { recursive: true, force: true });
    return n;
  }

  if (mapperId) {
    const dir = join(root, mapperId);
    if (!existsSync(dir)) return 0;
    return countAndRemove(dir);
  }

  let count = 0;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      count += countAndRemove(dir);
    } catch {
      // skip
    }
  }
  return count;
}

export function clearAllTranslatorCaches(mapperId?: string): {
  pipelines: number;
  discovery: number;
  fields: number;
  labels: number;
} {
  return {
    pipelines: clearPipelineCache(mapperId),
    discovery: clearDiscoveryCache(mapperId),
    fields: clearFieldPipelineCache(mapperId),
    labels: clearLabelCache(),
  };
}
