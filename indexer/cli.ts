#!/usr/bin/env tsx
/**
 * index-mappings — run JavaParser indexer for registered mappers (local worktree).
 *
 * Usage:
 *   npx tsx indexer/cli.ts
 *   npx tsx indexer/cli.ts --mapper example-mapper
 */

import { parseArgs } from "node:util";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { paths } from "../src/config/env.js";
import { loadRegistry } from "../src/registry/loadRegistry.js";
import { assertMapperInScope } from "../src/registry/scope.js";
import {
  runIndexer,
  writeRuntimeRegistry,
} from "../src/indexer/runIndexer.js";

const { values } = parseArgs({
  options: {
    mapper: { type: "string", short: "m" },
    registry: { type: "string", default: paths.registry },
    worktree: { type: "string", default: paths.root },
  },
});

const registry = loadRegistry(values.registry!);
const worktree = values.worktree!;
const runtimeRegistry = join(paths.cacheDir, "runtime-registry.yaml");

let mappers = registry.mappers;
if (values.mapper) {
  mappers = mappers.filter((m) => m.id === values.mapper);
  if (mappers.length === 0) {
    console.error(`Mapper not found: ${values.mapper}`);
    process.exit(1);
  }
}

for (const mapper of mappers) {
  assertMapperInScope(mapper.sourceFile, registry.scope);
  const sourcePath = join(worktree, mapper.sourceFile);
  if (!existsSync(sourcePath)) {
    console.error(`Source not found: ${sourcePath}`);
    process.exit(1);
  }
}

writeRuntimeRegistry(mappers, runtimeRegistry);

for (const mapper of mappers) {
  const result = runIndexer(mapper, worktree, runtimeRegistry);
  console.log(JSON.stringify(result, null, 2));
}
