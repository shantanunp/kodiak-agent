import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { paths } from "../config/env.js";

export interface CacheEntry {
  filePath: string;
  blobSha: string;
  commitSha: string;
  ast: unknown;
  indexedAt: string;
}

export interface RepoMeta {
  lastIndexedSha: string | null;
  updatedAt: string;
}

function cacheKey(filePath: string, blobSha: string): string {
  return createHash("sha256").update(`${filePath}:${blobSha}`).digest("hex");
}

function indexDir(): string {
  const dir = join(paths.cacheDir, "index");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function metaPath(repoSlug: string): string {
  const dir = join(paths.cacheDir, "meta");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${repoSlug.replace("/", "-")}.json`);
}

export function get(filePath: string, blobSha: string): CacheEntry | null {
  const file = join(indexDir(), `${cacheKey(filePath, blobSha)}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
}

export function set(entry: CacheEntry): void {
  const file = join(indexDir(), `${cacheKey(entry.filePath, entry.blobSha)}.json`);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
}

export function getLastIndexedSha(repoSlug: string): string | null {
  const file = metaPath(repoSlug);
  if (!existsSync(file)) return null;
  const meta = JSON.parse(readFileSync(file, "utf8")) as RepoMeta;
  return meta.lastIndexedSha;
}

export function setLastIndexedSha(repoSlug: string, sha: string): void {
  const file = metaPath(repoSlug);
  const meta: RepoMeta = { lastIndexedSha: sha, updatedAt: new Date().toISOString() };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, file);
}

export function worktreeDir(commitSha: string): string {
  const dir = join(paths.cacheDir, "worktrees", commitSha);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 40);
}
