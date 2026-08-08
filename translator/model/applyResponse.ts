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
 * Convert a model/agent FieldMappingResponse into the same FieldMappingJson
 * shape used by live labeling and field cache.
 * Trust the model pipeline — do not invent or drop transform steps here.
 */
export function applyFieldMappingResponse(
  entry: FieldMapping,
  response: FieldMappingResponse,
  labelSource: "model" = "model",
): FieldMappingJson {
  const pipeline = response.pipeline?.map((op) => ({
    ...op,
    kind: (op.kind ?? "").toLowerCase(),
    op: op.op?.toLowerCase(),
  }));

  if (response.recognized && pipeline?.length) {
    const normalized = normalizeKeepDigitsOp(pipeline);
    return {
      targetField: response.targetField?.trim() || entry.targetField,
      pipeline: normalized.map((op) => fromPipelineOp(op, response.reason, labelSource)),
    };
  }

  return {
    targetField: entry.targetField,
    pipeline: entry.pipeline.map((op) => ({
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
