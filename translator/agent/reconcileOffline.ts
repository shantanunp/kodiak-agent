#!/usr/bin/env tsx
/**
 * Offline reconciliation — two-leg parity for the offline labeling agent.
 *
 * Online, `runAgentLoop` gets a second, independent write-site opinion via a
 * real HTTP call (`translator/agentloop/aiWriteSiteMiner.ts`) and reconciles
 * it against the CST scan with `analyzer/reconcile.ts`. Offline there is no
 * second HTTP call available, so the *same* agent produces the second
 * opinion itself (see `.github/agents/kodiak-label.agent.md` step 2b) — but
 * the reconciliation step doesn't need to be re-implemented: this script
 * calls the exact same `reconcile()` and `verifyCitations()` functions the
 * online path uses. Zero duplicated logic, zero risk to the online path —
 * this file is new and imported by nothing online.
 *
 * After reconcile, writes `label-plan.json` with online-matching demotion:
 * `aiOnly` fields become `demotedUnresolved` (labeler escalation), never
 * asserted mapped from the miner alone.
 *
 *   npx tsx translator/agent/reconcileOffline.ts \
 *     --job .cache/agent-jobs/<mapper>/<fp>/job.json \
 *     --candidates .cache/agent-jobs/<mapper>/<fp>/ai-leg-candidates.json
 *
 * candidates.json shape (either):
 *   { "candidates": [{ "field": "…", "line": 12, "evidence": "…" }, …] }
 *   { "writes": [{ "field": "…", "line": 12, "evidence": "…" }, …] }  // online miner shape
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcile, type AiWriteCandidateLike } from "../../analyzer/reconcile.js";
import { verifyCitations } from "../judge/judge.js";
import type { WriteSite } from "../../analyzer/types.js";
import type { AgentJob } from "./types.js";
import { declaredFieldsFromJob, parseMinerWrites } from "./offlineMiner.js";

export interface OfflineReconcileResult {
  /** Declared fields both legs found (CST slice wins — unchanged in result.json). */
  agreed: string[];
  /**
   * AI-leg-only candidates, citation-verified.
   * Online: demote CST `unmapped` → `unresolved` for the labeler — never assert mapped alone.
   * Offline: same — see `buildOfflineLabelPlan` / `demotedUnresolved`.
   */
  aiOnly: AiWriteCandidateLike[];
  /** CST-only finds — CST still wins, nothing for the AI leg to add here. */
  cstOnly: WriteSite[];
  /** AI-leg claims dropped for an unknown field or an unverifiable citation. */
  dropped: string[];
}

/** Online-matching label plan derived from reconcile buckets. */
export interface OfflineLabelPlan {
  /** Label from CST slice (`agreed` / `cstOnly` with a slice in the job). */
  fromSlice: string[];
  /** Already `auditState: unresolved` in the job — escalate from sourceJava. */
  unresolved: string[];
  /**
   * `aiOnly` demoted to unresolved (same as online loop). Label via systemPrompt
   * from sourceJava using the miner hint — do not stamp recognized=true from the
   * miner claim alone.
   */
  demotedUnresolved: Array<{
    field: string;
    line: number;
    evidence: string;
    note: string;
  }>;
  /** Hard unmapped, not demoted — no mapped entry (recognized=false only if asked). */
  unmapped: string[];
  dropped: string[];
}

/** WriteSlice.sliceText starts "// write site (line 28, in map, via setter)" — recover the line. */
function lineFromSlice(slice: string | undefined): number {
  const m = slice?.match(/write site \(line (\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Rebuild a WriteSite-shaped stand-in for each CST-found job field (job.json
 * only carries the rendered slice text, not the original WriteSite object —
 * reconcile() only needs `targetField` for bucket matching; the rest are
 * display-only placeholders).
 */
function cstSitesFromJob(job: AgentJob): WriteSite[] {
  return job.fields
    .filter((f) => f.slice)
    .map((f) => ({
      targetField: f.javaTargetField,
      via: "setter" as const,
      receiver: "",
      expression: "",
      inMethod: "",
      line: lineFromSlice(f.slice),
      statement: (f.slice ?? "").trim().split("\n").pop() ?? "",
    }));
}

/**
 * Verify the offline agent's own candidates the same way `aiWriteSiteMiner.ts`
 * verifies a model's — every claim must cite a real line in `sourceJava` or
 * it's dropped, never trusted on its own say-so.
 */
function verifyCandidates(
  rawCandidates: unknown,
  sourceJava: string,
  declaredFields: string[],
): { verified: AiWriteCandidateLike[]; dropped: string[] } {
  // Prefer online miner shape `{ writes: [...] }` when present.
  if (
    rawCandidates &&
    typeof rawCandidates === "object" &&
    Array.isArray((rawCandidates as { writes?: unknown }).writes)
  ) {
    const parsed = parseMinerWrites(rawCandidates, sourceJava, declaredFields);
    return { verified: parsed.candidates, dropped: parsed.dropped };
  }

  const list = Array.isArray((rawCandidates as { candidates?: unknown[] })?.candidates)
    ? (rawCandidates as { candidates: unknown[] }).candidates
    : [];

  const verified: AiWriteCandidateLike[] = [];
  const dropped: string[] = [];
  for (const raw of list) {
    const c = raw as { field?: unknown; line?: unknown; evidence?: unknown };
    const field = declaredFields.find(
      (f) => f.toLowerCase() === String(c.field ?? "").toLowerCase(),
    );
    if (!field) {
      dropped.push(`ai-leg: claim for unknown field "${c.field}" — dropped`);
      continue;
    }
    const evidence = String(c.evidence ?? "");
    const ok =
      Number.isInteger(c.line) &&
      verifyCitations(`line ${c.line}: ${evidence}`, "", sourceJava);
    if (!ok) {
      dropped.push(`ai-leg: claim for "${field}" had no verifiable citation — dropped`);
      continue;
    }
    verified.push({ field, line: c.line as number, evidence });
  }
  return { verified, dropped };
}

/**
 * Mirror online `runAgentLoop` post-reconcile routing: miner can only demote
 * unmapped → unresolved; labeler still owns recognized/pipeline.
 */
export function buildOfflineLabelPlan(
  job: AgentJob,
  reconcileResult: OfflineReconcileResult,
): OfflineLabelPlan {
  const demotedFields = new Set(
    reconcileResult.aiOnly.map((c) => c.field.toLowerCase()),
  );
  const fromSlice: string[] = [];
  const unresolved: string[] = [];

  for (const f of job.fields) {
    const key = f.javaTargetField.toLowerCase();
    if (demotedFields.has(key)) continue;
    if (f.slice && f.auditState !== "unresolved") {
      fromSlice.push(f.javaTargetField);
    } else if (f.auditState === "unresolved" || !f.slice) {
      unresolved.push(f.javaTargetField);
    } else {
      fromSlice.push(f.javaTargetField);
    }
  }

  const demotedUnresolved = reconcileResult.aiOnly.map((c) => ({
    field: c.field,
    line: c.line,
    evidence: c.evidence,
    note: `ai-miner: possible missed write at line ${c.line} — ${c.evidence}`,
  }));

  const unmapped = (job.audit?.unmappedFields ?? []).filter(
    (f) => !demotedFields.has(f.toLowerCase()),
  );

  return {
    fromSlice,
    unresolved,
    demotedUnresolved,
    unmapped,
    dropped: reconcileResult.dropped,
  };
}

/** Pure — testable without touching the filesystem. */
export function runOfflineReconcile(job: AgentJob, rawCandidates: unknown): OfflineReconcileResult {
  const declaredFields = declaredFieldsFromJob(job);
  const cstSites = cstSitesFromJob(job);
  const { verified, dropped } = verifyCandidates(rawCandidates, job.sourceJava, declaredFields);
  const { agreed, aiOnly, cstOnly } = reconcile(cstSites, verified, declaredFields);
  return { agreed, aiOnly, cstOnly, dropped };
}

const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const { values } = parseArgs({
    options: {
      job: { type: "string" },
      candidates: { type: "string" },
      writes: { type: "string" },
      out: { type: "string" },
    },
  });

  const candPath = values.candidates ?? values.writes;
  if (!values.job || !candPath) {
    console.error(
      "Usage: reconcileOffline -- --job <job.json> --candidates <ai-leg-candidates.json> [--out <path>]\n" +
        "   or: reconcileOffline -- --job <job.json> --writes <ai-leg-writes.json>",
    );
    process.exit(1);
  }

  const job = JSON.parse(readFileSync(values.job, "utf8")) as AgentJob;
  const rawCandidates = JSON.parse(readFileSync(candPath, "utf8"));
  const result = runOfflineReconcile(job, rawCandidates);
  const labelPlan = buildOfflineLabelPlan(job, result);

  for (const d of result.dropped) console.error(`[ai-leg] ${d}`);
  console.error(
    `[ai-leg] reconciled: ${result.agreed.length} agreed, ${result.aiOnly.length} ai-only, ` +
      `${result.cstOnly.length} cst-only`,
  );
  console.error(
    `[ai-leg] label-plan: ${labelPlan.fromSlice.length} fromSlice, ` +
      `${labelPlan.unresolved.length} unresolved, ` +
      `${labelPlan.demotedUnresolved.length} demotedUnresolved, ` +
      `${labelPlan.unmapped.length} unmapped`,
  );

  const dir = dirname(values.job);
  const outPath = values.out ?? join(dir, "reconciliation.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  const planPath = join(dir, "label-plan.json");
  writeFileSync(planPath, JSON.stringify(labelPlan, null, 2));
  console.log(JSON.stringify({ ...result, labelPlan, outPath, planPath }, null, 2));
}
