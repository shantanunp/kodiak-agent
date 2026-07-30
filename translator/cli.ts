#!/usr/bin/env tsx
/**
 * Label RAW AST steps via Gemini (Phase 2).
 */

import { parseArgs } from "node:util";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/env.js";
import { StepLabeler } from "./labeler.js";
import { isGeminiConfigured } from "./config.js";
import { resolveAstForMapper } from "./resolvePipeline.js";
import type { IndexAst } from "./labeler.js";

const { values } = parseArgs({
  options: {
    file: { type: "string", short: "f" },
    mapper: { type: "string", short: "m" },
    local: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
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
    ast = await resolveAstForMapper(values.mapper, values.registry!, {
      local: values.local,
      remote: values.remote || undefined,
    });
  } else {
    const indexDir = join(paths.cacheDir, "index");
    if (!existsSync(indexDir)) {
      console.error("Usage: label --mapper <id> | --file <cache.json>");
      process.exit(1);
    }
    const files = readdirSync(indexDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      console.error("No cached index entries. Run: npm run scan -- --mapper <id> --remote");
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
