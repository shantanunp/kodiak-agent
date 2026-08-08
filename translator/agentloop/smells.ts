/**
 * AGT-2 — step-count sanity vs helper-closure depth.
 * A short pipeline from a deep helper chain is a smell (collapsed labeling).
 */

import type { FieldMappingJson } from "../model/labeler.js";
import type { FieldTask } from "./tasks.js";

export interface StepSmell {
  field: string;
  steps: number;
  closureDepth: number;
  detail: string;
}

export function closureDepth(task: FieldTask): number {
  const names = new Set<string>();
  for (const s of task.slices) {
    for (const h of s.helperClosure) names.add(h.name);
  }
  return names.size;
}

export function findStepSmells(
  mapping: FieldMappingJson[],
  tasks: FieldTask[],
): StepSmell[] {
  const byField = new Map(tasks.map((t) => [t.field.toLowerCase(), t]));
  const out: StepSmell[] = [];

  for (const m of mapping) {
    const task =
      byField.get(m.targetField.toLowerCase()) ??
      [...byField.values()].find(
        (t) =>
          t.field.toLowerCase() === m.targetField.toLowerCase() ||
          m.targetField.toLowerCase().endsWith("." + t.field.toLowerCase()) ||
          t.field.toLowerCase().endsWith("." + m.targetField.split(".").pop()!.toLowerCase()),
      );
    if (!task) continue;
    const depth = closureDepth(task);
    const steps = m.pipeline.length;
    // Deep helper chain but almost no steps → likely collapsed / missed transforms.
    if (depth >= 4 && steps > 0 && steps <= 2) {
      out.push({
        field: m.targetField,
        steps,
        closureDepth: depth,
        detail: `pipeline has ${steps} step(s) but slice helper closure has ${depth} method(s)`,
      });
    }
  }
  return out;
}

export function smellDiagnostics(smells: StepSmell[]): string[] {
  return smells.map(
    (s) => `step-smell ${s.field}: ${s.detail}`,
  );
}
