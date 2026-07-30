#!/usr/bin/env tsx
/**
 * Fetch one file from GitHub (or local worktree) and print contents.
 *
 * Usage:
 *   npx tsx src/tools/readSource.ts --path fixtures/ExampleMapper.java
 *   npx tsx src/tools/readSource.ts --path src/.../Mapper.java --remote
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/env.js";
import { loadRegistry, parseRepoSlug } from "../registry/loadRegistry.js";
import { GitHubClient } from "../mcp/githubClient.js";
import * as cache from "../cache/index.js";

const { values } = parseArgs({
  options: {
    path: { type: "string", short: "p" },
    remote: { type: "boolean", default: false },
    ref: { type: "string" },
    registry: { type: "string", default: paths.registry },
  },
});

async function main(): Promise<void> {
  if (!values.path) {
    console.error("Usage: readSource.ts --path <file-path> [--remote] [--ref <sha>]");
    process.exit(1);
  }

  const registry = loadRegistry(values.registry!);
  const filePath = values.path;

  if (!values.remote) {
    const local = join(paths.root, filePath);
    if (!existsSync(local)) {
      console.error(`Local file not found: ${local}`);
      process.exit(1);
    }
    const content = readFileSync(local, "utf8");
    const sha = cache.contentHash(content);
    console.log(JSON.stringify({ path: filePath, sha, content }, null, 2));
    return;
  }

  const { owner, name } = parseRepoSlug(registry.repo);
  const client = new GitHubClient();
  await client.connectMcp();

  try {
    const ref = values.ref ?? registry.branch;
    const file = await client.getFileContents(owner, name, filePath, ref);
    console.log(JSON.stringify(file, null, 2));
  } finally {
    await client.disconnectMcp();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
