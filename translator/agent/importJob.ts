#!/usr/bin/env tsx
/**
 * Import VS Code agent result.json into field cache (no model API, no indexer).
 *
 *   npm run label:import -- --mapper my-mapper \
 *     --worktree /path/to/mapper-repo \
 *     --fields Order.shipTo.postalCode
 *
 *   npm run label:import -- --result .cache/agent-jobs/.../result.json
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/env.js";
import { resolveMapperAst } from "../resolvePipeline.js";
import {
  applyFieldMappingResponse,
  loadSchemaJson,
  normalizeFieldMappingResponse,
} from "../model/index.js";
import type { FieldMapping, PipelineOp } from "../groupMapping.js";
import { matchesTargetField, parseFieldSelectors } from "../filterByFields.js";
import {
  computePipelineFingerprint,
  PIPELINE_CACHE_VERSION,
  setFieldPipelineCache,
} from "../cache/index.js";
import { patchPipelineViewField } from "../writePipelineView.js";
import { loadRegistry } from "../../src/registry/loadRegistry.js";
import { AGENT_OFFLINE_MODEL, type AgentJob, type AgentResult } from "./types.js";
import { agentJobFile, agentJobsRoot, agentResultFile } from "./paths.js";
import { exportAgentJob } from "./exportJob.js";
import { appendRun, sourceSha } from "../telemetry/journal.js";

const { values } = parseArgs({
  options: {
    mapper: { type: "string", short: "m" },
    worktree: { type: "string" },
    local: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    registry: { type: "string", default: paths.registry },
    field: { type: "string", multiple: true },
    fields: { type: "string" },
    result: { type: "string" },
    strict: { type: "boolean", default: false },
  },
});

function findLatestResult(mapperId: string): string | null {
  const root = join(agentJobsRoot(), mapperId);
  if (!existsSync(root)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(root)) {
    const file = agentResultFile(mapperId, name);
    if (!existsSync(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { path: file, mtime };
  }
  return best?.path ?? null;
}

function loadResult(path: string): AgentResult {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object") throw new Error("result.json must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.mapperId !== "string" || typeof r.fingerprint !== "string") {
    throw new Error("result.json requires mapperId and fingerprint");
  }
  if (!Array.isArray(r.fields)) throw new Error("result.json.fields must be an array");

  return {
    mapperId: r.mapperId,
    fingerprint: r.fingerprint,
    labelModel: typeof r.labelModel === "string" ? r.labelModel : AGENT_OFFLINE_MODEL,
    fields: r.fields.map((f, i) => {
      if (!f || typeof f !== "object") throw new Error(`fields[${i}] invalid`);
      const row = f as Record<string, unknown>;
      if (typeof row.javaTargetField !== "string") {
        throw new Error(`fields[${i}].javaTargetField required`);
      }
      return {
        javaTargetField: row.javaTargetField,
        response: normalizeFieldMappingResponse(row.response),
      };
    }),
  };
}

function fieldMatchesSelectors(
  javaTarget: string,
  businessTarget: string | undefined,
  selectors: string[],
): boolean {
  if (selectors.length === 0) return true;
  if (matchesTargetField(javaTarget, selectors)) return true;
  if (businessTarget && matchesTargetField(businessTarget, selectors)) return true;
  return false;
}

function groupsFromJob(job: AgentJob | null, result: AgentResult): FieldMapping[] {
  if (job) {
    return job.fields.map((f) => ({
      targetField: f.javaTargetField,
      pipeline: (f.indexerOps ?? []) as PipelineOp[],
    }));
  }
  return result.fields.map((f) => ({
    targetField: f.javaTargetField,
    pipeline: [] as PipelineOp[],
  }));
}

async function main(): Promise<void> {
  let resultPath = values.result;
  let mapperId = values.mapper;

  const selectors = parseFieldSelectors({
    field: values.field,
    fields: values.fields,
  });

  if (!resultPath) {
    if (!mapperId) {
      console.error(
        "Usage: label:import -- --mapper <id> [--worktree <path>] [--fields ...] | --result <result.json>",
      );
      process.exit(1);
    }

    if (values.worktree || values.local || values.remote) {
      const resolved = await resolveMapperAst(mapperId, values.registry!, {
        local: values.local,
        remote: values.remote || undefined,
        worktree: values.worktree,
      });
      mapperId = resolved.ast.mapperId ?? mapperId;
      const fingerprint = computePipelineFingerprint({
        sourceJava: resolved.sourceJava,
        schemaJson: loadSchemaJson(mapperId),
        model: AGENT_OFFLINE_MODEL,
        version: PIPELINE_CACHE_VERSION,
      });
      const expected = agentResultFile(mapperId, fingerprint);
      if (existsSync(expected)) {
        resultPath = expected;
      }
    }

    if (!resultPath) {
      resultPath = findLatestResult(mapperId) ?? undefined;
    }
    if (!resultPath) {
      console.error(
        `No result.json found for ${mapperId}. Run label:export, complete the agent job, or pass --result <path>.`,
      );
      process.exit(1);
    }
  }

  const result = loadResult(resultPath);
  mapperId = result.mapperId;
  const fingerprint = result.fingerprint;

  const jobPath = agentJobFile(mapperId, fingerprint);
  let job: AgentJob | null = null;
  if (existsSync(jobPath)) {
    job = JSON.parse(readFileSync(jobPath, "utf8")) as AgentJob;
    if (job.fingerprint !== result.fingerprint) {
      console.error("job.json fingerprint does not match result.json");
      process.exit(1);
    }
  }

  const groups = groupsFromJob(job, result);
  const groupByJava = new Map(groups.map((g) => [g.targetField, g]));
  let imported = 0;
  const mappingOut: ReturnType<typeof applyFieldMappingResponse>[] = [];
  let mapperTypes: { sourceType?: string; targetType?: string } | undefined;
  try {
    const mapperEntry = loadRegistry(values.registry!).mappers.find((m) => m.id === mapperId);
    mapperTypes = {
      sourceType: mapperEntry?.sourceType,
      targetType: mapperEntry?.targetType,
    };
  } catch {
    mapperTypes = undefined;
  }

  for (const field of result.fields) {
    if (
      !fieldMatchesSelectors(
        field.javaTargetField,
        field.response.targetField,
        selectors,
      )
    ) {
      continue;
    }

    const entry = groupByJava.get(field.javaTargetField) ?? {
      targetField: field.javaTargetField,
      pipeline: [] as PipelineOp[],
    };

    if (values.strict) {
      if (
        !field.response.recognized ||
        !field.response.pipeline?.length ||
        !field.response.targetField
      ) {
        throw new Error(
          `strict: field ${field.javaTargetField} missing recognized pipeline/targetField`,
        );
      }
    }

    const jobField = job?.fields?.find(
      (f) => f.javaTargetField === field.javaTargetField,
    );
    const labeled = applyFieldMappingResponse(
      entry,
      field.response,
      "model",
      jobField?.slice,
    );
    const now = new Date().toISOString();
    setFieldPipelineCache({
      fingerprint,
      mapperId,
      javaTargetField: field.javaTargetField,
      mapping: labeled,
      labeledAt: now,
      labelModel: result.labelModel || AGENT_OFFLINE_MODEL,
      cachedAt: now,
    });
    // UI paints only from view.json — keep the dump in sync on import.
    try {
      patchPipelineViewField({
        mapperId,
        targetField: labeled.targetField,
        pipeline: labeled.pipeline,
        sourceType: mapperTypes?.sourceType,
        targetType: mapperTypes?.targetType,
      });
    } catch (err) {
      console.error(
        `warn: could not patch view.json for ${labeled.targetField}: ${(err as Error).message}`,
      );
    }
    mappingOut.push(labeled);
    imported++;
  }

  if (imported === 0) {
    console.error("No fields imported (check --fields filters or result.json).");
    process.exit(1);
  }

  // ── Gap detection: job checklist fields with no recognized result ─────────
  const recognizedFields = new Set(
    result.fields
      .filter((f) => f.response.recognized)
      .map((f) => f.javaTargetField.toLowerCase()),
  );
  const gaps = (job?.fields ?? [])
    .map((f) => f.javaTargetField)
    .filter((name) => !recognizedFields.has(name.toLowerCase()));

  if (gaps.length > 0 && job) {
    console.error(
      `\nGap: ${gaps.length} checklist field(s) still unaccounted: ${gaps.join(", ")}`,
    );
    if (values.worktree) {
      try {
        const gapJob = await exportAgentJob({
          mapper: mapperId,
          worktree: values.worktree,
          local: values.local,
          remote: values.remote,
          registry: values.registry!,
          selectors: gaps,
        });
        console.error(
          `Re-exported gap job (${gapJob.fieldCount} field(s)): ${gapJob.jobFile}\n` +
            `Ask the agent to complete it, then re-run label:import.`,
        );
      } catch (err) {
        console.error(`Could not auto-export gap job: ${(err as Error).message}`);
      }
    } else {
      console.error(
        `Re-export just the gaps with:\n` +
          `  npm run label:export -- --mapper ${mapperId} --worktree <path> --fields ${gaps.join(",")}`,
      );
    }
  }

  const fieldsArg = selectors.length ? ` --fields ${selectors.join(",")}` : "";
  const fromCacheCmd = `npm run label -- --mapper ${mapperId} --from-cache-only${fieldsArg}`;

  appendRun({
    at: new Date().toISOString(),
    mapperId,
    sourceSha: sourceSha(job?.sourceJava ?? fingerprint),
    language: "java",
    declared: job?.fields?.length ?? imported,
    mapped: imported,
    unmapped: 0,
    unresolved: gaps.length,
    gatePassed: gaps.length === 0,
    resultSource: { model: imported },
    durationMs: 0,
    promoted: false,
    checklistSource: job?.audit?.checklistSource,
    diagnostics: gaps.length,
    outcome: "ok",
    path: "import-job",
  });

  console.log(
    JSON.stringify(
      {
        imported: true,
        mapperId,
        fingerprint,
        resultFile: resultPath,
        fieldsImported: imported,
        mapping: mappingOut,
        next: fromCacheCmd,
        vscodeSteps: job?.vscodeSteps?.slice(2) ?? [fromCacheCmd, "npm run ui:serve"],
      },
      null,
      2,
    ),
  );

  console.error(
    [
      "",
      "── Next: run in VS Code terminal ──",
      "",
      fromCacheCmd,
      "",
      "npm run ui:serve",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
