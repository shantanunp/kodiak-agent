/**
 * Cross-check verifier (parallel to labeling; catches scanner pattern gaps).
 *
 * The deterministic scan can only find write patterns it knows. This pass asks
 * the model ONE question about fields the scan believes are UNMAPPED: "do you
 * see any write for these, direct or indirect? cite the line." Rules that keep
 * it honest:
 *   - it can only DEMOTE confidence (unmapped -> unresolved), never assert truth
 *   - every claim's citation is mechanically verified against the source
 *   - unverifiable claims are dropped, with a diagnostic
 * Flipped fields feed the existing escalation / tool-loop path.
 */

import type { ModelProvider } from "../model/provider.js";
import { HttpModelProvider } from "../model/provider.js";
import { verifyCitations } from "../judge/judge.js";

export const CROSS_CHECK_PROMPT = `You are a completeness cross-checker for a source-to-target field mapping.

You receive full source code and a list of target fields a static scanner
believes are NEVER written. Your only job: find writes the scanner missed —
reflection or bulk-copy utilities, lambdas or method references mutating the
target, writes hidden in generated or unusual code.

Rules:
- Report a field ONLY if you can cite the exact line number of the write.
- Do NOT guess. No citation, no claim. An empty result is a good result.
- Do not report fields that are genuinely never written.

Respond with JSON only:
{"missedWrites":[{"field":"<name from the list>","line":12,"evidence":"line 12: <what happens there>"}]}
or {"missedWrites":[]}`;

export interface CrossCheckFlip {
  field: string;
  line: number;
  evidence: string;
}

export async function crossCheckUnmapped(options: {
  provider: ModelProvider;
  sourceJava: string;
  unmappedFields: string[];
}): Promise<{ flips: CrossCheckFlip[]; dropped: string[] }> {
  if (options.unmappedFields.length === 0) return { flips: [], dropped: [] };

  const provider = options.provider as HttpModelProvider;
  const text = await provider.generate(
    CROSS_CHECK_PROMPT,
    JSON.stringify({
      unmappedFields: options.unmappedFields,
      source: options.sourceJava,
    }),
  );

  let raw: { missedWrites?: Array<{ field?: string; line?: number; evidence?: string }> };
  try {
    raw = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { flips: [], dropped: ["cross-check returned invalid JSON — ignored"] };
  }

  const known = new Set(options.unmappedFields.map((f) => f.toLowerCase()));
  const flips: CrossCheckFlip[] = [];
  const dropped: string[] = [];

  for (const claim of raw.missedWrites ?? []) {
    const field = options.unmappedFields.find(
      (f) => f.toLowerCase() === String(claim.field ?? "").toLowerCase(),
    );
    if (!field || !known.has(field.toLowerCase())) {
      dropped.push(`claim for unknown field "${claim.field}" — dropped`);
      continue;
    }
    const evidence = String(claim.evidence ?? "");
    // Mechanical check: cited line must exist and evidence must reference it.
    const ok =
      Number.isInteger(claim.line) &&
      verifyCitations(`line ${claim.line}: ${evidence}`, "", options.sourceJava);
    if (!ok) {
      dropped.push(`claim for "${field}" had no verifiable citation — dropped`);
      continue;
    }
    flips.push({ field, line: claim.line as number, evidence });
  }
  return { flips, dropped };
}
