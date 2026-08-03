#!/usr/bin/env tsx
/**
 * AI-label mapper fields via Gemini → business/schema paths (no Java DTO paths).
 *
 *   npm run label -- --mapper lpa-request-mapper --worktree /path/to/Kmismomapper
 *   --fields MESSAGE.DEAL.PARTY.FirstName
 *   --no-cache | --clear-cache
 */

import { parseArgs } from "node:util";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/env.js";
import { StepLabeler } from "./labeler.js";
import { isGeminiConfigured } from "./gemini.js";
import { resolveMapperAst } from "./resolvePipeline.js";
import { filterMappingByFields, parseFieldSelectors } from "./filterByFields.js";
import { clearAllTranslatorCaches } from "./cache/index.js";
import type { IndexAst } from "./labeler.js";

const { values } = parseArgs({
  options: {
    file: { type: "string", short: "f" },
    mapper: { type: "string", short: "m" },
    local: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    worktree: { type: "string" },
    registry: { type: "string", default: paths.registry },
    field: { type: "string", multiple: true },
    fields: { type: "string" },
    "no-cache": { type: "boolean", default: false },
    "clear-cache": { type: "boolean", default: false },
    /** With --fields, also run Gemini discovery (default: AST-only to save quota). */
    "discover-ai": { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  if (values["clear-cache"]) {
    const cleared = clearAllTranslatorCaches(values.mapper);
    console.error(
      `Cleared caches (pipelines=${cleared.pipelines}, discovery=${cleared.discovery}, fields=${cleared.fields}, labels=${cleared.labels})` +
        (values.mapper ? ` for ${values.mapper}` : " (all)"),
    );
  }

  if (!isGeminiConfigured()) {
    console.error("Set GEMINI_API_KEY in .env (from https://aistudio.google.com/apikey)");
    process.exit(1);
  }

  let ast: IndexAst;
  let sourceJava = "";

  if (values.file) {
    const raw = JSON.parse(readFileSync(values.file, "utf8")) as { ast?: IndexAst } | IndexAst;
    ast = ("ast" in raw && raw.ast ? raw.ast : raw) as IndexAst;
  } else if (values.mapper) {
    const resolved = await resolveMapperAst(values.mapper, values.registry!, {
      local: values.local,
      remote: values.remote || undefined,
      worktree: values.worktree,
    });
    ast = resolved.ast;
    sourceJava = resolved.sourceJava;
  } else {
    const indexDir = join(paths.cacheDir, "index");
    if (!existsSync(indexDir)) {
      console.error(
        "Usage: label --mapper <id> [--remote | --worktree <path>] | --file <cache.json>",
      );
      process.exit(1);
    }
    const files = readdirSync(indexDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      console.error("No cached index entries. Run: npm run label -- --mapper <id> --remote");
      process.exit(1);
    }
    const latest = join(indexDir, files[files.length - 1]!);
    const entry = JSON.parse(readFileSync(latest, "utf8")) as { ast: IndexAst };
    ast = entry.ast;
  }

  const selectors = parseFieldSelectors({
    field: values.field,
    fields: values.fields,
  });

  const labeler = new StepLabeler();
  const pipeline = await labeler.labelIndex(ast, {
    fieldSelectors: selectors,
    sourceJava,
    noCache: Boolean(values["no-cache"]),
    discoverAi: Boolean(values["discover-ai"]),
  });

  if (selectors.length > 0) {
    pipeline.mapping = filterMappingByFields(pipeline.mapping, selectors);
  }

  console.log(
    JSON.stringify(
      {
        mapperId: pipeline.mapperId,
        mapping: pipeline.mapping,
        labeledAt: pipeline.labeledAt,
        labelModel: pipeline.labelModel,
        cacheHit: pipeline.cacheHit,
        fieldsFromCache: pipeline.fieldsFromCache,
        fieldsLabeled: pipeline.fieldsLabeled,
        fingerprint: pipeline.fingerprint,
        discoveryMeta: pipeline.discoveryMeta,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
