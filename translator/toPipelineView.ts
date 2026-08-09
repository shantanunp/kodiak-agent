/**
 * Converts labeler pipeline JSON → read-only UI view model
 * (same step vocabulary as mock/field-mapper-builder.html).
 */

import type { PipelineJson, PipelineStep } from "./model/index.js";
import { operationsOf } from "./model/index.js";
import { loadSchema } from "../schema/io.js";
import { flattenPaths } from "../schema/flatten.js";
import type { SchemaNode } from "../schema/types.js";

/**
 * Flatten one field's pipeline: attach targetField, carry READ source onto
 * following transforms, and ensure a terminal WRITE for the UI.
 */
function flattenFieldPipeline(
  targetField: string,
  pipeline: PipelineStep[],
): PipelineStep[] {
  let lastSource: string | undefined;
  const ops: PipelineStep[] = pipeline.map((op) => {
    const kind = (op.kind ?? "").toUpperCase();
    if (kind === "READ" && typeof op.sourceField === "string") {
      lastSource = op.sourceField;
    }
    const next: PipelineStep = { ...op, targetField };
    if (
      (kind === "TRANSFORM" || kind === "FILTER") &&
      !next.sourceField &&
      lastSource
    ) {
      next.sourceField = lastSource;
    }
    return next;
  });

  const hasWrite = ops.some((op) => (op.kind ?? "").toUpperCase() === "WRITE");
  if (!hasWrite && targetField) {
    const last = ops[ops.length - 1];
    ops.push({
      kind: "WRITE",
      targetField,
      labelSource: last?.labelSource,
      // reason is shown once per field in the viewer — keep WRITE clean
    });
  }

  // Field-level reason stays on the first step for the bottom summary.
  // Per-step AI "summary" is kept on every op for the stage cards.
  const reason = ops.find((op) => op.labelReason)?.labelReason;
  if (reason) {
    return ops.map((op, i) =>
      i === 0
        ? { ...op, labelReason: reason }
        : { ...op, labelReason: undefined },
    );
  }
  return ops;
}

/** Flatten grouped mapping back to ops with targetField for the view adapter. */
function flattenPipeline(pipeline: PipelineJson): PipelineStep[] {
  if (pipeline.mapping?.length) {
    return pipeline.mapping.flatMap((m) =>
      flattenFieldPipeline(m.targetField, m.pipeline),
    );
  }
  return operationsOf(pipeline) as PipelineStep[];
}

export type ViewStepKind =
  | "read"
  | "filter"
  | "select"
  | "transform"
  | "build"
  | "write"
  | "constant"
  | "raw";

export interface ViewStep {
  kind: ViewStepKind;
  field?: string;
  field2?: string;
  target?: string;
  op?: string;
  value?: string;
  mode?: string;
  param?: string | number;
  rows?: Array<{ source: string; target: string }>;
  repeat?: boolean;
  sourceText?: string;
  labelSource?: string;
  labelReason?: string;
  /** Per-step summary from the model. */
  summary?: string;
  children?: ViewStep[];
}

export interface FieldPipelineView {
  targetField: string;
  steps: ViewStep[];
}

export interface PipelineViewModel {
  mapperId: string;
  className?: string;
  entryMethod?: string;
  sourceType: string;
  targetType: string;
  sourceSimple: string;
  targetSimple: string;
  target: string;
  isList: boolean;
  sourceFields: string[];
  targetFields: string[];
  /** Flat steps (all fields). Prefer `fields` when present. */
  steps: ViewStep[];
  /** Per-target pipelines for tabbed UI. */
  fields?: FieldPipelineView[];
  sourceFile?: string;
  labeledAt?: string;
  labelModel?: string;
  readOnly: true;
  schemaRef?: string;
  sourceSchema?: SchemaNode;
  targetSchema?: SchemaNode;
}

export function simpleTypeName(fqcn: string): string {
  const idx = Math.max(fqcn.lastIndexOf("$"), fqcn.lastIndexOf("."));
  return idx >= 0 ? fqcn.slice(idx + 1) : fqcn;
}

function prefixField(typeSimple: string, field: string): string {
  if (!field || field.includes(".")) return field;
  return `${typeSimple}.${field}`;
}

function normalizeLeaf(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function fieldLeaf(targetField: string): string {
  const leaf = targetField.includes(".")
    ? targetField.slice(targetField.lastIndexOf(".") + 1)
    : targetField;
  return leaf.replace(/\[\]$/, "");
}

function matchSchemaPath(targetField: string, schemaTargetFields: string[]): string | undefined {
  const want = normalizeLeaf(fieldLeaf(targetField));
  return schemaTargetFields.find((p) => {
    const leaf = p.split(".").pop()?.replace(/\[\]$/, "") ?? "";
    return normalizeLeaf(leaf) === want;
  });
}

function formatWriteTarget(
  targetField: string | undefined,
  targetSimple: string,
  schemaTargetFields: string[] = [],
): string {
  if (!targetField) return targetSimple;
  if (targetField === "<return>") return `${targetSimple}.<return>`;

  const schemaMatch = matchSchemaPath(targetField, schemaTargetFields);
  if (schemaMatch) return schemaMatch;

  // Already a path / Java FQN — keep as-is when no schema match
  if (targetField.includes(".") || targetField.includes("$")) return targetField;

  return `${targetSimple}.${targetField}`;
}

function constantValue(step: PipelineStep): string | undefined {
  const metaVal = step.meta?.value;
  if (typeof metaVal === "string" || typeof metaVal === "number" || typeof metaVal === "boolean") {
    return String(metaVal);
  }
  return undefined;
}

/**
 * Coerce transform meta.value for the view model.
 * Numeric strings → number; everything else stays a string.
 *
 * Important: Number(" ") === 0 in JS (whitespace coerces to 0). Split
 * delimiters like " " / "\\t" must not be treated as numbers.
 */
export function coerceViewParam(param: unknown): string | number | undefined {
  if (param == null) return undefined;
  if (typeof param === "number") return Number.isNaN(param) ? undefined : param;
  if (typeof param === "boolean") return String(param);
  const s = String(param);
  // Empty / whitespace-only are delimiter values, never numbers.
  if (s.trim() === "") return s;
  const n = Number(s);
  return Number.isNaN(n) ? s : n;
}

function withSummary<T extends ViewStep>(view: T, step: PipelineStep): T {
  if (typeof step.summary === "string" && step.summary.trim()) {
    return { ...view, summary: step.summary.trim() };
  }
  return view;
}

function expandWriteStep(
  step: PipelineStep,
  sourceSimple: string,
  targetSimple: string,
  schemaTargetFields: string[],
): ViewStep[] {
  const target = formatWriteTarget(step.targetField, targetSimple, schemaTargetFields);
  const text = step.sourceText ?? "";

  if (
    text.includes("getFirstName()") &&
    text.includes("getLastName()") &&
    text.includes("+")
  ) {
    const f1 = `${sourceSimple}.firstName`;
    const f2 = `${sourceSimple}.lastName`;
    return [
      { kind: "read", field: f1 },
      { kind: "read", field: f2 },
      {
        kind: "transform",
        op: "Join text",
        field: f1,
        field2: f2,
        param: " ",
        labelSource: step.labelSource,
      },
      withSummary(
        {
          kind: "write",
          target,
          sourceText: text,
          labelSource: step.labelSource,
          labelReason: step.labelReason,
        },
        step,
      ),
    ];
  }

  if (text.includes(".toUpperCase()")) {
    return [
      {
        kind: "transform",
        op: "Uppercase",
        field: target.replace(/\.[^.]+$/, ".displayName"),
        labelSource: step.labelSource,
      },
      withSummary(
        {
          kind: "write",
          target,
          sourceText: text,
          labelSource: step.labelSource,
        },
        step,
      ),
    ];
  }

  return [
    withSummary(
      {
        kind: "write",
        target,
        sourceText: text,
        labelSource: step.labelSource,
        labelReason: step.labelReason,
      },
      step,
    ),
  ];
}

function convertStep(
  step: PipelineStep,
  sourceSimple: string,
  targetSimple: string,
  schemaTargetFields: string[] = [],
): ViewStep[] {
  const kind = (step.kind ?? "raw").toLowerCase();

  if (kind === "write" && step.targetField === "<return>") {
    return [];
  }

  if (kind === "constant") {
    const target = formatWriteTarget(step.targetField, targetSimple, schemaTargetFields);
    return [
      withSummary(
        {
          kind: "constant",
          target,
          value: constantValue(step),
          labelSource: step.labelSource,
          labelReason: step.labelReason,
        },
        step,
      ),
    ];
  }

  if (kind === "filter") {
    return [
      withSummary(
        {
          kind: "filter",
          op: "matches",
          value: step.condition,
          labelSource: step.labelSource,
          labelReason: step.labelReason,
        },
        step,
      ),
    ];
  }

  if (kind === "transform") {
    const opRaw = typeof step.meta?.op === "string" ? step.meta.op : "transform";
    const opLabels: Record<string, string> = {
      multiply: "Multiply",
      add: "Add",
      subtract: "Subtract",
      divide: "Divide",
      trim: "Trim",
      split: "Split",
      takefirst: "Take first",
      takelast: "Take last",
      takeindex: "Take index",
      uppercase: "Uppercase",
      lowercase: "Lowercase",
      join: "Join",
      lettersonly: "Letters only",
      keepdigits: "Keep digits",
      keepdigitsandhyphen: "Keep digits",
    };
    const opLabel = opLabels[opRaw.toLowerCase()] ?? opRaw;
    return [
      withSummary(
        {
          kind: "transform",
          op: opLabel,
          param: coerceViewParam(step.meta?.value),
          target: formatWriteTarget(step.targetField, targetSimple, schemaTargetFields),
          field: step.sourceField,
          labelSource: step.labelSource,
          labelReason: step.labelReason,
        },
        step,
      ),
    ];
  }

  if (kind === "build") {
    return [
      withSummary(
        {
          kind: "build",
          rows: step.targetField
            ? [{ source: step.sourceField ?? "", target: step.targetField }]
            : [],
          repeat: false,
          labelSource: step.labelSource,
          labelReason: step.labelReason,
        },
        step,
      ),
    ];
  }

  if (kind === "write") {
    const expanded = expandWriteStep(step, sourceSimple, targetSimple, schemaTargetFields);
    // Drop empty sourceText from synthetic writes (noise in JSON / UI).
    return expanded.map((s) =>
      s.kind === "write" && !s.sourceText
        ? { ...s, sourceText: undefined }
        : s,
    );
  }

  if (kind === "read") {
    return [
      withSummary(
        {
          kind: "read",
          field: step.sourceField ?? prefixField(sourceSimple, step.targetField ?? ""),
          target: step.targetField
            ? formatWriteTarget(step.targetField, targetSimple, schemaTargetFields)
            : undefined,
          labelSource: step.labelSource,
          labelReason: step.labelReason,
        },
        step,
      ),
    ];
  }

  if (kind === "raw") {
    const code = typeof step.meta?.code === "string" ? step.meta.code : step.sourceText;
    return [
      withSummary(
        {
          kind: "raw",
          sourceText: code,
          labelSource: step.labelSource,
          labelReason: step.labelReason ?? "Unclassified Java — needs review",
        },
        step,
      ),
    ];
  }

  return [
    withSummary(
      {
        kind: kind as ViewStepKind,
        target: step.targetField
          ? formatWriteTarget(step.targetField, targetSimple, schemaTargetFields)
          : undefined,
        field: step.sourceField,
        labelSource: step.labelSource,
        labelReason: step.labelReason,
      },
      step,
    ),
  ];
}

function collectFields(steps: ViewStep[]): { source: Set<string>; target: Set<string> } {
  const source = new Set<string>();
  const target = new Set<string>();

  function walk(list: ViewStep[]): void {
    for (const s of list) {
      if (s.field) source.add(s.field);
      if (s.field2) source.add(s.field2);
      if (s.target && !s.target.includes("<return>")) target.add(s.target);
      s.rows?.forEach((r) => {
        if (r.source) source.add(r.source);
        if (r.target) target.add(r.target);
      });
      if (s.children) walk(s.children);
    }
  }

  walk(steps);
  return { source, target };
}

/**
 * Nest FILTER outcomes as filter.children so if/else cascades render compactly.
 *
 * - FILTER → CONSTANT → nest the constant (typical literal branch)
 * - FILTER → TRANSFORM+ → nest transforms (true-branch transforms)
 * - FILTER → TRANSFORM+ → CONSTANT → nest transforms only; leave CONSTANT as the
 *   following else/default sibling (common in cascading if/else labels)
 */
export function foldConditionalBranches(steps: ViewStep[]): ViewStep[] {
  const out: ViewStep[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;
    if (step.kind !== "filter") {
      out.push(step);
      i += 1;
      continue;
    }

    i += 1;
    const children: ViewStep[] = [];
    while (i < steps.length && steps[i]!.kind === "transform") {
      children.push(steps[i]!);
      i += 1;
    }
    if (
      children.length === 0 &&
      i < steps.length &&
      steps[i]!.kind === "constant"
    ) {
      children.push(steps[i]!);
      i += 1;
    }

    out.push(children.length ? { ...step, children } : step);
  }
  return out;
}

export function toPipelineView(pipeline: PipelineJson): PipelineViewModel {
  const mapperId = pipeline.mapperId ?? "unknown";
  const sourceType = pipeline.sourceType ?? "Source";
  const targetType = pipeline.targetType ?? "Target";
  const sourceSimple = simpleTypeName(sourceType);
  const targetSimple = simpleTypeName(targetType);

  const savedSchema = loadSchema(mapperId);

  const schemaSourceFields = savedSchema ? flattenPaths(savedSchema.source.root) : [];
  const schemaTargetFields = savedSchema ? flattenPaths(savedSchema.target.root) : [];
  // Prefer saved schema paths; otherwise use fields discovered from the pipeline.
  const targetPathHints = schemaTargetFields;

  const fields: FieldPipelineView[] = (pipeline.mapping ?? []).map((m) => {
    const fieldSteps = foldConditionalBranches(
      flattenFieldPipeline(m.targetField, m.pipeline).flatMap((s) =>
        convertStep(s, sourceSimple, targetSimple, targetPathHints),
      ),
    );
    return {
      targetField: formatWriteTarget(m.targetField, targetSimple, targetPathHints),
      steps: fieldSteps,
    };
  });

  const steps =
    fields.length > 0
      ? fields.flatMap((f) => f.steps)
      : foldConditionalBranches(
          flattenPipeline(pipeline).flatMap((s) =>
            convertStep(s, sourceSimple, targetSimple, targetPathHints),
          ),
        );

  const collected = collectFields(steps);

  const sourceFields = schemaSourceFields.length
    ? schemaSourceFields
    : [...collected.source].sort();
  const targetFields = schemaTargetFields.length
    ? schemaTargetFields
    : [...collected.target].sort();

  const primaryTarget =
    fields.length === 1 ? fields[0]!.targetField : targetSimple;

  return {
    mapperId,
    className: pipeline.className,
    entryMethod: pipeline.entryMethod,
    sourceType,
    targetType,
    sourceSimple,
    targetSimple,
    target: primaryTarget,
    isList: false,
    sourceFields,
    targetFields,
    steps,
    fields: fields.length > 0 ? fields : undefined,
    sourceFile: (pipeline as { sourceFile?: string }).sourceFile,
    labeledAt: pipeline.labeledAt,
    labelModel: pipeline.labelModel,
    readOnly: true,
    schemaRef: savedSchema ? `${mapperId}.schema.json` : undefined,
    sourceSchema: savedSchema?.source.root,
    targetSchema: savedSchema?.target.root,
  };
}
