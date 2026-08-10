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

type GuardHeader = { start: number; header: string };

/**
 * Control header immediately before `pos` whose body is a single statement
 * (no `{` between header and `pos`): `if (pred)\n  stmt;`
 *
 * `pos` must be the start of that body (write statement, or an inner brace-less
 * header) — not the start of the `if` itself, or the header is skipped.
 */
function peekBraceLessHeaderBefore(
  bodyText: string,
  pos: number,
): GuardHeader | null {
  let j = pos - 1;
  while (j >= 0 && /\s/.test(bodyText[j]!)) j--;
  if (j < 0) return null;
  // Braced body — handled by the brace walk, not here.
  if (bodyText[j] === "{") return null;

  let headerEnd = j + 1;
  let start: number;

  if (bodyText[j] === ")") {
    // Walk back over balanced `(...)`, then the if/for/while keyword.
    let paren = 0;
    let s: string | null = null;
    const closeParen = j;
    let openParen = -1;
    for (; j >= 0; j--) {
      const c = bodyText[j]!;
      const p = j > 0 ? bodyText[j - 1]! : "";
      if (s) {
        if (c === s && p !== "\\") s = null;
        continue;
      }
      if (c === '"' || c === "'") {
        s = c;
        continue;
      }
      if (c === ")") paren++;
      else if (c === "(") {
        paren--;
        if (paren === 0) {
          openParen = j;
          j--;
          while (j >= 0 && /\s/.test(bodyText[j]!)) j--;
          break;
        }
      }
    }
    if (openParen < 0) return null;
    headerEnd = closeParen + 1;

    let k = j;
    while (k >= 0 && /[A-Za-z]/.test(bodyText[k]!)) k--;
    const keyword = bodyText.slice(k + 1, j + 1).trim();
    if (keyword !== "if" && keyword !== "for" && keyword !== "while") return null;
    start = k + 1;
    if (keyword === "if") {
      let p = start - 1;
      while (p >= 0 && /\s/.test(bodyText[p]!)) p--;
      if (p >= 3 && bodyText.slice(p - 3, p + 1) === "else") {
        start = p - 3;
      }
    }
  } else if (/[A-Za-z]/.test(bodyText[j]!)) {
    let k = j;
    while (k >= 0 && /[A-Za-z]/.test(bodyText[k]!)) k--;
    const keyword = bodyText.slice(k + 1, j + 1).trim();
    if (keyword !== "else") return null;
    start = k + 1;
    headerEnd = j + 1;
  } else {
    return null;
  }

  if (/[{}]/.test(bodyText.slice(headerEnd, pos))) return null;

  const header = bodyText.slice(start, headerEnd).replace(/\s+/g, " ").trim();
  if (!/^(?:else\s+if|if|else|for|while)\b/.test(header)) return null;
  return { start, header };
}

/** Brace-less guard chain whose body begins at `pos` (outer → inner). */
function braceLessGuardChain(bodyText: string, pos: number): GuardHeader[] {
  const found: GuardHeader[] = [];
  let cursor = pos;
  while (cursor > 0) {
    const g = peekBraceLessHeaderBefore(bodyText, cursor);
    if (!g) break;
    found.push(g);
    cursor = g.start;
  }
  return found.reverse();
}

/**
 * Headers of if/else/for/while/switch blocks that enclose `atOffset` in bodyText.
 * Constant / branched writes need their predicates in the slice — local-def
 * tracing alone cannot see them (true/false literals have no identifiers).
 *
 * Handles both braced (`if (p) { stmt; }`) and brace-less (`if (p)\n  stmt;`) forms.
 */
export function enclosingGuards(bodyText: string, atOffset: number): string[] {
  if (atOffset <= 0 || atOffset > bodyText.length) return [];

  const braced: GuardHeader[] = [];
  let depth = 0;
  let inStr: string | null = null;
  /** After recording `else` / `else if`, skip the `}` that closed the then-block so the matching `if (` still surfaces. */
  let skipNextCloseBrace = false;

  for (let i = atOffset - 1; i >= 0; i--) {
    const ch = bodyText[i]!;
    const prev = i > 0 ? bodyText[i - 1]! : "";

    if (inStr) {
      if (ch === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === "}") {
      if (skipNextCloseBrace) {
        skipNextCloseBrace = false;
        continue;
      }
      depth++;
      continue;
    }
    if (ch !== "{") continue;

    if (depth > 0) {
      depth--;
      continue;
    }

    // Opening brace of a block that contains the write — grab its header.
    let j = i - 1;
    while (j >= 0 && /\s/.test(bodyText[j]!)) j--;
    if (j < 0) continue;

    // Walk back over a balanced (...) if present (if/for/while/switch/catch).
    let headerEnd = j + 1;
    if (bodyText[j] === ")") {
      let paren = 0;
      let s: string | null = null;
      for (; j >= 0; j--) {
        const c = bodyText[j]!;
        const p = j > 0 ? bodyText[j - 1]! : "";
        if (s) {
          if (c === s && p !== "\\") s = null;
          continue;
        }
        if (c === '"' || c === "'") {
          s = c;
          continue;
        }
        if (c === ")") paren++;
        else if (c === "(") {
          paren--;
          if (paren === 0) {
            headerEnd = i; // exclusive end at "{"
            j--; // move before "("
            while (j >= 0 && /\s/.test(bodyText[j]!)) j--;
            break;
          }
        }
      }
    }

    // Keyword under the caret at j (last char of if/else/for/…).
    let k = j;
    while (k >= 0 && /[A-Za-z]/.test(bodyText[k]!)) k--;
    const keyword = bodyText.slice(k + 1, j + 1).trim();
    if (!keyword) continue;

    let start = k + 1;
    // "} else if (...)" — fold the preceding else into the header.
    if (keyword === "if") {
      let p = start - 1;
      while (p >= 0 && /\s/.test(bodyText[p]!)) p--;
      if (p >= 3 && bodyText.slice(p - 3, p + 1) === "else") {
        start = p - 3;
      }
    }

    const header = bodyText.slice(start, headerEnd).replace(/\s+/g, " ").trim();
    if (
      /^(?:else\s+if|if|else|for|while|switch|do|catch)\b/.test(header) &&
      !braced.some((g) => g.header === header)
    ) {
      braced.push({ start, header });
      if (/^else\b/.test(header)) skipNextCloseBrace = true;
    }
  }

  braced.reverse(); // outer → inner

  // Anchor at the write (or braced header start) — not "statement start" after
  // the previous `;`, which for `if (p)\n  stmt;` is the `if` itself.
  const lessInner = braceLessGuardChain(bodyText, atOffset);
  const lessOuter =
    braced.length > 0 ? braceLessGuardChain(bodyText, braced[0]!.start) : [];

  const guards: string[] = [];
  for (const g of [...lessOuter, ...braced, ...lessInner]) {
    if (!guards.includes(g.header)) guards.push(g.header);
  }
  return guards;
}

/**
 * Turn enclosing-guard headers into slice lines. Collapses a bare `if` followed
 * by `else` into one readable header — the raw headers alone look like broken
 * Java (`if (pred)\nelse`) and models sometimes answer with an empty pipeline.
 */
export function formatControlFlow(guards: string[]): string[] {
  if (guards.length === 0) return [];
  const merged: string[] = [];
  for (let i = 0; i < guards.length; i++) {
    const g = guards[i]!;
    const next = guards[i + 1];
    if (
      /^if\b/.test(g) &&
      next &&
      /^else\b/.test(next) &&
      !/^else\s+if\b/.test(next)
    ) {
      merged.push(`${g} { … } ${next}`);
      i++;
    } else {
      merged.push(g);
    }
  }
  return ["// control flow:", ...merged];
}

/** Locate the write statement inside the method body for guard extraction. */
function statementOffset(bodyText: string, statement: string): number {
  const idx = bodyText.indexOf(statement);
  if (idx >= 0) return idx;
  const first = statement.split("\n")[0]?.trim() ?? "";
  return first ? bodyText.indexOf(first) : -1;
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
    const bodyText = enclosing?.bodyText ?? "";
    const { statements: localDefs, combinedText } = traceLocalDefs(
      site.expression,
      bodyText,
      site.receiver,
    );

    const at = statementOffset(bodyText, site.statement);
    const guards = at >= 0 ? enclosingGuards(bodyText, at) : [];
    // Render if+else as one header so the model sees valid control flow
    // (`if (pred) { … } else`) instead of the broken two-line `if\nelse`.
    const controlFlow = formatControlFlow(guards);
    const guardText = controlFlow.join("\n");

    const helperClosure: Array<{ name: string; text: string }> = [];
    collectClosure(
      pool,
      adapter,
      options.worktree,
      [combinedText, guardText].filter(Boolean).join("\n"),
      0,
      new Set(),
      helperClosure,
    );

    const sliceText = [
      `// write site (line ${site.line}, in ${site.inMethod}, via ${site.via})`,
      ...controlFlow,
      ...(localDefs.length > 0 ? ["// local dataflow:", ...localDefs] : []),
      site.statement,
      ...helperClosure.map((h) => `\n// helper: ${h.name}\n${h.text}`),
    ].join("\n");

    return { ...site, helperClosure, sliceText };
  });

  return { parsed, slices };
}
