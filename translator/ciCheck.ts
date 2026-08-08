/**
 * Architecture #3 — CI mode for verified-store drift.
 *
 * For mappers touched in a git diff (or all registry mappers), recompute the
 * content fingerprint and fail when the store is stale — drift between code
 * and documented mappings cannot merge.
 *
 *   npm run ci:check -- --worktree /path/to/mapper-repo
 *   npm run ci:check -- --worktree /path --base origin/main
 *   npm run ci:check -- --worktree /path --all   # ignore diff; check every mapper
 */

import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { paths, getEnvOptional } from "../src/config/env.js";
import { loadRegistry } from "../src/registry/loadRegistry.js";
import { checkDrift, type DriftRow } from "./telemetry/drift.js";

export function gitChangedFiles(options: {
  cwd: string;
  base?: string;
}): string[] {
  try {
    const base = options.base ?? "HEAD~1";
    // Prefer merge-base diff against base; fall back to working tree.
    let out = "";
    try {
      out = execSync(`git diff --name-only ${base}...HEAD`, {
        cwd: options.cwd,
        encoding: "utf8",
      });
    } catch {
      out = execSync("git diff --name-only HEAD", {
        cwd: options.cwd,
        encoding: "utf8",
      });
    }
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function mappersTouchedByDiff(
  registryPath: string,
  changedFiles: string[],
): string[] {
  const registry = loadRegistry(registryPath);
  const changed = new Set(changedFiles.map((f) => f.replace(/\\/g, "/")));
  const hit = new Set<string>();
  for (const m of registry.mappers) {
    const src = m.sourceFile.replace(/\\/g, "/");
    for (const f of changed) {
      if (f === src || f.endsWith("/" + src) || src.endsWith(f) || f.includes(src)) {
        hit.add(m.id);
        break;
      }
    }
  }
  return [...hit];
}

export interface CiCheckResult {
  ok: boolean;
  scope: "diff" | "all";
  changedFiles: number;
  rows: DriftRow[];
  stale: string[];
  neverVerified: string[];
}

export async function runCiCheck(options: {
  registryPath: string;
  worktree?: string;
  base?: string;
  all?: boolean;
  mapperId?: string;
}): Promise<CiCheckResult> {
  const worktree =
    options.worktree ?? (getEnvOptional("MAPPER_WORKTREE") || undefined);
  let mapperIds: string[] | undefined;

  let changedFiles: string[] = [];
  let scope: "diff" | "all" = "all";

  if (options.mapperId) {
    mapperIds = [options.mapperId];
    scope = "all";
  } else if (!options.all && worktree && existsSync(worktree)) {
    changedFiles = gitChangedFiles({ cwd: worktree, base: options.base });
    const touched = mappersTouchedByDiff(options.registryPath, changedFiles);
    if (changedFiles.length > 0 && touched.length === 0) {
      // Diff present but no registry mapper touched — pass.
      return {
        ok: true,
        scope: "diff",
        changedFiles: changedFiles.length,
        rows: [],
        stale: [],
        neverVerified: [],
      };
    }
    if (touched.length > 0) {
      mapperIds = touched;
      scope = "diff";
    }
  }

  const rows: DriftRow[] = [];
  if (mapperIds) {
    for (const id of mapperIds) {
      rows.push(
        ...(await checkDrift({
          registryPath: options.registryPath,
          worktree,
          mapperId: id,
        })),
      );
    }
  } else {
    rows.push(
      ...(await checkDrift({
        registryPath: options.registryPath,
        worktree,
      })),
    );
    scope = "all";
  }

  const stale = rows.filter((r) => r.status === "stale").map((r) => r.mapperId);
  const neverVerified = rows
    .filter((r) => r.status === "never-verified")
    .map((r) => r.mapperId);

  return {
    ok: stale.length === 0,
    scope,
    changedFiles: changedFiles.length,
    rows,
    stale,
    neverVerified,
  };
}

const isMain =
  process.argv[1]?.endsWith("ciCheck.ts") ||
  process.argv[1]?.endsWith("ciCheck.js");

if (isMain) {
  const { values } = parseArgs({
    options: {
      registry: { type: "string", default: paths.registry },
      worktree: { type: "string" },
      base: { type: "string" },
      all: { type: "boolean", default: false },
      mapper: { type: "string" },
      json: { type: "boolean", default: false },
      /** Also fail when never-verified (stricter onboarding). */
      "fail-never-verified": { type: "boolean", default: false },
    },
  });

  const result = await runCiCheck({
    registryPath: values.registry!,
    worktree: values.worktree,
    base: values.base,
    all: Boolean(values.all),
    mapperId: values.mapper,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `ci:check — scope=${result.scope}` +
        (result.changedFiles ? ` changedFiles=${result.changedFiles}` : "") +
        ` mappers=${result.rows.length}`,
    );
    if (result.rows.length === 0) {
      console.log("  [OK] no in-scope mappers touched");
    }
    for (const r of result.rows) {
      const flag =
        r.status === "current"
          ? "[OK]"
          : r.status === "stale"
            ? "[!!]"
            : "[..]";
      console.log(
        `  ${flag} ${r.mapperId.padEnd(28)} ${r.status}` +
          (r.staleFingerprints.length
            ? ` staleFingerprints=${r.staleFingerprints.length}`
            : "") +
          (r.error ? ` — ${r.error}` : ""),
      );
    }
    if (result.stale.length) {
      console.log(
        `\nStale verified store for: ${result.stale.join(", ")}\n` +
          "Re-label with --analyzer --promote (or export an offline job) before merge.",
      );
    }
  }

  let exit = result.ok ? 0 : 1;
  if (values["fail-never-verified"] && result.neverVerified.length) exit = 1;
  process.exit(exit);
}
