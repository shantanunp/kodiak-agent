/**
 * Agent loop — slice-fed labeling with the audit gate in charge.
 *
 * Per declared target field:
 *   mapped     -> label from its self-contained slice (one focused model call;
 *                 field cache and verified store still take precedence upstream)
 *   unresolved -> escalation pass: the agent gets the FULL source plus the
 *                 opaque-escape note and must settle the field or explicitly
 *                 return recognized=false with a reason
 *   unmapped   -> no model call; reported as an explicit unmapped row
 *
 * The loop's verdict (gatePassed) is deterministic: it only passes when no
 * field is left unresolved. --promote refuses to write unverified results.
 */

import type { ModelProvider, FieldMappingResponse } from "../model/provider.js";
import { applyFieldMappingResponse } from "../model/applyResponse.js";
import type { FieldMappingJson, IndexAst, PipelineJson } from "../model/labeler.js";
import {
  getFieldPipelineCache,
  setFieldPipelineCache,
} from "../cache/index.js";
import type { FieldTask, LabelTasks } from "./tasks.js";
import { investigateField } from "./toolLoop.js";
import { mineWriteSites } from "./aiWriteSiteMiner.js";
import { reconcile } from "../../analyzer/reconcile.js";
import { normalizeFieldName } from "../../analyzer/fieldNames.js";
import { appendRunMetrics } from "../report/metrics.js";
import { appendRun, sourceSha } from "../telemetry/journal.js";
import { groundingDiagnostics } from "./grounding.js";
import { findStepSmells, smellDiagnostics } from "./smells.js";
import { verifyFieldConsistency, type VerifyDivergence } from "./verify.js";
import { criticField, type CriticFinding } from "./critic.js";
import { scoreLabeling, scoresForJournal } from "../report/scorers.js";
import { mapPool } from "./pool.js";
import {
  provenanceForTask,
  type LabelProvenance,
} from "./provenance.js";
import type { ModelConfig } from "../model/config.js";
import { p95LatencyMs, type ToolTraceEntry } from "../model/provider.js";

/** Default parallel field labels (independent model calls). Override via concurrency. */
export const DEFAULT_LABEL_CONCURRENCY = 4;

export interface AgentLoopOptions {
  fingerprint: string;
  schemaContext?: string;
  sourceJava: string;
  noCache?: boolean;
  /** Escalation retries for unresolved fields (default 1). */
  maxEscalations?: number;
  /** Enables the investigation tool loop for still-unresolved fields. */
  modelConfig?: ModelConfig;
  schemaContextText?: string;
  /** @deprecated use `useAiMiner: false` instead. Still honored if useAiMiner is unset. */
  skipCrossCheck?: boolean;
  /**
   * AI write-site miner (KOD-1/2/7/8) — an independent AI pass over the full
   * declared-field checklist, reconciled against the CST scan with the
   * deterministic reconciler in analyzer/reconcile.ts. Default true. CST
   * still wins on any agreement or CST-only find; the miner can only demote
   * an unmapped field to unresolved, never assert a field mapped on its own.
   */
  useAiMiner?: boolean;
  /** AGT-3 — second label at temp 0; report divergences (cost-aware). */
  verify?: boolean;
  /** Provider forced to temperature 0 for the verify second pass. */
  verifyProvider?: ModelProvider;
  /** AGT-4 — extra critic call per labeled field (cited missing transforms). */
  critic?: boolean;
  /** Max concurrent field label calls (default 4). Set 1 for serial. */
  concurrency?: number;
}

export interface AgentLoopAudit {
  declaredFields: number;
  mapped: number;
  unmapped: number;
  unresolved: number;
  gatePassed: boolean;
  unresolvedFields: string[];
  unmappedFields: string[];
}

export interface AgentLoopResult {
  mapping: FieldMappingJson[];
  audit: AgentLoopAudit;
  fieldsLabeled: number;
  fieldsFromCache: number;
  /** AGT-1 grounding warnings (also logged to stderr). */
  groundingWarnings: string[];
  /** AGT-3 — fields where two temp-0 runs disagreed. */
  verifyDivergences?: VerifyDivergence[];
  /** AGT-4 — cited missing transforms/filters from the critic. */
  criticFindings?: CriticFinding[];
  /** Per-field provenance for viewer confidence badges. */
  fieldProvenance?: Record<string, LabelProvenance>;
  /** KOD-9 — CST/AI-miner reconciliation notes (dropped claims, disagreements). */
  reconciliationDiagnostics?: string[];
}

function escalationOps(
  task: FieldTask,
  sourceJava: string,
  prior?: { emptyPipeline?: boolean },
): unknown[] {
  const emptyHint = prior?.emptyPipeline
    ? ` Prior response had recognized=true with an empty pipeline — that is invalid. ` +
      `Emit a NON-EMPTY pipeline (for if/else constants: read predicate + filter + constant) ` +
      `or recognized=false.`
    : "";
  return [
    {
      kind: "RAW",
      meta: {
        code: sourceJava,
        note:
          `Field "${task.field}" could not be resolved deterministically. ` +
          `${task.note ?? ""} Inspect the full source above; if this field is genuinely ` +
          `never written, return recognized=false with the reason.` +
          emptyHint,
      },
    },
  ];
}

export async function runAgentLoop(
  ast: IndexAst,
  tasks: LabelTasks,
  provider: ModelProvider,
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const mapperId = ast.mapperId ?? "unknown";
  const started = Date.now();

  // AI write-site miner (KOD-1/2/7/8): one call over the FULL declared-field
  // checklist, reconciled deterministically (analyzer/reconcile.ts) against
  // the CST scan. CST still wins on agreement or when it's the only leg with
  // a find; the miner can only demote a CST "unmapped" field to "unresolved"
  // — or, in --no-cst runs where every field already starts unresolved,
  // attach a hint note — it never asserts a field mapped on its own.
  let crossCheckFlips = 0;
  let toolLoopRuns = 0;
  let toolLoopResolved = 0;
  const reconciliationDiagnostics: string[] = [];
  const aiMinerEnabled = options.useAiMiner ?? !options.skipCrossCheck;
  if (aiMinerEnabled && tasks.tasks.length > 0) {
    try {
      const cstSites = tasks.tasks.flatMap((t) => t.slices);
      const declaredFieldNames = tasks.tasks.map((t) => t.field);
      const { candidates, dropped } = await mineWriteSites({
        provider,
        sourceJava: options.sourceJava,
        declaredFields: declaredFieldNames,
      });
      for (const note of dropped) {
        reconciliationDiagnostics.push(note);
        console.error(`[ai-miner] ${note}`);
      }
      const { agreed, aiOnly, cstOnly } = reconcile(cstSites, candidates, declaredFieldNames);
      for (const cand of aiOnly) {
        const task = tasks.tasks.find(
          (t) => normalizeFieldName(t.field.split(".").pop()!) === normalizeFieldName(cand.field),
        );
        if (!task) continue;
        if (task.state === "unmapped") {
          crossCheckFlips++;
          task.state = "unresolved";
          task.note = `ai-miner: possible missed write at line ${cand.line} — ${cand.evidence}`;
          console.error(`[ai-miner] ${task.field}: unmapped -> unresolved (${cand.evidence})`);
        } else if (task.state === "unresolved" && !task.note) {
          // --no-cst runs: every field starts unresolved with no slice; attach
          // the miner's line as a hint for the escalation pass.
          task.note = `ai-miner: possible write at line ${cand.line} — ${cand.evidence}`;
        }
      }
      const summary =
        `ai-miner reconciled: ${agreed.length} agreed, ${aiOnly.length} ai-only, ${cstOnly.length} cst-only`;
      reconciliationDiagnostics.push(summary);
      console.error(`[ai-miner] ${summary}`);
      if (agreed.length) {
        console.error(`[ai-miner]   agreed: ${agreed.join(", ")}`);
        reconciliationDiagnostics.push(`agreed: ${agreed.join(", ")}`);
      }
      if (aiOnly.length) {
        const aiList = aiOnly.map((c) => `${c.field}@${c.line}`).join(", ");
        console.error(`[ai-miner]   ai-only: ${aiList}`);
        reconciliationDiagnostics.push(`ai-only: ${aiList}`);
      }
      if (cstOnly.length) {
        const cstList = cstOnly
          .map((s) => `${s.targetField}@${s.line}`)
          .join(", ");
        console.error(`[ai-miner]   cst-only: ${cstList}`);
        reconciliationDiagnostics.push(`cst-only: ${cstList}`);
      }
      console.error(
        `[ai-miner]   miner candidates: ${candidates.length}, dropped claims: ${dropped.length}`,
      );    } catch (err) {
      console.error(`[ai-miner] skipped: ${(err as Error).message}`);
    }
  }

  const mapping: FieldMappingJson[] = [];
  let fieldsLabeled = 0;
  let fieldsFromCache = 0;
  const stillUnresolved: string[] = [];
  const unmappedFields: string[] = [];
  const verifyDivergences: VerifyDivergence[] = [];
  const criticFindings: CriticFinding[] = [];
  const fieldProvenance: Record<string, LabelProvenance> = {};

  const toLabel: FieldTask[] = [];

  for (const task of tasks.tasks) {
    if (task.state === "unmapped") {
      unmappedFields.push(task.field);
      continue;
    }
    const cached = !options.noCache
      ? getFieldPipelineCache(mapperId, options.fingerprint, task.field)
      : null;
    if (cached) {
      mapping.push(cached.mapping as FieldMappingJson);
      fieldsFromCache++;
      fieldProvenance[task.field] =
        (cached.provenance as LabelProvenance | undefined) ?? "cache";
      continue;
    }
    toLabel.push(task);
  }

  const concurrency = options.concurrency ?? DEFAULT_LABEL_CONCURRENCY;

  interface FieldLabelResult {
    field: string;
    labeled?: FieldMappingJson;
    unresolved?: boolean;
    provenance?: LabelProvenance;
    toolTrace?: ToolTraceEntry[];
    toolLoopAttempted?: boolean;
    toolLoopOk?: boolean;
    verifyDiv?: VerifyDivergence | null;
    criticHits?: CriticFinding[];
    criticDropped?: string[];
  }

  const outcomes = await mapPool(toLabel, concurrency, async (task): Promise<FieldLabelResult> => {
    const indexerOps =
      task.state === "mapped"
        ? [{ kind: "RAW", meta: { code: task.sliceText } }]
        : escalationOps(task, options.sourceJava);

    let response: FieldMappingResponse | null = null;
    let opsUsed: unknown[] = indexerOps;
    let usedEscalationRetry = false;
    const attempts =
      1 +
      (task.state === "unresolved"
        ? (options.maxEscalations ?? 1)
        : 1);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const ops =
        attempt === 0
          ? indexerOps
          : escalationOps(task, options.sourceJava, {
              emptyPipeline:
                response?.recognized === true &&
                (response.pipeline?.length ?? 0) === 0,
            });
      if (attempt > 0) usedEscalationRetry = true;
      opsUsed = ops;
      response = await provider.labelFieldMapping({
        javaTargetField: task.field,
        indexerOps: ops,
        schemaContext: options.schemaContext,
      });
      if (response?.recognized && (response.pipeline?.length ?? 0) > 0) break;
    }

    let toolTrace: ToolTraceEntry[] | undefined;
    let toolLoopAttempted = false;
    let toolLoopOk = false;
    if (task.state === "unresolved" && !response?.recognized && options.modelConfig) {
      toolLoopAttempted = true;
      try {
        const investigated = await investigateField({
          config: options.modelConfig,
          field: task.field,
          note: task.note,
          sourceJava: options.sourceJava,
          schemaContext: options.schemaContextText,
        });
        const parsed = JSON.parse(
          investigated.text.replace(/```json|```/g, "").trim(),
        ) as FieldMappingResponse & { toolTrace?: ToolTraceEntry[] };
        if (parsed && typeof parsed === "object") {
          if (parsed.recognized) toolLoopOk = true;
          response = parsed;
          toolTrace = investigated.trace.length > 0 ? investigated.trace : undefined;
          if (toolTrace?.length) {
            console.error(
              `[tool-loop] ${task.field}: ${toolTrace.length} tool call(s): ` +
                toolTrace.map((t) => t.tool).join(" -> "),
            );
          }
        }
      } catch (err) {
        console.error(`[tool-loop] ${task.field}: ${(err as Error).message}`);
      }
    }

    if (task.state === "unresolved" && !response?.recognized) {
      return { field: task.field, unresolved: true, toolLoopAttempted, toolLoopOk };
    }

    const labeled = applyFieldMappingResponse(
      { targetField: task.field, pipeline: [] },
      response ?? { recognized: false, reason: "no model response" },
      "model",
      task.sliceText,
    );
    if (labeled.pipeline.length === 0) {
      console.error(
        `[agent-loop] ${task.field}: model returned no pipeline steps; leaving unresolved`,
      );
      return { field: task.field, unresolved: true, toolLoopAttempted, toolLoopOk };
    }

    const provenance = provenanceForTask({
      taskState: task.state,
      note: task.note,
      usedToolLoop: toolLoopAttempted && toolLoopOk,
      usedEscalationRetry,
    });

    let verifyDiv: VerifyDivergence | null = null;
    if (options.verify) {
      verifyDiv = await verifyFieldConsistency({
        provider,
        verifyProvider: options.verifyProvider,
        task,
        first: labeled,
        schemaContext: options.schemaContext,
        indexerOps: opsUsed,
      });
      if (verifyDiv) {
        console.error(
          `[verify] ${verifyDiv.field}: diverge first=[${verifyDiv.firstKinds}] second=[${verifyDiv.secondKinds}]`,
        );
      }
    }

    let criticHits: CriticFinding[] | undefined;
    let criticDropped: string[] | undefined;
    if (options.critic) {
      try {
        const { findings, dropped } = await criticField({
          provider,
          field: task.field,
          sliceText: task.sliceText || options.sourceJava,
          sourceJava: options.sourceJava,
          mapping: labeled,
        });
        criticHits = findings;
        criticDropped = dropped;
      } catch (err) {
        criticDropped = [`${task.field}: ${(err as Error).message}`];
      }
    }

    return {
      field: task.field,
      labeled,
      provenance,
      toolTrace,
      toolLoopAttempted,
      toolLoopOk,
      verifyDiv,
      criticHits,
      criticDropped,
    };
  });

  for (const outcome of outcomes) {
    if (outcome.toolLoopAttempted) toolLoopRuns++;
    if (outcome.toolLoopOk) toolLoopResolved++;
    for (const note of outcome.criticDropped ?? []) {
      console.error(`[critic] ${note}`);
    }
    for (const f of outcome.criticHits ?? []) {
      criticFindings.push(f);
      console.error(
        `[critic] ${f.field}: missing ${f.kind} — ${f.detail} (${f.evidence})`,
      );
    }
    if (outcome.unresolved || !outcome.labeled || !outcome.provenance) {
      stillUnresolved.push(outcome.field);
      continue;
    }
    mapping.push(outcome.labeled);
    fieldsLabeled++;
    fieldProvenance[outcome.field] = outcome.provenance;
    if (outcome.verifyDiv) verifyDivergences.push(outcome.verifyDiv);

    if (!options.noCache) {
      const now = new Date().toISOString();
      setFieldPipelineCache({
        fingerprint: options.fingerprint,
        mapperId,
        javaTargetField: outcome.field,
        mapping: outcome.labeled,
        labeledAt: now,
        labelModel: provider.model,
        cachedAt: now,
        provenance: outcome.provenance,
        toolTrace: outcome.toolTrace,
      });
    }
  }

  const audit: AgentLoopAudit = {
    declaredFields: tasks.report.declaredFields,
    mapped: mapping.length,
    unmapped: unmappedFields.length,
    unresolved: stillUnresolved.length,
    gatePassed: stillUnresolved.length === 0,
    unresolvedFields: stillUnresolved,
    unmappedFields,
  };

  // AGT-1 — invented steps that don't appear in the slice.
  const sliceByField = new Map(
    tasks.tasks.map((t) => [t.field, t.sliceText] as const),
  );
  const groundingWarnings = groundingDiagnostics(mapping, sliceByField);
  for (const w of groundingWarnings) {
    console.error(`[grounding] ${w}`);
  }

  // AGT-2 — short pipeline vs deep helper closure.
  const smells = findStepSmells(mapping, tasks.tasks);
  for (const d of smellDiagnostics(smells)) {
    console.error(`[smell] ${d}`);
  }

  // PAR-4 — write-site pattern counts from the checklist slices.
  const writePatterns: Record<string, number> = {};
  for (const t of tasks.tasks) {
    for (const s of t.slices) {
      writePatterns[s.via] = (writePatterns[s.via] ?? 0) + 1;
    }
  }
  const diags = tasks.diagnostics ?? [];
  const countDiag = (prefix: string) =>
    diags.filter((d) => d.startsWith(prefix)).length;
  const possibleMissedWrites = countDiag("possible-missed-write");
  const unmappedButMentioned = countDiag("unmapped-but-mentioned");
  const multiInstanceUnattributed = countDiag("multi-instance-unattributed");
  const promptInjectionRisks = countDiag("prompt-injection-risk");

  const provenanceCounts: Record<string, number> = {};
  for (const tag of Object.values(fieldProvenance)) {
    provenanceCounts[tag] = (provenanceCounts[tag] ?? 0) + 1;
  }

  try {
    appendRunMetrics({
      mapperId,
      at: new Date().toISOString(),
      declaredFields: tasks.report.declaredFields,
      labeled: fieldsLabeled,
      fromCache: fieldsFromCache,
      unresolved: stillUnresolved.length,
      crossCheckFlips,
      toolLoopRuns,
      toolLoopResolved,
    });
  } catch {
    // metrics are best-effort; never fail a run over them
  }

  // EVAL-2 — rule-based labeling scorers (no model).
  const scores = scoreLabeling({ tasks, mapping });

  const pm = provider.getMetrics?.();
  // MON-1/2 — one journal line per agent-loop completion.
  appendRun({
    at: new Date().toISOString(),
    mapperId,
    sourceSha: sourceSha(options.sourceJava),
    language: "java",
    declared: tasks.report.declaredFields,
    mapped: mapping.length,
    unmapped: unmappedFields.length,
    unresolved: stillUnresolved.length,
    gatePassed: stillUnresolved.length === 0,
    resultSource: {
      cache: fieldsFromCache,
      model: fieldsLabeled,
    },
    modelCalls: pm?.calls ?? fieldsLabeled,
    toolLoopCalls: toolLoopRuns,
    durationMs: Date.now() - started,
    promoted: false,
    checklistSource: tasks.checklistSource,
    diagnostics:
      diags.length +
      groundingWarnings.length +
      smells.length +
      verifyDivergences.length +
      criticFindings.length +
      reconciliationDiagnostics.length,
    tokens: pm
      ? {
          prompt: pm.promptTokens,
          completion: pm.completionTokens,
          retries: pm.retries,
          latencyMs: pm.totalLatencyMs,
          p95LatencyMs: p95LatencyMs(pm.latenciesMs),
        }
      : undefined,
    writePatterns,
    possibleMissedWrites,
    unmappedButMentioned,
    multiInstanceUnattributed,
    promptInjectionRisks,
    crossCheckFlips,
    groundingWarnings: groundingWarnings.length,
    stepSmells: smells.length,
    provenance: provenanceCounts,
    scores: scoresForJournal(scores),
    verifyDivergences: verifyDivergences.length,
    criticFindings: criticFindings.length,
    outcome: "ok",
    path: "agent-loop",
  });
  provider.resetMetrics?.();

  return {
    mapping,
    audit,
    fieldsLabeled,
    fieldsFromCache,
    groundingWarnings,
    verifyDivergences,
    criticFindings,
    fieldProvenance,
    reconciliationDiagnostics,
  };
}

/** Assemble the labeler-compatible PipelineJson from a loop result. */
export function toPipelineJson(
  ast: IndexAst,
  result: AgentLoopResult,
  meta: { model: string; fingerprint: string },
): PipelineJson & { audit: AgentLoopAudit } {
  return {
    ...ast,
    mapperId: ast.mapperId,
    mapping: result.mapping,
    labeledAt: new Date().toISOString(),
    labelModel: meta.model,
    cacheHit: result.fieldsLabeled === 0 && result.mapping.length > 0,
    resultSource:
      result.fieldsLabeled === 0
        ? "cache"
        : result.fieldsFromCache > 0
          ? "mixed"
          : "model",
    fieldsFromCache: result.fieldsFromCache,
    fieldsLabeled: result.fieldsLabeled,
    fingerprint: meta.fingerprint,
    audit: result.audit,
  };
}
