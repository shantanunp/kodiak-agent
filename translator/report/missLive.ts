/**
 * Classify checklist diagnostics + field gate state into structured live misses
 * for the viewer scorecard (no string scraping in the UI).
 */

export type LiveMissKind =
  | "possible-missed-write"
  | "unmapped-but-mentioned"
  | "multi-instance-unattributed"
  | "prompt-injection-risk"
  | "cross-check"
  | "unmapped"
  | "unresolved";

export interface LiveMiss {
  kind: LiveMissKind;
  field?: string;
  line?: number;
  text: string;
}

const PREFIX_KINDS: Array<{ prefix: string; kind: LiveMissKind }> = [
  { prefix: "possible-missed-write", kind: "possible-missed-write" },
  { prefix: "unmapped-but-mentioned", kind: "unmapped-but-mentioned" },
  { prefix: "multi-instance-unattributed", kind: "multi-instance-unattributed" },
  { prefix: "prompt-injection-risk", kind: "prompt-injection-risk" },
];

function parseFieldAndLine(text: string, kind: LiveMissKind): {
  field?: string;
  line?: number;
} {
  const lineM = text.match(/\bline\s+(\d+)\b/i);
  const line = lineM ? Number(lineM[1]) : undefined;

  if (kind === "unmapped-but-mentioned") {
    const m = text.match(/^unmapped-but-mentioned\s+(\S+)/);
    return { field: m?.[1], line };
  }
  if (kind === "prompt-injection-risk") {
    const m = text.match(/^prompt-injection-risk\s+(\S+?):/);
    return { field: m?.[1], line };
  }
  if (kind === "multi-instance-unattributed") {
    const m = text.match(/\bfield\s+(\S+)/);
    return { field: m?.[1], line };
  }
  return { line };
}

/** Build structured miss rows from checklist diagnostics and field states. */
export function classifyMissLive(options: {
  diagnostics: string[];
  fields: Array<{ field: string; state: string; note?: string }>;
}): LiveMiss[] {
  const out: LiveMiss[] = [];

  for (const text of options.diagnostics) {
    const hit = PREFIX_KINDS.find((p) => text.startsWith(p.prefix));
    if (!hit) continue;
    const { field, line } = parseFieldAndLine(text, hit.kind);
    out.push({ kind: hit.kind, field, line, text });
  }

  for (const f of options.fields) {
    if (f.note?.startsWith("cross-check:")) {
      out.push({
        kind: "cross-check",
        field: f.field,
        text: `${f.field}: ${f.note}`,
      });
    }
    if (f.state === "unmapped") {
      out.push({
        kind: "unmapped",
        field: f.field,
        text: f.note
          ? `${f.field}: ${f.note}`
          : `${f.field}: unmapped (no write site)`,
      });
    }
    if (f.state === "unresolved") {
      out.push({
        kind: "unresolved",
        field: f.field,
        text: f.note
          ? `${f.field}: ${f.note}`
          : `${f.field}: unresolved`,
      });
    }
  }

  return out;
}

/** Sum of journal miss-signal counts (for meta-bar pill). */
export function journalMissTotal(j: {
  possibleMissedWrites?: number;
  unmappedButMentioned?: number;
  multiInstanceUnattributed?: number;
  promptInjectionRisks?: number;
  crossCheckFlips?: number;
  groundingWarnings?: number;
  stepSmells?: number;
  verifyDivergences?: number;
  criticFindings?: number;
}): number {
  return (
    (j.possibleMissedWrites ?? 0) +
    (j.unmappedButMentioned ?? 0) +
    (j.multiInstanceUnattributed ?? 0) +
    (j.promptInjectionRisks ?? 0) +
    (j.crossCheckFlips ?? 0) +
    (j.groundingWarnings ?? 0) +
    (j.stepSmells ?? 0) +
    (j.verifyDivergences ?? 0) +
    (j.criticFindings ?? 0)
  );
}
