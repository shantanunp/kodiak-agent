import type { FieldMappingResponse } from "../model/provider.js";

/** Fingerprint model key for offline agent-seeded field cache (does not collide with live API). */
export const AGENT_OFFLINE_MODEL = "agent:offline";

/** Registry mapper entry embedded in the job (no stubbed paths). */
export interface AgentJobMapper {
  id: string;
  sourceFile: string;
  class: string;
  entryMethod: string;
  sourceType: string;
  targetType: string;
  goldenTests?: string;
}

export interface AgentJobField {
  /** Business/schema field the user asked to label (--fields). */
  businessFieldSelector: string;
  /**
   * Java-side target hint for result.json (same as businessFieldSelector offline;
   * the agent finds the real setter/write in sourceJava).
   */
  javaTargetField: string;
  /** Legacy optional hints from older offline jobs. */
  indexerOps?: unknown[];
}

export interface AgentJob {
  version: 1;
  mapperId: string;
  fingerprint: string;
  labelModel: typeof AGENT_OFFLINE_MODEL;
  createdAt: string;
  /** Full mapper Java source bytes used for fingerprinting. */
  sourceJava: string;
  /** Raw schema JSON for this mapper. */
  schemaJson: string;
  /** Registry mapper metadata. */
  mapper: AgentJobMapper;
  systemPrompt: string;
  schemaContext?: string;
  instructions: string;
  /** Exact npm commands to run in VS Code after the agent writes result.json. */
  vscodeSteps: string[];
  fields: AgentJobField[];
  paths: {
    jobDir: string;
    jobFile: string;
    resultFile: string;
  };
}

export interface AgentResultField {
  javaTargetField: string;
  response: FieldMappingResponse;
}

export interface AgentResult {
  mapperId: string;
  fingerprint: string;
  labelModel: string;
  fields: AgentResultField[];
}
