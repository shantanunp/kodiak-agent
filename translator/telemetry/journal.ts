/**
 * MON-1 — Run journal. Append-only local JSONL of every label path.
 * Override path with KODIAK_RUNS_FILE (tests use a temp file).
 * Gitignored by default; committing it is an ops choice for shared history.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
