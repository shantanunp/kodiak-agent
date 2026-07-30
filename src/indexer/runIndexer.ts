import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { paths } from "../config/env.js";
import type { MapperEntry } from "../registry/loadRegistry.js";
import * as cache from "../cache/index.js";
import type { CacheEntry } from "../cache/index.js";

export function runIndexer(
  mapper: MapperEntry,
  worktreeRoot: string,
  runtimeRegistryPath: string,
): unknown {
  const jar = paths.indexerJar;
  if (!existsSync(jar)) {
    throw new Error(`Indexer jar not found at ${jar}. Run: npm run build:indexer`);
  }

  const result = spawnSync(
    "java",
    ["-jar", jar, runtimeRegistryPath, mapper.id, "--worktree", worktreeRoot],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(`Indexer failed:\n${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout.trim());
}

export function writeRuntimeRegistry(mappers: MapperEntry[], destPath: string): void {
  const yaml = [
    'repo: "local"',
    'branch: "local"',
    "scope: []",
    "mappers:",
    ...mappers.map((m) =>
      [
        `  - id: ${m.id}`,
        `    sourceFile: ${m.sourceFile}`,
        `    class: ${m.class}`,
        `    entryMethod: ${m.entryMethod}`,
        `    sourceType: ${m.sourceType}`,
        `    targetType: ${m.targetType}`,
        m.goldenTests ? `    goldenTests: ${m.goldenTests}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, yaml);
}

export function materializeFile(worktreeRoot: string, filePath: string, content: string): void {
  const full = join(worktreeRoot, filePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function indexAndCache(
  mapper: MapperEntry,
  worktreeRoot: string,
  commitSha: string,
  blobSha: string,
  runtimeRegistryPath: string,
): CacheEntry {
  const existing = cache.get(mapper.sourceFile, blobSha);
  if (existing) return existing;

  const ast = runIndexer(mapper, worktreeRoot, runtimeRegistryPath);
  const entry: CacheEntry = {
    filePath: mapper.sourceFile,
    blobSha,
    commitSha,
    ast,
    indexedAt: new Date().toISOString(),
  };
  cache.set(entry);
  return entry;
}
