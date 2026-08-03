/**
 * Shared: resolve AST + Java source bytes for a mapper
 * (worktree → remote scan → local → cache).
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { paths } from "../src/config/env.js";
import { loadRegistry } from "../src/registry/loadRegistry.js";
import { runIndexer, writeRuntimeRegistry } from "../src/indexer/runIndexer.js";
import { scanFiles } from "../src/orchestrator/scanRepo.js";
import * as cache from "../src/cache/index.js";
import type { IndexAst } from "./labeler.js";

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

export async function resolveAstForMapper(
  mapperId: string,
  registryPath = paths.registry,
  options: { local?: boolean; remote?: boolean; worktree?: string } = {},
): Promise<IndexAst> {
  const resolved = await resolveMapperAst(mapperId, registryPath, options);
  return resolved.ast;
}

export async function resolveMapperAst(
  mapperId: string,
  registryPath = paths.registry,
  options: { local?: boolean; remote?: boolean; worktree?: string } = {},
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
    const runtimeRegistry = join(paths.cacheDir, "runtime-registry.yaml");
    writeRuntimeRegistry([mapper], runtimeRegistry);
    const ast = runIndexer(mapper, worktree, runtimeRegistry) as IndexAst;
    return { ast, sourceJava: readJavaIfExists(sourcePath), sourcePath };
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
      return {
        ast: cached.ast as IndexAst,
        sourceJava: sourcePath ? readJavaIfExists(sourcePath) : "",
        sourcePath,
      };
    }
  }

  const localPath = join(paths.root, mapper.sourceFile);
  const useRemote = options.remote ?? (!options.local && !existsSync(localPath));

  if (useRemote) {
    const results = await scanFiles([mapperId], { remote: true, registryPath });
    if (!results[0]) throw new Error(`Scan produced no result for ${mapperId}`);
    const ast = results[0].ast as IndexAst;
    const commitSha = results[0].commitSha as string | undefined;
    const wtPath = commitSha
      ? join(paths.cacheDir, "worktrees", commitSha, mapper.sourceFile)
      : undefined;
    const sourcePath = wtPath && existsSync(wtPath) ? wtPath : undefined;
    return {
      ast,
      sourceJava: sourcePath ? readJavaIfExists(sourcePath) : "",
      sourcePath,
    };
  }

  const runtimeRegistry = join(paths.cacheDir, "runtime-registry.yaml");
  writeRuntimeRegistry([mapper], runtimeRegistry);
  const ast = runIndexer(mapper, paths.root, runtimeRegistry) as IndexAst;
  return { ast, sourceJava: readJavaIfExists(localPath), sourcePath: localPath };
}
