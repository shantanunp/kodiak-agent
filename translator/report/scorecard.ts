/**
 * Shared scorecard assembler — used by `npm run report` and GET /api/report.
 * Deterministic only (zero model calls).
 */

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
import { summarizeJournal, type JournalSummary } from "../telemetry/journalReport.js";
import { checkDrift, type DriftRow } from "../telemetry/drift.js";
import { readRuns, type RunJournalEntry } from "../telemetry/journal.js";
import {
  classifyMissLive,
  journalMissTotal,
  type LiveMiss,
} from "./missLive.js";

export interface MapperScore {
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
    verified: number;
    pendingReview: number;
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
  /** Present when source resolved — for API missLive classification. */
  _tasks?: {
    diagnostics: string[];
    fields: Array<{ field: string; state: string; note?: string }>;
  };
}

export interface MapperReportPayload {
  mapperId: string;
  generatedAt: string;
  ok: boolean;
  error?: string;
  coverage?: MapperScore["coverage"];
  store?: MapperScore["store"];
  runs?: MapperScore["runs"];
  golden?: MapperScore["golden"];
  concerns: string[];
  journal: JournalSummary & {
    judge: { rejects: number; agrees: number; agreeRate: number | null };
    missTotal: number;
  };
  drift?: DriftRow;
  missLive: LiveMiss[];
  recentRuns: RunJournalEntry[];
}

export async function scoreMapper(
  mapperId: string,
  options: { registryPath?: string; worktree?: string } = {},
): Promise<MapperScore> {
  const registryPath = options.registryPath ?? paths.registry;
  const registry = loadRegistry(registryPath);
  const mapper = registry.mappers.find((m) => m.id === mapperId);
  if (!mapper) {
    return { mapperId, ok: false, error: `unknown mapper: ${mapperId}`, concerns: [] };
  }
  const concerns: string[] = [];

  try {
    const resolved = await resolveMapperAst(mapperId, registryPath, {
      worktree: options.worktree,
      remote: false,
    });
    if (!resolved.sourceJava.trim()) {
      return {
        mapperId,
        ok: false,
        error: "source not resolvable (pass --worktree)",
        concerns: [],
      };
    }
    const worktree =
      options.worktree ?? inferWorktree(resolved.sourcePath, mapper.sourceFile) ?? undefined;

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
    const pendingReview =
      entry?.fields.filter((f) => f.status === "pending-review").length ?? 0;
    const verifiedFields =
      entry?.fields.filter((f) => f.status === "verified").length ?? 0;
    const store = {
      hasCurrentEntry: Boolean(entry),
      fields: entry?.fields.length ?? 0,
      verified: verifiedFields,
      pendingReview,
      corrected: entry?.fields.filter((f) => f.status === "user-corrected").length ?? 0,
      staleEntries: listStaleFingerprints(mapperId, fingerprint).length,
    };
    if (!entry) concerns.push("no verified entry for current source (labels not promoted)");
    else if (pendingReview > 0) {
      concerns.push(`${pendingReview} field(s) pending review (npm run verified:approve)`);
    }

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

    return {
      mapperId,
      ok: true,
      coverage,
      store,
      runs,
      golden,
      concerns,
      _tasks: {
        diagnostics: tasks.diagnostics,
        fields: tasks.tasks.map((t) => ({
          field: t.field,
          state: t.state,
          note: t.note,
        })),
      },
    };
  } catch (err) {
    return { mapperId, ok: false, error: (err as Error).message, concerns };
  }
}

/** Per-mapper payload for GET /api/report (journal always included). */
export async function buildMapperReport(options: {
  mapperId: string;
  registryPath?: string;
  worktree?: string;
  since?: string;
  recentLimit?: number;
}): Promise<MapperReportPayload> {
  const registryPath = options.registryPath ?? paths.registry;
  const score = await scoreMapper(options.mapperId, {
    registryPath,
    worktree: options.worktree,
  });
  const journalBase = summarizeJournal({
    mapperId: options.mapperId,
    since: options.since,
  });
  const agrees = score.store?.corrected ?? 0;
  const rejects = journalBase.judge.rejects;
  const journal = {
    ...journalBase,
    judge: {
      rejects,
      agrees,
      agreeRate: rejects + agrees > 0 ? agrees / (rejects + agrees) : null,
    },
    missTotal: journalMissTotal(journalBase),
  };

  const driftRows = await checkDrift({
    registryPath,
    worktree: options.worktree,
    mapperId: options.mapperId,
  });
  const drift = driftRows[0];

  const missLive = score._tasks
    ? classifyMissLive(score._tasks)
    : [];

  const recentRuns = readRuns({ mapperId: options.mapperId, since: options.since })
    .slice(-(options.recentLimit ?? 10))
    .reverse();

  const { _tasks: _, ...publicScore } = score;
  return {
    mapperId: options.mapperId,
    generatedAt: new Date().toISOString(),
    ok: publicScore.ok,
    error: publicScore.error,
    coverage: publicScore.coverage,
    store: publicScore.store,
    runs: publicScore.runs,
    golden: publicScore.golden,
    concerns: publicScore.concerns,
    journal,
    drift,
    missLive,
    recentRuns,
  };
}
