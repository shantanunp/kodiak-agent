#!/usr/bin/env tsx
/**
 * Full scan: registry → fetch mapper sources → worktree cache.
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/env.js";
import { loadRegistry, parseRepoSlug, type MapperEntry } from "../registry/loadRegistry.js";
import { assertMapperInScope } from "../registry/scope.js";
import { GitHubClient } from "../mcp/githubClient.js";
import * as cache from "../cache/index.js";
import { materializeFile } from "../source/worktree.js";

export interface ScanOptions {
  local?: boolean;
  remote?: boolean;
  commitSha?: string;
  registryPath?: string;
}

async function fetchOrReadLocal(
  mapper: MapperEntry,
  worktree: string,
  commitSha: string,
  remote: boolean,
  registryPath: string,
): Promise<{ blobSha: string }> {
  if (!remote) {
    const localPath = join(paths.root, mapper.sourceFile);
    if (!existsSync(localPath)) {
      throw new Error(`Local source not found: ${localPath}`);
    }
    const content = readFileSync(localPath, "utf8");
    materializeFile(worktree, mapper.sourceFile, content);
    return { blobSha: cache.contentHash(content) };
  }

  const registry = loadRegistry(registryPath);
  const { owner, name } = parseRepoSlug(registry.repo);
  const client = new GitHubClient();
  await client.connectMcp();
  try {
    const file = await client.getFileContents(owner, name, mapper.sourceFile, commitSha);
    materializeFile(worktree, mapper.sourceFile, file.content);
    return { blobSha: file.sha };
  } finally {
    await client.disconnectMcp();
  }
}

export function fetchAndCache(
  mapper: MapperEntry,
  commitSha: string,
  blobSha: string,
): cache.CacheEntry {
  const existing = cache.get(mapper.sourceFile, blobSha);
  if (existing) return existing;

  const entry: cache.CacheEntry = {
    filePath: mapper.sourceFile,
    blobSha,
    commitSha,
    fetchedAt: new Date().toISOString(),
  };
  cache.set(entry);
  return entry;
}

export async function scanFiles(
  mapperIds: string[],
  options: ScanOptions = {},
): Promise<cache.CacheEntry[]> {
  const registryPath = options.registryPath ?? paths.registry;
  const registry = loadRegistry(registryPath);
  const useRemote = options.remote ?? false;
  const useLocal = options.local ?? !useRemote;

  let commitSha = options.commitSha ?? "local";
  if (useRemote) {
    const { owner, name } = parseRepoSlug(registry.repo);
    const client = new GitHubClient();
    await client.connectMcp();
    try {
      commitSha = await client.getLatestCommitSha(owner, name, registry.branch);
    } finally {
      await client.disconnectMcp();
    }
  } else if (!options.commitSha) {
    commitSha = "local-" + cache.contentHash(registry.repo + registry.branch);
  }

  const worktree = cache.worktreeDir(commitSha);
  const mappers = registry.mappers.filter((m) => mapperIds.includes(m.id));

  if (mappers.length === 0) {
    throw new Error(`No mappers matched: ${mapperIds.join(", ")}`);
  }

  for (const mapper of mappers) {
    assertMapperInScope(mapper.sourceFile, registry.scope);
  }

  const results: cache.CacheEntry[] = [];
  for (const mapper of mappers) {
    const { blobSha } = await fetchOrReadLocal(
      mapper,
      worktree,
      commitSha,
      useRemote && !useLocal,
      registryPath,
    );
    results.push(fetchAndCache(mapper, commitSha, blobSha));
  }

  return results;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mapper: { type: "string", short: "m" },
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      registry: { type: "string", default: paths.registry },
    },
  });

  const registry = loadRegistry(values.registry!);
  let mapperIds = registry.mappers.map((m) => m.id);
  if (values.mapper) mapperIds = [values.mapper];

  // Network policy: GitHub only with explicit --remote (never implied by token).
  if (values.remote && values.local) {
    throw new Error("Pass only one of --remote or --local");
  }
  const useRemote = Boolean(values.remote) && !values.local;
  const results = await scanFiles(mapperIds, {
    local: !useRemote,
    remote: useRemote,
    registryPath: values.registry,
  });

  for (const entry of results) {
    console.log(
      JSON.stringify(
        {
          filePath: entry.filePath,
          blobSha: entry.blobSha,
          commitSha: entry.commitSha,
          fetched: entry.fetchedAt,
        },
        null,
        2,
      ),
    );
  }
}

const isMain = process.argv[1]?.endsWith("scanRepo.ts");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
