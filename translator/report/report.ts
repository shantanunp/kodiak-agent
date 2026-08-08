#!/usr/bin/env tsx
/**
 * Scorecard — `npm run report [-- --json] [--strict] [--worktree <path>]`
 *
 * Runs the DETERMINISTIC pipeline (no model calls) over every registry entry
 * and answers "is it safe to onboard / trust this mapper?" with numbers:
 *
 *   coverage    declared fields, % mapped / unmapped / unresolved, checklist source
 *   store       verified entry for current source? fields, corrections, stale entries
 *   run signals cross-check flip rate, tool-loop fire rate (from recorded runs)
 *   accuracy    verified store vs golden dataset, when a golden file exists
 *
 * --strict exits non-zero when any mapper has unresolved fields, a write-sites-only
 * checklist, or golden mismatches — CI-ready.
 */

import { parseArgs } from "node:util";
import { paths } from "../../src/config/env.js";
import { loadRegistry } from "../../src/registry/loadRegistry.js";
import { resolveMapperAst } from "../resolvePipeline.js";
import { buildLabelTasks } from "../agentloop/tasks.js";
import { inferWorktree } from "../../analyzer/resolveType.js";
import { loadSchemaJson } from "../model/index.js";
import {
  computeVerifiedFingerprint,
  getVerified,
  listStaleFingerprints,
} from "../verified/store.js";
import { readRunMetrics } from "./metrics.js";
import { compareToGolden, loadGolden } from "./golden.js";

const { values } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    worktree: { type: "string" },
    registry: { type: "string", default: paths.registry },
    mapper: { type: "string" },
  },
});

interface MapperScore {
  mapperId: string;
  ok: boolean;
  error?: string;
  coverage?: {
    declaredFields: number;
    mapped: number;
    unmapped: number;
    unresolved: number;
    mappedPct: number;
    checklistSource: string;
    diagnostics: number;
  };
  store?: {
    hasCurrentEntry: boolean;
    fields: number;
    corrected: number;
    staleEntries: number;
  };
  runs?: {
    recorded: number;
    crossCheckFlips: number;
    toolLoopRuns: number;
    toolLoopResolved: number;
  };
  golden?: {
    total: number;
    matched: number;
    mismatched: number;
    missing: number;
  };
  concerns: string[];
}

async function scoreMapper(mapperId: string): Promise<MapperScore> {
  const registry = loadRegistry(values.registry!);
  const mapper = registry.mappers.find((m) => m.id === mapperId)!;
  const concerns: string[] = [];

  try {
    const resolved = await resolveMapperAst(mapperId, values.registry!, {
      worktree: values.worktree,
      remote: false,
    });
    if (!resolved.sourceJava.trim()) {
      return { mapperId, ok: false, error: "source not resolvable (pass --worktree)", concerns: [] };
    }
    const worktree =
      values.worktree ?? inferWorktree(resolved.sourcePath, mapper.sourceFile) ?? undefined;

    const tasks = buildLabelTasks({ mapper, sourceJava: resolved.sourceJava, worktree });
    const r = tasks.report;
    const coverage = {
      declaredFields: r.declaredFields,
      mapped: r.mapped,
      unmapped: r.unmapped,
      unresolved: r.unresolved,
      mappedPct: r.declaredFields ? Math.round((r.mapped / r.declaredFields) * 100) : 0,
      checklistSource: tasks.checklistSource,
      diagnostics: tasks.diagnostics.length,
    };
    if (r.unresolved > 0) concerns.push(`${r.unresolved} unresolved field(s)`);
    if (tasks.checklistSource === "write-sites") {
      concerns.push("checklist from write sites only — unmapped fields undetectable");
    }

    const fingerprint = computeVerifiedFingerprint({
      sourceJava: resolved.sourceJava,
      schemaJson: loadSchemaJson(mapperId),
    });
    const entry = getVerified(mapperId, fingerprint);
    const store = {
      hasCurrentEntry: Boolean(entry),
      fields: entry?.fields.length ?? 0,
      corrected: entry?.fields.filter((f) => f.status === "user-corrected").length ?? 0,
      staleEntries: listStaleFingerprints(mapperId, fingerprint).length,
    };
    if (!entry) concerns.push("no verified entry for current source (labels not promoted)");

    const runList = readRunMetrics(mapperId);
    const runs = {
      recorded: runList.length,
      crossCheckFlips: runList.reduce((a, m) => a + m.crossCheckFlips, 0),
      toolLoopRuns: runList.reduce((a, m) => a + m.toolLoopRuns, 0),
      toolLoopResolved: runList.reduce((a, m) => a + m.toolLoopResolved, 0),
    };
    if (runs.crossCheckFlips > 0) {
      concerns.push(`cross-check flipped ${runs.crossCheckFlips} field(s) — scanner pattern gap`);
    }

    let golden: MapperScore["golden"];
    const goldenFile = loadGolden(mapperId);
    if (goldenFile && entry) {
      const g = compareToGolden(entry, goldenFile);
      golden = {
        total: g.total,
        matched: g.matched,
        mismatched: g.mismatched.length,
        missing: g.missing.length,
      };
      if (g.mismatched.length + g.missing.length > 0) {
        concerns.push(`golden dataset: ${g.mismatched.length} mismatch, ${g.missing.length} missing`);
      }
    }

    return { mapperId, ok: true, coverage, store, runs, golden, concerns };
  } catch (err) {
    return { mapperId, ok: false, error: (err as Error).message, concerns };
  }
}

const registry = loadRegistry(values.registry!);
const targets = values.mapper
  ? registry.mappers.filter((m) => m.id === values.mapper)
  : registry.mappers;

const scores: MapperScore[] = [];
for (const m of targets) scores.push(await scoreMapper(m.id));

if (values.json) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), scores }, null, 2));
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
        (s.store!.corrected ? ` corrected=${s.store!.corrected}` : "") +
        (s.runs!.recorded
          ? ` | runs=${s.runs!.recorded} flips=${s.runs!.crossCheckFlips} toolloop=${s.runs!.toolLoopResolved}/${s.runs!.toolLoopRuns}`
          : "") +
        (s.golden ? ` | golden=${s.golden.matched}/${s.golden.total}` : ""),
    );
    for (const concern of s.concerns) console.log(`       - ${concern}`);
  }
  console.log("");
}

const failing = scores.filter((s) => !s.ok || s.concerns.length > 0);
if (values.strict && failing.length > 0) {
  console.error(`--strict: ${failing.length} mapper(s) with concerns`);
  process.exit(2);
}
