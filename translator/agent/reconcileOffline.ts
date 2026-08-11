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
 *   npx tsx translator/agent/reconcileOffline.ts \
 *     --job .cache/agent-jobs/<mapper>/<fp>/job.json \
 *     --candidates .cache/agent-jobs/<mapper>/<fp>/ai-leg-candidates.json
 *
 * candidates.json shape: { "candidates": [{ "field": "…", "line": 12, "evidence": "…" }, …] }
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcile, type AiWriteCandidateLike } from "../../analyzer/reconcile.js";
import { verifyCitations } from "../judge/judge.js";
import type { WriteSite } from "../../analyzer/types.js";
import type { AgentJob } from "./types.js";

export interface OfflineReconcileResult {
  /** Declared fields both legs found (CST slice wins — unchanged in result.json). */
  agreed: string[];
  /** AI-leg-only candidates, citation-verified — the offline agent may add these to result.json. */
  aiOnly: AiWriteCandidateLike[];
  /** CST-only finds — CST still wins, nothing for the AI leg to add here. */
  cstOnly: WriteSite[];
  /** AI-leg claims dropped for an unknown field or an unverifiable citation. */
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

/** Pure — testable without touching the filesystem. */
export function runOfflineReconcile(job: AgentJob, rawCandidates: unknown): OfflineReconcileResult {
  const declaredFields = [
    ...job.fields.map((f) => f.javaTargetField),
    ...(job.audit?.unmappedFields ?? []),
  ];
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
      out: { type: "string" },
    },
  });

  if (!values.job || !values.candidates) {
    console.error(
      "Usage: reconcileOffline -- --job <job.json> --candidates <ai-leg-candidates.json> [--out <path>]",
    );
    process.exit(1);
  }

  const job = JSON.parse(readFileSync(values.job, "utf8")) as AgentJob;
  const rawCandidates = JSON.parse(readFileSync(values.candidates, "utf8"));
  const result = runOfflineReconcile(job, rawCandidates);

  for (const d of result.dropped) console.error(`[ai-leg] ${d}`);
  console.error(
    `[ai-leg] reconciled: ${result.agreed.length} agreed, ${result.aiOnly.length} ai-only, ` +
      `${result.cstOnly.length} cst-only`,
  );

  const outPath = values.out ?? join(dirname(values.job), "reconciliation.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, outPath }, null, 2));
}
