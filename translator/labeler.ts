/**
 * Phase 2 — AST step labeler (Gemini Studio).
 *
 * Labels only already-parsed constructs from the JavaParser indexer.
 * Never free-form parses Java source.
 */

import { GeminiLabelProvider, type LabelResponse } from "./geminiProvider.js";
import { loadGeminiConfig } from "./config.js";
import { getLabelCache, setLabelCache } from "./cache/index.js";
import { schemaContextForLabeler } from "../schema/io.js";

export interface AstStep {
  kind: string;
  sourceText?: string;
  targetField?: string;
  sourceField?: string;
  condition?: string;
  children?: AstStep[];
  meta?: Record<string, unknown>;
}

export interface IndexAst {
  mapperId?: string;
  className?: string;
  entryMethod?: string;
  steps: AstStep[];
}

export interface PipelineStep extends AstStep {
  labelSource?: "deterministic" | "gemini";
  labelReason?: string;
}

export interface PipelineJson extends Omit<IndexAst, "steps"> {
  steps: PipelineStep[];
  labeledAt?: string;
  labelModel?: string;
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
    const steps: PipelineStep[] = [];
    for (const step of ast.steps) {
      steps.push(await this.labelStepTree(step, schemaContext));
    }
    return {
      ...ast,
      steps,
      labeledAt: new Date().toISOString(),
      labelModel: this.model,
    };
  }

  private async labelStepTree(step: AstStep, schemaContext?: string): Promise<PipelineStep> {
    const labeled: PipelineStep = { ...step, labelSource: "deterministic" };

    if (step.children?.length) {
      labeled.children = [];
      for (const child of step.children) {
        labeled.children.push(await this.labelStepTree(child, schemaContext));
      }
    }

    if (step.kind !== "RAW" && step.kind !== "raw") {
      return labeled;
    }

    const sourceText = step.sourceText ?? "";
    const cached = getLabelCache(sourceText, this.model);
    const response: LabelResponse =
      cached?.response as LabelResponse ??
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
      if (response.sourceField) labeled.sourceField = response.sourceField;
      labeled.labelSource = "gemini";
      labeled.labelReason = response.reason;
    } else {
      labeled.labelSource = "deterministic";
      labeled.labelReason = response.reason ?? "left as raw";
    }

    return labeled;
  }
}
