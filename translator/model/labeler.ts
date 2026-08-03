/**
 * Phase 2 — AST + AI discovery merge, then model business-path labeling.
 *
 * Never free-form parses Java as the sole discovery source — AST is the spine.
 */

import {
  createModelProvider,
  type ModelProvider,
  type FieldMappingResponse,
} from "./provider.js";
import { loadModelConfig } from "./config.js";
import { applyFieldMappingResponse } from "./applyResponse.js";
import {
  getLabelCache,
  setLabelCache,
  getPipelineCache,
  setPipelineCache,
  getFieldPipelineCache,
  setFieldPipelineCache,
  listFieldPipelineCaches,
  computePipelineFingerprint,
  PIPELINE_CACHE_VERSION,
} from "../cache/index.js";
import { schemaContextForLabeler, schemaFilePath } from "../../schema/io.js";
import { filterMappingByFields, matchesTargetField } from "../filterByFields.js";
import { discoverAndMerge, type DiscoveryMeta } from "./discoverMerge.js";
import { existsSync, readFileSync } from "node:fs";
import type { FieldMapping } from "../groupMapping.js";

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
  labelSource?: "deterministic" | "model" | "gemini";
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
  cacheHit?: boolean;
  /** How many of the returned fields came from field-level cache */
  fieldsFromCache?: number;
  fieldsLabeled?: number;
  fingerprint?: string;
  discoveryMeta?: DiscoveryMeta;
}

export interface LabelIndexOptions {
  fieldSelectors?: string[];
  sourceJava?: string;
  /** Skip pipeline / field / discovery cache read/write */
  noCache?: boolean;
  /**
   * Force model discovery even with --fields.
   * Default: skip AI discovery when --fields is set (1 model call per uncached field).
   */
  discoverAi?: boolean;
}

export function operationsOf(ast: IndexAst | { operations?: AstStep[]; steps?: AstStep[] }): AstStep[] {
  return ast.operations ?? ast.steps ?? [];
}

export function loadSchemaJson(mapperId: string | undefined): string {
  if (!mapperId) return "";
  const file = schemaFilePath(mapperId);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
}

function fieldEntryMatchesSelectors(
  entry: { javaTargetField: string; mapping: { targetField: string } },
  selectors: string[],
): boolean {
  return (
    matchesTargetField(entry.mapping.targetField, selectors) ||
    matchesTargetField(entry.javaTargetField, selectors)
  );
}

export class StepLabeler {
  private provider: ModelProvider;
  private model: string;

  private apiStyle: string;

  constructor(provider?: ModelProvider) {
    const config = loadModelConfig();
    this.provider = provider ?? createModelProvider(config);
    this.model = this.provider.model;
    this.apiStyle = config.apiStyle;
  }

  async labelIndex(
    ast: IndexAst,
    fieldSelectorsOrOptions: string[] | LabelIndexOptions = [],
  ): Promise<PipelineJson> {
    const options: LabelIndexOptions = Array.isArray(fieldSelectorsOrOptions)
      ? { fieldSelectors: fieldSelectorsOrOptions }
      : fieldSelectorsOrOptions;
    const fieldSelectors = options.fieldSelectors ?? [];
    const sourceJava = options.sourceJava ?? "";
    const noCache = Boolean(options.noCache);
    const discoverAi = Boolean(options.discoverAi);
    const mapperId = ast.mapperId ?? "unknown";
    // --fields: AST-only discovery by default (avoids a second model call / rate limits)
    const skipAiDiscovery = fieldSelectors.length > 0 && !discoverAi;

    const schemaJson = loadSchemaJson(ast.mapperId);
    const fingerprint = computePipelineFingerprint({
      sourceJava,
      schemaJson,
      model: `${this.apiStyle}:${this.model}`,
      version: PIPELINE_CACHE_VERSION,
    });

    // 1) Full pipeline cache
    if (!noCache && sourceJava) {
      const hit = getPipelineCache(mapperId, fingerprint);
      if (hit) {
        let mapping = hit.mapping as FieldMappingJson[];
        if (fieldSelectors.length > 0) {
          mapping = filterMappingByFields(mapping, fieldSelectors);
        }
        return {
          mapperId: hit.mapperId,
          mapping,
          labeledAt: hit.labeledAt,
          labelModel: hit.labelModel,
          cacheHit: true,
          fieldsFromCache: mapping.length,
          fieldsLabeled: 0,
          fingerprint,
          discoveryMeta: hit.discoveryMeta,
        };
      }
    }

    // 2) Field-level cache: if --fields all present, skip discovery + model
    if (!noCache && sourceJava && fieldSelectors.length > 0) {
      const cachedFields = listFieldPipelineCaches(mapperId, fingerprint);
      const selectorsCovered = fieldSelectors.every((sel) =>
        cachedFields.some((e) => fieldEntryMatchesSelectors(e, [sel])),
      );

      if (selectorsCovered) {
        const seen = new Set<string>();
        const mapping: FieldMappingJson[] = [];
        for (const e of cachedFields) {
          if (!fieldEntryMatchesSelectors(e, fieldSelectors)) continue;
          const m = e.mapping as FieldMappingJson;
          if (seen.has(m.targetField)) continue;
          seen.add(m.targetField);
          mapping.push(m);
        }
        if (mapping.length > 0) {
          return {
            mapperId: ast.mapperId,
            mapping,
            labeledAt: new Date().toISOString(),
            labelModel: this.model,
            cacheHit: true,
            fieldsFromCache: mapping.length,
            fieldsLabeled: 0,
            fingerprint,
          };
        }
      }
    }

    const schemaContext = ast.mapperId ? schemaContextForLabeler(ast.mapperId) : undefined;
    const { groups, meta } = await discoverAndMerge(ast, sourceJava, this.provider, {
      fingerprint,
      noCache,
      skipAiDiscovery,
    });

    const toLabel =
      fieldSelectors.length > 0 ? filterMappingByFields(groups, fieldSelectors) : groups;

    const mapping: FieldMappingJson[] = [];
    let fieldsFromCache = 0;
    let fieldsLabeled = 0;

    for (const entry of toLabel) {
      const fieldHit =
        !noCache && sourceJava
          ? getFieldPipelineCache(mapperId, fingerprint, entry.targetField)
          : null;

      if (fieldHit) {
        mapping.push(fieldHit.mapping as FieldMappingJson);
        fieldsFromCache++;
        continue;
      }

      const labeled = await this.labelFieldMapping(entry, schemaContext);
      mapping.push(labeled);
      fieldsLabeled++;

      if (!noCache && sourceJava) {
        setFieldPipelineCache({
          fingerprint,
          mapperId,
          javaTargetField: entry.targetField,
          mapping: labeled,
          labeledAt: new Date().toISOString(),
          labelModel: this.model,
          cachedAt: new Date().toISOString(),
        });
      }
    }

    const labeledAt = new Date().toISOString();

    if (!noCache && sourceJava && fieldSelectors.length === 0) {
      setPipelineCache({
        fingerprint,
        mapperId,
        mapping,
        labeledAt,
        labelModel: this.model,
        discoveryMeta: meta,
        cachedAt: labeledAt,
      });
    }

    return {
      mapperId: ast.mapperId,
      mapping,
      labeledAt,
      labelModel: this.model,
      cacheHit: fieldsLabeled === 0 && mapping.length > 0,
      fieldsFromCache,
      fieldsLabeled,
      fingerprint,
      discoveryMeta: meta,
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

    return applyFieldMappingResponse(entry, response, "model");
  }
}
