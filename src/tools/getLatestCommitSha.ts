#!/usr/bin/env tsx
/**
 * Print latest commit SHA for the registry repo/branch.
 *
 * Usage:
 *   npx tsx src/tools/getLatestCommitSha.ts
 *   npx tsx src/tools/getLatestCommitSha.ts --local   # hash local fixture tree
 */

import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/env.js";
import { loadRegistry, parseRepoSlug } from "../registry/loadRegistry.js";
import { GitHubClient } from "../mcp/githubClient.js";

const { values } = parseArgs({
  options: {
    local: { type: "boolean", default: false },
    registry: { type: "string", default: paths.registry },
  },
});

function localTreeSha(root: string): string {
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else files.push(full);
    }
  }
  walk(join(root, "fixtures"));
  files.sort();
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f.replace(root, ""));
    hash.update(readFileSync(f));
  }
  return hash.digest("hex").slice(0, 40);
}

async function main(): Promise<void> {
  const registry = loadRegistry(values.registry!);

  if (values.local) {
    const sha = localTreeSha(paths.root);
    console.log(JSON.stringify({ repo: registry.repo, branch: "local", sha }, null, 2));
    return;
  }

  const { owner, name } = parseRepoSlug(registry.repo);
  const client = new GitHubClient();
  await client.connectMcp();

  try {
    const sha = await client.getLatestCommitSha(owner, name, registry.branch);
    console.log(JSON.stringify({ repo: registry.repo, branch: registry.branch, sha }, null, 2));
  } finally {
    await client.disconnectMcp();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
