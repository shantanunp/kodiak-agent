/**
 * Golden-dataset comparison — label accuracy against known-good answers.
 *
 * validator/golden-dataset/{mapperId}.json:
 *   { "mapperId": "...", "fields": [ { "targetField": "...", "pipelineKinds": ["READ","TRANSFORM"] } ] }
 *
 * Deliberately compares pipeline SHAPE (ordered step kinds), not exact text —
 * summaries vary between model runs; the step structure is what must hold.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/env.js";
import type { VerifiedEntry } from "../verified/store.js";

export interface GoldenField {
  targetField: string;
  pipelineKinds: string[];
}

export interface GoldenFile {
  mapperId: string;
  fields: GoldenField[];
}

export interface GoldenResult {
  total: number;
  matched: number;
  mismatched: Array<{ field: string; expected: string[]; actual: string[] }>;
  missing: string[];
}

export function goldenDir(): string {
  return process.env.KODIAK_GOLDEN_DIR ?? join(paths.root, "validator", "golden-dataset");
}

export function loadGolden(mapperId: string): GoldenFile | null {
  const file = join(goldenDir(), `${mapperId}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as GoldenFile;
}

export function listGoldenMappers(): string[] {
  if (!existsSync(goldenDir())) return [];
  return readdirSync(goldenDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}

function kindsOf(pipeline: unknown[]): string[] {
  return pipeline.map((s) => String((s as { kind?: string }).kind ?? "?").toUpperCase());
}

export function compareToGolden(entry: VerifiedEntry, golden: GoldenFile): GoldenResult {
  const byLeaf = new Map(
    entry.fields.map((f) => [f.targetField.split(".").pop()!.toLowerCase(), f]),
  );
  const result: GoldenResult = { total: golden.fields.length, matched: 0, mismatched: [], missing: [] };

  for (const g of golden.fields) {
    const leaf = g.targetField.split(".").pop()!.toLowerCase();
    const actual = byLeaf.get(leaf);
    if (!actual) {
      result.missing.push(g.targetField);
      continue;
    }
    const actualKinds = kindsOf(actual.pipeline);
    if (JSON.stringify(actualKinds) === JSON.stringify(g.pipelineKinds.map((k) => k.toUpperCase()))) {
      result.matched++;
    } else {
      result.mismatched.push({ field: g.targetField, expected: g.pipelineKinds, actual: actualKinds });
    }
  }
  return result;
}
