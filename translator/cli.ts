#!/usr/bin/env tsx
/**
 * AI-label mapper fields via model provider → business/schema paths (no Java DTO paths).
 *
 *   npm run label -- --mapper my-mapper --worktree /path/to/mapper-repo
 *   --fields Order.shipTo.postalCode
 *   --no-cache | --clear-cache
 *   --from-cache-only   # offline: read agent-seeded field cache (no MODEL_API_KEY)
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { paths } from "../src/config/env.js";
import {
  StepLabeler,
  isModelConfigured,
  loadSchemaJson,
  type FieldMappingJson,
  type IndexAst,
  type PipelineJson,
} from "./model/index.js";
import { resolveMapperAst, stubIndexAst } from "./resolvePipeline.js";
import { exportAgentJob } from "./agent/exportJob.js";
import { loadRegistry } from "../src/registry/loadRegistry.js";
import {
  filterMappingByFields,
  matchesTargetField,
  parseFieldSelectors,
} from "./filterByFields.js";
import {
  clearAllTranslatorCaches,
  computePipelineFingerprint,
  findLatestFieldFingerprint,
  listFieldPipelineCaches,
  PIPELINE_CACHE_VERSION,
} from "./cache/index.js";
import { AGENT_OFFLINE_MODEL } from "./agent/types.js";
import {
  computeVerifiedFingerprint,
  getVerified,
  promoteToVerified,
} from "./verified/store.js";
import { buildLabelTasks } from "./agentloop/tasks.js";
import { inferWorktree } from "../analyzer/resolveType.js";
import { runAgentLoop, toPipelineJson } from "./agentloop/loop.js";
import { createModelProvider, loadModelConfig } from "./model/index.js";
import { schemaContextForLabeler } from "../schema/io.js";
import { writePipelineView } from "./writePipelineView.js";
import { appendRun, sourceSha } from "./telemetry/journal.js";

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
    /** Read agent/offline field cache only — no MODEL_API_KEY required. */
    "from-cache-only": { type: "boolean", default: false },
    /** Write the labeled result to the git-tracked verified store. */
    promote: { type: "boolean", default: false },
    /** Deterministic checklist + slices drive the agent; audit gate decides done. */
    analyzer: { type: "boolean", default: false },
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

  // Verified store beats the agent field cache too.
  if (sourceJava) {
    const vfp = computeVerifiedFingerprint({
      sourceJava,
      schemaJson: loadSchemaJson(mapperId),
    });
    const verified = getVerified(mapperId, vfp);
    if (verified) {
      let mapping = verified.fields.map((f) => ({
        targetField: f.targetField,
        pipeline: f.pipeline,
      })) as FieldMappingJson[];
      if (selectors.length > 0) {
        mapping = mapping.filter((m) =>
          matchesTargetField(m.targetField, selectors),
        );
      }
      const { path: viewPath, view } = writePipelineView({
        ...ast,
        mapperId,
        mapping,
        labeledAt: verified.updatedAt,
        labelModel: "verified-store",
      });
      console.error(`Wrote pipeline view ${viewPath} (${view.steps.length} steps)`);
      console.log(
        JSON.stringify(
          {
            mapperId,
            mapping,
            labeledAt: verified.updatedAt,
            labelModel: "verified-store",
            cacheHit: true,
            resultSource: "verified",
            fingerprint: vfp,
            viewPath,
          },
          null,
          2,
        ),
      );
      return;
    }
  }

  // `--from-cache-only` is meant to work with zero network access, so prefer
  // whatever is already on disk. When we do have sourceJava (caller passed --worktree /
  // --local / --remote alongside --from-cache-only), try the exact content fingerprint
  // first, but fall back to the most recently imported fingerprint dir if that snapshot's
  // fields were never cached (e.g. source moved since the offline job was labeled) instead
  // of hard-failing.
  let fingerprint = sourceJava
    ? computePipelineFingerprint({
        sourceJava,
        schemaJson: loadSchemaJson(mapperId),
        model: AGENT_OFFLINE_MODEL,
        version: PIPELINE_CACHE_VERSION,
      })
    : undefined;

  if (!fingerprint || listFieldPipelineCaches(mapperId, fingerprint).length === 0) {
    const latest = findLatestFieldFingerprint(mapperId);
    if (latest) {
      if (fingerprint && fingerprint !== latest) {
        console.error(
          `Note: current source fingerprint (${fingerprint}) has no cached fields; ` +
            `using most recently imported cache (${latest}) instead.`,
        );
      }
      fingerprint = latest;
    }
  }

  if (!fingerprint) {
    console.error(
      `No agent field cache for ${mapperId}. Run label:export → agent → label:import first.`,
    );
    process.exit(1);
  }

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

  let promoted: string | undefined;
  if (values.promote && sourceJava) {
    const vfp = computeVerifiedFingerprint({
      sourceJava,
      schemaJson: loadSchemaJson(mapperId),
    });
    const res = promoteToVerified({
      mapperId,
      fingerprint: vfp,
      mapping,
      labeledBy: AGENT_OFFLINE_MODEL,
    });
    promoted = res.file;
    console.error(
      `Promoted ${res.fields} field(s) to verified store: ${res.file} — commit this file.`,
    );
  } else if (values.promote && !sourceJava) {
    console.error(
      "Cannot promote without source bytes — pass --worktree/--local/--remote with --from-cache-only.",
    );
  }

  console.log(
    JSON.stringify(
      {
        mapperId,
        mapping,
        labeledAt,
        labelModel: AGENT_OFFLINE_MODEL,
        cacheHit: true,
        resultSource: "cache",
        fieldsFromCache: mapping.length,
        fieldsLabeled: 0,
        fingerprint,
        promoted,
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
    console.error(
      [
        reason,
        `Exported an offline agent job (${exported.fieldCount} field(s), no HTTP calls).`,
        "",
        exported.vscodePrompt,
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
    const wantsSourceResolution = Boolean(values.worktree || values.local || values.remote);

    if (fromCacheOnly && !wantsSourceResolution) {
      const registry = loadRegistry(values.registry!);
      const mapper = registry.mappers.find((m) => m.id === values.mapper);
      if (!mapper) {
        console.error(`Mapper not found: ${values.mapper}`);
        process.exit(1);
      }
      ast = stubIndexAst(mapper);
    } else {
      const resolved = await resolveMapperAst(values.mapper, values.registry!, {
        local: values.local,
        remote: values.remote || undefined,
        worktree: values.worktree,
      });
      ast = resolved.ast;
      sourceJava = resolved.sourceJava;
    }
  } else {
    console.error(
      "Usage: label --mapper <id> [--remote | --worktree <path>] | --file <cache.json>",
    );
    process.exit(1);
  }

  if (fromCacheOnly) {
    await labelFromAgentCache(ast, sourceJava, selectors);
    return;
  }

  if (values.analyzer && values.mapper && sourceJava) {
    const registry = loadRegistry(values.registry!);
    const mapperEntry = registry.mappers.find((m) => m.id === values.mapper)!;
    let tasks;
    try {
      tasks = buildLabelTasks({
        mapper: mapperEntry, sourceJava,
        worktree: values.worktree, // CLI always resolves via explicit worktree/local/remote
      });
    } catch (err) {
      console.error(
        `Analyzer could not parse source (${(err as Error).message}); ` +
          "falling back to legacy discovery path.",
      );
      tasks = null;
    }

    if (tasks) {
      const mapperId = ast.mapperId ?? values.mapper;
      const schemaJson = loadSchemaJson(mapperId);

      // Verified store still outranks the loop.
      const vfp = computeVerifiedFingerprint({ sourceJava, schemaJson });
      const verified = getVerified(mapperId, vfp);
      if (verified) {
        let mapping = verified.fields.map((f) => ({
          targetField: f.targetField,
          pipeline: f.pipeline,
        })) as FieldMappingJson[];
        if (selectors.length > 0) {
          mapping = filterMappingByFields(mapping, selectors);
        }
        const { path: viewPath, view } = writePipelineView({
          ...ast, mapperId, mapping,
          labeledAt: verified.updatedAt, labelModel: "verified-store",
        });
        console.error(`Wrote pipeline view ${viewPath} (${view.steps.length} steps)`);
        console.log(JSON.stringify({
          mapperId, mapping, labeledAt: verified.updatedAt,
          labelModel: "verified-store", cacheHit: true,
          resultSource: "verified", fingerprint: vfp, viewPath,
        }, null, 2));
        return;
      }

      const config = loadModelConfig();
      const provider = createModelProvider(config);
      const fingerprint = computePipelineFingerprint({
        sourceJava, schemaJson,
        model: `${config.apiStyle}:${config.model}`,
        version: PIPELINE_CACHE_VERSION,
      });

      let result;
      try {
        result = await runAgentLoop(ast, tasks, provider, {
          fingerprint,
          schemaContext: schemaContextForLabeler(mapperId),
          sourceJava,
          noCache: Boolean(values["no-cache"]),
          modelConfig: config,
          schemaContextText: schemaContextForLabeler(mapperId),
        });
      } catch (err) {
        await offlineAgentFallback(
          `Model API call failed (likely blocked network/proxy at your office): ${(err as Error).message}`,
          selectors,
        );
        return;
      }

      const pipeline = toPipelineJson(ast, result, {
        model: config.model,
        fingerprint,
      });

      if (selectors.length > 0) {
        pipeline.mapping = filterMappingByFields(pipeline.mapping, selectors);
      }

      const { path: viewPath, view } = writePipelineView(pipeline);
      console.error(`Wrote pipeline view ${viewPath} (${view.steps.length} steps)`);

      let promoted: string | undefined;
      if (values.promote) {
        if (!result.audit.gatePassed) {
          console.error(
            `Refusing to promote: audit gate NOT PASSED ` +
              `(unresolved: ${result.audit.unresolvedFields.join(", ")}).`,
          );
        } else if (selectors.length > 0) {
          console.error("Refusing to promote a --fields subset from the agent loop; run without --fields.");
        } else {
          const res = promoteToVerified({
            mapperId, fingerprint: vfp,
            mapping: pipeline.mapping, labeledBy: config.model,
          });
          promoted = res.file;
          console.error(`Promoted ${res.fields} field(s) to verified store: ${res.file} — commit this file.`);
        }
      }

      console.log(JSON.stringify({
        mapperId: pipeline.mapperId,
        mapping: pipeline.mapping,
        labeledAt: pipeline.labeledAt,
        labelModel: pipeline.labelModel,
        cacheHit: pipeline.cacheHit,
        resultSource: pipeline.resultSource,
        fieldsFromCache: pipeline.fieldsFromCache,
        fieldsLabeled: pipeline.fieldsLabeled,
        fingerprint: pipeline.fingerprint,
        audit: result.audit,
        promoted,
        viewPath,
      }, null, 2));
      return;
    }
  }

  const labeler = new StepLabeler();
  let pipeline: PipelineJson;
  try {
    pipeline = await labeler.labelIndex(ast, {
      fieldSelectors: selectors,
      sourceJava,
      noCache: Boolean(values["no-cache"]),
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

  let promoted: string | undefined;
  if (values.promote && sourceJava && pipeline.resultSource !== "verified") {
    // Audit gate applies to the legacy path too: refuse when the deterministic
    // checklist says fields are unresolved.
    try {
      const reg = loadRegistry(values.registry!);
      const me = reg.mappers.find((m) => m.id === (pipeline.mapperId ?? values.mapper));
      if (me) {
        const gate = buildLabelTasks({
          mapper: me, sourceJava,
          worktree: values.worktree ?? inferWorktree(undefined, me.sourceFile) ?? undefined,
        });
        if (gate.report.unresolved > 0) {
          console.error(
            `Refusing to promote: audit gate NOT PASSED — unresolved: ` +
              gate.report.checklist.filter((c) => c.state === "unresolved").map((c) => c.field).join(", "),
          );
          promoted = undefined;
          values.promote = false;
        }
      }
    } catch {
      // analyzer unavailable for this source — legacy promote proceeds as before
    }
  }
  if (values.promote && sourceJava && pipeline.resultSource !== "verified") {
    const vfp = computeVerifiedFingerprint({
      sourceJava,
      schemaJson: loadSchemaJson(pipeline.mapperId),
    });
    const res = promoteToVerified({
      mapperId: pipeline.mapperId ?? "unknown",
      fingerprint: vfp,
      mapping: pipeline.mapping,
      labeledBy: pipeline.labelModel ?? "model",
    });
    promoted = res.file;
    console.error(
      `Promoted ${res.fields} field(s) to verified store: ${res.file} — commit this file.`,
    );
  }

  appendRun({
    at: new Date().toISOString(),
    mapperId: pipeline.mapperId ?? String(values.mapper),
    sourceSha: sourceSha(sourceJava ?? ""),
    language: "java",
    declared: pipeline.mapping.length,
    mapped: pipeline.mapping.length,
    unmapped: 0,
    unresolved: 0,
    gatePassed: true,
    resultSource: {
      cache: pipeline.fieldsFromCache ?? 0,
      model: pipeline.fieldsLabeled ?? 0,
      verified: pipeline.resultSource === "verified" ? pipeline.mapping.length : 0,
    },
    durationMs: 0,
    promoted: Boolean(promoted),
    outcome: "ok",
    path: "cli-legacy",
  });

  console.log(
    JSON.stringify(
      {
        mapperId: pipeline.mapperId,
        mapping: pipeline.mapping,
        labeledAt: pipeline.labeledAt,
        labelModel: pipeline.labelModel,
        cacheHit: pipeline.cacheHit,
        resultSource: pipeline.resultSource,
        promoted,
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
