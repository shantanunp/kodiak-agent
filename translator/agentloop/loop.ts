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
import { crossCheckUnmapped } from "./crossCheck.js";
import { appendRunMetrics } from "../report/metrics.js";
import { appendRun, sourceSha } from "../telemetry/journal.js";
import { groundingDiagnostics } from "./grounding.js";
import { findStepSmells, smellDiagnostics } from "./smells.js";
import type { ModelConfig } from "../model/config.js";
import { p95LatencyMs, type ToolTraceEntry } from "../model/provider.js";

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
  /** Disable the cross-check pass (tests / cost control). */
  skipCrossCheck?: boolean;
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

  // Cross-check pass: one call, only when the scan produced UNMAPPED fields.
  // Verified claims demote unmapped -> unresolved (never mapped directly), so
  // the normal escalation / tool-loop path settles them with full rigor.
  let crossCheckFlips = 0;
  let toolLoopRuns = 0;
  let toolLoopResolved = 0;
  const unmappedTasks = tasks.tasks.filter((t) => t.state === "unmapped");
  if (unmappedTasks.length > 0 && !options.skipCrossCheck) {
    try {
      const { flips, dropped } = await crossCheckUnmapped({
        provider,
        sourceJava: options.sourceJava,
        unmappedFields: unmappedTasks.map((t) => t.field),
      });
      for (const note of dropped) console.error(`[cross-check] ${note}`);
      for (const flip of flips) {
        const task = tasks.tasks.find((t) => t.field === flip.field);
        if (task) {
          crossCheckFlips++;
          task.state = "unresolved";
          task.note = `cross-check: possible missed write at line ${flip.line} — ${flip.evidence}`;
          console.error(`[cross-check] ${flip.field}: unmapped -> unresolved (${flip.evidence})`);
        }
      }
    } catch (err) {
      console.error(`[cross-check] skipped: ${(err as Error).message}`);
    }
  }

  const mapping: FieldMappingJson[] = [];
  let fieldsLabeled = 0;
  let fieldsFromCache = 0;
  const stillUnresolved: string[] = [];
  const unmappedFields: string[] = [];

  for (const task of tasks.tasks) {
    if (task.state === "unmapped") {
      unmappedFields.push(task.field);
      continue;
    }

    // Field cache (runtime layer; verified store handled upstream).
    const cached = !options.noCache
      ? getFieldPipelineCache(mapperId, options.fingerprint, task.field)
      : null;
    if (cached) {
      mapping.push(cached.mapping as FieldMappingJson);
      fieldsFromCache++;
      continue;
    }

    const indexerOps =
      task.state === "mapped"
        ? [{ kind: "RAW", meta: { code: task.sliceText } }]
        : escalationOps(task, options.sourceJava);

    let response: FieldMappingResponse | null = null;
    // Mapped fields get one focused call + one full-source retry if the model
    // returns recognized=false or an empty pipeline (common on bare constants).
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
      response = await provider.labelFieldMapping({
        javaTargetField: task.field,
        indexerOps: ops,
        schemaContext: options.schemaContext,
      });
      if (response?.recognized && (response.pipeline?.length ?? 0) > 0) break;
    }

    // Last resort for unresolved fields: Copilot-style investigation loop.
    if (task.state === "unresolved" && !response?.recognized && options.modelConfig) {
      toolLoopRuns++;
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
          if (parsed.recognized) toolLoopResolved++;
          response = parsed;
          if (investigated.trace.length > 0) {
            console.error(
              `[tool-loop] ${task.field}: ${investigated.trace.length} tool call(s): ` +
                investigated.trace.map((t) => t.tool).join(" -> "),
            );
          }
        }
      } catch (err) {
        console.error(`[tool-loop] ${task.field}: ${(err as Error).message}`);
      }
    }

    if (task.state === "unresolved" && !response?.recognized) {
      stillUnresolved.push(task.field);
      continue;
    }

    const labeled = applyFieldMappingResponse(
      { targetField: task.field, pipeline: [] },
      response ?? { recognized: false, reason: "no model response" },
      "model",
    );
    // Never promote an empty pipeline as a successful label — the e2e gate and
    // viewers treat that as a real failure mode (model declined / omitted steps).
    // Mapped fields that still have no steps are unresolved from the agent's view.
    if (labeled.pipeline.length === 0) {
      stillUnresolved.push(task.field);
      console.error(
        `[agent-loop] ${task.field}: model returned no pipeline steps; leaving unresolved`,
      );
      continue;
    }
    mapping.push(labeled);
    fieldsLabeled++;

    if (!options.noCache) {
      const now = new Date().toISOString();
      setFieldPipelineCache({
        fingerprint: options.fingerprint,
        mapperId,
        javaTargetField: task.field,
        mapping: labeled,
        labeledAt: now,
        labelModel: provider.model,
        cachedAt: now,
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
  const possibleMissedWrites = (tasks.diagnostics ?? []).filter((d) =>
    d.startsWith("possible-missed-write"),
  ).length;

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
      (tasks.diagnostics?.length ?? 0) + groundingWarnings.length + smells.length,
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
    groundingWarnings: groundingWarnings.length,
    stepSmells: smells.length,
    outcome: "ok",
    path: "agent-loop",
  });
  provider.resetMetrics?.();

  return { mapping, audit, fieldsLabeled, fieldsFromCache, groundingWarnings };
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
