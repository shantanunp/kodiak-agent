/**
 * Shared: resolve AST + Java source bytes for a mapper
 * (worktree → remote scan → local → cache).
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { paths } from "../src/config/env.js";
import { loadRegistry, type MapperEntry } from "../src/registry/loadRegistry.js";
import { runIndexer, writeRuntimeRegistry } from "../src/indexer/runIndexer.js";
import { scanFiles } from "../src/orchestrator/scanRepo.js";
import * as cache from "../src/cache/index.js";
import type { IndexAst } from "./model/index.js";

export interface ResolveMapperOptions {
  local?: boolean;
  remote?: boolean;
  worktree?: string;
  /**
   * When false, skip JavaParser indexer — stub AST metadata + source bytes only.
   * Default true (callers that need ops, e.g. `ast` / export). Label passes false unless --with-ast.
   */
  withAst?: boolean;
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

/** Registry metadata only — no indexer operations (AI-only discovery path). */
export function stubIndexAst(mapper: MapperEntry): IndexAst {
  return {
    mapperId: mapper.id,
    className: mapper.className,
    entryMethod: mapper.entryMethod,
    sourceType: mapper.sourceType,
    targetType: mapper.targetType,
    sourceFile: mapper.sourceFile,
    operations: [],
    steps: [],
  };
}

function stripAstOps(ast: IndexAst, mapper: MapperEntry): IndexAst {
  return {
    ...stubIndexAst(mapper),
    // keep mapperId from indexed result if present
    mapperId: ast.mapperId ?? mapper.id,
    className: ast.className ?? mapper.className,
    entryMethod: ast.entryMethod ?? mapper.entryMethod,
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

  const withAst = options.withAst !== false;

  const worktree = options.worktree?.trim();
  if (worktree) {
    const sourcePath = join(worktree, mapper.sourceFile);
    if (!existsSync(sourcePath)) {
      throw new Error(`Source not found in worktree: ${sourcePath}`);
    }
    const sourceJava = readJavaIfExists(sourcePath);
    if (!withAst) {
      return { ast: stubIndexAst(mapper), sourceJava, sourcePath };
    }
    const runtimeRegistry = join(paths.cacheDir, "runtime-registry.yaml");
    writeRuntimeRegistry([mapper], runtimeRegistry);
    const ast = runIndexer(mapper, worktree, runtimeRegistry) as IndexAst;
    return { ast, sourceJava, sourcePath };
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
      const ast = withAst
        ? (cached.ast as IndexAst)
        : stripAstOps(cached.ast as IndexAst, mapper);
      return { ast, sourceJava, sourcePath };
    }
  }

  const localPath = join(paths.root, mapper.sourceFile);
  const useRemote = options.remote ?? (!options.local && !existsSync(localPath));

  if (useRemote) {
    const results = await scanFiles([mapperId], { remote: true, registryPath });
    if (!results[0]) throw new Error(`Scan produced no result for ${mapperId}`);
    const indexed = results[0].ast as IndexAst;
    const commitSha = results[0].commitSha as string | undefined;
    const wtPath = commitSha
      ? join(paths.cacheDir, "worktrees", commitSha, mapper.sourceFile)
      : undefined;
    const sourcePath = wtPath && existsSync(wtPath) ? wtPath : undefined;
    const sourceJava = sourcePath ? readJavaIfExists(sourcePath) : "";
    const ast = withAst ? indexed : stripAstOps(indexed, mapper);
    return { ast, sourceJava, sourcePath };
  }

  const sourceJava = readJavaIfExists(localPath);
  if (!withAst) {
    return { ast: stubIndexAst(mapper), sourceJava, sourcePath: localPath };
  }
  const runtimeRegistry = join(paths.cacheDir, "runtime-registry.yaml");
  writeRuntimeRegistry([mapper], runtimeRegistry);
  const ast = runIndexer(mapper, paths.root, runtimeRegistry) as IndexAst;
  return { ast, sourceJava, sourcePath: localPath };
}
