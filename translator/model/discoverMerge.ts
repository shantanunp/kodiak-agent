/**
 * AI field discovery — primary path for labeling targets.
 */

import type { ModelProvider, DiscoverHit } from "./provider.js";
import type { FieldMapping, PipelineOp } from "../groupMapping.js";
import type { IndexAst } from "./labeler.js";
import { getDiscoveryCache, setDiscoveryCache } from "../cache/index.js";

export interface DiscoveryMeta {
  aiTargets: number;
  mergedTargets: number;
}

export interface DiscoverMergeResult {
  groups: FieldMapping[];
  meta: DiscoveryMeta;
}

const CONFIDENCE_AI = 0.6;

function normalizeLeaf(name: string): string {
  const leaf = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return leaf
    .replace(/^set/, "")
    .replace(/^get/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function tagFirstOp(
  ops: PipelineOp[],
  extras: Record<string, unknown> = {},
): PipelineOp[] {
  if (ops.length === 0) {
    return [
      {
        kind: "RAW",
        meta: { discoverySource: "ai", confidence: CONFIDENCE_AI, ...extras },
      },
    ];
  }
  const first = { ...ops[0]! };
  const meta = { ...(typeof first.meta === "object" && first.meta ? first.meta : {}) };
  meta.discoverySource = "ai";
  meta.confidence = CONFIDENCE_AI;
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined) meta[k] = v;
  }
  first.meta = meta;
  return [first, ...ops.slice(1)];
}

function aiHitsToGroups(aiHits: DiscoverHit[]): FieldMapping[] {
  const seen = new Set<string>();
  const merged: FieldMapping[] = [];

  for (const hit of aiHits) {
    if (!hit.javaTargetHint?.trim()) continue;
    const leaf = normalizeLeaf(hit.javaTargetHint);
    if (seen.has(leaf)) continue;
    seen.add(leaf);

    const aiCode = hit.codeSnippet?.trim() ?? "";
    const extras: Record<string, unknown> = {
      code: aiCode || hit.javaTargetHint.trim(),
    };
    if (hit.note) extras.aiNote = hit.note;

    merged.push({
      targetField: hit.javaTargetHint.trim(),
      pipeline: tagFirstOp([{ kind: "RAW", meta: { code: extras.code } }], extras),
    });
  }

  return merged;
}

export async function discoverAndMerge(
  ast: IndexAst,
  sourceJava: string,
  provider: ModelProvider,
  options: {
    fingerprint?: string;
    noCache?: boolean;
  } = {},
): Promise<DiscoverMergeResult> {
  const mapperId = ast.mapperId ?? "unknown";

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

  const groups = aiHitsToGroups(aiHits);
  return {
    groups,
    meta: {
      aiTargets: aiHits.length,
      mergedTargets: groups.length,
    },
  };
}
