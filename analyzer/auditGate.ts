/**
 * audit_gate — deterministic completeness check.
 *
 * Declared target fields vs write sites. Every field must end in exactly one
 * state:
 *   mapped     — at least one write site accounts for it (with provenance)
 *   unresolved — an opaque bulk call (receiver handed to unknown code) may
 *                write it; a human or the agent's tool loop must settle it
 *   unmapped   — no write anywhere in the analyzed closure
 *
 * The gate passes only when nothing is silently missing: the "unmapped" state
 * is itself an explicit, visible answer — not an absence.
 */

import type { AuditReport, ChecklistEntry, ParsedSource, WriteSite } from "./types.js";

function norm(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/**
 * Opaque receiver escapes: the target object passed as an argument into a
 * method we cannot see (different class, not a recognized write pattern).
 * e.g. AuditStamper.stamp(notice) — could write anything.
 */
export function findOpaqueEscapes(
  source: string,
  receivers: string[],
  knownWriteLines: Set<number>,
): Array<{ line: number; statement: string }> {
  if (receivers.length === 0) return [];
  const out: Array<{ line: number; statement: string }> = [];
  const recvAlt = receivers.join("|");
  const escapeRe = new RegExp(`\\b([A-Z]\\w*(?:\\.\\w+)?)\\s*\\(([^()]*\\b(?:${recvAlt})\\b[^()]*)\\)`, "g");
  let line = 1;
  let lastIdx = 0;
  for (const m of source.matchAll(escapeRe)) {
    for (let i = lastIdx; i < m.index!; i++) if (source[i] === "\n") line++;
    lastIdx = m.index!;
    if (m[1]!.startsWith("new ")) continue;
    if (!knownWriteLines.has(line)) {
      out.push({ line, statement: m[0].trim() });
    }
  }
  return out;
}

export function runAuditGate(options: {
  parsed: ParsedSource;
  source: string;
  targetClass: string;
  declaredFields: Array<{ name: string; type?: string }>;
  writeSites: WriteSite[];
}): AuditReport {
  const { parsed, source, targetClass, declaredFields, writeSites } = options;

  const byField = new Map<string, WriteSite[]>();
  for (const site of writeSites) {
    const key = norm(site.targetField);
    if (!byField.has(key)) byField.set(key, []);
    byField.get(key)!.push(site);
  }

  function writesFor(fieldName: string): WriteSite[] {
    const full = byField.get(norm(fieldName));
    if (full?.length) return full;
    // Dotted checklist path vs leaf-named write (or vice versa).
    const leaf = norm(fieldName.split(".").pop()!);
    return byField.get(leaf) ?? [];
  }

  const receivers = [...new Set(writeSites.map((s) => s.receiver))].filter(
    (r) => !r.includes("("),
  );
  const knownLines = new Set(writeSites.map((s) => s.line));
  const escapes = findOpaqueEscapes(source, receivers, knownLines);

  const declaredKeys = new Set(declaredFields.map((f) => norm(f.name)));
  const checklist: ChecklistEntry[] = declaredFields.map((f) => {
    const writes = writesFor(f.name);
    if (writes.length > 0) {
      return {
        field: f.name,
        type: f.type,
        state: "mapped",
        writes: writes.map((w) => ({ line: w.line, via: w.via, inMethod: w.inMethod })),
      };
    }
    if (escapes.length > 0) {
      return {
        field: f.name,
        type: f.type,
        state: "unresolved",
        writes: [],
        note: `possibly written by opaque call(s): ${escapes
          .map((e) => `line ${e.line} "${e.statement}"`)
          .join("; ")}`,
      };
    }
    return {
      field: f.name,
      type: f.type,
      state: "unmapped",
      writes: [],
      note: "no write found anywhere in the analyzed source",
    };
  });

  const declaredLeafKeys = new Set(
    declaredFields.map((f) => norm(f.name.split(".").pop()!)),
  );
  const orphanWrites = writeSites.filter(
    (s) =>
      !declaredKeys.has(norm(s.targetField)) &&
      !declaredLeafKeys.has(norm(s.targetField.split(".").pop()!)),
  );

  const mapped = checklist.filter((c) => c.state === "mapped").length;
  const unmapped = checklist.filter((c) => c.state === "unmapped").length;
  const unresolved = checklist.filter((c) => c.state === "unresolved").length;

  return {
    sourceFile: parsed.filePath,
    targetClass,
    declaredFields: declaredFields.length,
    mapped,
    unmapped,
    unresolved,
    gatePassed: unresolved === 0 && orphanWrites.length === 0,
    checklist,
    orphanWrites,
  };
}
