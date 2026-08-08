/**
 * EVAL-1 — golden-dataset harness.
 *
 * Offline (default): seed a temp verified store from each golden file's committed
 * pipelines, then compare shape — zero model calls, CI-safe.
 *
 *   npm run test:golden
 *
 * Optional live mode (NOT in test:all): re-label with the model and print a
 * diff summary without failing the build.
 *
 *   npm run test:golden -- --model
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { scanWriteSites, adapterFor } from "../../analyzer/scanWriteSites.js";
import { runAuditGate } from "../../analyzer/auditGate.js";
import {
  compareToGolden,
  goldenDir,
  listGoldenMappers,
  loadGolden,
  type GoldenFile,
} from "./golden.js";
import {
  computeVerifiedFingerprint,
  getVerified,
  promoteToVerified,
  type VerifiedEntry,
} from "../verified/store.js";

export interface GoldenCase extends GoldenFile {
  sourceFixture?: string;
  mapperClass?: string;
  targetClass?: string;
  entryMethod?: string;
  fields: Array<
    GoldenFile["fields"][number] & {
      pipeline?: unknown[];
    }
  >;
}

export function loadGoldenCase(mapperId: string): GoldenCase | null {
  const base = loadGolden(mapperId);
  if (!base) return null;
  const file = join(goldenDir(), `${mapperId}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as GoldenCase;
}

/** Seed verified store from committed golden pipelines (offline path). */
export function seedVerifiedFromGolden(golden: GoldenCase, fingerprint: string): VerifiedEntry {
  const mapping = golden.fields
    .filter((f) => Array.isArray(f.pipeline) && f.pipeline!.length > 0)
    .map((f) => ({
      targetField: f.targetField,
      pipeline: f.pipeline as VerifiedEntry["fields"][number]["pipeline"],
    }));
  if (mapping.length === 0) {
    throw new Error(`golden ${golden.mapperId}: no embedded pipelines to seed`);
  }
  promoteToVerified({
    mapperId: golden.mapperId,
    fingerprint,
    mapping,
    labeledBy: "golden-seed",
  });
  const entry = getVerified(golden.mapperId, fingerprint);
  if (!entry) throw new Error(`failed to seed verified store for ${golden.mapperId}`);
  return entry;
}

export function assertFixtureChecklist(golden: GoldenCase): string[] {
  const errors: string[] = [];
  if (!golden.sourceFixture || !existsSync(golden.sourceFixture)) {
    errors.push(`missing sourceFixture: ${golden.sourceFixture}`);
    return errors;
  }
  const source = readFileSync(golden.sourceFixture, "utf8");
  const mapperClass = golden.mapperClass ?? "ShipmentNoticeMapper";
  const targetClass = golden.targetClass ?? "DeliveryNotice";
  const { parsed, slices } = scanWriteSites({
    filePath: golden.sourceFixture,
    language: "java",
    mapperClass,
    targetClass,
    source,
  });
  const declared = adapterFor("java").targetFields(parsed, targetClass);
  const report = runAuditGate({
    parsed,
    source,
    targetClass,
    declaredFields: declared,
    writeSites: slices,
  });
  const checklist = new Set(report.checklist.map((c) => c.field));
  for (const f of golden.fields) {
    if (!checklist.has(f.targetField)) {
      errors.push(`checklist missing golden field ${f.targetField}`);
    }
  }
  return errors;
}

export interface GoldenRunResult {
  mapperId: string;
  ok: boolean;
  matched: number;
  total: number;
  mismatched: string[];
  missing: string[];
  checklistErrors: string[];
  mode: "offline" | "model-diff";
  modelDiffNote?: string;
}

export function runGoldenOffline(mapperId: string): GoldenRunResult {
  const golden = loadGoldenCase(mapperId);
  if (!golden) {
    return {
      mapperId,
      ok: false,
      matched: 0,
      total: 0,
      mismatched: [],
      missing: [],
      checklistErrors: [`golden file not found`],
      mode: "offline",
    };
  }
  const checklistErrors = assertFixtureChecklist(golden);
  const prev = process.env.KODIAK_VERIFIED_DIR;
  const tmp = mkdtempSync(join(tmpdir(), "kodiak-golden-"));
  process.env.KODIAK_VERIFIED_DIR = tmp;
  try {
    const source = golden.sourceFixture
      ? readFileSync(golden.sourceFixture, "utf8")
      : "";
    const fingerprint = computeVerifiedFingerprint({
      sourceJava: source,
      schemaJson: "",
    });
    const entry = seedVerifiedFromGolden(golden, fingerprint);
    const cmp = compareToGolden(entry, golden);
    return {
      mapperId,
      ok: checklistErrors.length === 0 && cmp.mismatched.length === 0 && cmp.missing.length === 0,
      matched: cmp.matched,
      total: cmp.total,
      mismatched: cmp.mismatched.map(
        (m) => `${m.field}: expected [${m.expected}] got [${m.actual}]`,
      ),
      missing: cmp.missing,
      checklistErrors,
      mode: "offline",
    };
  } finally {
    if (prev === undefined) delete process.env.KODIAK_VERIFIED_DIR;
    else process.env.KODIAK_VERIFIED_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runAllGoldenOffline(): Promise<GoldenRunResult[]> {
  mkdirSync(goldenDir(), { recursive: true });
  const ids = listGoldenMappers();
  return ids.map((id) => runGoldenOffline(id));
}

/** CLI entry when executed directly. */
const isMain =
  process.argv[1]?.endsWith("goldenHarness.ts") ||
  process.argv[1]?.endsWith("goldenHarness.js");

if (isMain) {
  const wantModel = process.argv.includes("--model");
  if (wantModel) {
    console.error(
      "test:golden --model: live re-label diff is opt-in and not wired to fail CI.\n" +
        "Run offline harness first; model-diff mode prints guidance only.",
    );
    console.error(
      "Use: npm run label -- --mapper <id> --worktree <path> --analyzer, then compare verified store to validator/golden-dataset/<id>.json manually or via npm run report.",
    );
    process.exit(0);
  }
  const results = await runAllGoldenOffline();
  let failed = 0;
  for (const r of results) {
    const flag = r.ok ? "[OK]" : "[!!]";
    console.log(
      `${flag} ${r.mapperId}  shape=${r.matched}/${r.total}` +
        (r.mismatched.length ? ` mismatched=${r.mismatched.length}` : "") +
        (r.missing.length ? ` missing=${r.missing.length}` : "") +
        (r.checklistErrors.length ? ` checklist=${r.checklistErrors.length}` : ""),
    );
    for (const e of [...r.checklistErrors, ...r.mismatched, ...r.missing.map((m) => `missing ${m}`)]) {
      console.log(`       - ${e}`);
    }
    if (!r.ok) failed++;
  }
  if (results.length === 0) {
    console.error("No golden files under validator/golden-dataset/");
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}
