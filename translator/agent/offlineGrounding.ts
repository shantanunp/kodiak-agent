/**
 * Offline-only label fidelity: instruction addendum + import grounding gate.
 * Does not change online FIELD_MAPPING_PROMPT or agentloop warn-only grounding.
 */

import { checkPipelineGrounding, type UngroundedStep } from "../agentloop/grounding.js";
import type { PipelineStep } from "../model/labeler.js";
import type { FieldMappingResponse } from "../model/provider.js";
import { AGENT_OFFLINE_MODEL } from "./types.js";

/** Appended to offline job.instructions (and mirrored in Cursor/GH offline docs). */
export const OFFLINE_LABEL_FIDELITY = [
  "Label fidelity (offline-only — do not invent steps):",
  "- Label ONLY from fields[].slice / sourceJava. Never invent transforms from the allowed-op list.",
  "- Emit keepDigits / lettersOnly ONLY when the helper body actually filters characters",
  "  that way (Character.isDigit / isLetter loops, digit/letter builders, etc.).",
  "- Every helper-body guard that returns null or skips the write (raw == null, isEmpty(),",
  "  length < N, prefix checks) MUST become a filter step — even without // control flow: headers.",
  "- Prefer trim when the body is edge-whitespace only (stripEdges / start–end whitespace walks).",
  "  Do not upgrade trim to digit/letter sanitizers.",
  "- After writing result.json, check each TRANSFORM op is evidenced in the slice; if not, remove it",
  "  before import (import rejects ungrounded TRANSFORM/CONSTANT for agent:offline).",
].join("\n");

export function isOfflineLabelModel(labelModel: string | undefined): boolean {
  return !labelModel || labelModel === AGENT_OFFLINE_MODEL;
}

/** Map result.json pipeline rows into the shape checkPipelineGrounding expects. */
export function pipelineResponseToSteps(
  pipeline: FieldMappingResponse["pipeline"],
): PipelineStep[] {
  if (!pipeline?.length) return [];
  return pipeline.map((op) => {
    const meta: Record<string, unknown> = {};
    if (typeof op.op === "string") meta.op = op.op;
    if (op.value !== undefined) meta.value = op.value;
    if (typeof op.condition === "string") meta.condition = op.condition;
    const step: PipelineStep = {
      kind: op.kind,
      sourceField: typeof op.sourceField === "string" ? op.sourceField : undefined,
      labelSource: "model",
      summary: typeof op.summary === "string" ? op.summary : undefined,
    };
    if (Object.keys(meta).length > 0) step.meta = meta;
    return step;
  });
}

/**
 * Offline import gate: only TRANSFORM/CONSTANT must be evidenced in the slice.
 * READ is skipped here (schema paths often unavailable at import).
 */
export function ungroundedOfflineTransformOrConstant(options: {
  field: string;
  pipeline: FieldMappingResponse["pipeline"];
  sliceText: string;
}): UngroundedStep[] {
  const steps = pipelineResponseToSteps(options.pipeline);
  return checkPipelineGrounding({
    field: options.field,
    pipeline: steps,
    sliceText: options.sliceText,
  }).filter((u) => u.kind === "TRANSFORM" || u.kind === "CONSTANT");
}

export interface OfflineGroundingFieldInput {
  javaTargetField: string;
  response: FieldMappingResponse;
  sliceText?: string;
}

/**
 * Collect grounding violations for offline import.
 * Fields without a slice are skipped (nothing to evidence against).
 * Unrecognized / empty pipelines are skipped.
 */
export function collectOfflineGroundingViolations(
  fields: OfflineGroundingFieldInput[],
): UngroundedStep[] {
  const out: UngroundedStep[] = [];
  for (const f of fields) {
    if (!f.response.recognized || !f.response.pipeline?.length) continue;
    const slice = f.sliceText?.trim();
    if (!slice) continue;
    out.push(
      ...ungroundedOfflineTransformOrConstant({
        field: f.javaTargetField,
        pipeline: f.response.pipeline,
        sliceText: slice,
      }),
    );
  }
  return out;
}

/**
 * Hard-reject helper for label:import. No-op when allowUngrounded or not offline.
 * Throws Error with actionable message when TRANSFORM/CONSTANT steps are ungrounded.
 */
export function assertOfflineImportGrounded(options: {
  labelModel: string | undefined;
  allowUngrounded?: boolean;
  fields: OfflineGroundingFieldInput[];
}): void {
  if (options.allowUngrounded) return;
  if (!isOfflineLabelModel(options.labelModel)) return;

  const violations = collectOfflineGroundingViolations(options.fields);
  if (violations.length === 0) return;

  const lines = violations.map((v) => `  - ${v.field}: ${v.detail}`);
  throw new Error(
    [
      "Offline import rejected: ungrounded TRANSFORM/CONSTANT step(s) not evidenced in the job slice.",
      ...lines,
      "Re-label from fields[].slice (drop invented ops; emit helper-body filters), then re-import.",
      "Escape hatch: npm run label:import -- --allow-ungrounded …",
    ].join("\n"),
  );
}
