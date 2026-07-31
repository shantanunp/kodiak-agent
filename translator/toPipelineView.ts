/**
 * Converts indexer/labeler pipeline JSON → read-only UI view model
 * (same step vocabulary as mock/field-mapper-builder.html).
 */

import type { PipelineJson, PipelineStep } from "./labeler.js";
import { loadSchema } from "../schema/io.js";
import { flattenPaths } from "../schema/flatten.js";
import type { SchemaNode } from "../schema/types.js";

export type ViewStepKind =
  | "read"
  | "filter"
  | "select"
  | "transform"
  | "build"
  | "write"
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
  children?: ViewStep[];
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
  steps: ViewStep[];
  sourceFile?: string;
  labeledAt?: string;
  labelModel?: string;
  readOnly: true;
  schemaRef?: string;
  sourceSchema?: SchemaNode;
  targetSchema?: SchemaNode;
}

/** Known field hints when registry does not list them explicitly. */
const MAPPER_SCHEMA_HINTS: Record<
  string,
  { sourceFields: string[]; targetFields: string[]; isList?: boolean }
> = {
  "demo-ai-recognition-mapper": {
    sourceFields: ["Person.firstName", "Person.lastName"],
    targetFields: ["Summary.displayName"],
    isList: false,
  },
  "lpa-request-mapper": {
    sourceFields: ["LoanApplicationRequest.*"],
    targetFields: ["LPALoanAssessmentServiceRequest.*"],
    isList: false,
  },
};

export function simpleTypeName(fqcn: string): string {
  const idx = Math.max(fqcn.lastIndexOf("$"), fqcn.lastIndexOf("."));
  return idx >= 0 ? fqcn.slice(idx + 1) : fqcn;
}

function prefixField(typeSimple: string, field: string): string {
  if (!field || field.includes(".")) return field;
  return `${typeSimple}.${field}`;
}

function formatWriteTarget(targetField: string | undefined, targetSimple: string): string {
  if (!targetField) return targetSimple;
  if (targetField === "<return>") return `${targetSimple}.<return>`;
  if (targetField.includes(".")) return targetField;
  return `${targetSimple}.${targetField}`;
}

function expandWriteStep(step: PipelineStep, sourceSimple: string, targetSimple: string): ViewStep[] {
  const target = formatWriteTarget(step.targetField, targetSimple);
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
      {
        kind: "write",
        target,
        sourceText: text,
        labelSource: step.labelSource,
        labelReason: step.labelReason,
      },
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
      {
        kind: "write",
        target,
        sourceText: text,
        labelSource: step.labelSource,
      },
    ];
  }

  return [
    {
      kind: "write",
      target,
      sourceText: text,
      labelSource: step.labelSource,
      labelReason: step.labelReason,
    },
  ];
}

function convertStep(
  step: PipelineStep,
  sourceSimple: string,
  targetSimple: string,
): ViewStep[] {
  const kind = (step.kind ?? "raw").toLowerCase();

  if (kind === "raw") {
    return [
      {
        kind: "raw",
        sourceText: step.sourceText,
        labelSource: step.labelSource,
        labelReason: step.labelReason ?? "Unclassified Java — needs review",
      },
    ];
  }

  if (kind === "write" && step.targetField === "<return>") {
    return [];
  }

  if (kind === "filter") {
    const children =
      step.children?.flatMap((c) => convertStep(c as PipelineStep, sourceSimple, targetSimple)) ??
      [];
    return [
      {
        kind: "filter",
        op: "matches",
        value: step.condition ?? step.sourceText,
        sourceText: step.sourceText,
        labelSource: step.labelSource,
        children,
      },
    ];
  }

  if (kind === "build") {
    return [
      {
        kind: "build",
        rows: step.targetField
          ? [{ source: step.sourceField ?? "", target: step.targetField }]
          : [],
        repeat: false,
        sourceText: step.sourceText,
        labelSource: step.labelSource,
        labelReason: step.labelReason,
      },
    ];
  }

  if (kind === "write") {
    return expandWriteStep(step, sourceSimple, targetSimple);
  }

  if (kind === "read") {
    return [
      {
        kind: "read",
        field: prefixField(sourceSimple, step.sourceField ?? step.targetField ?? ""),
        sourceText: step.sourceText,
        labelSource: step.labelSource,
      },
    ];
  }

  return [
    {
      kind: kind as ViewStepKind,
      sourceText: step.sourceText,
      target: step.targetField ? formatWriteTarget(step.targetField, targetSimple) : undefined,
      field: step.sourceField,
      labelSource: step.labelSource,
      labelReason: step.labelReason,
    },
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

export function toPipelineView(pipeline: PipelineJson): PipelineViewModel {
  const mapperId = pipeline.mapperId ?? "unknown";
  const sourceType = pipeline.sourceType ?? "Source";
  const targetType = pipeline.targetType ?? "Target";
  const sourceSimple = simpleTypeName(sourceType);
  const targetSimple = simpleTypeName(targetType);

  const hints = MAPPER_SCHEMA_HINTS[mapperId];
  const savedSchema = loadSchema(mapperId);

  const steps = pipeline.steps.flatMap((s) =>
    convertStep(s, sourceSimple, targetSimple),
  );

  const collected = collectFields(steps);
  const schemaSourceFields = savedSchema ? flattenPaths(savedSchema.source.root) : [];
  const schemaTargetFields = savedSchema ? flattenPaths(savedSchema.target.root) : [];

  const sourceFields = schemaSourceFields.length
    ? schemaSourceFields
    : hints?.sourceFields ?? [...collected.source].sort();
  const targetFields = schemaTargetFields.length
    ? schemaTargetFields
    : hints?.targetFields ?? [...collected.target].sort();

  return {
    mapperId,
    className: pipeline.className,
    entryMethod: pipeline.entryMethod,
    sourceType,
    targetType,
    sourceSimple,
    targetSimple,
    target: targetSimple,
    isList: hints?.isList ?? false,
    sourceFields,
    targetFields,
    steps,
    sourceFile: (pipeline as { sourceFile?: string }).sourceFile,
    labeledAt: pipeline.labeledAt,
    labelModel: pipeline.labelModel,
    readOnly: true,
    schemaRef: savedSchema ? `${mapperId}.schema.json` : undefined,
    sourceSchema: savedSchema?.source.root,
    targetSchema: savedSchema?.target.root,
  };
}
