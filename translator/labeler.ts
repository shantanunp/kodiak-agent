/**
 * Phase 2 — AST operation labeler (Gemini Studio).
 *
 * Labels only already-parsed constructs from the JavaParser indexer.
 * Never free-form parses Java source.
 */

import { GeminiLabelProvider, type LabelResponse } from "./geminiProvider.js";
import { loadGeminiConfig } from "./config.js";
import { getLabelCache, setLabelCache } from "./cache/index.js";
import { schemaContextForLabeler } from "../schema/io.js";
import { groupOperationsByTarget } from "./groupMapping.js";

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

export interface PipelineJson extends Omit<IndexAst, "steps" | "operations"> {
  /** @deprecated flat list — prefer mapping */
  operations?: PipelineStep[];
  /** One entry per target field; pipeline holds READ/TRANSFORM/CONSTANT/… */
  mapping: FieldMappingJson[];
  labeledAt?: string;
  labelModel?: string;
}

export function operationsOf(ast: IndexAst | PipelineJson): AstStep[] {
  return ast.operations ?? ast.steps ?? [];
}

export class StepLabeler {
  private provider: GeminiLabelProvider;
  private model: string;

  constructor(provider?: GeminiLabelProvider) {
    const config = loadGeminiConfig();
    this.provider = provider ?? new GeminiLabelProvider(config);
    this.model = config.model;
  }

  async labelIndex(ast: IndexAst): Promise<PipelineJson> {
    const schemaContext = ast.mapperId ? schemaContextForLabeler(ast.mapperId) : undefined;
    const operations: PipelineStep[] = [];
    for (const step of operationsOf(ast)) {
      operations.push(await this.labelOperation(step, schemaContext));
    }
    const { steps: _legacy, operations: _ops, ...rest } = ast;
    return {
      ...rest,
      mapping: groupOperationsByTarget(operations),
      labeledAt: new Date().toISOString(),
      labelModel: this.model,
    };
  }

  private async labelOperation(step: AstStep, schemaContext?: string): Promise<PipelineStep> {
    const labeled: PipelineStep = {
      kind: step.kind,
      targetField: step.targetField,
      sourceField: step.sourceField,
      condition: step.condition,
      meta: step.meta,
      labelSource: "deterministic",
    };

    const kind = (step.kind ?? "").toUpperCase();

    if (kind === "CONSTANT") {
      const value =
        typeof step.meta?.value === "string" || typeof step.meta?.value === "number"
          ? String(step.meta.value)
          : undefined;
      labeled.labelReason = value != null ? `Constant value: ${value}` : "Constant value";
      return labeled;
    }

    if (kind === "READ") {
      labeled.labelReason = "Direct field mapping";
      return labeled;
    }

    if (kind === "TRANSFORM") {
      const op = typeof step.meta?.op === "string" ? step.meta.op : "transform";
      const value = step.meta?.value != null ? String(step.meta.value) : undefined;
      labeled.labelReason =
        value != null ? `${op} by ${value}` : op;
      return labeled;
    }

    if (kind !== "RAW") {
      return labeled;
    }

    const sourceText =
      (typeof step.meta?.code === "string" ? step.meta.code : undefined) ??
      step.sourceText ??
      "";
    const cached = getLabelCache(sourceText, this.model);
    const response: LabelResponse =
      (cached?.response as LabelResponse) ??
      (await this.provider.labelStep({
        sourceText,
        currentKind: step.kind,
        context: schemaContext,
      }));

    if (!cached) {
      setLabelCache({
        sourceText,
        model: this.model,
        response,
        cachedAt: new Date().toISOString(),
      });
    }

    if (response.recognized && response.kind) {
      labeled.kind = response.kind.toUpperCase();
      if (response.targetField) labeled.targetField = response.targetField;
      if (response.kind.toLowerCase() === "constant") {
        labeled.sourceField = undefined;
        if (response.value != null) {
          labeled.meta = { ...(labeled.meta ?? {}), value: response.value };
        }
      } else if (response.sourceField) {
        labeled.sourceField = response.sourceField;
      }
      labeled.labelSource = "gemini";
      labeled.labelReason = response.reason;
      labeled.meta = labeled.meta?.code ? { ...labeled.meta } : labeled.meta;
      if (labeled.meta && "code" in labeled.meta) {
        const { code: _c, ...rest } = labeled.meta;
        labeled.meta = Object.keys(rest).length ? rest : undefined;
      }
    } else {
      labeled.labelSource = "deterministic";
      labeled.labelReason = response.reason ?? "left as raw";
    }

    return labeled;
  }
}
