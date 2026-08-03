/**
 * Phase 2 — AST operation labeler (Gemini Studio).
 *
 * Indexer supplies Java-path ops; Gemini rewrites every field to business/schema paths.
 * Never free-form parses Java source.
 */

import {
  GeminiLabelProvider,
  type FieldMappingResponse,
  type PipelineOpLabel,
} from "./geminiProvider.js";
import { loadGeminiConfig } from "./config.js";
import { getLabelCache, setLabelCache } from "./cache/index.js";
import { schemaContextForLabeler } from "../schema/io.js";
import { groupOperationsByTarget, type FieldMapping, type PipelineOp } from "./groupMapping.js";
import { filterMappingByFields } from "./filterByFields.js";

export interface AstStep {
  kind: string;
  targetField?: string;
  sourceField?: string;
  condition?: string;
  meta?: Record<string, unknown>;
  /** @deprecated use meta.code — kept for old cache entries */
  sourceText?: string;
  children?: AstStep[];
}

export interface IndexAst {
  mapperId?: string;
  className?: string;
  entryMethod?: string;
  sourceType?: string;
  targetType?: string;
  sourceFile?: string;
  /** Preferred flat pipeline list */
  operations?: AstStep[];
  /** @deprecated use operations */
  steps?: AstStep[];
}

export interface PipelineStep extends AstStep {
  labelSource?: "deterministic" | "gemini";
  labelReason?: string;
}

export interface FieldMappingJson {
  targetField: string;
  pipeline: PipelineStep[];
}

/**
 * Labeled pipeline. `npm run label` emits mapperId + mapping only (business paths).
 * Optional Java envelope fields remain for view export / ast passthrough.
 */
export interface PipelineJson {
  mapperId?: string;
  mapping: FieldMappingJson[];
  labeledAt?: string;
  labelModel?: string;
  className?: string;
  entryMethod?: string;
  sourceType?: string;
  targetType?: string;
  sourceFile?: string;
}

export function operationsOf(ast: IndexAst | { operations?: AstStep[]; steps?: AstStep[] }): AstStep[] {
  return ast.operations ?? ast.steps ?? [];
}

function stripCodeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const { code: _c, ...rest } = meta;
  return Object.keys(rest).length ? rest : undefined;
}

export class StepLabeler {
  private provider: GeminiLabelProvider;
  private model: string;

  constructor(provider?: GeminiLabelProvider) {
    const config = loadGeminiConfig();
    this.provider = provider ?? new GeminiLabelProvider(config);
    this.model = config.model;
  }

  /**
   * @param fieldSelectors optional `--fields` filters. Matches Java targets by leaf
   *   before AI (saves calls), then result is business-path mapping.
   */
  async labelIndex(ast: IndexAst, fieldSelectors: string[] = []): Promise<PipelineJson> {
    const schemaContext = ast.mapperId ? schemaContextForLabeler(ast.mapperId) : undefined;
    let grouped = groupOperationsByTarget(operationsOf(ast) as PipelineOp[]);
    if (fieldSelectors.length > 0) {
      grouped = filterMappingByFields(grouped, fieldSelectors);
    }

    const mapping: FieldMappingJson[] = [];
    for (const entry of grouped) {
      mapping.push(await this.labelFieldMapping(entry, schemaContext));
    }

    return {
      mapperId: ast.mapperId,
      mapping,
      labeledAt: new Date().toISOString(),
      labelModel: this.model,
    };
  }

  private async labelFieldMapping(
    entry: FieldMapping,
    schemaContext?: string,
  ): Promise<FieldMappingJson> {
    const cacheKey = JSON.stringify({
      javaTarget: entry.targetField,
      ops: entry.pipeline,
      schema: schemaContext ?? "",
    });
    const cached = getLabelCache(cacheKey, this.model);
    const response: FieldMappingResponse =
      (cached?.response as FieldMappingResponse) ??
      (await this.provider.labelFieldMapping({
        javaTargetField: entry.targetField,
        indexerOps: entry.pipeline,
        schemaContext,
      }));

    if (!cached) {
      setLabelCache({
        sourceText: cacheKey,
        model: this.model,
        response,
        cachedAt: new Date().toISOString(),
      });
    }

    if (response.recognized && response.pipeline?.length && response.targetField) {
      return {
        targetField: response.targetField,
        pipeline: response.pipeline.map((op) =>
          this.fromPipelineOp(op, response.reason),
        ),
      };
    }

    // Fallback: keep indexer ops under Java target (should be rare)
    return {
      targetField: entry.targetField,
      pipeline: entry.pipeline.map((op) => ({
        kind: op.kind,
        sourceField: typeof op.sourceField === "string" ? op.sourceField : undefined,
        condition: typeof op.condition === "string" ? op.condition : undefined,
        meta: stripCodeMeta(
          op.meta && typeof op.meta === "object"
            ? (op.meta as Record<string, unknown>)
            : undefined,
        ),
        labelSource: "deterministic",
        labelReason: response.reason ?? "gemini did not rewrite field",
      })),
    };
  }

  private fromPipelineOp(op: PipelineOpLabel, reason: string | undefined): PipelineStep {
    const kind = (op.kind ?? "raw").toUpperCase();
    const step: PipelineStep = {
      kind,
      labelSource: "gemini",
      labelReason: reason,
    };

    if (kind === "READ" || kind === "WRITE" || kind === "BUILD") {
      if (op.sourceField) step.sourceField = op.sourceField;
    }
    if (kind === "FILTER" && op.condition) {
      step.condition = op.condition;
    }
    if (kind === "CONSTANT") {
      if (op.value != null) {
        step.meta = { value: op.value };
      }
    }
    if (kind === "TRANSFORM") {
      step.meta = {};
      if (op.op) step.meta.op = op.op;
      if (op.value != null) step.meta.value = op.value;
      if (op.sourceField) step.sourceField = op.sourceField;
    }

    return step;
  }
}
