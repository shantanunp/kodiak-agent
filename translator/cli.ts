#!/usr/bin/env tsx
/**
 * AI-label mapper fields via model provider → business/schema paths (no Java DTO paths).
 *
 *   npm run label -- --mapper lpa-request-mapper --worktree /path/to/Kmismomapper
 *   --fields MESSAGE.DEAL.PARTY.FirstName
 *   --no-cache | --clear-cache
 *   --with-ast          # opt-in JavaParser corroboration (off by default)
 *   --no-discover-ai    # AST-only escape hatch (requires --with-ast)
 *   --from-cache-only   # offline: read agent-seeded field cache (no MODEL_API_KEY)
 */

import { parseArgs } from "node:util";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/env.js";
import {
  StepLabeler,
  isModelConfigured,
  loadSchemaJson,
  type FieldMappingJson,
  type IndexAst,
} from "./model/index.js";
import { resolveMapperAst } from "./resolvePipeline.js";
import {
  filterMappingByFields,
  matchesTargetField,
  parseFieldSelectors,
} from "./filterByFields.js";
import {
  clearAllTranslatorCaches,
  computePipelineFingerprint,
  listFieldPipelineCaches,
  PIPELINE_CACHE_VERSION,
} from "./cache/index.js";
import { AGENT_OFFLINE_MODEL } from "./agent/types.js";

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
    /** AI discovery on by default (AI-primary). Kept for compatibility. */
    "discover-ai": { type: "boolean", default: true },
    /** Skip AI discovery; AST-only escape hatch (requires --with-ast). */
    "no-discover-ai": { type: "boolean", default: false },
    /** Opt-in JavaParser AST corroboration (off by default). */
    "with-ast": { type: "boolean", default: false },
    /** Read agent/offline field cache only — no MODEL_API_KEY required. */
    "from-cache-only": { type: "boolean", default: false },
  },
});

function fieldEntryMatchesSelectors(
  entry: { javaTargetField: string; mapping: { targetField: string } },
  selectors: string[],
): boolean {
  return (
    matchesTargetField(entry.mapping.targetField, selectors) ||
    matchesTargetField(entry.javaTargetField, selectors)
  );
}

async function labelFromAgentCache(
  ast: IndexAst,
  sourceJava: string,
  selectors: string[],
): Promise<void> {
  const mapperId = ast.mapperId ?? "unknown";
  const fingerprint = computePipelineFingerprint({
    sourceJava,
    schemaJson: loadSchemaJson(mapperId),
    model: AGENT_OFFLINE_MODEL,
    version: PIPELINE_CACHE_VERSION,
  });

  const cachedFields = listFieldPipelineCaches(mapperId, fingerprint);
  let mapping: FieldMappingJson[] = [];

  if (selectors.length > 0) {
    const missing = selectors.filter(
      (sel) => !cachedFields.some((e) => fieldEntryMatchesSelectors(e, [sel])),
    );
    if (missing.length > 0) {
      console.error(
        `Cache miss for fields: ${missing.join(", ")}. Run label:export → agent → label:import first.`,
      );
      process.exit(1);
    }
    const seen = new Set<string>();
    for (const e of cachedFields) {
      if (!fieldEntryMatchesSelectors(e, selectors)) continue;
      const m = e.mapping as FieldMappingJson;
      if (seen.has(m.targetField)) continue;
      seen.add(m.targetField);
      mapping.push(m);
    }
  } else {
    mapping = cachedFields.map((e) => e.mapping as FieldMappingJson);
    if (mapping.length === 0) {
      console.error(
        `No agent field cache for ${mapperId}. Run label:export → agent → label:import first.`,
      );
      process.exit(1);
    }
  }

  console.log(
    JSON.stringify(
      {
        mapperId,
        mapping,
        labeledAt: new Date().toISOString(),
        labelModel: AGENT_OFFLINE_MODEL,
        cacheHit: true,
        fieldsFromCache: mapping.length,
        fieldsLabeled: 0,
        fingerprint,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  if (values["clear-cache"]) {
    const cleared = clearAllTranslatorCaches(values.mapper);
    console.error(
      `Cleared caches (pipelines=${cleared.pipelines}, discovery=${cleared.discovery}, fields=${cleared.fields}, labels=${cleared.labels})` +
        (values.mapper ? ` for ${values.mapper}` : " (all)"),
    );
  }

  const fromCacheOnly = Boolean(values["from-cache-only"]);
  if (!fromCacheOnly && !isModelConfigured()) {
    console.error(
      "Set MODEL_API_KEY (or GEMINI_API_KEY) in .env, or use --from-cache-only after label:import.\n" +
        "Offline: npm run label:export → VS Code agent → npm run label:import → npm run label -- --from-cache-only",
    );
    process.exit(1);
  }

  let ast: IndexAst;
  let sourceJava = "";

  if (values.file) {
    const raw = JSON.parse(readFileSync(values.file, "utf8")) as { ast?: IndexAst } | IndexAst;
    ast = ("ast" in raw && raw.ast ? raw.ast : raw) as IndexAst;
  } else if (values.mapper) {
    const withAst = Boolean(values["with-ast"]);
    if (values["no-discover-ai"] && !withAst) {
      console.error("--no-discover-ai requires --with-ast (AST escape hatch).");
      process.exit(1);
    }
    const resolved = await resolveMapperAst(values.mapper, values.registry!, {
      local: values.local,
      remote: values.remote || undefined,
      worktree: values.worktree,
      withAst,
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

  if (fromCacheOnly) {
    await labelFromAgentCache(ast, sourceJava, selectors);
    return;
  }

  const labeler = new StepLabeler();
  const pipeline = await labeler.labelIndex(ast, {
    fieldSelectors: selectors,
    sourceJava,
    noCache: Boolean(values["no-cache"]),
    discoverAi: !values["no-discover-ai"] && values["discover-ai"] !== false,
    useAst: Boolean(values["with-ast"]),
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
