/**
 * Merge AST indexer groups with Gemini discovery hits.
 * Never drops AST targets; AI-only hits become RAW candidates.
 */

import type { GeminiLabelProvider, DiscoverHit } from "./gemini.js";
import { groupOperationsByTarget, type FieldMapping, type PipelineOp } from "./groupMapping.js";
import type { AstStep, IndexAst } from "./labeler.js";
import { operationsOf } from "./labeler.js";
import { getDiscoveryCache, setDiscoveryCache } from "./cache/index.js";

export interface DiscoveryMeta {
  astTargets: number;
  aiTargets: number;
  mergedTargets: number;
  aiOnly: number;
  astOnly: number;
}

export interface DiscoverMergeResult {
  groups: FieldMapping[];
  meta: DiscoveryMeta;
}

function normalizeLeaf(name: string): string {
  const leaf = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return leaf
    .replace(/^set/, "")
    .replace(/^get/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function tagDiscoverySource(ops: PipelineOp[], source: "ast" | "ai" | "both"): PipelineOp[] {
  if (ops.length === 0) return ops;
  const first = { ...ops[0]! };
  const meta = { ...(typeof first.meta === "object" && first.meta ? first.meta : {}) };
  meta.discoverySource = source;
  first.meta = meta;
  return [first, ...ops.slice(1)];
}

function isWeakAstPipeline(ops: PipelineOp[]): boolean {
  return ops.every((op) => {
    const kind = (op.kind ?? "").toUpperCase();
    return kind === "RAW" || kind === "WRITE";
  });
}

/**
 * Deterministic merge of AST groups + AI discovery hits.
 */
export function mergeAstAndAiDiscovery(
  astGroups: FieldMapping[],
  aiHits: DiscoverHit[],
): DiscoverMergeResult {
  const merged: FieldMapping[] = [];
  const matchedAi = new Set<number>();

  let both = 0;
  let astOnly = 0;

  for (const group of astGroups) {
    const leaf = normalizeLeaf(group.targetField);
    const aiIndex = aiHits.findIndex(
      (h, i) => !matchedAi.has(i) && normalizeLeaf(h.javaTargetHint) === leaf,
    );

    if (aiIndex >= 0) {
      matchedAi.add(aiIndex);
      both++;
      const hit = aiHits[aiIndex]!;
      let pipeline = [...group.pipeline];

      if (isWeakAstPipeline(pipeline) && hit.codeSnippet) {
        const hasCode = pipeline.some(
          (op) => op.meta && typeof op.meta === "object" && "code" in (op.meta as object),
        );
        if (!hasCode) {
          pipeline = [
            {
              kind: "RAW",
              meta: {
                code: hit.codeSnippet,
                discoverySource: "both",
                aiNote: hit.note,
              },
            },
            ...pipeline.filter((op) => (op.kind ?? "").toUpperCase() !== "RAW"),
          ];
        } else {
          pipeline = pipeline.map((op, idx) => {
            if (idx !== 0) return op;
            const meta = { ...(typeof op.meta === "object" && op.meta ? op.meta : {}) };
            if (!meta.code) meta.code = hit.codeSnippet;
            meta.discoverySource = "both";
            if (hit.note) meta.aiNote = hit.note;
            return { ...op, meta };
          });
        }
      } else {
        pipeline = tagDiscoverySource(pipeline, "both");
      }

      merged.push({ targetField: group.targetField, pipeline });
    } else {
      astOnly++;
      merged.push({
        targetField: group.targetField,
        pipeline: tagDiscoverySource(group.pipeline, "ast"),
      });
    }
  }

  let aiOnly = 0;
  aiHits.forEach((hit, i) => {
    if (matchedAi.has(i)) return;
    if (!hit.javaTargetHint?.trim()) return;
    aiOnly++;
    const hint = hit.javaTargetHint.trim();
    merged.push({
      targetField: hint,
      pipeline: [
        {
          kind: "RAW",
          meta: {
            code: hit.codeSnippet || hint,
            discoverySource: "ai",
            aiNote: hit.note,
          },
        },
      ],
    });
  });

  return {
    groups: merged,
    meta: {
      astTargets: astGroups.length,
      aiTargets: aiHits.length,
      mergedTargets: merged.length,
      aiOnly,
      astOnly,
    },
  };
}

export async function discoverAndMerge(
  ast: IndexAst,
  sourceJava: string,
  provider: GeminiLabelProvider,
  options: {
    fingerprint?: string;
    noCache?: boolean;
    /** When true, skip Gemini discovery (AST groups only). */
    skipAiDiscovery?: boolean;
  } = {},
): Promise<DiscoverMergeResult> {
  const astGroups = groupOperationsByTarget(operationsOf(ast) as PipelineOp[]);
  const mapperId = ast.mapperId ?? "unknown";

  if (options.skipAiDiscovery) {
    return mergeAstAndAiDiscovery(astGroups, []);
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

  return mergeAstAndAiDiscovery(astGroups, aiHits);
}

/** Re-export for tests / callers that only have flat ops. */
export function groupAst(ast: IndexAst | { operations?: AstStep[]; steps?: AstStep[] }): FieldMapping[] {
  return groupOperationsByTarget(operationsOf(ast) as PipelineOp[]);
}
