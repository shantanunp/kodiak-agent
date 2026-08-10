/**
 * Fresh-start wipe for field-mapping artifacts.
 *
 * Clears runtime caches, verified store, viewer dumps, offline agent jobs,
 * and mapper-scoped telemetry so a re-label has no prior field mapping left.
 * Does NOT touch registry schemas or mapping-registry.yaml.
 */

import { clearAllTranslatorCaches } from "./cache/index.js";
import { clearVerifiedStore } from "./verified/store.js";
import { clearPipelineView } from "./writePipelineView.js";
import { clearAgentJobs } from "./agent/paths.js";
import { clearRunMetrics } from "./report/metrics.js";
import { clearRuns } from "./telemetry/journal.js";
import { clearDefects } from "./judge/judge.js";

export interface ResetMappingDataResult {
  mapperId: string | null;
  caches: {
    pipelines: number;
    discovery: number;
    fields: number;
    labels: number;
  };
  verified: number;
  views: number;
  agentJobs: number;
  metrics: number;
  runs: number;
  defects: number;
}

export function resetMappingData(mapperId?: string): ResetMappingDataResult {
  const id = mapperId?.trim() || undefined;
  return {
    mapperId: id ?? null,
    caches: clearAllTranslatorCaches(id),
    verified: clearVerifiedStore(id),
    views: clearPipelineView(id),
    agentJobs: clearAgentJobs(id),
    metrics: clearRunMetrics(id),
    runs: clearRuns(id),
    defects: clearDefects(id),
  };
}
