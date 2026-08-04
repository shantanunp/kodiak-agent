#!/usr/bin/env tsx
/**
 * ast / index-mappings — deterministic JavaParser AST (no AI).
 * Emits grouped `mapping` (one entry per target field).
 *
 *   npm run ast -- --mapper my-mapper --worktree /path/to/mapper-repo
 *   --fields Order.customerId,Order.shipTo.postalCode
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
import { filterMappingByFields, parseFieldSelectors } from "../translator/filterByFields.js";
import { groupOperationsByTarget } from "../translator/groupMapping.js";

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
    operations?: Array<Record<string, unknown>>;
    steps?: Array<Record<string, unknown>>;
    mapping?: unknown;
    [key: string]: unknown;
  };
  const ops = result.operations ?? result.steps ?? [];
  let mapping = groupOperationsByTarget(ops);
  if (selectors.length > 0) {
    mapping = filterMappingByFields(mapping, selectors);
  }
  delete result.steps;
  delete result.operations;
  result.mapping = mapping;
  console.log(JSON.stringify(result, null, 2));
}
