import { join } from "node:path";
import { paths } from "../../src/config/env.js";

export function agentJobsRoot(): string {
  return join(paths.cacheDir, "agent-jobs");
}

export function agentJobDir(mapperId: string, fingerprint: string): string {
  return join(agentJobsRoot(), mapperId, fingerprint);
}

export function agentJobFile(mapperId: string, fingerprint: string): string {
  return join(agentJobDir(mapperId, fingerprint), "job.json");
}

export function agentResultFile(mapperId: string, fingerprint: string): string {
  return join(agentJobDir(mapperId, fingerprint), "result.json");
}

export function agentReadmeFile(mapperId: string, fingerprint: string): string {
  return join(agentJobDir(mapperId, fingerprint), "README.md");
}
