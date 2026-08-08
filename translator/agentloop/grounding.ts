/**
 * AGT-1 — rule-based grounding check (no model).
 * Every TRANSFORM op / READ sourceField / CONSTANT value should be evidenced
 * by the field's slice (or known schema paths). Violations → ungrounded-step.
 */

import type { FieldMappingJson, PipelineStep } from "../model/labeler.js";

export interface UngroundedStep {
  field: string;
  kind: string;
  detail: string;
}

function stepOp(step: PipelineStep): string | undefined {
  const op = step.meta && typeof step.meta === "object" ? (step.meta as { op?: unknown }).op : undefined;
  return typeof op === "string" ? op : undefined;
}

function stepValue(step: PipelineStep): unknown {
  if (step.meta && typeof step.meta === "object" && "value" in step.meta) {
    return (step.meta as { value?: unknown }).value;
  }
  return undefined;
}

/** Normalize for loose presence checks in slice text. */
function looseIncludes(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h.includes(n)) return true;
  // camelCase / dotted leaf
  const leaf = n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : n;
  return leaf.length >= 2 && h.includes(leaf);
}

export function checkPipelineGrounding(options: {
  field: string;
  pipeline: PipelineStep[];
  sliceText: string;
  /** Known schema / source paths the model may READ from. */
  schemaPaths?: string[];
}): UngroundedStep[] {
  const { field, pipeline, sliceText, schemaPaths = [] } = options;
  const schemaSet = new Set(schemaPaths.map((p) => p.toLowerCase()));
  const schemaLeaves = new Set(
    schemaPaths.map((p) => p.split(".").pop()!.toLowerCase()),
  );
  const out: UngroundedStep[] = [];

  for (const step of pipeline) {
    const kind = String(step.kind || "").toUpperCase();

    if (kind === "READ") {
      const src = step.sourceField;
      if (!src) {
        out.push({ field, kind, detail: "READ missing sourceField" });
        continue;
      }
      const inSchema =
        schemaSet.has(src.toLowerCase()) ||
        schemaLeaves.has(src.split(".").pop()!.toLowerCase());
      const inSlice = looseIncludes(sliceText, src);
      if (!inSchema && !inSlice) {
        out.push({
          field,
          kind,
          detail: `READ sourceField "${src}" not in schema paths or slice`,
        });
      }
    }

    if (kind === "TRANSFORM") {
      const op = stepOp(step);
      if (op && !looseIncludes(sliceText, op)) {
        // Common op aliases that may not appear literally (multiply → *, trim → trimValue).
        const aliases: Record<string, string[]> = {
          multiply: ["*", "multiply"],
          keepdigits: ["isdigit", "keepdigits", "digit"],
          lettersonly: ["isletter", "letter"],
          uppercase: ["toupper", "uppercase", "toUpperCase"],
          lowercase: ["tolower", "lowercase", "toLowerCase"],
          trim: ["trim"],
          split: ["split"],
          takefirst: ["[0]", "takefirst", "parts[0]"],
          takelast: ["takelast", "parts["],
        };
        const keys = aliases[op.toLowerCase()] ?? [op];
        const ok = keys.some((k) => looseIncludes(sliceText, k));
        if (!ok) {
          out.push({
            field,
            kind,
            detail: `TRANSFORM op "${op}" not evidenced in slice`,
          });
        }
      }
    }

    if (kind === "CONSTANT") {
      const val = stepValue(step);
      if (val != null && val !== "") {
        const lit = typeof val === "string" ? val : JSON.stringify(val);
        // booleans/numbers often appear as literals true/false/360
        if (!looseIncludes(sliceText, lit) && !sliceText.includes(String(val))) {
          out.push({
            field,
            kind,
            detail: `CONSTANT value ${lit} not found as literal in slice`,
          });
        }
      }
    }
  }

  return out;
}

export function groundingDiagnostics(
  mapping: FieldMappingJson[],
  sliceByField: Map<string, string>,
  schemaPaths?: string[],
): string[] {
  const diags: string[] = [];
  for (const m of mapping) {
    const slice =
      sliceByField.get(m.targetField) ??
      sliceByField.get(m.targetField.split(".").pop()!.toLowerCase()) ??
      "";
    // Also try matching by leaf key
    let sliceText = slice;
    if (!sliceText) {
      for (const [k, v] of sliceByField) {
        if (
          k.toLowerCase() === m.targetField.toLowerCase() ||
          k.endsWith("." + m.targetField.split(".").pop()!.toLowerCase()) ||
          m.targetField.toLowerCase().endsWith("." + k.toLowerCase())
        ) {
          sliceText = v;
          break;
        }
      }
    }
    for (const u of checkPipelineGrounding({
      field: m.targetField,
      pipeline: m.pipeline,
      sliceText,
      schemaPaths,
    })) {
      diags.push(`ungrounded-step ${u.field}: ${u.detail}`);
    }
  }
  return diags;
}
