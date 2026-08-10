import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/env.js";

export function agentJobsRoot(): string {
  return join(paths.cacheDir, "agent-jobs");
}

/** Remove offline agent job dirs (job.json / result.json). */
export function clearAgentJobs(mapperId?: string): number {
  const root = agentJobsRoot();
  if (!existsSync(root)) return 0;
  if (mapperId) {
    const dir = join(root, mapperId);
    if (!existsSync(dir)) return 0;
    const n = readdirSync(dir).length;
    rmSync(dir, { recursive: true, force: true });
    return n;
  }
  let n = 0;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    n += readdirSync(dir).length;
    rmSync(dir, { recursive: true, force: true });
  }
  return n;
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
