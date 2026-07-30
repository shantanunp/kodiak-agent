#!/usr/bin/env tsx
/**
 * Incremental re-scan: only index changed in-scope files when commit SHA advances.
 */

import { loadRegistry, parseRepoSlug } from "../registry/loadRegistry.js";
import { matchesScope } from "../registry/scope.js";
import { GitHubClient } from "../mcp/githubClient.js";
import * as cache from "../cache/index.js";
import { scanFiles } from "./scanRepo.js";
import { parseArgs } from "node:util";
import { paths } from "../config/env.js";
import { createHash } from "node:crypto";

const { values } = parseArgs({
  options: {
    local: { type: "boolean", default: false },
    registry: { type: "string", default: paths.registry },
  },
});

function localCommitSha(repo: string, branch: string): string {
  return (
    "local-" + createHash("sha256").update(`${repo}:${branch}:fixtures`).digest("hex").slice(0, 32)
  );
}

export async function incrementalScan(): Promise<void> {
  const registry = loadRegistry(values.registry!);
  const repoSlug = registry.repo;

  if (values.local || !process.env.GITHUB_TOKEN) {
    const currentSha = localCommitSha(registry.repo, registry.branch);
    const lastSha = cache.getLastIndexedSha(repoSlug);

    if (lastSha === currentSha) {
      console.log(JSON.stringify({ action: "skip", reason: "same_sha", sha: currentSha }));
      return;
    }

    const mapperIds = registry.mappers.map((m) => m.id);
    await scanFiles(mapperIds, { local: true, commitSha: currentSha });
    cache.setLastIndexedSha(repoSlug, currentSha);
    console.log(JSON.stringify({ action: "scan", mode: "local", sha: currentSha, mappers: mapperIds }));
    return;
  }

  const { owner, name } = parseRepoSlug(registry.repo);
  const client = new GitHubClient();
  await client.connectMcp();

  try {
    const currentSha = await client.getLatestCommitSha(owner, name, registry.branch);
    const lastSha = cache.getLastIndexedSha(repoSlug);

    if (lastSha === currentSha) {
      console.log(JSON.stringify({ action: "skip", reason: "same_sha", sha: currentSha }));
      return;
    }

    if (!lastSha) {
      const mapperIds = registry.mappers.map((m) => m.id);
      await scanFiles(mapperIds, { remote: true, commitSha: currentSha });
      cache.setLastIndexedSha(repoSlug, currentSha);
      console.log(
        JSON.stringify({ action: "scan", mode: "full", sha: currentSha, mappers: mapperIds }),
      );
      return;
    }

    const changed = await client.diffFiles(owner, name, lastSha, currentSha);
    const inScope = changed.filter((f) => matchesScope(f, registry.scope));

    if (inScope.length === 0) {
      cache.setLastIndexedSha(repoSlug, currentSha);
      console.log(
        JSON.stringify({ action: "skip", reason: "no_in_scope_changes", sha: currentSha }),
      );
      return;
    }

    const mapperIds = registry.mappers
      .filter((m) => inScope.includes(m.sourceFile))
      .map((m) => m.id);

    if (mapperIds.length === 0) {
      cache.setLastIndexedSha(repoSlug, currentSha);
      console.log(
        JSON.stringify({ action: "skip", reason: "changed_not_registered", sha: currentSha, changed: inScope }),
      );
      return;
    }

    await scanFiles(mapperIds, { remote: true, commitSha: currentSha });
    cache.setLastIndexedSha(repoSlug, currentSha);
    console.log(
      JSON.stringify({ action: "scan", mode: "incremental", sha: currentSha, mappers: mapperIds }),
    );
  } finally {
    await client.disconnectMcp();
  }
}

async function main(): Promise<void> {
  await incrementalScan();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
