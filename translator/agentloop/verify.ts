/**
 * AGT-3 — self-consistency double-run (opt-in `--verify`).
 * Label each newly-modeled field a second time at temperature 0 and diff
 * ordered step kinds (+ key meta). Divergence → stderr + journal count.
 */

import type { ModelProvider, FieldMappingResponse } from "../model/provider.js";
import { applyFieldMappingResponse } from "../model/applyResponse.js";
import type { FieldMappingJson, PipelineStep } from "../model/labeler.js";
import type { FieldTask } from "./tasks.js";

export interface VerifyDivergence {
  field: string;
  firstKinds: string[];
  secondKinds: string[];
}

function stepSignature(step: PipelineStep): string {
  const kind = String(step.kind ?? "?").toUpperCase();
  const meta =
    step.meta && typeof step.meta === "object"
      ? (step.meta as Record<string, unknown>)
      : {};
  const bits = [
    kind,
    step.sourceField ? `src=${step.sourceField}` : "",
    step.condition ? `cond=${step.condition}` : "",
    meta.op != null ? `op=${meta.op}` : "",
    meta.value != null ? `val=${JSON.stringify(meta.value)}` : "",
  ].filter(Boolean);
  return bits.join("|");
}

export function pipelineSignatures(pipeline: PipelineStep[]): string[] {
  return pipeline.map(stepSignature);
}

export function pipelinesDiverge(a: PipelineStep[], b: PipelineStep[]): boolean {
  return JSON.stringify(pipelineSignatures(a)) !== JSON.stringify(pipelineSignatures(b));
}

/** Second-pass label at temp 0 when the provider supports it. */
export async function verifyFieldConsistency(options: {
  provider: ModelProvider;
  /** Optional second provider (temperature 0). Falls back to primary. */
  verifyProvider?: ModelProvider;
  task: FieldTask;
  first: FieldMappingJson;
  schemaContext?: string;
  indexerOps: unknown[];
}): Promise<VerifyDivergence | null> {
  const p = options.verifyProvider ?? options.provider;
  let response: FieldMappingResponse;
  try {
    response = await p.labelFieldMapping({
      javaTargetField: options.task.field,
      indexerOps: options.indexerOps,
      schemaContext: options.schemaContext,
    });
  } catch (err) {
    console.error(`[verify] ${options.task.field}: second pass failed: ${(err as Error).message}`);
    return null;
  }
  const second = applyFieldMappingResponse(
    { targetField: options.task.field, pipeline: [] },
    response ?? { recognized: false, reason: "no verify response" },
    "model",
  );
  if (!pipelinesDiverge(options.first.pipeline, second.pipeline)) return null;
  return {
    field: options.task.field,
    firstKinds: options.first.pipeline.map((s) => String(s.kind).toUpperCase()),
    secondKinds: second.pipeline.map((s) => String(s.kind).toUpperCase()),
  };
}
