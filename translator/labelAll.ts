/**
 * Scale ergonomics — batch label every registry mapper (store-aware).
 *
 * Warm path: verified store hit → skip model (free).
 * Cold path: run `label --analyzer` when a model is configured; otherwise
 * report needs-model so the operator can export offline jobs.
 *
 *   npm run label:all -- --worktree /path/to/mapper-repo
 *   npm run label:all -- --worktree /path --mapper order-request-mapper
 */

import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { paths, getEnvOptional } from "../src/config/env.js";
import { loadRegistry } from "../src/registry/loadRegistry.js";
import { resolveMapperAst } from "./resolvePipeline.js";
import {
  computeVerifiedFingerprint,
  getVerified,
} from "./verified/store.js";
import { loadSchemaJson, isModelConfigured } from "./model/index.js";

export type LabelAllStatus =
  | "verified"
  | "labeled"
  | "needs-model"
  | "error"
  | "skipped";

export interface LabelAllRow {
  mapperId: string;
  status: LabelAllStatus;
  detail: string;
  fields?: number;
}

export async function labelAllMappers(options: {
  registryPath: string;
  worktree?: string;
  mapperId?: string;
  /** Extra CLI flags forwarded to cold label runs (e.g. --promote). */
  extraArgs?: string[];
  /** When true, do not spawn cold label — only report verified/needs-model. */
  dryRun?: boolean;
}): Promise<LabelAllRow[]> {
  const registry = loadRegistry(options.registryPath);
  const targets = options.mapperId
    ? registry.mappers.filter((m) => m.id === options.mapperId)
    : registry.mappers;
  if (targets.length === 0) {
    return [
      {
        mapperId: options.mapperId ?? "*",
        status: "error",
        detail: "no matching mappers in registry",
      },
    ];
  }

  const rows: LabelAllRow[] = [];
  const modelOk = isModelConfigured();

  for (const mapper of targets) {
    try {
      const resolved = await resolveMapperAst(mapper.id, options.registryPath, {
        worktree: options.worktree,
        remote: false,
      });
      const schemaJson = loadSchemaJson(mapper.id);
      const vfp = computeVerifiedFingerprint({
        sourceJava: resolved.sourceJava,
        schemaJson,
      });
      const verified = getVerified(mapper.id, vfp);
      if (verified) {
        rows.push({
          mapperId: mapper.id,
          status: "verified",
          detail: `store hit fingerprint=${vfp.slice(0, 12)}…`,
          fields: verified.fields.length,
        });
        continue;
      }

      if (!modelOk || options.dryRun) {
        rows.push({
          mapperId: mapper.id,
          status: "needs-model",
          detail: options.dryRun
            ? "dry-run: would label (no verified entry)"
            : "no MODEL_API_KEY — run label:export or configure a model",
        });
        continue;
      }

      const args = [
        "tsx",
        "translator/cli.ts",
        "--mapper",
        mapper.id,
        "--analyzer",
        ...(options.worktree ? ["--worktree", options.worktree] : []),
        ...(options.extraArgs ?? []),
      ];
      const proc = spawnSync("npx", args, {
        cwd: paths.root,
        encoding: "utf8",
        env: process.env,
      });
      if (proc.status === 0) {
        rows.push({
          mapperId: mapper.id,
          status: "labeled",
          detail: "analyzer label completed",
        });
      } else {
        const err = (proc.stderr || proc.stdout || "").trim().slice(-400);
        rows.push({
          mapperId: mapper.id,
          status: "error",
          detail: err || `label exited ${proc.status}`,
        });
      }
    } catch (err) {
      rows.push({
        mapperId: mapper.id,
        status: "error",
        detail: (err as Error).message,
      });
    }
  }
  return rows;
}

const isMain =
  process.argv[1]?.endsWith("labelAll.ts") ||
  process.argv[1]?.endsWith("labelAll.js");

if (isMain) {
  const { values } = parseArgs({
    options: {
      registry: { type: "string", default: paths.registry },
      worktree: { type: "string" },
      mapper: { type: "string" },
      promote: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const worktree =
    values.worktree ?? (getEnvOptional("MAPPER_WORKTREE") || undefined);
  if (worktree && !existsSync(worktree)) {
    console.error(`worktree not found: ${worktree}`);
    process.exit(1);
  }
  const rows = await labelAllMappers({
    registryPath: values.registry!,
    worktree,
    mapperId: values.mapper,
    dryRun: Boolean(values["dry-run"]),
    extraArgs: values.promote ? ["--promote"] : [],
  });

  if (values.json) {
    console.log(JSON.stringify({ rows }, null, 2));
  } else {
    console.log(`label:all — ${rows.length} mapper(s)\n`);
    for (const r of rows) {
      const flag =
        r.status === "verified" || r.status === "labeled"
          ? "[OK]"
          : r.status === "needs-model"
            ? "[..]"
            : "[!!]";
      console.log(
        `${flag} ${r.mapperId.padEnd(28)} ${r.status}` +
          (r.fields != null ? ` fields=${r.fields}` : "") +
          ` — ${r.detail}`,
      );
    }
  }
  const failed = rows.some((r) => r.status === "error");
  process.exit(failed ? 1 : 0);
}
