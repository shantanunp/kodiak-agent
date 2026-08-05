/**
 * Shared: resolve mapper metadata + Java source bytes
 * (worktree → remote fetch → local → cache).
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { paths } from "../src/config/env.js";
import {
  loadRegistry,
  parseRepoSlug,
  type MapperEntry,
} from "../src/registry/loadRegistry.js";
import { materializeFile } from "../src/source/worktree.js";
import { GitHubClient } from "../src/mcp/githubClient.js";
import * as cache from "../src/cache/index.js";
import type { IndexAst } from "./model/index.js";

export interface ResolveMapperOptions {
  local?: boolean;
  remote?: boolean;
  worktree?: string;
}

export interface ResolvedMapperAst {
  ast: IndexAst;
  /** Exact Java source bytes used for fingerprint + AI discovery (may be empty if unavailable). */
  sourceJava: string;
  sourcePath?: string;
}

function readJavaIfExists(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

/** Fetch mapper Java bytes from GitHub or an existing worktree cache. */
async function fetchRemoteMapperSource(
  mapper: MapperEntry,
  registryPath: string,
): Promise<{ sourceJava: string; sourcePath?: string }> {
  const cached = cache.findLatestByFilePath(mapper.sourceFile);
  if (cached) {
    const wtPath = join(paths.cacheDir, "worktrees", cached.commitSha, mapper.sourceFile);
    if (existsSync(wtPath)) {
      return { sourceJava: readJavaIfExists(wtPath), sourcePath: wtPath };
    }
  }

  const registry = loadRegistry(registryPath);
  const { owner, name } = parseRepoSlug(registry.repo);
  const client = new GitHubClient();
  await client.connectMcp();
  try {
    const commitSha = await client.getLatestCommitSha(owner, name, registry.branch);
    const file = await client.getFileContents(owner, name, mapper.sourceFile, commitSha);
    const worktree = join(paths.cacheDir, "worktrees", commitSha);
    materializeFile(worktree, mapper.sourceFile, file.content);
    const sourcePath = join(worktree, mapper.sourceFile);
    return { sourceJava: file.content, sourcePath };
  } finally {
    await client.disconnectMcp();
  }
}

/** Registry metadata only — AI discovery reads sourceJava directly. */
export function stubIndexAst(mapper: MapperEntry): IndexAst {
  return {
    mapperId: mapper.id,
    className: mapper.class,
    entryMethod: mapper.entryMethod,
    sourceType: mapper.sourceType,
    targetType: mapper.targetType,
    sourceFile: mapper.sourceFile,
    operations: [],
    steps: [],
  };
}

export async function resolveAstForMapper(
  mapperId: string,
  registryPath = paths.registry,
  options: ResolveMapperOptions = {},
): Promise<IndexAst> {
  const resolved = await resolveMapperAst(mapperId, registryPath, options);
  return resolved.ast;
}

export async function resolveMapperAst(
  mapperId: string,
  registryPath = paths.registry,
  options: ResolveMapperOptions = {},
): Promise<ResolvedMapperAst> {
  const registry = loadRegistry(registryPath);
  const mapper = registry.mappers.find((m) => m.id === mapperId);
  if (!mapper) {
    throw new Error(`Mapper not found: ${mapperId}`);
  }

  const worktree = options.worktree?.trim();
  if (worktree) {
    const sourcePath = join(worktree, mapper.sourceFile);
    if (!existsSync(sourcePath)) {
      throw new Error(`Source not found in worktree: ${sourcePath}`);
    }
    return {
      ast: stubIndexAst(mapper),
      sourceJava: readJavaIfExists(sourcePath),
      sourcePath,
    };
  }

  const forceRefresh = Boolean(options.remote || options.local);
  if (!forceRefresh) {
    const cached = cache.findLatestByFilePath(mapper.sourceFile);
    if (cached) {
      const localPath = join(paths.root, mapper.sourceFile);
      const wtPath = join(paths.cacheDir, "worktrees", cached.commitSha, mapper.sourceFile);
      const sourcePath = existsSync(localPath)
        ? localPath
        : existsSync(wtPath)
          ? wtPath
          : undefined;
      const sourceJava = sourcePath ? readJavaIfExists(sourcePath) : "";
      return { ast: stubIndexAst(mapper), sourceJava, sourcePath };
    }
  }

  const localPath = join(paths.root, mapper.sourceFile);
  const useRemote = options.remote ?? (!options.local && !existsSync(localPath));

  if (useRemote) {
    const { sourceJava, sourcePath } = await fetchRemoteMapperSource(mapper, registryPath);
    return { ast: stubIndexAst(mapper), sourceJava, sourcePath };
  }

  const sourceJava = readJavaIfExists(localPath);
  return { ast: stubIndexAst(mapper), sourceJava, sourcePath: localPath };
}
