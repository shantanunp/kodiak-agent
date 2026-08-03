import type { FieldMapping } from "../groupMapping.js";
import type { FieldMappingResponse, PipelineOpLabel } from "./provider.js";
import type { FieldMappingJson, PipelineStep } from "./labeler.js";

function stripCodeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const { code: _c, ...rest } = meta;
  return Object.keys(rest).length ? rest : undefined;
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
    return {
      targetField: response.targetField,
      pipeline: pipeline.map((op) => fromPipelineOp(op, response.reason, labelSource)),
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
