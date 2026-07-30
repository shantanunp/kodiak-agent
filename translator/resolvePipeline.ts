/**
 * Shared: resolve AST for a mapper (cache → remote scan → local).
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { paths } from "../src/config/env.js";
import { loadRegistry } from "../src/registry/loadRegistry.js";
import { runIndexer, writeRuntimeRegistry } from "../src/indexer/runIndexer.js";
import { scanFiles } from "../src/orchestrator/scanRepo.js";
import * as cache from "../src/cache/index.js";
import type { IndexAst } from "./labeler.js";

export async function resolveAstForMapper(
  mapperId: string,
  registryPath = paths.registry,
  options: { local?: boolean; remote?: boolean } = {},
): Promise<IndexAst> {
  const registry = loadRegistry(registryPath);
  const mapper = registry.mappers.find((m) => m.id === mapperId);
  if (!mapper) {
    throw new Error(`Mapper not found: ${mapperId}`);
  }

  const cached = cache.findLatestByFilePath(mapper.sourceFile);
  if (cached) {
    return cached.ast as IndexAst;
  }

  const localPath = join(paths.root, mapper.sourceFile);
  const useRemote = options.remote ?? (!options.local && !existsSync(localPath));

  if (useRemote) {
    const results = await scanFiles([mapperId], { remote: true, registryPath });
    if (!results[0]) throw new Error(`Scan produced no result for ${mapperId}`);
    return results[0].ast as IndexAst;
  }

  const runtimeRegistry = join(paths.cacheDir, "runtime-registry.yaml");
  writeRuntimeRegistry([mapper], runtimeRegistry);
  return runIndexer(mapper, paths.root, runtimeRegistry) as IndexAst;
}
