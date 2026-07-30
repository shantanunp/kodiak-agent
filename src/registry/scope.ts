import { minimatch } from "minimatch";

export function matchesScope(filePath: string, scopeGlobs: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return scopeGlobs.some((glob) => minimatch(normalized, glob, { dot: true }));
}

export function assertMapperInScope(sourceFile: string, scopeGlobs: string[]): void {
  if (!matchesScope(sourceFile, scopeGlobs)) {
    throw new Error(`Mapper sourceFile "${sourceFile}" does not match registry scope`);
  }
}
