#!/usr/bin/env tsx
/**
 * Label RAW AST steps via Gemini Studio (Phase 2).
 *
 * Usage:
 *   npm run label -- --file .cache/index/<hash>.json
 *   npm run label -- --mapper example-mapper   # index locally, then label
 */

import { parseArgs } from "node:util";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/env.js";
import { loadRegistry } from "../src/registry/loadRegistry.js";
import { runIndexer, writeRuntimeRegistry } from "../src/indexer/runIndexer.js";
import { StepLabeler } from "./labeler.js";
import { isGeminiConfigured } from "./config.js";
import type { IndexAst } from "./labeler.js";

const { values } = parseArgs({
  options: {
    file: { type: "string", short: "f" },
    mapper: { type: "string", short: "m" },
    registry: { type: "string", default: paths.registry },
  },
});

async function main(): Promise<void> {
  if (!isGeminiConfigured()) {
    console.error("Set GEMINI_API_KEY in .env (from https://aistudio.google.com/apikey)");
    process.exit(1);
  }

  let ast: IndexAst;

  if (values.file) {
    const raw = JSON.parse(readFileSync(values.file, "utf8")) as { ast?: IndexAst } | IndexAst;
    ast = ("ast" in raw && raw.ast ? raw.ast : raw) as IndexAst;
  } else if (values.mapper) {
    const registry = loadRegistry(values.registry!);
    const mapper = registry.mappers.find((m) => m.id === values.mapper);
    if (!mapper) {
      console.error(`Mapper not found: ${values.mapper}`);
      process.exit(1);
    }
    const runtimeRegistry = join(paths.cacheDir, "runtime-registry.yaml");
    writeRuntimeRegistry([mapper], runtimeRegistry);
    ast = runIndexer(mapper, paths.root, runtimeRegistry) as IndexAst;
  } else {
    const indexDir = join(paths.cacheDir, "index");
    if (!existsSync(indexDir)) {
      console.error("Usage: label --file <cache.json> | --mapper <id>");
      process.exit(1);
    }
    const files = readdirSync(indexDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      console.error("No cached index entries. Run npm run scan first.");
      process.exit(1);
    }
    const latest = join(indexDir, files[files.length - 1]!);
    const entry = JSON.parse(readFileSync(latest, "utf8")) as { ast: IndexAst };
    ast = entry.ast;
  }

  const labeler = new StepLabeler();
  const pipeline = await labeler.labelIndex(ast);
  console.log(JSON.stringify(pipeline, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
