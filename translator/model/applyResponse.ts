import type { FieldMapping, PipelineOp } from "../groupMapping.js";
import type { FieldMappingResponse, PipelineOpLabel } from "./provider.js";
import type { FieldMappingJson, PipelineStep } from "./labeler.js";

function stripCodeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const { code: _c, ...rest } = meta;
  return Object.keys(rest).length ? rest : undefined;
}

/** Java evidence that non-letter characters are stripped. */
export function hasLettersOnlyEvidence(code: string): boolean {
  return /sanitizeAlpha|Character\.isLetter|\.isLetter\s*\(/.test(code);
}

function codeFromIndexerOps(ops: PipelineOp[] | undefined): string {
  if (!ops?.length) return "";
  return ops
    .map((op) => {
      const meta = op.meta && typeof op.meta === "object" ? (op.meta as Record<string, unknown>) : undefined;
      return typeof meta?.code === "string" ? meta.code : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Repair model omissions when indexer/RAW code clearly shows letter sanitization.
 * Inserts lettersOnly after trim (or before uppercase / at end).
 */
/** Normalize invented postal/digit-filter op names to keepDigits. */
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

export function ensureLettersOnlyTransform(
  pipeline: PipelineOpLabel[],
  code: string,
): PipelineOpLabel[] {
  if (!hasLettersOnlyEvidence(code)) return pipeline;
  if (pipeline.some((op) => op.kind === "transform" && op.op === "lettersonly")) {
    return pipeline;
  }

  const out = pipeline.map((op) => ({ ...op }));
  const step: PipelineOpLabel = { kind: "transform", op: "lettersonly" };
  const trimIdx = out.findIndex((op) => op.kind === "transform" && op.op === "trim");
  const upperIdx = out.findIndex((op) => op.kind === "transform" && op.op === "uppercase");
  if (trimIdx >= 0) out.splice(trimIdx + 1, 0, step);
  else if (upperIdx >= 0) out.splice(upperIdx, 0, step);
  else out.push(step);
  return out;
}

export function fromPipelineOp(
  op: PipelineOpLabel,
  reason: string | undefined,
  labelSource: "model" | "gemini" = "model",
): PipelineStep {
  const kind = (op.kind ?? "raw").toUpperCase();
  const step: PipelineStep = {
    kind,
    labelSource,
    labelReason: reason,
  };

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
 */
export function applyFieldMappingResponse(
  entry: FieldMapping,
  response: FieldMappingResponse,
  labelSource: "model" | "gemini" = "model",
): FieldMappingJson {
  const pipeline = response.pipeline?.map((op) => ({
    ...op,
    kind: (op.kind ?? "").toLowerCase(),
    op: op.op?.toLowerCase(),
  }));

  if (response.recognized && pipeline?.length && response.targetField) {
    const evidence = [codeFromIndexerOps(entry.pipeline), response.reason ?? ""].join("\n");
    const repaired = normalizeKeepDigitsOp(
      ensureLettersOnlyTransform(pipeline, evidence),
    );
    return {
      targetField: response.targetField,
      pipeline: repaired.map((op) => fromPipelineOp(op, response.reason, labelSource)),
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
      }))
    : undefined;

  return {
    recognized,
    targetField: typeof r.targetField === "string" ? r.targetField : undefined,
    pipeline,
    reason: typeof r.reason === "string" ? r.reason : undefined,
  };
}
