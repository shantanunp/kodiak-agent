/**
 * Model provider package — config, HTTP client (gemini|openai styles),
 * discovery merge, and business labeling.
 */

export {
  type ModelConfig,
  type ModelApiStyle,
  loadModelConfig,
  isModelConfigured,
  // deprecated aliases
  loadGeminiConfig,
  isGeminiConfigured,
  type GeminiConfig,
} from "./config.js";

export {
  type ModelProvider,
  HttpModelProvider,
  createModelProvider,
  GeminiLabelProvider,
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
  mergeAstAndAiDiscovery,
  groupAst,
  type DiscoveryMeta,
  type DiscoverMergeResult,
} from "./discoverMerge.js";
