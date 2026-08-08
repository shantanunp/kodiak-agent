#!/usr/bin/env tsx
/**
 * MON-4 — Drift check.
 *
 *   npm run drift [-- --mapper <id>] [-- --json]
 *
 * Walks the registry, recomputes the content-only verified fingerprint for each
 * mapper's current source, and reports: current / stale / never-verified.
 * Exit 1 when any stale entry exists (CI / cron gate).
 */

import { parseArgs } from "node:util";
import { paths } from "../../src/config/env.js";
import { loadRegistry } from "../../src/registry/loadRegistry.js";
import { resolveMapperAst } from "../resolvePipeline.js";
import { inferWorktree } from "../../analyzer/resolveType.js";
import { loadSchemaJson } from "../model/index.js";
import {
  computeVerifiedFingerprint,
  getVerified,
  listStaleFingerprints,
} from "../verified/store.js";

const { values } = parseArgs({
  options: {
    mapper: { type: "string" },
    json: { type: "boolean", default: false },
    worktree: { type: "string" },
    registry: { type: "string", default: paths.registry },
  },
});

export type DriftStatus = "current" | "stale" | "never-verified" | "unresolvable";

export interface DriftRow {
  mapperId: string;
  status: DriftStatus;
  fingerprint?: string;
  staleFingerprints: string[];
  /** User-corrected fields on a stale fingerprint (need re-verification). */
  staleCorrections: number;
  error?: string;
}

export async function checkDrift(options: {
  registryPath: string;
  worktree?: string;
  mapperId?: string;
}): Promise<DriftRow[]> {
  const registry = loadRegistry(options.registryPath);
  const targets = options.mapperId
    ? registry.mappers.filter((m) => m.id === options.mapperId)
    : registry.mappers;
  const rows: DriftRow[] = [];

  for (const mapper of targets) {
    try {
      const resolved = await resolveMapperAst(mapper.id, options.registryPath, {
        worktree: options.worktree,
        remote: false,
      });
      if (!resolved.sourceJava.trim()) {
        rows.push({
          mapperId: mapper.id,
          status: "unresolvable",
          staleFingerprints: [],
          staleCorrections: 0,
          error: "source not resolvable",
        });
        continue;
      }
      const worktree =
        options.worktree ??
        inferWorktree(resolved.sourcePath, mapper.sourceFile) ??
        undefined;
      void worktree;
      const fingerprint = computeVerifiedFingerprint({
        sourceJava: resolved.sourceJava,
        schemaJson: loadSchemaJson(mapper.id),
      });
      const current = getVerified(mapper.id, fingerprint);
      const stale = listStaleFingerprints(mapper.id, fingerprint);
      let staleCorrections = 0;
      for (const fp of stale) {
        const e = getVerified(mapper.id, fp);
        staleCorrections +=
          e?.fields.filter((f) => f.status === "user-corrected").length ?? 0;
      }
      // current = verified for today's source; stale = only older fingerprints;
      // never-verified = nothing in the store.
      const status: DriftStatus = current
        ? "current"
        : stale.length > 0
          ? "stale"
          : "never-verified";

      rows.push({
        mapperId: mapper.id,
        status,
        fingerprint,
        staleFingerprints: stale,
        staleCorrections,
      });
    } catch (err) {
      rows.push({
        mapperId: mapper.id,
        status: "unresolvable",
        staleFingerprints: [],
        staleCorrections: 0,
        error: (err as Error).message,
      });
    }
  }
  return rows;
}

const isMain =
  process.argv[1]?.endsWith("drift.ts") || process.argv[1]?.endsWith("drift.js");

if (isMain) {
  const rows = await checkDrift({
    registryPath: values.registry!,
    worktree: values.worktree,
    mapperId: values.mapper,
  });
  if (values.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
  } else {
    console.log(`\nKodiak drift — ${rows.length} mapper(s)\n`);
    for (const r of rows) {
      const flag =
        r.status === "current" ? "[OK]" : r.status === "never-verified" ? "[..]" : "[!!]";
      console.log(
        `${flag} ${r.mapperId.padEnd(28)} ${r.status}` +
          (r.staleFingerprints.length
            ? ` staleEntries=${r.staleFingerprints.length}`
            : "") +
          (r.staleCorrections ? ` staleCorrections=${r.staleCorrections}` : "") +
          (r.error ? ` (${r.error})` : ""),
      );
    }
    console.log("");
  }
  const bad = rows.filter((r) => r.status === "stale" || r.status === "unresolvable");
  if (bad.length > 0) process.exit(1);
}
