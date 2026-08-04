/**
 * AI-primary discovery merge with AST corroboration.
 * AI hits drive the labeling target set; AST raises confidence and may enrich code.
 * AST-only targets are counted in meta but not emitted (unless escape-hatch path).
 */

import type { ModelProvider, DiscoverHit } from "./provider.js";
import { groupOperationsByTarget, type FieldMapping, type PipelineOp } from "../groupMapping.js";
import type { AstStep, IndexAst } from "./labeler.js";
import { operationsOf } from "./labeler.js";
import { getDiscoveryCache, setDiscoveryCache } from "../cache/index.js";

export interface DiscoveryMeta {
  astTargets: number;
  aiTargets: number;
  mergedTargets: number;
  aiOnly: number;
  astOnly: number;
  both?: number;
}

export interface DiscoverMergeResult {
  groups: FieldMapping[];
  meta: DiscoveryMeta;
}

const CONFIDENCE_BOTH = 1;
const CONFIDENCE_AI = 0.6;
const CONFIDENCE_AST = 0.4;

function normalizeLeaf(name: string): string {
  const leaf = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return leaf
    .replace(/^set/, "")
    .replace(/^get/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function codeFromOps(ops: PipelineOp[]): string {
  for (const op of ops) {
    const meta = op.meta && typeof op.meta === "object" ? op.meta : undefined;
    if (meta && typeof meta.code === "string" && meta.code) return meta.code;
  }
  return "";
}

/** Prefer longer snippets and those that include helper / trim transforms. */
export function preferRicherCode(a: string, b: string): string {
  const score = (s: string): number => {
    if (!s) return 0;
    let n = s.length;
    if (/String::trim|\.trim\s*\(/.test(s)) n += 100;
    if (/private\s+\S+\s+\w+\s*\(/.test(s)) n += 50;
    if (/Optional\.|Stream\./.test(s)) n += 25;
    return n;
  };
  return score(a) >= score(b) ? a : b;
}

function tagFirstOp(
  ops: PipelineOp[],
  source: "ast" | "ai" | "both",
  confidence: number,
  extras: Record<string, unknown> = {},
): PipelineOp[] {
  if (ops.length === 0) {
    return [
      {
        kind: "RAW",
        meta: { discoverySource: source, confidence, ...extras },
      },
    ];
  }
  const first = { ...ops[0]! };
  const meta = { ...(typeof first.meta === "object" && first.meta ? first.meta : {}) };
  meta.discoverySource = source;
  meta.confidence = confidence;
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined) meta[k] = v;
  }
  first.meta = meta;
  return [first, ...ops.slice(1)];
}

/**
 * Escape hatch: AST groups only (no AI discovery). Used by --no-discover-ai.
 */
export function mergeAstOnlyEscapeHatch(astGroups: FieldMapping[]): DiscoverMergeResult {
  const groups = astGroups.map((g) => ({
    targetField: g.targetField,
    pipeline: tagFirstOp(g.pipeline, "ast", CONFIDENCE_AST),
  }));
  return {
    groups,
    meta: {
      astTargets: astGroups.length,
      aiTargets: 0,
      mergedTargets: groups.length,
      aiOnly: 0,
      astOnly: groups.length,
      both: 0,
    },
  };
}

/**
 * AI-primary merge: emit AI hits; AST corroborates confidence / enriches code.
 * AST-only targets are not labeled.
 */
export function mergeAstAndAiDiscovery(
  astGroups: FieldMapping[],
  aiHits: DiscoverHit[],
): DiscoverMergeResult {
  const astByLeaf = new Map<string, FieldMapping>();
  for (const g of astGroups) {
    const leaf = normalizeLeaf(g.targetField);
    if (!astByLeaf.has(leaf)) astByLeaf.set(leaf, g);
  }

  const merged: FieldMapping[] = [];
  const usedAstLeaves = new Set<string>();
  const seenAiLeaves = new Set<string>();
  let both = 0;
  let aiOnly = 0;

  for (const hit of aiHits) {
    if (!hit.javaTargetHint?.trim()) continue;
    const leaf = normalizeLeaf(hit.javaTargetHint);
    if (seenAiLeaves.has(leaf)) continue;
    seenAiLeaves.add(leaf);

    const astGroup = astByLeaf.get(leaf);
    const aiCode = hit.codeSnippet?.trim() ?? "";

    if (astGroup) {
      usedAstLeaves.add(leaf);
      both++;
      const astCode = codeFromOps(astGroup.pipeline);
      const code =
        preferRicherCode(astCode, aiCode) || aiCode || astCode || hit.javaTargetHint.trim();
      const extras: Record<string, unknown> = {};
      if (code) extras.code = code;
      if (hit.note) extras.aiNote = hit.note;

      const strongAst = astGroup.pipeline.some((op) => {
        const k = (op.kind ?? "").toUpperCase();
        return k === "READ" || k === "TRANSFORM" || k === "CONSTANT";
      });
      const pipeline = strongAst
        ? tagFirstOp([...astGroup.pipeline], "both", CONFIDENCE_BOTH, extras)
        : tagFirstOp([{ kind: "RAW", meta: { code } }], "both", CONFIDENCE_BOTH, extras);

      merged.push({
        targetField: astGroup.targetField,
        pipeline,
      });
    } else {
      aiOnly++;
      const extras: Record<string, unknown> = {
        code: aiCode || hit.javaTargetHint.trim(),
      };
      if (hit.note) extras.aiNote = hit.note;
      merged.push({
        targetField: hit.javaTargetHint.trim(),
        pipeline: tagFirstOp(
          [{ kind: "RAW", meta: { code: extras.code } }],
          "ai",
          CONFIDENCE_AI,
          extras,
        ),
      });
    }
  }

  const astOnly = Math.max(0, astGroups.length - usedAstLeaves.size);

  return {
    groups: merged,
    meta: {
      astTargets: astGroups.length,
      aiTargets: aiHits.length,
      mergedTargets: merged.length,
      aiOnly,
      astOnly,
      both,
    },
  };
}

export async function discoverAndMerge(
  ast: IndexAst,
  sourceJava: string,
  provider: ModelProvider,
  options: {
    fingerprint?: string;
    noCache?: boolean;
    /** When true, skip model discovery (requires useAst). */
    skipAiDiscovery?: boolean;
    /** When true, use AST groups for corroboration / escape hatch. Default false. */
    useAst?: boolean;
  } = {},
): Promise<DiscoverMergeResult> {
  const useAst = Boolean(options.useAst);
  const astGroups = useAst
    ? groupOperationsByTarget(operationsOf(ast) as PipelineOp[])
    : [];
  const mapperId = ast.mapperId ?? "unknown";

  if (options.skipAiDiscovery) {
    if (!useAst) {
      return {
        groups: [],
        meta: {
          astTargets: 0,
          aiTargets: 0,
          mergedTargets: 0,
          aiOnly: 0,
          astOnly: 0,
          both: 0,
        },
      };
    }
    return mergeAstOnlyEscapeHatch(astGroups);
  }

  let aiHits: DiscoverHit[] = [];
  if (sourceJava.trim()) {
    const cached =
      !options.noCache && options.fingerprint
        ? getDiscoveryCache(mapperId, options.fingerprint)
        : null;
    if (cached) {
      aiHits = cached.hits;
    } else {
      const discovered = await provider.discoverMappings({
        sourceJava,
        className: ast.className,
        entryMethod: ast.entryMethod,
      });
      aiHits = discovered.mappings;
      if (!options.noCache && options.fingerprint) {
        setDiscoveryCache({
          fingerprint: options.fingerprint,
          mapperId,
          hits: aiHits,
          cachedAt: new Date().toISOString(),
        });
      }
    }
  }

  // No AI hits — do not invent from AST; empty labeling set when AI-primary.
  return mergeAstAndAiDiscovery(astGroups, aiHits);
}

/** Re-export for tests / callers that only have flat ops. */
export function groupAst(ast: IndexAst | { operations?: AstStep[]; steps?: AstStep[] }): FieldMapping[] {
  return groupOperationsByTarget(operationsOf(ast) as PipelineOp[]);
}
