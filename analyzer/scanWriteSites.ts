/**
 * scan_write_sites — deterministic tool.
 *
 * Input: source file + target class name.
 * Output: every write site, each with a self-contained code slice
 * (statement + transitive same-class helper bodies). The labeling agent
 * consumes these slices; it never needs the whole file.
 */

import { readFileSync } from "node:fs";
import type { LanguageAdapter, ParsedSource, SourceMethod, WriteSite, WriteSlice } from "./types.js";
import { javaAdapter } from "./adapters/java.js";
import { findTypeFile } from "./resolveType.js";

const ADAPTERS: Record<string, LanguageAdapter> = {
  [javaAdapter.language]: javaAdapter,
};

export function adapterFor(language: string): LanguageAdapter {
  const adapter = ADAPTERS[language];
  if (!adapter) {
    throw new Error(
      `No analyzer adapter for language "${language}" (available: ${Object.keys(ADAPTERS).join(", ")})`,
    );
  }
  return adapter;
}

const MAX_CLOSURE_DEPTH = 5;

const KEYWORDS = new Set([
  "if", "else", "for", "while", "return", "new", "true", "false", "null",
  "this", "switch", "case", "break", "instanceof", "final", "var",
]);

/**
 * Local definitions inside a method body: variable name -> defining statements.
 * Captures both declarations ("String[] parts = ...") and reassignments.
 */
function buildLocalDefs(bodyText: string): Map<string, string[]> {
  const defs = new Map<string, string[]>();
  const defRe = /(?:[\w<>,.\[\]]+\s+)?(\w+)\s*=(?!=)\s*[^;]+;/g;
  for (const m of bodyText.matchAll(defRe)) {
    const name = m[1]!;
    if (KEYWORDS.has(name)) continue;
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name)!.push(m[0].trim());
  }
  return defs;
}

/** Bare identifiers referenced by an expression (not method calls, not after a dot). */
function referencedIdentifiers(expression: string): string[] {
  const out = new Set<string>();
  for (const m of expression.matchAll(/(?<![\w.])([a-z]\w*)\b(?!\s*\()/g)) {
    if (!KEYWORDS.has(m[1]!)) out.add(m[1]!);
  }
  return [...out];
}

/**
 * Trace the expression's local dependencies backward through the method body:
 * for every identifier it uses, pull the statements that defined it, and
 * recurse on those statements' own identifiers. Returns defining statements
 * in stable order plus the combined text (for helper-closure discovery).
 */
function traceLocalDefs(
  expression: string,
  bodyText: string,
  receiver: string,
): { statements: string[]; combinedText: string } {
  const defs = buildLocalDefs(bodyText);
  const statements: string[] = [];
  const visited = new Set<string>([receiver]);
  const queue = referencedIdentifiers(expression);

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    for (const stmt of defs.get(name) ?? []) {
      if (stmt.includes(`${receiver}.`)) continue; // don't re-pull writes
      if (!statements.includes(stmt)) {
        statements.push(stmt);
        queue.push(...referencedIdentifiers(stmt));
      }
    }
  }

  return { statements, combinedText: [expression, ...statements].join("\n") };
}

/** Bare same-class calls inside an expression: helper( … ) or this.helper( … ). */
function calledHelperNames(expression: string): string[] {
  const names = new Set<string>();
  for (const m of expression.matchAll(/(?<![\w.])(?:this\.)?([a-z]\w*)\s*\(/g)) {
    names.add(m[1]!);
  }
  return [...names];
}

function collectClosure(
  pool: SourceMethod[],
  adapter: LanguageAdapter,
  worktree: string | undefined,
  expression: string,
  depth: number,
  visited: Set<string>,
  out: Array<{ name: string; text: string }>,
): void {
  if (depth > MAX_CLOSURE_DEPTH) return;

  // Bare calls -> mapper class + inherited pool.
  for (const name of calledHelperNames(expression)) {
    if (visited.has(name)) continue;
    const helper = pool.find((m) => m.name === name);
    if (!helper) continue;
    visited.add(name);
    out.push({ name: helper.name, text: helper.fullText });
    collectClosure(pool, adapter, worktree, helper.bodyText, depth + 1, visited, out);
  }

  // Qualified calls -> resolve the class file cross-file and inline the method.
  if (!worktree) return;
  for (const q of qualifiedCalls(expression)) {
    const key = `${q.cls}.${q.method}`;
    if (visited.has(key)) continue;
    const file = findTypeFile(worktree, q.cls);
    if (!file) continue;
    const other = parseFileCached(adapter, file);
    const helper = other?.methods.find(
      (m) => m.name === q.method && m.className === q.cls,
    );
    if (!helper) continue;
    visited.add(key);
    out.push({ name: key, text: helper.fullText });
    collectClosure(pool, adapter, worktree, helper.bodyText, depth + 1, visited, out);
  }
}

export interface ScanResult {
  parsed: ParsedSource;
  slices: WriteSlice[];
}

// Per-run parse cache for cross-file resolution (keyed by absolute path).
const parseCache = new Map<string, ParsedSource>();

function parseFileCached(adapter: LanguageAdapter, file: string): ParsedSource | null {
  const hit = parseCache.get(file);
  if (hit) return hit;
  try {
    const parsed = adapter.parse(file, readFileSync(file, "utf8"));
    parseCache.set(file, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Helper pool: methods callable by bare name from the mapper — its own class
 * plus superclass chain (resolved cross-file via extends, depth-capped).
 */
function buildHelperPool(
  adapter: LanguageAdapter,
  parsed: ParsedSource,
  source: string,
  mapperClass: string,
  worktree?: string,
): SourceMethod[] {
  const pool = parsed.methods.filter((m) => m.className === mapperClass);
  if (!worktree) return pool;
  let cls = mapperClass;
  let src = source;
  for (let hop = 0; hop < 3; hop++) {
    const ext = new RegExp(`class\\s+${cls}\\s+extends\\s+([\\w.]+)`).exec(src);
    if (!ext) break;
    const superSimple = ext[1]!.split(".").pop()!;
    const file = findTypeFile(worktree, ext[1]!);
    if (!file) break;
    const superParsed = parseFileCached(adapter, file);
    if (!superParsed) break;
    pool.push(...superParsed.methods.filter((m) => m.className === superSimple));
    cls = superSimple;
    src = readFileSync(file, "utf8");
  }
  return pool;
}

/** Qualified static-style calls in an expression: Utils.method( -> [Utils, method]. */
function qualifiedCalls(expression: string): Array<{ cls: string; method: string }> {
  const out: Array<{ cls: string; method: string }> = [];
  for (const m of expression.matchAll(/(?<![\w.])([A-Z]\w*)\.(\w+)\s*\(/g)) {
    out.push({ cls: m[1]!, method: m[2]! });
  }
  return out;
}

export function scanWriteSites(options: {
  filePath: string;
  language: string;
  mapperClass: string;
  targetClass: string;
  source?: string;
  /** Enables cross-file helper closure (static utils, superclass helpers). */
  worktree?: string;
}): ScanResult {
  const adapter = adapterFor(options.language);
  const source = options.source ?? readFileSync(options.filePath, "utf8");
  parseCache.clear();
  const parsed = adapter.parse(options.filePath, source);
  const pool = buildHelperPool(adapter, parsed, source, options.mapperClass, options.worktree);

  const sites: WriteSite[] = adapter.findWriteSites(parsed, source, options.targetClass);

  const slices: WriteSlice[] = sites.map((site) => {
    const enclosing = parsed.methods.find(
      (m) => m.name === site.inMethod && site.line >= m.startLine && site.line <= m.endLine,
    );
    const { statements: localDefs, combinedText } = traceLocalDefs(
      site.expression,
      enclosing?.bodyText ?? "",
      site.receiver,
    );

    const helperClosure: Array<{ name: string; text: string }> = [];
    collectClosure(pool, adapter, options.worktree, combinedText, 0, new Set(), helperClosure);

    const sliceText = [
      `// write site (line ${site.line}, in ${site.inMethod}, via ${site.via})`,
      ...(localDefs.length > 0 ? ["// local dataflow:", ...localDefs] : []),
      site.statement,
      ...helperClosure.map((h) => `\n// helper: ${h.name}\n${h.text}`),
    ].join("\n");

    return { ...site, helperClosure, sliceText };
  });

  return { parsed, slices };
}
