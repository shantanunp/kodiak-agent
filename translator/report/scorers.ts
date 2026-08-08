/**
 * EVAL-2 — rule-based labeling scorers (no model).
 * Emitted into the run journal and surfaced by `npm run report`.
 */

import type { FieldMappingJson, PipelineStep } from "../model/labeler.js";
import type { LabelTasks } from "../agentloop/tasks.js";
import { groundingDiagnostics } from "../agentloop/grounding.js";

export interface LabelScores {
  /** mapped ÷ declared (0..1) */
  coverage: number;
  /** 1 − (ungrounded steps ÷ total steps) */
  grounding: number;
  /** 1 − (RAW steps ÷ total steps) — higher is more specific */
  specificity: number;
  /** mapped fields that have ≥1 write-site line in their slice ÷ mapped */
  provenance: number;
  ungroundedSteps: number;
  rawSteps: number;
  totalSteps: number;
}

export function scoreLabeling(options: {
  tasks: LabelTasks;
  mapping: FieldMappingJson[];
}): LabelScores {
  const declared = options.tasks.report.declaredFields || 1;
  const mapped = options.mapping.length;
  const coverage = Math.min(1, mapped / declared);

  const sliceByField = new Map(
    options.tasks.tasks.map((t) => [t.field, t.sliceText] as const),
  );
  const ungrounded = groundingDiagnostics(options.mapping, sliceByField);
  let totalSteps = 0;
  let rawSteps = 0;
  for (const m of options.mapping) {
    for (const s of m.pipeline) {
      totalSteps++;
      if (String(s.kind).toUpperCase() === "RAW") rawSteps++;
    }
  }
  const grounding =
    totalSteps === 0 ? 1 : Math.max(0, 1 - ungrounded.length / totalSteps);
  const specificity = totalSteps === 0 ? 1 : Math.max(0, 1 - rawSteps / totalSteps);

  let withProvenance = 0;
  for (const m of options.mapping) {
    const task = options.tasks.tasks.find(
      (t) =>
        t.field === m.targetField ||
        t.field.endsWith("." + m.targetField.split(".").pop()),
    );
    const hasLine =
      (task?.slices.some((s) => s.line > 0) ?? false) ||
      /line\s+\d+/i.test(task?.sliceText ?? "");
    if (hasLine) withProvenance++;
  }
  const provenance = mapped === 0 ? 1 : withProvenance / mapped;

  return {
    coverage: round4(coverage),
    grounding: round4(grounding),
    specificity: round4(specificity),
    provenance: round4(provenance),
    ungroundedSteps: ungrounded.length,
    rawSteps,
    totalSteps,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Compact scores for journal embedding. */
export function scoresForJournal(scores: LabelScores): Record<string, number> {
  return {
    coverage: scores.coverage,
    grounding: scores.grounding,
    specificity: scores.specificity,
    provenance: scores.provenance,
  };
}
