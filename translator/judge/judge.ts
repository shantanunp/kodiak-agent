/**
 * Steering judge — verifies a user's pipeline correction against the source.
 *
 * Agrees   -> corrected pipeline written to the verified store (user-corrected
 *             fields outrank every future re-label for this source version)
 * Disagrees-> mock defect notice (KOD-nnnn) + appended to registry/defects.jsonl
 *
 * Evidence discipline: the judge must cite line numbers; citations are
 * mechanically checked against the real source, so an agreeable hallucination
 * cannot slip a bogus correction into the store.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { paths } from "../../src/config/env.js";
import type { ModelProvider, PipelineOpLabel } from "../model/provider.js";
import { HttpModelProvider } from "../model/provider.js";
import { normalizeFieldMappingResponse } from "../model/applyResponse.js";
import { fromPipelineOp } from "../model/applyResponse.js";
import { upsertCorrectedField } from "../verified/store.js";

export const JUDGE_PROMPT = `You are a verification judge for one field of a source->target mapping.

You receive: the field, its code slice (the write statement + helper bodies), the
currently displayed pipeline, and a user's claim that the pipeline is wrong
(e.g. "there should be a trim before the split").

Decide strictly from the CODE. Rules:
- agree=true ONLY if the code actually supports the user's claim.
- Every judgment MUST cite evidence: exact line numbers from the slice comments
  (each slice starts with "// write site (line N, ...)") or quoted code fragments.
- If you agree, return the full corrected pipeline (same step vocabulary:
  read/transform/filter/constant/build/write, transform ops like trim/split/
  takeFirst/keepDigits/lettersOnly/uppercase/multiply...), every step with a
  one-sentence "summary".
- If the user is wrong, agree=false with the evidence that contradicts them.
- Never invent helpers or transforms not present in the code.

Respond with JSON only:
{"agree":true,"evidence":"line 62: trimValue(raw) runs before split","pipeline":[{"kind":"read","sourceField":"…","summary":"…"},…],"reason":"…"}
or {"agree":false,"evidence":"…","reason":"…"}`;

export interface JudgeVerdict {
  agree: boolean;
  evidence: string;
  reason?: string;
  pipeline?: PipelineOpLabel[];
  /** Evidence citations that mechanically matched the slice. */
  citationsVerified: boolean;
}

export function defectsFile(): string {
  return process.env.KODIAK_DEFECTS_FILE ?? join(paths.root, "registry", "defects.jsonl");
}

export function mockDefectId(seed: string): string {
  const n = parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 6), 16) % 9000;
  return `KOD-${1000 + n}`;
}

export function logDefect(record: {
  mapperId: string;
  field: string;
  userClaim: string;
  judgeEvidence: string;
  defectId: string;
}): void {
  const file = defectsFile();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n");
}

/** Line numbers cited in evidence must exist in the slice/source context. */
export function verifyCitations(evidence: string, sliceText: string, source: string): boolean {
  const cited = [...evidence.matchAll(/line\s+(\d+)/gi)].map((m) => Number(m[1]));
  if (cited.length === 0) {
    // No line citations: accept only if evidence quotes a real code fragment.
    const quoted = evidence.match(/["'`]([^"'`]{6,})["'`]/);
    return quoted ? sliceText.includes(quoted[1]!) || source.includes(quoted[1]!) : false;
  }
  const sourceLines = source.split("\n").length;
  return cited.every(
    (n) => n >= 1 && (n <= sourceLines || sliceText.includes(`line ${n}`)),
  );
}

export async function judgeSuggestion(options: {
  provider: ModelProvider;
  mapperId: string;
  fingerprint: string;
  field: string;
  sliceText: string;
  sourceJava: string;
  currentPipeline: unknown[];
  userClaim: string;
  schemaContext?: string;
}): Promise<
  | { outcome: "corrected"; verdict: JudgeVerdict; pipeline: unknown[] }
  | { outcome: "rejected"; verdict: JudgeVerdict; defectId: string }
  | { outcome: "invalid"; verdict: JudgeVerdict }
> {
  const provider = options.provider as HttpModelProvider;
  const userPayload = JSON.stringify({
    field: options.field,
    slice: options.sliceText,
    currentPipeline: options.currentPipeline,
    userClaim: options.userClaim,
    schemaContext: options.schemaContext ?? "",
  });

  const text = await provider.generate(JUDGE_PROMPT, userPayload);

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    raw = { agree: false, evidence: "", reason: `invalid judge JSON: ${text.slice(0, 120)}` };
  }

  const verdict: JudgeVerdict = {
    agree: Boolean(raw.agree),
    evidence: typeof raw.evidence === "string" ? raw.evidence : "",
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    pipeline: Array.isArray(raw.pipeline)
      ? normalizeFieldMappingResponse({ recognized: true, pipeline: raw.pipeline }).pipeline
      : undefined,
    citationsVerified: verifyCitations(
      typeof raw.evidence === "string" ? raw.evidence : "",
      options.sliceText,
      options.sourceJava,
    ),
  };

  if (verdict.agree && verdict.pipeline?.length) {
    if (!verdict.citationsVerified) {
      // Agreement without checkable evidence never reaches the store.
      return { outcome: "invalid", verdict };
    }
    const steps = verdict.pipeline.map((op) => fromPipelineOp(op, verdict.reason, "model"));
    upsertCorrectedField({
      mapperId: options.mapperId,
      fingerprint: options.fingerprint,
      targetField: options.field,
      pipeline: steps,
      userClaim: options.userClaim,
      judgeEvidence: verdict.evidence,
    });
    return { outcome: "corrected", verdict, pipeline: steps };
  }

  const defectId = mockDefectId(`${options.mapperId}:${options.field}:${options.userClaim}`);
  logDefect({
    mapperId: options.mapperId,
    field: options.field,
    userClaim: options.userClaim,
    judgeEvidence: verdict.evidence,
    defectId,
  });
  return { outcome: "rejected", verdict, defectId };
}
