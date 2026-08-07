/**
 * Resolve the source file that declares a type, given its fully qualified name
 * and a worktree root. Deterministic:
 *   1. package-path convention under common source roots
 *   2. bounded worktree walk for "<OuterClass>.<ext>" as fallback
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCE_ROOTS = ["src/main/java", "src", "app/src/main/java", "main/java", ""];
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", "dist", "build", "target", "out",
  ".idea", ".gradle", ".vscode", "coverage",
]);
const MAX_WALK_DEPTH = 10;

/** "com.a.b.Outer$Inner" -> { packagePath: "com/a/b", outerClass: "Outer" } */
export function splitFqcn(fqcn: string): { packagePath: string; outerClass: string } {
  const lastDot = fqcn.lastIndexOf(".");
  const tail = lastDot === -1 ? fqcn : fqcn.slice(lastDot + 1);
  const packagePath = lastDot === -1 ? "" : fqcn.slice(0, lastDot).replace(/\./g, "/");
  const outerClass = tail.includes("$") ? tail.slice(0, tail.indexOf("$")) : tail;
  return { packagePath, outerClass };
}

function walkFor(root: string, fileName: string, depth: number): string | null {
  if (depth > MAX_WALK_DEPTH) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry === fileName) return join(root, entry);
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = join(root, entry);
    try {
      if (statSync(full).isDirectory()) dirs.push(full);
    } catch {
      // unreadable — skip
    }
  }
  for (const dir of dirs) {
    const found = walkFor(dir, fileName, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Find the file declaring the given FQCN, or null. */
export function findTypeFile(
  worktree: string,
  fqcn: string,
  ext = ".java",
): string | null {
  const { packagePath, outerClass } = splitFqcn(fqcn);
  const fileName = `${outerClass}${ext}`;

  if (packagePath) {
    for (const root of SOURCE_ROOTS) {
      const candidate = join(worktree, root, packagePath, fileName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return walkFor(worktree, fileName, 0);
}

/**
 * Infer the worktree root from a resolved mapper source path:
 * "/wt/src/main/java/com/x/M.java" + sourceFile "src/main/java/com/x/M.java"
 * -> "/wt". Removes the need to set MAPPER_WORKTREE for reads.
 */
export function inferWorktree(
  sourcePath: string | undefined,
  mapperSourceFile: string,
): string | null {
  if (!sourcePath) return null;
  const norm = sourcePath.replace(/\\/g, "/");
  const rel = mapperSourceFile.replace(/\\/g, "/");
  if (!norm.endsWith(rel)) return null;
  const root = norm.slice(0, norm.length - rel.length).replace(/\/$/, "");
  return root || null;
}
