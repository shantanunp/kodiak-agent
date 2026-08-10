/**
 * Run metrics — append-only, local, deterministic to read.
 * .cache/metrics/{mapperId}.jsonl — one line per label run. Feeds `npm run report`
 * with the signals that otherwise only flash past on stderr: how often the
 * cross-check flips a field (scanner pattern-gap rate) and how often the tool
 * loop fires (slice quality).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { paths } from "../../src/config/env.js";

export interface RunMetrics {
  mapperId: string;
  at: string;
  declaredFields: number;
  labeled: number;
  fromCache: number;
  unresolved: number;
  crossCheckFlips: number;
  toolLoopRuns: number;
  toolLoopResolved: number;
}

function metricsDir(): string {
  return process.env.KODIAK_METRICS_DIR ?? join(paths.cacheDir, "metrics");
}

function metricsFile(mapperId: string): string {
  return join(metricsDir(), `${mapperId}.jsonl`);
}

/** Delete metrics jsonl for one mapper, or all metrics files when omitted. */
export function clearRunMetrics(mapperId?: string): number {
  const dir = metricsDir();
  if (!existsSync(dir)) return 0;
  const files = mapperId
    ? [metricsFile(mapperId)]
    : readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(dir, f));
  let n = 0;
  for (const file of files) {
    if (!existsSync(file)) continue;
    unlinkSync(file);
    n += 1;
  }
  return n;
}

export function appendRunMetrics(m: RunMetrics): void {
  const file = metricsFile(m.mapperId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(m) + "\n");
}

export function readRunMetrics(mapperId: string): RunMetrics[] {
  const file = metricsFile(mapperId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunMetrics);
}
