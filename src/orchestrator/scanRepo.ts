#!/usr/bin/env tsx
/**
 * Full scan: registry → fetch → JavaParser index → cache.
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/env.js";
import { loadRegistry, parseRepoSlug, type MapperEntry } from "../registry/loadRegistry.js";
import { assertMapperInScope } from "../registry/scope.js";
import { GitHubClient } from "../mcp/githubClient.js";
import * as cache from "../cache/index.js";
import {
  indexAndCache,
  materializeFile,
  writeRuntimeRegistry,
} from "../indexer/runIndexer.js";

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

export async function scanFiles(
  mapperIds: string[],
  options: ScanOptions = {},
): Promise<cache.CacheEntry[]> {
  const registryPath = options.registryPath ?? paths.registry;
  const registry = loadRegistry(registryPath);
  const useRemote = options.remote ?? false;
  const useLocal = options.local ?? !useRemote;
  const runtimeRegistry = join(paths.cacheDir, "runtime-registry.yaml");

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

  writeRuntimeRegistry(mappers, runtimeRegistry);

  const results: cache.CacheEntry[] = [];
  for (const mapper of mappers) {
    const { blobSha } = await fetchOrReadLocal(
      mapper,
      worktree,
      commitSha,
      useRemote && !useLocal,
      registryPath,
    );
    const entry = indexAndCache(mapper, worktree, commitSha, blobSha, runtimeRegistry);
    results.push(entry);
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

  const useRemote =
    values.remote || (!values.local && (!!process.env.GITHUB_TOKEN || true));
  const results = await scanFiles(mapperIds, {
    local: values.local,
    remote: useRemote && !values.local,
    registryPath: values.registry,
  });

  for (const entry of results) {
    console.log(
      JSON.stringify(
        {
          filePath: entry.filePath,
          blobSha: entry.blobSha,
          commitSha: entry.commitSha,
          cached: entry.indexedAt,
          stepCount: (entry.ast as { steps?: unknown[] })?.steps?.length ?? 0,
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
