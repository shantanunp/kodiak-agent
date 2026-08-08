/**
 * Prompt-injection posture — flag suspicious imperative comments in slices.
 * Source is untrusted input flowing into prompts; deterministic diagnostics
 * warn reviewers when comments look like instructions to the model.
 */

const IMPERATIVE_PATTERNS: Array<{ re: RegExp; why: string }> = [
  {
    re: /\/\/\s*(ignore|disregard|forget)\b[^\n]{0,80}(instruction|prompt|above|previous)/i,
    why: "comment asks to ignore prior instructions",
  },
  {
    re: /\/\/\s*(you are|act as|system\s*:|assistant\s*:)/i,
    why: "comment role-plays as system/assistant",
  },
  {
    re: /\/\/\s*(always|never)\s+(output|return|respond|emit)\b/i,
    why: "comment dictates model output",
  },
  {
    re: /\/\*\s*(ignore|disregard|forget)\b[\s\S]{0,120}?\*\//i,
    why: "block comment asks to ignore instructions",
  },
  {
    re: /\/\/\s*IMPORTANT\s*:.*\b(do not|don't)\s+(follow|obey|use)\b/i,
    why: "comment overrides analysis instructions",
  },
];

export interface InjectionFinding {
  field: string;
  why: string;
  excerpt: string;
}

/** Scan one slice (or full source) for imperative comment patterns. */
export function scanPromptInjection(
  field: string,
  text: string,
): InjectionFinding[] {
  if (!text) return [];
  const out: InjectionFinding[] = [];
  for (const { re, why } of IMPERATIVE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const excerpt = m[0].replace(/\s+/g, " ").trim().slice(0, 100);
    out.push({ field, why, excerpt });
  }
  return out;
}

/** Format findings as checklist diagnostics. */
export function injectionDiagnostics(
  fields: Array<{ field: string; sliceText: string }>,
): string[] {
  const diags: string[] = [];
  for (const f of fields) {
    for (const hit of scanPromptInjection(f.field, f.sliceText)) {
      diags.push(
        `prompt-injection-risk ${hit.field}: ${hit.why} — "${hit.excerpt}"`,
      );
    }
  }
  return diags;
}
