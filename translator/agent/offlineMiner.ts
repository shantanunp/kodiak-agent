#!/usr/bin/env tsx
/**
 * Offline AI write-site miner — same prompt + candidate verification as online
 * (`translator/agentloop/aiWriteSiteMiner.ts`), without HTTP.
 *
 * Online `mineWriteSites()` calls the model with `AI_MINER_PROMPT` and parses
 * `{ "writes": [...] }`. Offline the editor agent fills that JSON by hand;
 * this script applies the identical citation check and emits
 * `ai-leg-candidates.json` for `reconcileOffline.ts`.
 *
 *   npx tsx translator/agent/offlineMiner.ts \
 *     --job .cache/agent-jobs/<mapper>/<fp>/job.json \
 *     --writes .cache/agent-jobs/<mapper>/<fp>/ai-leg-writes.json
 *
 * Does not modify online code — imports `AI_MINER_PROMPT` read-only.
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_MINER_PROMPT,
  type AiWriteCandidate,
} from "../agentloop/aiWriteSiteMiner.js";
import { verifyCitations } from "../judge/judge.js";
import type { AgentJob } from "./types.js";

export { AI_MINER_PROMPT };

/**
 * Parse the online miner response shape `{ writes: [...] }` into citation-verified
 * candidates. Mirrors `mineWriteSites()` post-generate logic (no HTTP).
 */
export function parseMinerWrites(
  raw: unknown,
  sourceJava: string,
  declaredFields: string[],
): { candidates: AiWriteCandidate[]; dropped: string[] } {
  let payload = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw.replace(/```json|```/g, "").trim());
    } catch {
      return { candidates: [], dropped: ["ai-miner returned invalid JSON — ignored"] };
    }
  }

  const writes = (payload as { writes?: unknown })?.writes;
  if (!Array.isArray(writes)) {
    return { candidates: [], dropped: ["ai-miner: missing writes[] — ignored"] };
  }

  const known = new Set(declaredFields.map((f) => f.toLowerCase()));
  const candidates: AiWriteCandidate[] = [];
  const dropped: string[] = [];

  for (const claim of writes) {
    const row = claim as { field?: unknown; line?: unknown; evidence?: unknown };
    const field = declaredFields.find(
      (f) => f.toLowerCase() === String(row.field ?? "").toLowerCase(),
    );
    if (!field || !known.has(field.toLowerCase())) {
      dropped.push(`ai-miner: claim for unknown field "${row.field}" — dropped`);
      continue;
    }
    const evidence = String(row.evidence ?? "");
    const ok =
      Number.isInteger(row.line) &&
      verifyCitations(`line ${row.line}: ${evidence}`, "", sourceJava);
    if (!ok) {
      dropped.push(`ai-miner: claim for "${field}" had no verifiable citation — dropped`);
      continue;
    }
    candidates.push({ field, line: row.line as number, evidence });
  }
  return { candidates, dropped };
}

export function declaredFieldsFromJob(job: AgentJob): string[] {
  return [
    ...job.fields.map((f) => f.javaTargetField),
    ...(job.audit?.unmappedFields ?? []),
  ];
}

const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const { values } = parseArgs({
    options: {
      job: { type: "string" },
      writes: { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.job || !values.writes) {
    console.error(
      "Usage: offlineMiner -- --job <job.json> --writes <ai-leg-writes.json> [--out <candidates.json>]",
    );
    process.exit(1);
  }

  const job = JSON.parse(readFileSync(values.job, "utf8")) as AgentJob;
  const raw = JSON.parse(readFileSync(values.writes, "utf8"));
  const declared = declaredFieldsFromJob(job);
  const { candidates, dropped } = parseMinerWrites(raw, job.sourceJava, declared);

  for (const d of dropped) console.error(`[ai-miner] ${d}`);
  console.error(`[ai-miner] ${candidates.length} citation-verified candidate(s)`);

  const outPath =
    values.out ?? join(dirname(values.job), "ai-leg-candidates.json");
  writeFileSync(outPath, JSON.stringify({ candidates }, null, 2));
  console.log(JSON.stringify({ candidates, dropped, outPath }, null, 2));
}
