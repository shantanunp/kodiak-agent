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
import { loadRegistry } from "../../src/registry/loadRegistry.js";
import { resolveMapperAst } from "../resolvePipeline.js";
import { buildOfflineFieldGroups } from "./offlineFields.js";
import { buildLabelTasks } from "../agentloop/tasks.js";
import { inferWorktree } from "../../analyzer/resolveType.js";
import type { LabelTasks } from "../agentloop/tasks.js";
import {
  FIELD_MAPPING_PROMPT,
  loadSchemaJson,
  type IndexAst,
} from "../model/index.js";
import { schemaContextForLabeler, schemaTargetLeafPaths } from "../../schema/io.js";
import { parseFieldSelectors } from "../filterByFields.js";
import {
  computePipelineFingerprint,
  PIPELINE_CACHE_VERSION,
} from "../cache/index.js";
import { AGENT_OFFLINE_MODEL, type AgentJob, type AgentJobMapper } from "./types.js";
import {
  agentJobDir,
  agentJobFile,
  agentReadmeFile,
  agentResultFile,
} from "./paths.js";
import { formatOfflineVscodePrompt, offlineVscodeSteps } from "./vscodeSteps.js";

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
  vscodeSteps: string[];
  vscodePrompt: string;
}

/**
 * Build and write an offline agent job (job.json + README.md) for the given mapper/fields.
 * Reused by the `label:export` CLI and by `label`'s auto-fallback when no model API is configured.
 */
export async function exportAgentJob(
  opts: ExportAgentJobOptions,
): Promise<ExportAgentJobResult> {
  const { mapper, worktree, local, remote, registry, selectors } = opts;

  const registryDoc = loadRegistry(registry);
  const mapperEntry = registryDoc.mappers.find((m) => m.id === mapper);

  if (!mapperEntry) {
    throw new Error(`Mapper not found in registry: ${mapper}`);
  }

  const resolved = await resolveMapperAst(mapper, registry, {
    local,
    remote: remote || undefined,
    worktree,
  });
  const ast = resolved.ast as IndexAst;
  const sourceJava = resolved.sourceJava;
  const mapperId = ast.mapperId ?? mapper;

  if (!sourceJava.trim()) {
    throw new Error(
      "Offline export needs mapper Java source. Pass --worktree <path> to your mapper checkout.",
    );
  }

  const schemaJson = loadSchemaJson(mapperId);
  const fingerprint = computePipelineFingerprint({
    sourceJava,
    schemaJson,
    model: AGENT_OFFLINE_MODEL,
    version: PIPELINE_CACHE_VERSION,
  });

  // Analyzer pre-pass: checklist + slices for the offline agent. Falls back to
  // selector-only groups when the source cannot be parsed.
  let tasks: LabelTasks | null = null;
  try {
    tasks = buildLabelTasks({
      mapper: mapperEntry,
      sourceJava,
      worktree: worktree ?? inferWorktree(resolved.sourcePath, mapperEntry.sourceFile) ?? undefined,
    });
  } catch (err) {
    console.error(
      `Analyzer could not parse source (${(err as Error).message}); exporting selector-only job.`,
    );
  }

  let groups: Array<{
    targetField: string;
    pipeline: unknown[];
    slice?: string;
    auditState?: "mapped" | "unresolved";
    auditNote?: string;
  }>;

  if (tasks) {
    // Schema checklists keep "unresolved" (no write site) labelable; only skip hard unmapped.
    const wanted = tasks.tasks.filter((t) => t.state !== "unmapped");
    const filtered =
      selectors.length > 0
        ? wanted.filter((t) =>
            selectors.some((sel) =>
              t.field.toLowerCase().includes(sel.split(".").pop()!.toLowerCase()),
            ),
          )
        : wanted;
    groups = filtered.map((t) => ({
      targetField: t.field,
      pipeline: [],
      slice: t.state === "mapped" && t.sliceText ? t.sliceText : undefined,
      auditState: t.state as "mapped" | "unresolved",
      auditNote: t.note,
    }));
  } else {
    const schemaSelectors = schemaTargetLeafPaths(mapperId);
    const effective =
      selectors.length > 0 ? selectors : schemaSelectors;
    groups = buildOfflineFieldGroups({ selectors: effective });
  }

  if (groups.length === 0) {
    throw new Error(
      selectors.length > 0
        ? `No field groups matched --fields ${selectors.join(",")}`
        : "No field groups found for mapper. Save a schema in the pipeline viewer (Edit schema) or pass --fields.",
    );
  }

  const schemaContext = schemaContextForLabeler(mapperId);
  const jobDir = agentJobDir(mapperId, fingerprint);
  const jobFile = agentJobFile(mapperId, fingerprint);
  const resultFile = agentResultFile(mapperId, fingerprint);
  const readmeFile = agentReadmeFile(mapperId, fingerprint);

  const vscodeStepList = offlineVscodeSteps({
    mapperId,
    jobFile,
    resultFile,
    worktree,
    fields: selectors,
  });
  const vscodePrompt = formatOfflineVscodePrompt({
    mapperId,
    jobFile,
    resultFile,
    worktree,
    fields: selectors,
  });

  const mapperMeta: AgentJobMapper = {
    id: mapperEntry.id,
    sourceFile: mapperEntry.sourceFile,
    class: mapperEntry.class,
    entryMethod: mapperEntry.entryMethod,
    sourceType: mapperEntry.sourceType,
    targetType: mapperEntry.targetType,
    ...(mapperEntry.goldenTests ? { goldenTests: mapperEntry.goldenTests } : {}),
  };

  const job: AgentJob = {
    version: 1,
    mapperId,
    fingerprint,
    labelModel: AGENT_OFFLINE_MODEL,
    createdAt: new Date().toISOString(),
    sourceJava,
    schemaJson,
    mapper: mapperMeta,
    systemPrompt: FIELD_MAPPING_PROMPT,
    schemaContext,
    instructions: [
      "You are labeling Java mapper fields into business pipelines.",
      "Everything you need is in this job.json — do not open external files.",
      "",
      "- sourceJava: full mapper class source",
      "- schemaJson + schemaContext: allowed business field paths",
      "- mapper: registry metadata (class, entryMethod, sourceType, targetType)",
      "- fields[].businessFieldSelector: the field the user asked to label",
      "",
      "For EACH entry in fields[]:",
      "1. If the entry has a 'slice', it is self-contained (write statement + local",
      "   dataflow + every helper body + // control flow: headers) — label from the",
      "   slice; sourceJava is backup. Every control-flow header MUST become a filter",
      "   step (even for plain getter→setter under an if).",
      "2. If auditState is 'unresolved', the analyzer could not settle it (see auditNote,",
      "   usually an opaque call). Inspect sourceJava; if the field is genuinely never",
      "   written, return recognized=false with the reason.",
      "3. Apply systemPrompt + schemaContext to produce a FieldMappingResponse.",
      "",
      `Write the complete result to: ${resultFile}`,
      "Do not call external model HTTP APIs.",
      "",
      "result.json shape:",
      '{ "mapperId", "fingerprint", "labelModel": "agent:offline", "fields": [',
      '  { "javaTargetField": "<from job.fields[i].javaTargetField>",',
      '    "response": { "recognized": true, "targetField": "Order.…",',
      '      "pipeline": [{"kind":"read","sourceField":"…","summary":"…"},…], "reason": "…" } }',
      "] }",
      "",
      "Keep mapperId and fingerprint exactly as in this job.",
      "",
      "After writing result.json, print vscodeSteps from this job for the user",
      "(do not run npm yourself — the user runs them in the VS Code terminal).",
    ].join("\n"),
    vscodeSteps: vscodeStepList,
    audit: tasks
      ? {
          checklistSource: tasks.checklistSource,
          targetTypeFile: tasks.targetTypeFile,
          declaredFields: tasks.report.declaredFields,
          mapped: tasks.report.mapped,
          unmapped: tasks.report.unmapped,
          unresolved: tasks.report.unresolved,
          unmappedFields: tasks.report.checklist
            .filter((c) => c.state === "unmapped")
            .map((c) => c.field),
        }
      : undefined,
    fields: groups.map((g) => {
      const selector =
        selectors.find((s) =>
          g.targetField.toLowerCase().includes(s.split(".").pop()!.toLowerCase()),
        ) ?? g.targetField;
      const field: AgentJob["fields"][number] = {
        businessFieldSelector: selector,
        javaTargetField: g.targetField,
        slice: g.slice,
        auditState: g.auditState,
        auditNote: g.auditNote,
      };
      return field;
    }),
    paths: {
      jobDir,
      jobFile,
      resultFile,
    },
  };

  mkdirSync(jobDir, { recursive: true });
  writeFileSync(jobFile, JSON.stringify(job, null, 2));
  writeFileSync(readmeFile, [`# Offline label job — ${mapperId}`, "", vscodePrompt, ""].join("\n"));

  return {
    mapperId,
    fingerprint,
    fieldCount: job.fields.length,
    jobFile,
    resultFile,
    readmeFile,
    vscodeSteps: vscodeStepList,
    vscodePrompt,
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
          vscodeSteps: result.vscodeSteps,
        },
        null,
        2,
      ),
    );
    console.error("\n" + result.vscodePrompt + "\n");
  };

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
