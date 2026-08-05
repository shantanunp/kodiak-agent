/**
 * Model provider package — config, HTTP client (openai|claude|copilot styles),
 * discovery merge, and business labeling.
 */

export {
  type ModelConfig,
  type ModelApiStyle,
  loadModelConfig,
  isModelConfigured,
} from "./config.js";

export {
  type ModelProvider,
  HttpModelProvider,
  createModelProvider,
  FIELD_MAPPING_PROMPT,
  type LabelRequest,
  type FieldMappingRequest,
  type PipelineOpLabel,
  type LabelResponse,
  type FieldMappingResponse,
  type DiscoverRequest,
  type DiscoverHit,
  type DiscoverResponse,
} from "./provider.js";

export {
  applyFieldMappingResponse,
  normalizeFieldMappingResponse,
  fromPipelineOp,
} from "./applyResponse.js";

export {
  StepLabeler,
  operationsOf,
  loadSchemaJson,
  type AstStep,
  type IndexAst,
  type PipelineStep,
  type FieldMappingJson,
  type PipelineJson,
  type LabelIndexOptions,
} from "./labeler.js";

export {
  discoverAndMerge,
  type DiscoveryMeta,
  type DiscoverMergeResult,
} from "./discoverMerge.js";
