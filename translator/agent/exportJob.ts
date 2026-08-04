#!/usr/bin/env tsx
/**
 * Export an offline labeling job for a VS Code custom agent (no model API).
 *
 *   npm run label:export -- --mapper my-mapper \
 *     --worktree /path/to/mapper-repo \
 *     --fields Order.shipTo.postalCode
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paths } from "../../src/config/env.js";
import { resolveMapperAst } from "../resolvePipeline.js";
import { groupAst, mergeAstOnlyEscapeHatch } from "../model/discoverMerge.js";
import {
  FIELD_MAPPING_PROMPT,
  loadSchemaJson,
  type IndexAst,
} from "../model/index.js";
import { schemaContextForLabeler } from "../../schema/io.js";
import { filterMappingByFields, parseFieldSelectors } from "../filterByFields.js";
import {
  computePipelineFingerprint,
  PIPELINE_CACHE_VERSION,
} from "../cache/index.js";
import { AGENT_OFFLINE_MODEL, type AgentJob } from "./types.js";
import {
  agentJobDir,
  agentJobFile,
  agentReadmeFile,
  agentResultFile,
} from "./paths.js";

export interface ExportAgentJobOptions {
  mapper: string;
  worktree?: string;
  local?: boolean;
  remote?: boolean;
  registry: string;
  selectors: string[];
}

export interface ExportAgentJobResult {
  mapperId: string;
  fingerprint: string;
  fieldCount: number;
  jobFile: string;
  resultFile: string;
  readmeFile: string;
}

/**
 * Build and write an offline agent job (job.json + README.md) for the given mapper/fields.
 * Reused by the `label:export` CLI and by `label`'s auto-fallback when no model API is configured.
 */
export async function exportAgentJob(
  opts: ExportAgentJobOptions,
): Promise<ExportAgentJobResult> {
  const { mapper, worktree, local, remote, registry, selectors } = opts;

  const resolved = await resolveMapperAst(mapper, registry, {
    local,
    remote: remote || undefined,
    worktree,
    withAst: true,
  });
  const ast = resolved.ast as IndexAst;
  const sourceJava = resolved.sourceJava;
  const mapperId = ast.mapperId ?? mapper;

  const schemaJson = loadSchemaJson(mapperId);
  const fingerprint = computePipelineFingerprint({
    sourceJava,
    schemaJson,
    model: AGENT_OFFLINE_MODEL,
    version: PIPELINE_CACHE_VERSION,
  });

  // Offline export has no model API — AST escape-hatch ops (confidence tagged) as indexer hints.
  let groups = mergeAstOnlyEscapeHatch(groupAst(ast)).groups;
  if (selectors.length > 0) {
    groups = filterMappingByFields(groups, selectors);
  }

  if (groups.length === 0) {
    throw new Error(
      selectors.length > 0
        ? `No field groups matched --fields ${selectors.join(",")}`
        : "No field groups found for mapper",
    );
  }

  const schemaContext = schemaContextForLabeler(mapperId);
  const jobDir = agentJobDir(mapperId, fingerprint);
  const jobFile = agentJobFile(mapperId, fingerprint);
  const resultFile = agentResultFile(mapperId, fingerprint);
  const readmeFile = agentReadmeFile(mapperId, fingerprint);

  const job: AgentJob = {
    version: 1,
    mapperId,
    fingerprint,
    labelModel: AGENT_OFFLINE_MODEL,
    createdAt: new Date().toISOString(),
    systemPrompt: FIELD_MAPPING_PROMPT,
    schemaContext,
    instructions: [
      "You are labeling Java mapper fields into business pipelines.",
      "Read this job.json. For EACH entry in fields[], apply systemPrompt + schemaContext",
      "to indexerOps and produce a FieldMappingResponse object.",
      `Write the complete result to: ${resultFile}`,
      "Do not call external model APIs. Output JSON only in result.json.",
      "result.json shape:",
      '{ "mapperId", "fingerprint", "labelModel": "agent:offline", "fields": [',
      '  { "javaTargetField": "...", "response": { "recognized": true, "targetField": "Order.…", "pipeline": [{"kind":"read","sourceField":"…","summary":"…"},…], "reason": "…" } }',
      "] }",
      "Keep mapperId and fingerprint exactly as in this job.",
    ].join("\n"),
    fields: groups.map((g) => ({
      javaTargetField: g.targetField,
      indexerOps: g.pipeline,
      fieldSelector:
        selectors.find((s) =>
          g.targetField.toLowerCase().includes(s.split(".").pop()!.toLowerCase()),
        ) ?? selectors[0],
    })),
    paths: {
      jobDir,
      jobFile,
      resultFile,
    },
  };

  mkdirSync(jobDir, { recursive: true });
  writeFileSync(jobFile, JSON.stringify(job, null, 2));
  writeFileSync(
    readmeFile,
    [
      `# Offline label job — ${mapperId}`,
      "",
      "1. Open `job.json` in this folder.",
      "2. Ask your VS Code / Cursor agent to complete labeling per `instructions`.",
      "   The agent writes `result.json` in this same folder, then runs `label:import`",
      "   and `label --from-cache-only` itself — no manual follow-up commands needed.",
      "",
    ].join("\n"),
  );

  return {
    mapperId,
    fingerprint,
    fieldCount: job.fields.length,
    jobFile,
    resultFile,
    readmeFile,
  };
}

// Only parse argv / run the CLI when this file is executed directly (e.g. `tsx
// translator/agent/exportJob.ts`). `exportAgentJob` is also imported by
// translator/cli.ts, and top-level argv parsing would otherwise run twice and
// crash on cli.ts's own flags (e.g. --no-cache).
const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const { values } = parseArgs({
    options: {
      mapper: { type: "string", short: "m" },
      worktree: { type: "string" },
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      registry: { type: "string", default: paths.registry },
      field: { type: "string", multiple: true },
      fields: { type: "string" },
    },
  });

  const main = async (): Promise<void> => {
    if (!values.mapper) {
      console.error(
        "Usage: label:export -- --mapper <id> --worktree <path> [--fields PATH,...]",
      );
      process.exit(1);
    }

    const selectors = parseFieldSelectors({
      field: values.field,
      fields: values.fields,
    });

    const result = await exportAgentJob({
      mapper: values.mapper,
      worktree: values.worktree,
      local: values.local,
      remote: values.remote,
      registry: values.registry!,
      selectors,
    });

    console.log(
      JSON.stringify(
        {
          exported: true,
          mapperId: result.mapperId,
          fingerprint: result.fingerprint,
          fieldCount: result.fieldCount,
          jobFile: result.jobFile,
          resultFile: result.resultFile,
          next: [
            "Have VS Code agent complete the offline label job — it writes result.json and",
            "runs label:import + label --from-cache-only itself, no manual commands needed.",
          ],
        },
        null,
        2,
      ),
    );
  };

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
