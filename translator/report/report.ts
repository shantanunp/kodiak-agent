#!/usr/bin/env tsx
/**
 * Scorecard — `npm run report [-- --json] [--strict] [--worktree <path>]`
 *
 * Runs the DETERMINISTIC pipeline (no model calls) over every registry entry
 * and answers "is it safe to onboard / trust this mapper?" with numbers.
 * Shared assembler: `./scorecard.ts` (also used by GET /api/report).
 */

import { parseArgs } from "node:util";
import { paths } from "../../src/config/env.js";
import { loadRegistry } from "../../src/registry/loadRegistry.js";
import { summarizeJournal } from "../telemetry/journalReport.js";
import { checkDrift } from "../telemetry/drift.js";
import { scoreMapper, type MapperScore } from "./scorecard.js";

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    worktree: { type: "string" },
    registry: { type: "string", default: paths.registry },
    mapper: { type: "string" },
    since: { type: "string" },
  },
});

const registry = loadRegistry(values.registry!);
const targets = values.mapper
  ? registry.mappers.filter((m) => m.id === values.mapper)
  : registry.mappers;

const scores: MapperScore[] = [];
for (const m of targets) {
  const s = await scoreMapper(m.id, {
    registryPath: values.registry!,
    worktree: values.worktree,
  });
  // Strip internal task payload from CLI output.
  const { _tasks: _, ...pub } = s;
  scores.push(pub);
}

const journal = summarizeJournal({
  mapperId: values.mapper,
  since: values.since,
});
const correctedTotal = scores.reduce((a, s) => a + (s.store?.corrected ?? 0), 0);
const drift = await checkDrift({
  registryPath: values.registry!,
  worktree: values.worktree,
  mapperId: values.mapper,
});

if (values.json) {
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scores,
        journal: {
          ...journal,
          judge: {
            rejects: journal.judge.rejects,
            agrees: correctedTotal,
            agreeRate:
              journal.judge.rejects + correctedTotal > 0
                ? correctedTotal / (journal.judge.rejects + correctedTotal)
                : null,
          },
        },
        drift,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`\nKodiak scorecard — ${scores.length} mapper(s)\n`);
  for (const s of scores) {
    if (!s.ok) {
      console.log(`[!!] ${s.mapperId.padEnd(28)} ERROR: ${s.error}`);
      continue;
    }
    const c = s.coverage!;
    const flag = s.concerns.length === 0 ? "[OK]" : "[..]";
    console.log(
      `${flag} ${s.mapperId.padEnd(28)} fields=${String(c.declaredFields).padStart(3)} ` +
        `mapped=${String(c.mappedPct).padStart(3)}% unmapped=${c.unmapped} unresolved=${c.unresolved} ` +
        `src=${c.checklistSource} store=${s.store!.hasCurrentEntry ? "current" : "MISSING"}` +
        (s.store!.pendingReview ? ` pending=${s.store!.pendingReview}` : "") +
        (s.store!.corrected ? ` corrected=${s.store!.corrected}` : "") +
        (s.runs!.recorded
          ? ` | runs=${s.runs!.recorded} flips=${s.runs!.crossCheckFlips} toolloop=${s.runs!.toolLoopResolved}/${s.runs!.toolLoopRuns}`
          : "") +
        (s.golden ? ` | golden=${s.golden.matched}/${s.golden.total}` : ""),
    );
    for (const concern of s.concerns) console.log(`       - ${concern}`);
  }

  console.log(`\nJournal (${journal.runs} run(s)${values.since ? ` since ${values.since}` : ""})`);
  if (journal.runs === 0) {
    console.log("  (empty — label a mapper to start recording)");
  } else {
    const c = journal.cost;
    console.log(
      `  cost: modelCalls=${c.modelCalls} tokens=${c.promptTokens}+${c.completionTokens} ` +
        `resultSource verified=${c.verifiedHits} cache=${c.cacheHits} model=${c.modelLabels}`,
    );
    console.log(
      `  miss signals: possible-missed-write=${journal.possibleMissedWrites} ` +
        `unmapped-but-mentioned=${journal.unmappedButMentioned} ` +
        `multi-instance=${journal.multiInstanceUnattributed} ` +
        `prompt-injection=${journal.promptInjectionRisks} ` +
        `cross-check-flips=${journal.crossCheckFlips} ` +
        `grounding=${journal.groundingWarnings} step-smells=${journal.stepSmells}` +
        ` verify-diverge=${journal.verifyDivergences} critic=${journal.criticFindings}`,
    );
    if (journal.scores) {
      const s = journal.scores;
      console.log(
        `  scores: coverage=${s.coverage} grounding=${s.grounding} ` +
          `specificity=${s.specificity} provenance=${s.provenance}`,
      );
    }
    if (Object.keys(journal.provenance).length) {
      console.log(
        `  provenance: ${Object.entries(journal.provenance)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      );
    }
    if (Object.keys(journal.writePatterns).length) {
      console.log(
        `  write patterns: ${Object.entries(journal.writePatterns)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
      );
    }
    const denom = journal.judge.rejects + correctedTotal;
    console.log(
      `  judge: agrees(corrected)=${correctedTotal} rejects(defects)=${journal.judge.rejects}` +
        (denom ? ` agreeRate=${(correctedTotal / denom).toFixed(2)}` : ""),
    );
  }

  console.log(`\nDrift`);
  for (const d of drift) {
    const flag =
      d.status === "current" ? "[OK]" : d.status === "never-verified" ? "[..]" : "[!!]";
    console.log(
      `  ${flag} ${d.mapperId.padEnd(28)} ${d.status}` +
        (d.staleCorrections ? ` staleCorrections=${d.staleCorrections}` : ""),
    );
  }
  console.log("");
}

const failing = scores.filter((s) => !s.ok || s.concerns.length > 0);
if (values.strict && failing.length > 0) {
  console.error(`--strict: ${failing.length} mapper(s) with concerns`);
  process.exit(2);
}
