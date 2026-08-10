/**
 * MON-1 — Run journal. Append-only local JSONL of every label path.
 * Override path with KODIAK_RUNS_FILE (tests use a temp file).
 * Gitignored by default; committing it is an ops choice for shared history.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { paths } from "../../src/config/env.js";

export interface RunJournalEntry {
  at: string;
  mapperId: string;
  sourceSha: string;
  language: string;
  declared: number;
  mapped: number;
  unmapped: number;
  unresolved: number;
  gatePassed: boolean;
  resultSource: {
    verified?: number;
    cache?: number;
    model?: number;
    mixed?: number;
  };
  modelCalls?: number;
  toolLoopCalls?: number;
  durationMs: number;
  promoted: boolean;
  checklistSource?: string;
  diagnostics?: number;
  /** MON-2 — token/latency block from HttpModelProvider.getMetrics(). */
  tokens?: {
    prompt: number;
    completion: number;
    retries: number;
    latencyMs: number;
    p95LatencyMs: number;
  };
  /** PAR-4 — write sites found per CST pattern kind. */
  writePatterns?: Record<string, number>;
  possibleMissedWrites?: number;
  /** PAR-2 — unmapped fields that still mention a setter/getter/name in source. */
  unmappedButMentioned?: number;
  /** Multi-instance: writes tainted onto all parent candidates. */
  multiInstanceUnattributed?: number;
  /** Prompt-injection posture hits in slices. */
  promptInjectionRisks?: number;
  /** Cross-check demotions (unmapped → unresolved). */
  crossCheckFlips?: number;
  groundingWarnings?: number;
  stepSmells?: number;
  /** Per-run provenance tag counts (slice / tool-loop / cache / …). */
  provenance?: Record<string, number>;
  /** EVAL-2 — rule-based labeling scorers (0..1). */
  scores?: {
    coverage: number;
    grounding: number;
    specificity: number;
    provenance: number;
  };
  /** AGT-3 — count of fields where double-run disagreed. */
  verifyDivergences?: number;
  /** AGT-4 — count of cited critic findings. */
  criticFindings?: number;
  /** Best-effort: "ok" | "error" — failed runs still append. */
  outcome: "ok" | "error";
  error?: string;
  path?: "cli-analyzer" | "cli-legacy" | "ui-label-field" | "import-job" | "agent-loop";
}

export function runsFile(): string {
  return process.env.KODIAK_RUNS_FILE ?? join(paths.root, "registry", "runs.jsonl");
}

export function sourceSha(sourceJava: string): string {
  return createHash("sha256").update(sourceJava).digest("hex").slice(0, 12);
}

export function appendRun(entry: RunJournalEntry): void {
  try {
    const file = runsFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Journal must never fail a label run.
    console.error(`[journal] append failed: ${(err as Error).message}`);
  }
}

export function readRuns(filter?: {
  mapperId?: string;
  since?: string;
}): RunJournalEntry[] {
  const file = runsFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunJournalEntry)
    .filter((e) => {
      if (filter?.mapperId && e.mapperId !== filter.mapperId) return false;
      if (filter?.since && e.at < filter.since) return false;
      return true;
    });
}

/** Drop journal lines for one mapper, or delete the whole file when omitted. */
export function clearRuns(mapperId?: string): number {
  const file = runsFile();
  if (!existsSync(file)) return 0;
  if (!mapperId) {
    const n = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
    unlinkSync(file);
    return n;
  }
  const kept: string[] = [];
  let removed = 0;
  for (const line of readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
    try {
      const e = JSON.parse(line) as RunJournalEntry;
      if (e.mapperId === mapperId) {
        removed += 1;
        continue;
      }
    } catch {
      /* keep unparseable lines */
    }
    kept.push(line);
  }
  if (kept.length === 0) unlinkSync(file);
  else writeFileSync(file, kept.join("\n") + "\n");
  return removed;
}
