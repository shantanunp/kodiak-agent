import type { FieldMappingResponse } from "../model/provider.js";

/** Fingerprint model key for offline agent-seeded field cache (does not collide with live API). */
export const AGENT_OFFLINE_MODEL = "agent:offline";

export interface AgentJobField {
  javaTargetField: string;
  indexerOps: unknown[];
  /** Optional selector the user asked for (business path). */
  fieldSelector?: string;
}

export interface AgentJob {
  version: 1;
  mapperId: string;
  fingerprint: string;
  labelModel: typeof AGENT_OFFLINE_MODEL;
  createdAt: string;
  systemPrompt: string;
  schemaContext?: string;
  instructions: string;
  fields: AgentJobField[];
  /** Absolute paths written by export (hints for the agent). */
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
