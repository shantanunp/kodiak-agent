/**
 * Scale ergonomics — registry:check.
 * Validate every mapper's sourceFile exists and source/target types resolve
 * under a worktree before onboarding. Zero model calls.
 *
 *   npm run registry:check -- --worktree /path/to/mapper-repo
 */

import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { paths, getEnvOptional } from "../config/env.js";
import { loadRegistry, type MapperEntry } from "./loadRegistry.js";
import { findTypeFile } from "../../analyzer/resolveType.js";

export interface RegistryCheckIssue {
  mapperId: string;
  severity: "error" | "warn";
  code: string;
  message: string;
}

export interface RegistryCheckResult {
  ok: boolean;
  worktree: string | null;
  issues: RegistryCheckIssue[];
  checked: number;
}

function resolveUnderWorktree(worktree: string, relative: string): string {
  return isAbsolute(relative) ? relative : join(worktree, relative);
}

export function checkMapperEntry(
  mapper: MapperEntry,
  worktree: string | null,
): RegistryCheckIssue[] {
  const issues: RegistryCheckIssue[] = [];
  const id = mapper.id;

  if (!mapper.sourceFile?.trim()) {
    issues.push({
      mapperId: id,
      severity: "error",
      code: "missing-sourceFile",
      message: "sourceFile is empty",
    });
  }
  if (!mapper.class?.trim()) {
    issues.push({
      mapperId: id,
      severity: "error",
      code: "missing-class",
      message: "class is empty",
    });
  }
  if (!mapper.targetType?.trim()) {
    issues.push({
      mapperId: id,
      severity: "error",
      code: "missing-targetType",
      message: "targetType is empty",
    });
  }
  if (!mapper.sourceType?.trim()) {
    issues.push({
      mapperId: id,
      severity: "warn",
      code: "missing-sourceType",
      message: "sourceType is empty",
    });
  }
  if (!mapper.entryMethod?.trim()) {
    issues.push({
      mapperId: id,
      severity: "warn",
      code: "missing-entryMethod",
      message: "entryMethod is empty",
    });
  }

  if (!worktree) {
    if (mapper.sourceFile) {
      issues.push({
        mapperId: id,
        severity: "warn",
        code: "no-worktree",
        message: "pass --worktree (or MAPPER_WORKTREE) to verify sourceFile/types on disk",
      });
    }
    return issues;
  }

  if (mapper.sourceFile) {
    const srcPath = resolveUnderWorktree(worktree, mapper.sourceFile);
    if (!existsSync(srcPath)) {
      issues.push({
        mapperId: id,
        severity: "error",
        code: "sourceFile-missing",
        message: `sourceFile not found: ${srcPath}`,
      });
    }
  }

  if (mapper.targetType) {
    const t = findTypeFile(worktree, mapper.targetType);
    if (!t) {
      issues.push({
        mapperId: id,
        severity: "error",
        code: "targetType-unresolved",
        message: `targetType not found under worktree: ${mapper.targetType}`,
      });
    }
  }

  if (mapper.sourceType) {
    const s = findTypeFile(worktree, mapper.sourceType);
    if (!s) {
      issues.push({
        mapperId: id,
        severity: "warn",
        code: "sourceType-unresolved",
        message: `sourceType not found under worktree: ${mapper.sourceType}`,
      });
    }
  }

  return issues;
}

export function checkRegistry(options: {
  registryPath?: string;
  worktree?: string | null;
}): RegistryCheckResult {
  const registryPath = options.registryPath ?? paths.registry;
  const worktree =
    options.worktree === undefined
      ? getEnvOptional("MAPPER_WORKTREE") || null
      : options.worktree;
  const registry = loadRegistry(registryPath);
  const issues: RegistryCheckIssue[] = [];
  for (const m of registry.mappers) {
    issues.push(...checkMapperEntry(m, worktree && existsSync(worktree) ? worktree : null));
  }
  if (worktree && !existsSync(worktree)) {
    issues.push({
      mapperId: "*",
      severity: "error",
      code: "worktree-missing",
      message: `worktree does not exist: ${worktree}`,
    });
  }
  const errors = issues.filter((i) => i.severity === "error");
  return {
    ok: errors.length === 0,
    worktree: worktree && existsSync(worktree) ? worktree : null,
    issues,
    checked: registry.mappers.length,
  };
}

const isMain =
  process.argv[1]?.endsWith("checkRegistry.ts") ||
  process.argv[1]?.endsWith("checkRegistry.js");

if (isMain) {
  const { values } = parseArgs({
    options: {
      registry: { type: "string", default: paths.registry },
      worktree: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const result = checkRegistry({
    registryPath: values.registry,
    worktree: values.worktree ?? undefined,
  });
  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `registry:check — ${result.checked} mapper(s)` +
        (result.worktree ? ` worktree=${result.worktree}` : " (no worktree)"),
    );
    if (result.issues.length === 0) {
      console.log("  [OK] no issues");
    }
    for (const i of result.issues) {
      const flag = i.severity === "error" ? "[!!]" : "[..]";
      console.log(`  ${flag} ${i.mapperId}: ${i.code} — ${i.message}`);
    }
  }
  process.exit(result.ok ? 0 : 1);
}
