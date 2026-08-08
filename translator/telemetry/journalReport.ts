/**
 * MON-3 helpers — aggregate runs.jsonl + defects.jsonl for `npm run report`.
 */

import { existsSync, readFileSync } from "node:fs";
import { defectsFile } from "../judge/judge.js";
import { readRuns, type RunJournalEntry } from "./journal.js";

export interface JournalSummary {
  runs: number;
  mappers: string[];
  coverageTrend: Array<{
    mapperId: string;
    at: string;
    declared: number;
    mapped: number;
    unresolved: number;
    gatePassed: boolean;
  }>;
  cost: {
    modelCalls: number;
    promptTokens: number;
    completionTokens: number;
    cacheHits: number;
    modelLabels: number;
    verifiedHits: number;
  };
  topUnresolved: Array<{ fieldKey: string; count: number }>;
  writePatterns: Record<string, number>;
  possibleMissedWrites: number;
  unmappedButMentioned: number;
  multiInstanceUnattributed: number;
  promptInjectionRisks: number;
  crossCheckFlips: number;
  groundingWarnings: number;
  stepSmells: number;
  /** Sum of provenance tag counts across runs. */
  provenance: Record<string, number>;
  /** EVAL-2 — mean of per-run scores (undefined dims omitted from average). */
  scores?: {
    coverage: number;
    grounding: number;
    specificity: number;
    provenance: number;
  };
  verifyDivergences: number;
  criticFindings: number;
  judge: {
    rejects: number; // defects.jsonl — user claim rejected (agent stood)
    /** Agree rate needs corrected-store counts from the caller (AGT-6). */
  };
}

export function readDefects(filter?: { mapperId?: string; since?: string }): Array<{
  at?: string;
  mapperId: string;
  field: string;
  defectId: string;
}> {
  const file = defectsFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at?: string; mapperId: string; field: string; defectId: string })
    .filter((d) => {
      if (filter?.mapperId && d.mapperId !== filter.mapperId) return false;
      if (filter?.since && d.at && d.at < filter.since) return false;
      return true;
    });
}

export function summarizeJournal(filter?: {
  mapperId?: string;
  since?: string;
}): JournalSummary {
  const runs = readRuns(filter);
  const unresolvedCounts = new Map<string, number>();
  const writePatterns: Record<string, number> = {};
  let modelCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheHits = 0;
  let modelLabels = 0;
  let verifiedHits = 0;
  let possibleMissedWrites = 0;
  let unmappedButMentioned = 0;
  let multiInstanceUnattributed = 0;
  let promptInjectionRisks = 0;
  let crossCheckFlips = 0;
  let groundingWarnings = 0;
  let stepSmells = 0;
  let verifyDivergences = 0;
  let criticFindings = 0;
  const provenance: Record<string, number> = {};
  const scoreSums = { coverage: 0, grounding: 0, specificity: 0, provenance: 0 };
  let scoreRuns = 0;

  for (const r of runs) {
    modelCalls += r.modelCalls ?? 0;
    promptTokens += r.tokens?.prompt ?? 0;
    completionTokens += r.tokens?.completion ?? 0;
    cacheHits += r.resultSource.cache ?? 0;
    modelLabels += r.resultSource.model ?? 0;
    verifiedHits += r.resultSource.verified ?? 0;
    possibleMissedWrites += r.possibleMissedWrites ?? 0;
    unmappedButMentioned += r.unmappedButMentioned ?? 0;
    multiInstanceUnattributed += r.multiInstanceUnattributed ?? 0;
    promptInjectionRisks += r.promptInjectionRisks ?? 0;
    crossCheckFlips += r.crossCheckFlips ?? 0;
    groundingWarnings += r.groundingWarnings ?? 0;
    stepSmells += r.stepSmells ?? 0;
    verifyDivergences += r.verifyDivergences ?? 0;
    criticFindings += r.criticFindings ?? 0;
    if (r.scores) {
      scoreRuns++;
      scoreSums.coverage += r.scores.coverage;
      scoreSums.grounding += r.scores.grounding;
      scoreSums.specificity += r.scores.specificity;
      scoreSums.provenance += r.scores.provenance;
    }
    if (r.writePatterns) {
      for (const [k, v] of Object.entries(r.writePatterns)) {
        writePatterns[k] = (writePatterns[k] ?? 0) + v;
      }
    }
    if (r.provenance) {
      for (const [k, v] of Object.entries(r.provenance)) {
        provenance[k] = (provenance[k] ?? 0) + v;
      }
    }
    // Approximate: count unresolved fields by run (field names not always stored).
    if (r.unresolved > 0) {
      const key = `${r.mapperId}:unresolved×${r.unresolved}`;
      unresolvedCounts.set(key, (unresolvedCounts.get(key) ?? 0) + 1);
    }
  }

  const defects = readDefects(filter);
  const coverageTrend = runs.map((r: RunJournalEntry) => ({
    mapperId: r.mapperId,
    at: r.at,
    declared: r.declared,
    mapped: r.mapped,
    unresolved: r.unresolved,
    gatePassed: r.gatePassed,
  }));

  return {
    runs: runs.length,
    mappers: [...new Set(runs.map((r) => r.mapperId))],
    coverageTrend,
    cost: {
      modelCalls,
      promptTokens,
      completionTokens,
      cacheHits,
      modelLabels,
      verifiedHits,
    },
    topUnresolved: [...unresolvedCounts.entries()]
      .map(([fieldKey, count]) => ({ fieldKey, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
    writePatterns,
    possibleMissedWrites,
    unmappedButMentioned,
    multiInstanceUnattributed,
    promptInjectionRisks,
    crossCheckFlips,
    groundingWarnings,
    stepSmells,
    provenance,
    scores:
      scoreRuns > 0
        ? {
            coverage: round4(scoreSums.coverage / scoreRuns),
            grounding: round4(scoreSums.grounding / scoreRuns),
            specificity: round4(scoreSums.specificity / scoreRuns),
            provenance: round4(scoreSums.provenance / scoreRuns),
          }
        : undefined,
    verifyDivergences,
    criticFindings,
    judge: { rejects: defects.length },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
