/**
 * Deterministic reconciler (KOD-5) between the CST write-site scan and the AI
 * write-site miner. Plain code, no model call — same spirit as
 * `findPossibleMissedWrites` in secondOpinion.ts.
 *
 * The rule (see AI-MINER-PLAN.md): CST wins whenever it has an opinion.
 *   - both legs found the field       -> "agreed"; CST's slice is still what
 *                                         the labeler reads, the AI candidate
 *                                         is just corroboration
 *   - only the AI leg found it        -> "aiOnly"; NOT asserted mapped —
 *                                         the caller (agent loop) uses this to
 *                                         demote the field to unresolved so it
 *                                         goes through the existing escalation
 *                                         path, never to assert a pipeline
 *   - only the CST leg found it       -> "cstOnly"; CST still wins, nothing to
 *                                         reconcile
 *   - neither leg found it            -> field stays unmapped (not returned
 *                                         in any of the three buckets here)
 *
 * Field-name matching is on the normalized leaf, so "DeliveryPayload.remarks"
 * (checklist path), "remarks" (write-site targetField), and an AI claim of
 * "Remarks" all line up.
 */

import type { WriteSite } from "./types.js";
import { normalizeFieldName } from "./fieldNames.js";

/** Duck-typed on purpose: analyzer/ must not import translator/ (AI stays out
 * of analyzer/), so this mirrors the shape of AiWriteCandidate rather than
 * importing it. */
export interface AiWriteCandidateLike {
  field: string;
  line: number;
  evidence: string;
}

export interface ReconcileResult {
  /** Declared fields both legs found. */
  agreed: string[];
  /** AI candidates for fields the CST leg did not find. */
  aiOnly: AiWriteCandidateLike[];
  /** CST write sites for fields the AI leg did not find. */
  cstOnly: WriteSite[];
}

function leafKey(field: string): string {
  return normalizeFieldName(field.includes(".") ? field.slice(field.lastIndexOf(".") + 1) : field);
}

export function reconcile(
  cstSites: WriteSite[],
  aiCandidates: AiWriteCandidateLike[],
  declaredFields: string[],
): ReconcileResult {
  const cstByLeaf = new Map<string, WriteSite>();
  for (const site of cstSites) {
    cstByLeaf.set(leafKey(site.targetField), site);
  }
  const aiByLeaf = new Map<string, AiWriteCandidateLike>();
  for (const cand of aiCandidates) {
    aiByLeaf.set(leafKey(cand.field), cand);
  }

  const agreed: string[] = [];
  const aiOnly: AiWriteCandidateLike[] = [];
  const cstOnly: WriteSite[] = [];

  for (const field of declaredFields) {
    const key = leafKey(field);
    const cstSite = cstByLeaf.get(key);
    const aiCand = aiByLeaf.get(key);
    if (cstSite && aiCand) {
      agreed.push(field);
    } else if (!cstSite && aiCand) {
      aiOnly.push(aiCand);
    } else if (cstSite && !aiCand) {
      cstOnly.push(cstSite);
    }
    // neither -> field stays unmapped; not reported in any bucket
  }

  return { agreed, aiOnly, cstOnly };
}
