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
  approveVerified,
  pruneStaleFingerprints,
  countByStatus,
  diffAgainstPrevious,
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
    status: "verified",
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

test("promote defaults to pending-review; approve flips to verified", () => {
  const src = "class M { void map() { /* pending */ } }";
  const fp = computeVerifiedFingerprint({ sourceJava: src, schemaJson: "" });
  promoteToVerified({
    mapperId: "pending-mapper",
    fingerprint: fp,
    mapping: [{ targetField: "Out.a", pipeline: [{ kind: "CONSTANT" }] }],
    labeledBy: "test",
  });
  let entry = getVerified("pending-mapper", fp)!;
  assert.equal(countByStatus(entry)["pending-review"], 1);
  const res = approveVerified({ mapperId: "pending-mapper", fingerprint: fp });
  assert.equal(res?.approved, 1);
  entry = getVerified("pending-mapper", fp)!;
  assert.equal(countByStatus(entry).verified, 1);
  assert.equal(countByStatus(entry)["pending-review"], 0);
});

test("prune keeps current + newest stale, removes older", () => {
  const mapperId = "prune-mapper";
  const sources = ["/*a*/", "/*b*/", "/*c*/", "/*d*/"];
  const fps = sources.map((s) =>
    computeVerifiedFingerprint({ sourceJava: s, schemaJson: "" }),
  );
  for (let i = 0; i < fps.length; i++) {
    promoteToVerified({
      mapperId,
      fingerprint: fps[i]!,
      mapping: [{ targetField: "x", pipeline: [{ kind: "READ" }] }],
      labeledBy: "test",
      status: "verified",
    });
    // Ensure distinct updatedAt ordering for prune sort.
  }
  const current = fps[3]!;
  const { kept, removed } = pruneStaleFingerprints(mapperId, current, 2);
  assert.ok(kept.includes(current));
  assert.equal(kept.length, 2);
  assert.equal(removed.length, 2);
  assert.equal(getVerified(mapperId, current)?.fingerprint, current);
  for (const fp of removed) {
    assert.equal(getVerified(mapperId, fp), null);
  }
});

test("diffAgainstPrevious reports kind changes", () => {
  const fpOld = computeVerifiedFingerprint({ sourceJava: "old", schemaJson: "" });
  const fpNew = computeVerifiedFingerprint({ sourceJava: "new", schemaJson: "" });
  promoteToVerified({
    mapperId: "diff-mapper",
    fingerprint: fpOld,
    mapping: [{ targetField: "Out.a", pipeline: [{ kind: "READ" }] }],
    labeledBy: "test",
    status: "verified",
  });
  promoteToVerified({
    mapperId: "diff-mapper",
    fingerprint: fpNew,
    mapping: [
      { targetField: "Out.a", pipeline: [{ kind: "READ" }, { kind: "TRANSFORM" }] },
      { targetField: "Out.b", pipeline: [{ kind: "CONSTANT" }] },
    ],
    labeledBy: "test",
    status: "pending-review",
  });
  const d = diffAgainstPrevious("diff-mapper", fpNew);
  assert.equal(d.previousFingerprint, fpOld);
  const a = d.rows.find((r) => r.targetField === "Out.a");
  assert.equal(a?.change, "kinds-changed");
  const b = d.rows.find((r) => r.targetField === "Out.b");
  assert.equal(b?.change, "added");
});
