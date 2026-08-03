#!/usr/bin/env tsx
/**
 * ast / index-mappings — deterministic JavaParser AST (no AI).
 *
 * Usage:
 *   npm run ast -- --mapper lpa-request-mapper --worktree /path/to/Kmismomapper
 *   npm run ast -- --mapper lpa-request-mapper --worktree … \
 *     --fields MESSAGE.MISMOReferenceModelIdentifier,MESSAGE.DataVersionIdentifier
 */

import { parseArgs } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { paths } from "../src/config/env.js";
import { loadRegistry } from "../src/registry/loadRegistry.js";
import { assertMapperInScope } from "../src/registry/scope.js";
import {
  runIndexer,
  writeRuntimeRegistry,
} from "../src/indexer/runIndexer.js";
import { filterStepsByFields, parseFieldSelectors } from "../translator/filterByFields.js";

const { values } = parseArgs({
  options: {
    mapper: { type: "string", short: "m" },
    registry: { type: "string", default: paths.registry },
    worktree: { type: "string", default: paths.root },
    field: { type: "string", multiple: true },
    fields: { type: "string" },
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

const selectors = parseFieldSelectors({
  field: values.field,
  fields: values.fields,
});

for (const mapper of mappers) {
  const result = runIndexer(mapper, worktree, runtimeRegistry) as {
    steps: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  if (selectors.length > 0) {
    result.steps = filterStepsByFields(result.steps, selectors);
  }
  console.log(JSON.stringify(result, null, 2));
}
