/**
 * Golden test harness — capture N sample inputs and expected mapper outputs.
 *
 * Phase 0: deterministic only, no AI. Uses inline fixture records that mirror
 * ExampleMapper behavior until a JVM test runner is wired in Phase 4.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/env.js";

export interface GoldenRecord {
  id: string;
  mapperId: string;
  input: Record<string, unknown>;
  expectedOutput: Record<string, unknown>;
  capturedAt: string;
}

const SAMPLE_RECORDS: Omit<GoldenRecord, "capturedAt" | "mapperId">[] = [
  {
    id: "record-001",
    input: { firstName: "Ada", lastName: "Lovelace", age: 36 },
    expectedOutput: { displayName: "ADA LOVELACE", adult: true },
  },
  {
    id: "record-002",
    input: { firstName: "Grace", lastName: "Hopper", age: 85 },
    expectedOutput: { displayName: "GRACE HOPPER", adult: true },
  },
  {
    id: "record-003",
    input: { firstName: "Lin", lastName: "Zhao", age: 16 },
    expectedOutput: { displayName: "LIN ZHAO", adult: false },
  },
];

function datasetDir(): string {
  const dir = join(paths.root, "validator/golden-dataset/records");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function captureGoldenDataset(mapperId = "example-mapper"): GoldenRecord[] {
  const captured: GoldenRecord[] = SAMPLE_RECORDS.map((r) => ({
    ...r,
    mapperId,
    capturedAt: new Date().toISOString(),
  }));

  const dir = datasetDir();
  for (const record of captured) {
    const file = join(dir, `${record.id}.json`);
    writeFileSync(file, JSON.stringify(record, null, 2));
  }

  const manifest = {
    mapperId,
    count: captured.length,
    records: captured.map((r) => r.id),
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, "../manifest.json"), JSON.stringify(manifest, null, 2));

  return captured;
}

export function loadGoldenRecord(id: string): GoldenRecord | null {
  const file = join(datasetDir(), `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as GoldenRecord;
}

async function main(): Promise<void> {
  const records = captureGoldenDataset();
  console.log(JSON.stringify({ captured: records.length, ids: records.map((r) => r.id) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
