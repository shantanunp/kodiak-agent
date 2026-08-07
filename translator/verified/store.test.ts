import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KODIAK_VERIFIED_DIR = mkdtempSync(join(tmpdir(), "kodiak-verified-"));
process.env.MODEL_API_KEY = process.env.MODEL_API_KEY || "test-key-never-used";

const {
  computeVerifiedFingerprint,
  getVerified,
  promoteToVerified,
  upsertCorrectedField,
  findPreviousVerified,
} = await import("./store.js");
const { StepLabeler } = await import("../model/labeler.js");
import type { ModelProvider } from "../model/provider.js";

after(() => rmSync(process.env.KODIAK_VERIFIED_DIR!, { recursive: true, force: true }));

const SOURCE_V1 = "class M { void map() { /* v1 */ } }";
const SOURCE_V2 = "class M { void map() { /* v2 changed */ } }";

function neverCallProvider(): ModelProvider {
  return {
    model: "must-not-be-called",
    async labelFieldMapping() {
      throw new Error("model was called — verified store precedence broken");
    },
    async discoverMappings() {
      throw new Error("model was called — verified store precedence broken");
    },
    async labelStep() {
      throw new Error("model was called");
    },
  };
}

test("fingerprint is content-only: model/prompt changes do not invalidate it", () => {
  const a = computeVerifiedFingerprint({ sourceJava: SOURCE_V1, schemaJson: "" });
  const b = computeVerifiedFingerprint({ sourceJava: SOURCE_V1, schemaJson: "" });
  const c = computeVerifiedFingerprint({ sourceJava: SOURCE_V2, schemaJson: "" });
  assert.equal(a, b);
  assert.notEqual(a, c, "changed source must change the fingerprint");
});

test("labeler returns verified entry with zero model calls (reproducibility)", async () => {
  const fp = computeVerifiedFingerprint({ sourceJava: SOURCE_V1, schemaJson: "" });
  promoteToVerified({
    mapperId: "demo-mapper",
    fingerprint: fp,
    mapping: [
      {
        targetField: "Notice.recipientFirst",
        pipeline: [{ kind: "READ", sourceField: "shipment.customerName" }],
      },
    ],
    labeledBy: "test",
  });

  const labeler = new StepLabeler(neverCallProvider());
  const result = await labeler.labelIndex(
    { mapperId: "demo-mapper" },
    { sourceJava: SOURCE_V1 },
  );

  assert.equal(result.resultSource, "verified");
  assert.equal(result.fieldsLabeled, 0);
  assert.equal(result.mapping[0]?.targetField, "Notice.recipientFirst");

  // Second run: byte-identical mapping.
  const again = await labeler.labelIndex({ mapperId: "demo-mapper" }, { sourceJava: SOURCE_V1 });
  assert.deepEqual(again.mapping, result.mapping);
});

test("user corrections stick: re-promote cannot overwrite a corrected field", () => {
  const fp = computeVerifiedFingerprint({ sourceJava: SOURCE_V1, schemaJson: "" });

  upsertCorrectedField({
    mapperId: "demo-mapper",
    fingerprint: fp,
    targetField: "Notice.recipientFirst",
    pipeline: [
      { kind: "READ", sourceField: "shipment.customerName" },
      { kind: "TRANSFORM", meta: { op: "trim" } },
    ],
    userClaim: "needs a trim before use",
    judgeEvidence: "line 88: trimValue(raw) confirmed",
  });

  promoteToVerified({
    mapperId: "demo-mapper",
    fingerprint: fp,
    mapping: [
      { targetField: "Notice.recipientFirst", pipeline: [{ kind: "READ" }] }, // stale re-label
      { targetField: "Notice.weightGrams", pipeline: [{ kind: "READ" }] },
    ],
    labeledBy: "test",
  });

  const entry = getVerified("demo-mapper", fp)!;
  const first = entry.fields.find((f) => f.targetField === "Notice.recipientFirst")!;
  assert.equal(first.status, "user-corrected");
  assert.equal(first.pipeline.length, 2, "corrected 2-step pipeline preserved");
  assert.ok(entry.fields.some((f) => f.targetField === "Notice.weightGrams"));
});

test("partial promote is an upsert: existing fields are never dropped", () => {
  const fp = computeVerifiedFingerprint({ sourceJava: SOURCE_V1, schemaJson: "" });
  promoteToVerified({
    mapperId: "demo-mapper",
    fingerprint: fp,
    mapping: [{ targetField: "Notice.regionCode", pipeline: [{ kind: "READ" }] }],
    labeledBy: "test",
  });
  const entry = getVerified("demo-mapper", fp)!;
  const names = entry.fields.map((f) => f.targetField);
  assert.ok(names.includes("Notice.recipientFirst"));
  assert.ok(names.includes("Notice.weightGrams"));
  assert.ok(names.includes("Notice.regionCode"));
});

test("changed source: entry goes stale, previous entry available as convergence context", () => {
  const fpV2 = computeVerifiedFingerprint({ sourceJava: SOURCE_V2, schemaJson: "" });
  assert.equal(getVerified("demo-mapper", fpV2), null, "no verified answer for new source");
  const previous = findPreviousVerified("demo-mapper", fpV2);
  assert.ok(previous, "prior version's mapping offered as context, not as truth");
  assert.ok(previous!.fields.length >= 3);
});
