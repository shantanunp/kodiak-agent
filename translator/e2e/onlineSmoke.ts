#!/usr/bin/env tsx
/**
 * Online end-to-end smoke — the ONLY script that calls the real model API.
 *
 *   npm run e2e:online
 *
 * Requires MODEL_API_KEY (or ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY
 * / COPILOT_TOKEN) + MODEL_API_STYLE in .env. Switching vendors is config-only:
 *   claude  -> Anthropic Messages API
 *   openai  -> any OpenAI-compatible /chat/completions
 *   gemini  -> Google's OpenAI-compatible endpoint (alias of openai style)
 *   copilot -> GitHub Copilot
 *
 * Exercises: analyzer checklist -> agent loop (real model, slice-fed) ->
 * audit gate -> promote to a TEMP verified store -> zero-model re-read.
 * Nothing permanent is written (temp store + cache bypass).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KODIAK_VERIFIED_DIR = mkdtempSync(join(tmpdir(), "kodiak-e2e-store-"));

const { isModelConfigured, loadModelConfig, createModelProvider } = await import(
  "../model/index.js"
);
const { buildLabelTasks } = await import("../agentloop/tasks.js");
const { runAgentLoop } = await import("../agentloop/loop.js");
const {
  computeVerifiedFingerprint,
  promoteToVerified,
  getVerified,
} = await import("../verified/store.js");
const { CANONICAL_STEP_KINDS } = await import("../model/applyResponse.js");

if (!isModelConfigured()) {
  console.error(
    "e2e:online needs a model API key.\n" +
      "Set in .env: MODEL_API_STYLE=claude|openai|gemini|copilot and MODEL_API_KEY=…\n" +
      "(ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / COPILOT_TOKEN also accepted)",
  );
  process.exit(1);
}

const config = loadModelConfig();
console.log(`[e2e] provider style=${config.apiStyle} model=${config.model} base=${config.baseUrl}`);

const mapper = {
  id: "e2e-smoke",
  sourceFile: "fixtures/ShipmentNoticeMapper.java",
  class: "com.kodiak.fixtures.ShipmentNoticeMapper",
  entryMethod: "map",
  sourceType: "com.kodiak.fixtures.ShipmentNoticeMapper$Shipment",
  targetType: "com.kodiak.fixtures.ShipmentNoticeMapper$DeliveryNotice",
};
const sourceJava = readFileSync(mapper.sourceFile, "utf8");

console.log("[e2e] 1/4 deterministic checklist + slices…");
const tasks = buildLabelTasks({ mapper: mapper as never, sourceJava });
console.log(
  `      ${tasks.report.declaredFields} declared: ${tasks.report.mapped} mapped, ` +
    `${tasks.report.unmapped} unmapped, ${tasks.report.unresolved} unresolved`,
);

console.log("[e2e] 2/4 agent loop against the REAL model (per-field slices)…");
const provider = createModelProvider(config);
const result = await runAgentLoop({ mapperId: mapper.id }, tasks, provider, {
  fingerprint: `e2e-${Date.now()}`,
  sourceJava,
  noCache: true,
});
console.log(
  `      labeled=${result.fieldsLabeled} unresolved=${result.audit.unresolvedFields.join(",") || "none"} ` +
    `gate=${result.audit.gatePassed ? "PASSED" : "NOT PASSED"}`,
);
for (const m of result.mapping.slice(0, 3)) {
  console.log(
    `      ${m.targetField}: ${m.pipeline.map((s) => (s as { kind: string }).kind).join(" -> ")}`,
  );
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`      ${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log("[e2e] 3/4 assertions…");
check("every mapped checklist field labeled", result.mapping.length >= tasks.report.mapped);
check(
  "no Java/DTO artifacts in business paths",
  result.mapping.every(
    (m) => !/com\.|\$|dto\./.test(m.targetField),
  ),
);
const empties = result.mapping.filter((m) => m.pipeline.length === 0).map((m) => m.targetField);
check("every pipeline is non-empty", empties.length === 0, `empty: ${empties.join(", ")}`);

const offenders: string[] = [];
for (const m of result.mapping) {
  for (const step of m.pipeline) {
    const s = step as { kind?: string; meta?: { originalKind?: string } };
    if (!(CANONICAL_STEP_KINDS as readonly string[]).includes(String(s.kind))) {
      offenders.push(`${m.targetField}: kind "${s.kind}"`);
    } else if (s.meta?.originalKind) {
      offenders.push(`${m.targetField}: model returned "${s.meta.originalKind}" -> normalized to RAW`);
    }
  }
}
check(
  "all step kinds are canonical (no model-invented kinds)",
  offenders.length === 0,
  offenders.join("; "),
);

console.log("[e2e] 4/4 verified store round trip (temp dir, zero model calls)…");
const vfp = computeVerifiedFingerprint({ sourceJava, schemaJson: "" });
promoteToVerified({
  mapperId: mapper.id,
  fingerprint: vfp,
  mapping: result.mapping,
  labeledBy: config.model,
});
const readBack = getVerified(mapper.id, vfp);
check("store returns byte-identical mapping", JSON.stringify(readBack?.fields.map((f) => ({ targetField: f.targetField, pipeline: f.pipeline })).sort((a, b) => a.targetField.localeCompare(b.targetField))) === JSON.stringify([...result.mapping].sort((a, b) => a.targetField.localeCompare(b.targetField)).map((m) => ({ targetField: m.targetField, pipeline: m.pipeline }))));

rmSync(process.env.KODIAK_VERIFIED_DIR!, { recursive: true, force: true });

console.log(failures === 0 ? "\n[e2e] ALL CHECKS PASSED" : `\n[e2e] ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
