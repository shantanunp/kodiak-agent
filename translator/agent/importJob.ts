#!/usr/bin/env tsx
/**
 * Import VS Code agent result.json into field cache (no model API).
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
import { groupAst } from "../model/discoverMerge.js";
import {
  applyFieldMappingResponse,
  loadSchemaJson,
  normalizeFieldMappingResponse,
  type IndexAst,
} from "../model/index.js";
import type { FieldMapping, PipelineOp } from "../groupMapping.js";
import { matchesTargetField, parseFieldSelectors } from "../filterByFields.js";
import {
  computePipelineFingerprint,
  PIPELINE_CACHE_VERSION,
  setFieldPipelineCache,
} from "../cache/index.js";
import { AGENT_OFFLINE_MODEL, type AgentJob, type AgentResult } from "./types.js";
import { agentJobFile, agentJobsRoot, agentResultFile } from "./paths.js";

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

async function main(): Promise<void> {
  let resultPath = values.result;
  let mapperId = values.mapper;
  let fingerprint: string | undefined;
  let ast: IndexAst | undefined;

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

    const resolved = await resolveMapperAst(mapperId, values.registry!, {
      local: values.local,
      remote: values.remote || undefined,
      worktree: values.worktree,
    });
    ast = resolved.ast as IndexAst;
    mapperId = ast.mapperId ?? mapperId;
    fingerprint = computePipelineFingerprint({
      sourceJava: resolved.sourceJava,
      schemaJson: loadSchemaJson(mapperId),
      model: AGENT_OFFLINE_MODEL,
      version: PIPELINE_CACHE_VERSION,
    });

    const expected = agentResultFile(mapperId, fingerprint);
    if (existsSync(expected)) {
      resultPath = expected;
    } else {
      resultPath = findLatestResult(mapperId) ?? undefined;
    }
    if (!resultPath) {
      console.error(
        `No result.json found. Expected ${expected} (or any under .cache/agent-jobs/${mapperId}/).`,
      );
      process.exit(1);
    }
  }

  const result = loadResult(resultPath);
  mapperId = result.mapperId;
  fingerprint = result.fingerprint;

  const jobPath = agentJobFile(mapperId, fingerprint);
  let job: AgentJob | null = null;
  if (existsSync(jobPath)) {
    job = JSON.parse(readFileSync(jobPath, "utf8")) as AgentJob;
    if (job.fingerprint !== result.fingerprint) {
      console.error("job.json fingerprint does not match result.json");
      process.exit(1);
    }
  }

  if (!ast && (values.worktree || values.local || values.remote)) {
    const resolved = await resolveMapperAst(mapperId, values.registry!, {
      local: values.local,
      remote: values.remote || undefined,
      worktree: values.worktree,
    });
    ast = resolved.ast as IndexAst;
  }

  const groups: FieldMapping[] = ast
    ? groupAst(ast)
    : (job?.fields.map((f) => ({
        targetField: f.javaTargetField,
        pipeline: (f.indexerOps ?? []) as PipelineOp[],
      })) ?? []);

  const groupByJava = new Map(groups.map((g) => [g.targetField, g]));
  let imported = 0;
  const mappingOut: ReturnType<typeof applyFieldMappingResponse>[] = [];

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

    const labeled = applyFieldMappingResponse(entry, field.response, "model");
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
    mappingOut.push(labeled);
    imported++;
  }

  if (imported === 0) {
    console.error("No fields imported (check --fields filters or result.json).");
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        imported: true,
        mapperId,
        fingerprint,
        resultFile: resultPath,
        fieldsImported: imported,
        mapping: mappingOut,
        next:
          `npm run label -- --mapper ${mapperId} --from-cache-only` +
          (selectors.length ? ` --fields ${selectors.join(",")}` : "") +
          (values.worktree ? ` --worktree ${values.worktree}` : ""),
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
