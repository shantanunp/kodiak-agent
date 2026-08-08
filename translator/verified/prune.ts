/**
 * Prune old verified-store fingerprints (keep latest N per mapper).
 *
 *   npm run verified:prune -- --worktree /path [--keep 3] [--mapper id] [--dry-run]
 */

import { parseArgs } from "node:util";
import { paths, getEnvOptional } from "../../src/config/env.js";
import { loadRegistry } from "../../src/registry/loadRegistry.js";
import { resolveMapperAst } from "../resolvePipeline.js";
import { loadSchemaJson } from "../model/index.js";
import {
  computeVerifiedFingerprint,
  pruneStaleFingerprints,
} from "./store.js";

const isMain =
  process.argv[1]?.endsWith("prune.ts") || process.argv[1]?.endsWith("prune.js");

if (isMain) {
  const { values } = parseArgs({
    options: {
      registry: { type: "string", default: paths.registry },
      worktree: { type: "string" },
      mapper: { type: "string" },
      keep: { type: "string", default: "3" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const worktree =
    values.worktree ?? (getEnvOptional("MAPPER_WORKTREE") || undefined);
  const keep = Math.max(1, Number(values.keep) || 3);
  const registry = loadRegistry(values.registry!);
  const targets = values.mapper
    ? registry.mappers.filter((m) => m.id === values.mapper)
    : registry.mappers;

  const results: Array<{
    mapperId: string;
    kept: string[];
    removed: string[];
    error?: string;
  }> = [];

  for (const m of targets) {
    try {
      const resolved = await resolveMapperAst(m.id, values.registry!, {
        worktree,
        remote: false,
      });
      const fp = computeVerifiedFingerprint({
        sourceJava: resolved.sourceJava,
        schemaJson: loadSchemaJson(m.id),
      });
      const r = pruneStaleFingerprints(m.id, fp, keep, {
        dryRun: Boolean(values["dry-run"]),
      });
      results.push({ mapperId: m.id, ...r });
    } catch (err) {
      results.push({
        mapperId: m.id,
        kept: [],
        removed: [],
        error: (err as Error).message,
      });
    }
  }

  if (values.json) {
    console.log(JSON.stringify({ keep, dryRun: values["dry-run"], results }, null, 2));
  } else {
    console.log(
      `verified:prune — keep=${keep}${values["dry-run"] ? " (dry-run)" : ""}`,
    );
    for (const r of results) {
      if (r.error) {
        console.log(`  [!!] ${r.mapperId}: ${r.error}`);
        continue;
      }
      console.log(
        `  [OK] ${r.mapperId.padEnd(28)} kept=${r.kept.length} removed=${r.removed.length}`,
      );
      for (const fp of r.removed) console.log(`       - removed ${fp.slice(0, 12)}…`);
    }
  }
}
