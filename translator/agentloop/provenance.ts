/**
 * Confidence / provenance tags for labeled fields.
 * Surfaced in the viewer so reviewers know where to look first.
 */

export type LabelProvenance =
  | "verified"
  | "corrected"
  | "pending-review"
  | "cache"
  | "slice"
  | "escalation"
  | "tool-loop"
  | "cross-check";

export const PROVENANCE_LABELS: Record<LabelProvenance, string> = {
  verified: "verified store",
  corrected: "user-corrected",
  "pending-review": "pending review",
  cache: "field cache",
  slice: "labeled from slice",
  escalation: "needed escalation",
  "tool-loop": "needed tool loop",
  "cross-check": "cross-check flip",
};

/** Infer how a field reached the model path (before cache/store). */
export function provenanceForTask(options: {
  taskState: "mapped" | "unmapped" | "unresolved";
  note?: string;
  usedToolLoop: boolean;
  usedEscalationRetry: boolean;
}): LabelProvenance {
  if (options.usedToolLoop) return "tool-loop";
  if (options.note?.startsWith("cross-check:")) return "cross-check";
  if (options.taskState === "unresolved" || options.usedEscalationRetry) {
    return "escalation";
  }
  return "slice";
}
