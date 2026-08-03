/**
 * Collapse a flat operation list into one mapping entry per target field.
 * READ + TRANSFORM (etc.) for the same target become one element's pipeline.
 */

export interface PipelineOp {
  kind: string;
  targetField?: string;
  sourceField?: string;
  condition?: string;
  meta?: Record<string, unknown>;
  labelSource?: string;
  labelReason?: string;
  [key: string]: unknown;
}

export interface FieldMapping {
  targetField: string;
  pipeline: PipelineOp[];
}

function stripTargetField(op: PipelineOp): PipelineOp {
  const { targetField: _t, children: _c, sourceText: _s, ...rest } = op;
  return rest;
}

/**
 * Group sequential ops by targetField. Ops without a target (e.g. FILTER markers)
 * are prepended to the next field mapping's pipeline.
 */
export function groupOperationsByTarget(ops: PipelineOp[]): FieldMapping[] {
  const mapping: FieldMapping[] = [];
  let pending: PipelineOp[] = [];

  for (const op of ops) {
    const kind = (op.kind ?? "").toUpperCase();
    if (kind === "WRITE" && op.targetField === "<return>") {
      continue;
    }

    if (!op.targetField) {
      pending.push(stripTargetField(op));
      continue;
    }

    const clean = stripTargetField(op);
    const existing = mapping.find((m) => m.targetField === op.targetField);
    if (existing) {
      existing.pipeline.push(...pending, clean);
      pending = [];
    } else {
      mapping.push({
        targetField: op.targetField,
        pipeline: [...pending, clean],
      });
      pending = [];
    }
  }

  return mapping;
}
