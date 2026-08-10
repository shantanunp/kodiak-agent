import type { FieldMapping, PipelineOp } from "../groupMapping.js";
import type { FieldMappingResponse, PipelineOpLabel } from "./provider.js";
import type { FieldMappingJson, PipelineStep } from "./labeler.js";

function stripCodeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const { code: _c, ...rest } = meta;
  return Object.keys(rest).length ? rest : undefined;
}

/** Normalize invented digit-filter op names to keepDigits (AI wording only — does not invent steps). */
export function normalizeKeepDigitsOp(pipeline: PipelineOpLabel[]): PipelineOpLabel[] {
  return pipeline.map((op) => {
    if (op.kind !== "transform" || typeof op.op !== "string") return op;
    const name = op.op.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      name === "keepdigits" ||
      name === "keepdigitsandhyphen" ||
      name === "digitsandhyphen" ||
      name === "keepdigitshyphen"
    ) {
      return { ...op, op: "keepdigits" };
    }
    return op;
  });
}

/**
 * Canonical pipeline step kinds. Anything else a model invents is normalized to
 * RAW (shown as "Raw / unclassified" in the viewer) with the original kind kept
 * in meta.originalKind — never silently accepted as a first-class kind.
 */
export const CANONICAL_STEP_KINDS = [
  "READ", "TRANSFORM", "FILTER", "SELECT", "BUILD", "WRITE", "CONSTANT", "RAW",
] as const;

export type CanonicalStepKind = (typeof CANONICAL_STEP_KINDS)[number];

export function normalizeStepKind(raw: string | undefined): {
  kind: CanonicalStepKind;
  originalKind?: string;
} {
  const upper = (raw ?? "raw").toUpperCase();
  if ((CANONICAL_STEP_KINDS as readonly string[]).includes(upper)) {
    return { kind: upper as CanonicalStepKind };
  }
  return { kind: "RAW", originalKind: upper };
}

export function fromPipelineOp(
  op: PipelineOpLabel,
  reason: string | undefined,
  labelSource: "model" = "model",
): PipelineStep {
  const { kind, originalKind } = normalizeStepKind(op.kind);
  const step: PipelineStep = {
    kind,
    labelSource,
    labelReason: reason,
  };
  if (originalKind) {
    step.meta = { originalKind };
    if (op.op) step.meta.op = op.op;
    if (op.value != null) step.meta.value = op.value;
    if (op.sourceField) step.sourceField = op.sourceField;
  }
  if (typeof op.summary === "string" && op.summary.trim()) {
    step.summary = op.summary.trim();
  }

  if (kind === "READ" || kind === "WRITE" || kind === "BUILD") {
    if (op.sourceField) step.sourceField = op.sourceField;
  }
  if (kind === "FILTER" && op.condition) {
    step.condition = op.condition;
  }
  if (kind === "CONSTANT") {
    if (op.value != null) {
      step.meta = { value: op.value };
    }
  }
  if (kind === "TRANSFORM") {
    step.meta = {};
    if (op.op) step.meta.op = op.op;
    if (op.value != null) step.meta.value = op.value;
    if (op.sourceField) step.sourceField = op.sourceField;
  }

  return step;
}

/**
 * Pull `// control flow:` headers from a write-site slice (analyzer output).
 * Outer → inner order, same as the slice.
 */
export function controlFlowHeadersFromSlice(sliceText: string): string[] {
  if (!sliceText) return [];
  const lines = sliceText.split(/\r?\n/);
  const idx = lines.findIndex((l) => /\/\/\s*control flow:/i.test(l));
  if (idx < 0) return [];
  const headers: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (line.startsWith("//")) break;
    if (/^(?:else\s+if|if|else|for|while)\b/.test(line)) {
      headers.push(line);
      continue;
    }
    break;
  }
  return headers;
}

/** Turn an analyzer control-flow header into a FILTER condition string. */
export function conditionFromControlFlowHeader(header: string): string {
  const trimmed = header.trim();
  // if (pred) / else if (pred) — optionally followed by `{ … } else`
  const m = trimmed.match(
    /^(?:else\s+)?if\s*\((.*)\)\s*(?:\{\s*[.…]{1,3}\s*\}\s*else)?\s*$/s,
  );
  if (m?.[1]) return m[1].trim();
  return trimmed;
}

/**
 * If the slice documents enclosing if/else/for/while and the model omitted
 * FILTER, inject deterministic FILTER steps after leading READ/SELECT.
 * Does not invent predicates — only headers already present in the slice.
 */
export function mergeControlFlowFilters(
  pipeline: PipelineStep[],
  sliceText: string | undefined,
): PipelineStep[] {
  if (!sliceText || pipeline.length === 0) return pipeline;
  if (pipeline.some((s) => String(s.kind).toUpperCase() === "FILTER")) {
    return pipeline;
  }
  const headers = controlFlowHeadersFromSlice(sliceText);
  if (headers.length === 0) return pipeline;

  const filters: PipelineStep[] = headers.map((header) => {
    const condition = conditionFromControlFlowHeader(header);
    return {
      kind: "FILTER",
      condition,
      summary: `Applies when ${condition}.`,
      labelSource: "deterministic",
      labelReason: "control-flow header from write-site slice",
    };
  });

  let insertAt = 0;
  for (let i = 0; i < pipeline.length; i++) {
    const k = String(pipeline[i]!.kind).toUpperCase();
    if (k === "READ" || k === "SELECT") insertAt = i + 1;
    else break;
  }
  return [...pipeline.slice(0, insertAt), ...filters, ...pipeline.slice(insertAt)];
}

/**
 * Convert a model/agent FieldMappingResponse into the same FieldMappingJson
 * shape used by live labeling and field cache.
 * Trust the model pipeline — do not invent or drop transform steps here.
 * When `sliceText` carries `// control flow:` headers, missing FILTERs are
 * filled in deterministically (models often collapse guarded getter→setter to READ).
 */
export function applyFieldMappingResponse(
  entry: FieldMapping,
  response: FieldMappingResponse,
  labelSource: "model" = "model",
  sliceText?: string,
): FieldMappingJson {
  const pipeline = response.pipeline?.map((op) => ({
    ...op,
    kind: (op.kind ?? "").toLowerCase(),
    op: op.op?.toLowerCase(),
  }));

  if (response.recognized && pipeline?.length) {
    const normalized = normalizeKeepDigitsOp(pipeline);
    const steps = normalized.map((op) => fromPipelineOp(op, response.reason, labelSource));
    return {
      targetField: response.targetField?.trim() || entry.targetField,
      pipeline: mergeControlFlowFilters(steps, sliceText),
    };
  }

  return {
    targetField: entry.targetField,
    pipeline: mergeControlFlowFilters(
      entry.pipeline.map((op) => ({
        kind: op.kind,
        sourceField: typeof op.sourceField === "string" ? op.sourceField : undefined,
        condition: typeof op.condition === "string" ? op.condition : undefined,
        meta: stripCodeMeta(
          op.meta && typeof op.meta === "object"
            ? (op.meta as Record<string, unknown>)
            : undefined,
        ),
        labelSource: "deterministic",
        labelReason: response.reason ?? "model did not rewrite field",
      })),
      sliceText,
    ),
  };
}

export function normalizeFieldMappingResponse(raw: unknown): FieldMappingResponse {
  if (!raw || typeof raw !== "object") {
    throw new Error("Field response must be an object");
  }
  const r = raw as Record<string, unknown>;
  const recognized = Boolean(r.recognized);
  const pipeline = Array.isArray(r.pipeline)
    ? (r.pipeline as PipelineOpLabel[]).map((op) => ({
        ...op,
        kind: (op.kind ?? "").toLowerCase(),
        op: typeof op.op === "string" ? op.op.toLowerCase() : op.op,
        summary:
          typeof op.summary === "string" && op.summary.trim()
            ? op.summary.trim()
            : undefined,
      }))
    : undefined;

  return {
    recognized,
    targetField: typeof r.targetField === "string" ? r.targetField : undefined,
    pipeline,
    reason: typeof r.reason === "string" ? r.reason : undefined,
  };
}
