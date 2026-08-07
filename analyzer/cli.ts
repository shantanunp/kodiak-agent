#!/usr/bin/env tsx
/**
 * Deterministic analyzer CLI — the checklist the agents work against.
 *
 *   npm run analyze -- --file fixtures/ShipmentNoticeMapper.java \
 *     --mapper-class ShipmentNoticeMapper --target-class DeliveryNotice
 *
 *   [--language java] [--json] [--slices]
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { scanWriteSites, adapterFor } from "./scanWriteSites.js";
import { runAuditGate } from "./auditGate.js";

const { values } = parseArgs({
  options: {
    file: { type: "string", short: "f" },
    language: { type: "string", default: "java" },
    "mapper-class": { type: "string" },
    "target-class": { type: "string" },
    json: { type: "boolean", default: false },
    slices: { type: "boolean", default: false },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const filePath = values.file ?? fail("Usage: analyze --file <path> --mapper-class <C> --target-class <C>");
const mapperClass = values["mapper-class"] ?? fail("--mapper-class required");
const targetClass = values["target-class"] ?? fail("--target-class required");

const source = readFileSync(filePath, "utf8");
const { parsed, slices } = scanWriteSites({
  filePath,
  language: values.language!,
  mapperClass,
  targetClass,
  source,
});

const adapter = adapterFor(values.language!);
const declared = adapter.targetFields(parsed, targetClass);

const report = runAuditGate({
  parsed,
  source,
  targetClass,
  declaredFields: declared,
  writeSites: slices,
});

if (values.json) {
  console.log(JSON.stringify({ report, slices: values.slices ? slices : undefined }, null, 2));
  process.exit(report.gatePassed ? 0 : 2);
}

const ICON: Record<string, string> = { mapped: "[OK]", unmapped: "[--]", unresolved: "[??]" };

console.log(`\nAnalyzer report — ${filePath}`);
console.log(`Target type: ${targetClass} (${report.declaredFields} declared fields)\n`);

for (const entry of report.checklist) {
  const head = `${ICON[entry.state]} ${entry.field}`.padEnd(28);
  if (entry.state === "mapped") {
    const prov = entry.writes
      .map((w) => `line ${w.line} (${w.via}, in ${w.inMethod})`)
      .join(", ");
    console.log(`${head} ${prov}`);
  } else {
    console.log(`${head} ${entry.state.toUpperCase()} — ${entry.note}`);
  }
}

if (report.orphanWrites.length > 0) {
  console.log(`\nOrphan writes (target field not declared on ${targetClass}):`);
  for (const o of report.orphanWrites) {
    console.log(`  line ${o.line}: ${o.statement}`);
  }
}

console.log(
  `\nSummary: ${report.mapped} mapped, ${report.unmapped} unmapped, ${report.unresolved} unresolved` +
    ` — audit gate ${report.gatePassed ? "PASSED" : "NOT PASSED (agent/human follow-up required)"}\n`,
);

if (values.slices) {
  console.log("── Agent slices (one per write site) ──────────────────────\n");
  for (const s of slices) {
    console.log(`### ${s.targetField}\n${s.sliceText}\n`);
  }
}

process.exit(report.gatePassed ? 0 : 2);
