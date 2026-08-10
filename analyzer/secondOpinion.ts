/**
 * PAR-1 / PAR-2 — miss-detection helpers over mapper source (deterministic, no model).
 *
 * PAR-1: loose regex sweep for write-like patterns the CST scan may have missed.
 * PAR-2: for each UNMAPPED field, flag if the name / setter still appears in source.
 */

import type { WriteSite } from "./types.js";

export interface PossibleMissedWrite {
  kind: "possible-missed-write";
  line: number;
  evidence: string;
  hint: string;
}

export interface UnmappedMention {
  kind: "unmapped-but-mentioned";
  field: string;
  line: number;
  evidence: string;
}

function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

function stripCommentsAndStrings(source: string): string {
  // Replace string/char literals and // / /* */ comments with spaces (keep newlines).
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      out += "  ";
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < source.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += " ";
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < source.length) {
          out += "  ";
          i += 2;
          continue;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < source.length) {
        out += " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Loose candidates: setter / withX / put("k" / method-ref ::setX */
export function looseWriteCandidates(source: string): Array<{ line: number; evidence: string; hint: string }> {
  const scrubbed = stripCommentsAndStrings(source);
  const out: Array<{ line: number; evidence: string; hint: string }> = [];
  const seen = new Set<string>();

  const patterns: Array<{ re: RegExp; hint: string }> = [
    { re: /\.\s*set([A-Z]\w*)\s*\(/g, hint: "setter-like call" },
    { re: /\.\s*with([A-Z]\w*)\s*\(/g, hint: "fluent with* call" },
    { re: /\.\s*put\s*\(\s*"/g, hint: "map put" },
    { re: /::\s*set([A-Z]\w*)\b/g, hint: "method-reference setter" },
    { re: /\.\s*get([A-Z]\w*)\s*\(\s*\)\s*\.\s*(?:add|addAll)\s*\(/g, hint: "collection getter-add" },
  ];

  for (const { re, hint } of patterns) {
    for (const m of scrubbed.matchAll(re)) {
      const line = lineOfOffset(source, m.index!);
      // Recover a short evidence snippet from the original source.
      const lineStart = source.lastIndexOf("\n", m.index!) + 1;
      const lineEnd = source.indexOf("\n", m.index!);
      const evidence = source
        .slice(lineStart, lineEnd < 0 ? source.length : lineEnd)
        .trim()
        .slice(0, 120);
      const key = `${line}:${hint}:${evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ line, evidence, hint });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * PAR-1: candidates the loose scan found that CST write sites do not cover
 * (same line, or evidence contains the CST statement leaf).
 */
export function findPossibleMissedWrites(
  source: string,
  cstSites: WriteSite[],
): PossibleMissedWrite[] {
  const cstLines = new Set(cstSites.map((s) => s.line));
  const cstFields = new Set(
    cstSites.map((s) => s.targetField.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()),
  );

  const misses: PossibleMissedWrite[] = [];
  for (const c of looseWriteCandidates(source)) {
    if (cstLines.has(c.line)) continue;
    // If the evidence clearly names a field the CST already attributed elsewhere, skip.
    const named = /\.(?:set|with)([A-Z]\w*)/.exec(c.evidence);
    if (named) {
      const leaf = named[1]!.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      // decap: setFoo -> foo
      const decap = leaf.charAt(0).toLowerCase() + leaf.slice(1);
      if (cstFields.has(leaf) || cstFields.has(decap)) continue;
    }
    misses.push({
      kind: "possible-missed-write",
      line: c.line,
      evidence: c.evidence,
      hint: c.hint,
    });
  }
  return misses;
}

/** PAR-2: unmapped fields whose name / setter / getter still appear in source. */
export function findUnmappedMentions(
  source: string,
  unmappedFields: string[],
): UnmappedMention[] {
  const scrubbed = stripCommentsAndStrings(source);
  const out: UnmappedMention[] = [];

  for (const field of unmappedFields) {
    const leaf = field.includes(".") ? field.slice(field.lastIndexOf(".") + 1) : field;
    if (!leaf) continue;
    const cap = leaf.charAt(0).toUpperCase() + leaf.slice(1);
    const forms = [
      new RegExp(`\\bset${cap}\\b`),
      new RegExp(`\\bget${cap}\\b`),
      new RegExp(`\\bis${cap}\\b`),
      new RegExp(`\\bwith${cap}\\b`),
      new RegExp(`\\b${leaf}\\b`),
    ];
    for (const re of forms) {
      const m = re.exec(scrubbed);
      if (!m) continue;
      const line = lineOfOffset(source, m.index);
      const lineStart = source.lastIndexOf("\n", m.index) + 1;
      const lineEnd = source.indexOf("\n", m.index);
      const evidence = source
        .slice(lineStart, lineEnd < 0 ? source.length : lineEnd)
        .trim()
        .slice(0, 120);
      out.push({ kind: "unmapped-but-mentioned", field, line, evidence });
      break;
    }
  }
  return out;
}

export function missDiagnostics(
  source: string,
  cstSites: WriteSite[],
  unmappedFields: string[],
): string[] {
  const diags: string[] = [];
  for (const m of findPossibleMissedWrites(source, cstSites)) {
    diags.push(
      `possible-missed-write line ${m.line} (${m.hint}): ${m.evidence}`,
    );
  }
  for (const u of findUnmappedMentions(source, unmappedFields)) {
    diags.push(
      `unmapped-but-mentioned ${u.field} line ${u.line}: ${u.evidence}`,
    );
  }
  return diags;
}
