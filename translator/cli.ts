#!/usr/bin/env tsx
/**
 * AI-label mapper fields via model provider → business/schema paths (no Java DTO paths).
 *
 *   npm run label -- --mapper my-mapper --worktree /path/to/mapper-repo
 *   --fields Order.shipTo.postalCode
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
  type PipelineJson,
} from "./model/index.js";
import { resolveMapperAst } from "./resolvePipeline.js";
import { exportAgentJob } from "./agent/exportJob.js";
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
import { writePipelineView } from "./writePipelineView.js";

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

  const labeledAt = new Date().toISOString();
  const pipeline: PipelineJson = {
    ...ast,
    mapperId,
    mapping,
    labeledAt,
    labelModel: AGENT_OFFLINE_MODEL,
  };
  const { path: viewPath, view } = writePipelineView(pipeline);
  console.error(`Wrote pipeline view ${viewPath} (${view.steps.length} steps)`);

  console.log(
    JSON.stringify(
      {
        mapperId,
        mapping,
        labeledAt,
        labelModel: AGENT_OFFLINE_MODEL,
        cacheHit: true,
        fieldsFromCache: mapping.length,
        fieldsLabeled: 0,
        fingerprint,
        viewPath,
      },
      null,
      2,
    ),
  );
}

async function offlineAgentFallback(reason: string, selectors: string[]): Promise<never> {
  if (!values.mapper) {
    console.error(
      `${reason}\n` +
        "Set MODEL_API_KEY (or ANTHROPIC_API_KEY / COPILOT_TOKEN) in .env, or use --from-cache-only after label:import.\n" +
        "Offline: npm run label:export → VS Code agent → npm run label:import → npm run label -- --from-cache-only",
    );
    process.exit(1);
  }

  try {
    const exported = await exportAgentJob({
      mapper: values.mapper,
      worktree: values.worktree,
      local: values.local,
      remote: values.remote,
      registry: values.registry!,
      selectors,
    });
    const importCmd =
      `npm run label:import -- --mapper ${exported.mapperId}` +
      (values.worktree ? ` --worktree ${values.worktree}` : "") +
      (selectors.length ? ` --fields ${selectors.join(",")}` : "");
    const cacheCmd =
      `npm run label -- --mapper ${exported.mapperId} --from-cache-only` +
      (values.worktree ? ` --worktree ${values.worktree}` : "") +
      (selectors.length ? ` --fields ${selectors.join(",")}` : "");
    console.error(
      [
        reason,
        `Exported an offline agent job instead (${exported.fieldCount} field(s), no HTTP calls needed).`,
        "",
        "Run this agent with this input:",
        `  Job file: ${exported.jobFile}`,
        "",
        "1. Open that job.json in VS Code.",
        `2. Ask Copilot Chat (agent mode): "Complete the offline label job in ${exported.jobFile}"`,
        "   (.github/instructions/kodiak-agent-label.instructions.md auto-attaches and tells the agent exactly what to write).",
        `3. The agent writes ${exported.resultFile}`,
        "4. Then run:",
        `   ${importCmd}`,
        `   ${cacheCmd}`,
      ].join("\n"),
    );
  } catch (err) {
    console.error(
      `${reason}\n` +
        "Set MODEL_API_KEY (or ANTHROPIC_API_KEY / COPILOT_TOKEN) in .env, or use --from-cache-only after label:import.\n" +
        `Could not auto-export offline agent job: ${(err as Error).message}`,
    );
  }
  process.exit(1);
}

async function main(): Promise<void> {
  if (values["clear-cache"]) {
    const cleared = clearAllTranslatorCaches(values.mapper);
    console.error(
      `Cleared caches (pipelines=${cleared.pipelines}, discovery=${cleared.discovery}, fields=${cleared.fields}, labels=${cleared.labels})` +
        (values.mapper ? ` for ${values.mapper}` : " (all)"),
    );
  }

  const selectors = parseFieldSelectors({
    field: values.field,
    fields: values.fields,
  });

  const fromCacheOnly = Boolean(values["from-cache-only"]);
  if (!fromCacheOnly && !isModelConfigured()) {
    await offlineAgentFallback(
      "No model API configured (MODEL_API_KEY / ANTHROPIC_API_KEY / COPILOT_TOKEN not set).",
      selectors,
    );
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

  if (fromCacheOnly) {
    await labelFromAgentCache(ast, sourceJava, selectors);
    return;
  }

  const labeler = new StepLabeler();
  let pipeline: PipelineJson;
  try {
    pipeline = await labeler.labelIndex(ast, {
      fieldSelectors: selectors,
      sourceJava,
      noCache: Boolean(values["no-cache"]),
      discoverAi: !values["no-discover-ai"] && values["discover-ai"] !== false,
      useAst: Boolean(values["with-ast"]),
    });
  } catch (err) {
    await offlineAgentFallback(
      `Model API call failed (likely blocked network/proxy at your office): ${(err as Error).message}`,
      selectors,
    );
    return;
  }

  if (selectors.length > 0) {
    pipeline.mapping = filterMappingByFields(pipeline.mapping, selectors);
  }

  const { path: viewPath, view } = writePipelineView(pipeline);
  console.error(`Wrote pipeline view ${viewPath} (${view.steps.length} steps)`);

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
        viewPath,
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
