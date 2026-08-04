#!/usr/bin/env tsx
/**
 * Export an offline labeling job for a VS Code custom agent (no model API).
 *
 *   npm run label:export -- --mapper lpa-request-mapper \
 *     --worktree /path/to/Kmismomapper \
 *     --fields MESSAGE.DEAL.PARTY.LastName
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
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

async function main(): Promise<void> {
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

  const resolved = await resolveMapperAst(values.mapper, values.registry!, {
    local: values.local,
    remote: values.remote || undefined,
    worktree: values.worktree,
    withAst: true,
  });
  const ast = resolved.ast as IndexAst;
  const sourceJava = resolved.sourceJava;
  const mapperId = ast.mapperId ?? values.mapper;

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
    console.error(
      selectors.length > 0
        ? `No field groups matched --fields ${selectors.join(",")}`
        : "No field groups found for mapper",
    );
    process.exit(1);
  }

  const schemaContext = schemaContextForLabeler(mapperId);
  const jobDir = agentJobDir(mapperId, fingerprint);
  const jobFile = agentJobFile(mapperId, fingerprint);
  const resultFile = agentResultFile(mapperId, fingerprint);

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
      '  { "javaTargetField": "...", "response": { "recognized": true, "targetField": "MESSAGE.…", "pipeline": [...], "reason": "…" } }',
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
    agentReadmeFile(mapperId, fingerprint),
    [
      `# Offline label job — ${mapperId}`,
      "",
      "1. Open `job.json` in this folder.",
      "2. Ask your VS Code / Cursor custom agent to complete labeling per `instructions`.",
      "3. Agent must write `result.json` in this same folder.",
      "4. Then run:",
      "",
      "```bash",
      `npm run label:import -- --mapper ${mapperId}` +
        (values.worktree ? ` --worktree ${values.worktree}` : "") +
        (selectors.length ? ` --fields ${selectors.join(",")}` : ""),
      "```",
      "",
      "5. Read from cache (no model API):",
      "",
      "```bash",
      `npm run label -- --mapper ${mapperId} --from-cache-only` +
        (values.worktree ? ` --worktree ${values.worktree}` : "") +
        (selectors.length ? ` --fields ${selectors.join(",")}` : ""),
      "```",
      "",
    ].join("\n"),
  );

  console.log(
    JSON.stringify(
      {
        exported: true,
        mapperId,
        fingerprint,
        fieldCount: job.fields.length,
        jobFile,
        resultFile,
        next: [
          "Have VS Code agent write result.json beside job.json",
          `npm run label:import -- --mapper ${mapperId}` +
            (selectors.length ? ` --fields ${selectors.join(",")}` : ""),
        ],
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
