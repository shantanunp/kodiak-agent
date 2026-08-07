#!/usr/bin/env tsx
/**
 * Offline steering — the judge as an exportable editor-agent job.
 *
 *   npm run judge:export -- --mapper <id> --field <path> --claim "…" [--worktree <path>]
 *   npm run judge:import -- --result <judge-result.json>
 *
 * Export bundles the field's slice, the current pipeline (verified/cache if
 * any), the user's claim, and the judge prompt into a self-contained job.
 * A coding agent (agent mode) fills judge-result.json; import applies the
 * verdict with the SAME mechanics as online: citations mechanically checked,
 * agree -> verified store, disagree -> mock defect + registry/defects.jsonl.
 * No model HTTP calls anywhere in this flow.
 */

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../../src/config/env.js";
import { loadRegistry } from "../../src/registry/loadRegistry.js";
import { resolveMapperAst } from "../resolvePipeline.js";
import { buildLabelTasks } from "../agentloop/tasks.js";
import { loadSchemaJson } from "../model/index.js";
import { schemaContextForLabeler } from "../../schema/io.js";
import { computeVerifiedFingerprint, getVerified } from "../verified/store.js";
import { agentJobDir } from "../agent/paths.js";
import { inferWorktree } from "../../analyzer/resolveType.js";
import { JUDGE_PROMPT, applyJudgeVerdict, type RawVerdictInput } from "./judge.js";

export interface JudgeJob {
  version: 1;
  kind: "judge";
  mapperId: string;
  /** Content fingerprint (source + schema) the correction will be keyed to. */
  fingerprint: string;
  field: string;
  userClaim: string;
  sliceText: string;
  sourceJava: string;
  currentPipeline: unknown[];
  schemaContext?: string;
  systemPrompt: string;
  instructions: string;
  paths: { jobFile: string; resultFile: string };
}

function fieldKey(field: string): string {
  return field.replace(/[^a-zA-Z0-9]/g, "_");
}

export async function exportJudgeJob(options: {
  mapper: string;
  field: string;
  claim: string;
  worktree?: string;
  registry?: string;
}): Promise<{ jobFile: string; resultFile: string; steps: string[] }> {
  const registryPath = options.registry ?? paths.registry;
  const registry = loadRegistry(registryPath);
  const mapperEntry = registry.mappers.find((m) => m.id === options.mapper);
  if (!mapperEntry) throw new Error(`Mapper not found: ${options.mapper}`);

  const resolved = await resolveMapperAst(options.mapper, registryPath, {
    worktree: options.worktree,
  });
  if (!resolved.sourceJava.trim()) {
    throw new Error("Judge export needs mapper source. Pass --worktree <path>.");
  }

  const tasks = buildLabelTasks({
    mapper: mapperEntry,
    sourceJava: resolved.sourceJava,
    worktree:
      options.worktree ??
      inferWorktree(resolved.sourcePath, mapperEntry.sourceFile) ??
      undefined,
  });
  const leaf = options.field.split(".").pop()!.toLowerCase();
  const task = tasks.tasks.find(
    (t) =>
      t.field.toLowerCase() === options.field.toLowerCase() ||
      t.field.split(".").pop()!.toLowerCase() === leaf,
  );
  if (!task) throw new Error(`Field not on checklist: ${options.field}`);

  const schemaJson = loadSchemaJson(options.mapper);
  const fingerprint = computeVerifiedFingerprint({
    sourceJava: resolved.sourceJava,
    schemaJson,
  });
  const verified = getVerified(options.mapper, fingerprint);
  const currentPipeline =
    verified?.fields.find(
      (f) => f.targetField.split(".").pop()!.toLowerCase() === leaf,
    )?.pipeline ?? [];

  const dir = agentJobDir(options.mapper, fingerprint);
  const jobFile = join(dir, `judge-${fieldKey(task.field)}.json`);
  const resultFile = join(dir, `judge-${fieldKey(task.field)}.result.json`);

  const job: JudgeJob = {
    version: 1,
    kind: "judge",
    mapperId: options.mapper,
    fingerprint,
    field: task.field,
    userClaim: options.claim,
    sliceText: task.sliceText,
    sourceJava: resolved.sourceJava,
    currentPipeline,
    schemaContext: schemaContextForLabeler(options.mapper),
    systemPrompt: JUDGE_PROMPT,
    instructions: [
      "You are the verification judge for ONE field. Everything you need is in this file.",
      "Apply systemPrompt to: field, sliceText (primary evidence), sourceJava (backup),",
      "currentPipeline, and userClaim. Decide strictly from the code.",
      "Cite line numbers or quote exact code fragments — citations are checked mechanically.",
      "",
      `Write JSON to: ${resultFile}`,
      'Shape: {"mapperId","fingerprint","field","verdict":{"agree":true|false,"evidence":"…","reason":"…","pipeline":[…] }}',
      "Keep mapperId, fingerprint, and field exactly as in this job.",
      "Do not call any external model HTTP API. Do not run npm commands; print them.",
      "",
      `After writing, tell the user to run: npm run judge:import -- --result ${resultFile}`,
    ].join("\n"),
    paths: { jobFile, resultFile },
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(jobFile, JSON.stringify(job, null, 2));

  const steps = [
    `Open in VS Code: ${jobFile}`,
    `Copilot Chat (agent mode): Complete the judge job in ${jobFile}`,
    `npm run judge:import -- --result ${resultFile}`,
  ];
  return { jobFile, resultFile, steps };
}

export function importJudgeResult(resultPath: string): ReturnType<typeof applyJudgeVerdict> {
  const raw = JSON.parse(readFileSync(resultPath, "utf8")) as {
    mapperId?: string;
    fingerprint?: string;
    field?: string;
    verdict?: RawVerdictInput;
  };
  if (!raw.mapperId || !raw.fingerprint || !raw.field || !raw.verdict) {
    throw new Error("judge result requires mapperId, fingerprint, field, verdict");
  }
  const jobFile = join(
    agentJobDir(raw.mapperId, raw.fingerprint),
    `judge-${fieldKey(raw.field)}.json`,
  );
  if (!existsSync(jobFile)) {
    throw new Error(`Original judge job not found: ${jobFile} (result must match its job)`);
  }
  const job = JSON.parse(readFileSync(jobFile, "utf8")) as JudgeJob;
  if (job.fingerprint !== raw.fingerprint) {
    throw new Error("judge job fingerprint does not match result");
  }

  // Slice + source come from the JOB (trusted export), never from the result.
  return applyJudgeVerdict({
    mapperId: job.mapperId,
    fingerprint: job.fingerprint,
    field: job.field,
    sliceText: job.sliceText,
    sourceJava: job.sourceJava,
    userClaim: job.userClaim,
    raw: raw.verdict,
  });
}

const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const { values, positionals } = parseArgs({
    options: {
      mapper: { type: "string", short: "m" },
      field: { type: "string" },
      claim: { type: "string" },
      worktree: { type: "string" },
      registry: { type: "string", default: paths.registry },
      result: { type: "string" },
    },
    allowPositionals: true,
  });
  void positionals;

  const main = async (): Promise<void> => {
    if (values.result) {
      const outcome = importJudgeResult(values.result);
      console.log(JSON.stringify(outcome, null, 2));
      if (outcome.outcome === "corrected") {
        console.error(
          "\nCorrection saved to the verified store (registry/verified/) — commit it.",
        );
      } else if (outcome.outcome === "rejected") {
        console.error(`\nDefect ${outcome.defectId} created (mock) — see registry/defects.jsonl`);
      } else {
        console.error("\nJudge agreed but cited no checkable evidence — nothing was saved.");
      }
      return;
    }

    if (!values.mapper || !values.field || !values.claim) {
      console.error(
        'Usage:\n  judge:export -- --mapper <id> --field <path> --claim "…" [--worktree <path>]\n' +
          "  judge:import -- --result <judge-result.json>",
      );
      process.exit(1);
    }
    const exported = await exportJudgeJob({
      mapper: values.mapper,
      field: values.field,
      claim: values.claim,
      worktree: values.worktree,
      registry: values.registry,
    });
    console.log(JSON.stringify(exported, null, 2));
    console.error("\n── Offline judge ──\n" + exported.steps.join("\n") + "\n");
  };

  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
