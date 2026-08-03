/**
 * Converts indexer/labeler pipeline JSON → read-only UI view model
 * (same step vocabulary as mock/field-mapper-builder.html).
 */

import type { PipelineJson, PipelineStep } from "./model/index.js";
import { operationsOf } from "./model/index.js";
import { loadSchema } from "../schema/io.js";
import { flattenPaths } from "../schema/flatten.js";
import type { SchemaNode } from "../schema/types.js";

/** Flatten grouped mapping back to ops with targetField for the view adapter. */
function flattenPipeline(pipeline: PipelineJson): PipelineStep[] {
  if (pipeline.mapping?.length) {
    return pipeline.mapping.flatMap((m) =>
      m.pipeline.map((op) => ({ ...op, targetField: m.targetField })),
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
    sourceFields: [
      "LoanApplicationRequest.refNumber",
      "LoanApplicationRequest.applicant.displayName",
      "LoanApplicationRequest.applicant.dateOfBirth",
      "LoanApplicationRequest.mortgage.amount",
      "LoanApplicationRequest.mortgage.ratePercent",
      "LoanApplicationRequest.mortgage.purpose",
      "LoanApplicationRequest.mortgage.termYears",
      "LoanApplicationRequest.property.street",
      "LoanApplicationRequest.property.city",
      "LoanApplicationRequest.property.state",
      "LoanApplicationRequest.property.postalCode",
    ],
    targetFields: [
      "MESSAGE.MISMOReferenceModelIdentifier",
      "MESSAGE.DataVersionIdentifier",
      "MESSAGE.DEAL.LOAN.LoanIdentifier",
      "MESSAGE.DEAL.LOAN.NoteAmount",
      "MESSAGE.DEAL.LOAN.LoanPurposeType",
      "MESSAGE.DEAL.LOAN.LoanMaturityPeriodCount",
      "MESSAGE.DEAL.PARTY.FirstName",
      "MESSAGE.DEAL.PARTY.LastName",
      "MESSAGE.DEAL.PARTY.FullName",
      "MESSAGE.DEAL.PARTY.PartyRoleType",
      "MESSAGE.DEAL.PARTY.BorrowerBirthDate",
      "MESSAGE.DEAL.COLLATERAL.AddressLineText",
      "MESSAGE.DEAL.COLLATERAL.CityName",
      "MESSAGE.DEAL.COLLATERAL.StateCode",
      "MESSAGE.DEAL.COLLATERAL.PostalCode",
    ],
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
  schemaTargetFields: string[] = [],
): ViewStep[] {
  const kind = (step.kind ?? "raw").toLowerCase();

  if (kind === "write" && step.targetField === "<return>") {
    return [];
  }

  if (kind === "constant") {
    const target = formatWriteTarget(step.targetField, targetSimple, schemaTargetFields);
    return [
      {
        kind: "constant",
        target,
        value: constantValue(step),
        labelSource: step.labelSource,
        labelReason: step.labelReason,
      },
    ];
  }

  if (kind === "filter") {
    return [
      {
        kind: "filter",
        op: "matches",
        value: step.condition,
        labelSource: step.labelSource,
        labelReason: step.labelReason,
      },
    ];
  }

  if (kind === "transform") {
    const opRaw = typeof step.meta?.op === "string" ? step.meta.op : "transform";
    const opLabel =
      opRaw === "multiply"
        ? "Multiply"
        : opRaw === "add"
          ? "Add"
          : opRaw === "subtract"
            ? "Subtract"
            : opRaw === "divide"
              ? "Divide"
              : opRaw === "trim"
                ? "Trim"
                : opRaw === "split"
                  ? "Split"
                  : opRaw === "takefirst"
                    ? "Take first"
                    : opRaw === "takelast"
                      ? "Take last"
                      : opRaw === "takeindex"
                        ? "Take index"
                        : opRaw;
    const param = step.meta?.value;
    return [
      {
        kind: "transform",
        op: opLabel,
        param: param != null ? (Number.isNaN(Number(param)) ? String(param) : Number(param)) : undefined,
        target: formatWriteTarget(step.targetField, targetSimple, schemaTargetFields),
        field: step.sourceField,
        labelSource: step.labelSource,
        labelReason: step.labelReason,
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
        labelSource: step.labelSource,
        labelReason: step.labelReason,
      },
    ];
  }

  if (kind === "write") {
    return expandWriteStep(step, sourceSimple, targetSimple, schemaTargetFields);
  }

  if (kind === "read") {
    return [
      {
        kind: "read",
        field: step.sourceField ?? prefixField(sourceSimple, step.targetField ?? ""),
        target: step.targetField
          ? formatWriteTarget(step.targetField, targetSimple, schemaTargetFields)
          : undefined,
        labelSource: step.labelSource,
        labelReason: step.labelReason,
      },
    ];
  }

  if (kind === "raw") {
    const code = typeof step.meta?.code === "string" ? step.meta.code : step.sourceText;
    return [
      {
        kind: "raw",
        sourceText: code,
        labelSource: step.labelSource,
        labelReason: step.labelReason ?? "Unclassified Java — needs review",
      },
    ];
  }

  return [
    {
      kind: kind as ViewStepKind,
      target: step.targetField
        ? formatWriteTarget(step.targetField, targetSimple, schemaTargetFields)
        : undefined,
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

  const schemaSourceFields = savedSchema ? flattenPaths(savedSchema.source.root) : [];
  const schemaTargetFields = savedSchema ? flattenPaths(savedSchema.target.root) : [];
  const targetPathHints =
    schemaTargetFields.length > 0 ? schemaTargetFields : hints?.targetFields ?? [];

  const steps = flattenPipeline(pipeline).flatMap((s) =>
    convertStep(s, sourceSimple, targetSimple, targetPathHints),
  );

  const collected = collectFields(steps);

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
