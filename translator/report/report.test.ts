import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KODIAK_METRICS_DIR = mkdtempSync(join(tmpdir(), "kodiak-metrics-"));
process.env.KODIAK_GOLDEN_DIR = mkdtempSync(join(tmpdir(), "kodiak-golden-"));
process.env.KODIAK_VERIFIED_DIR = mkdtempSync(join(tmpdir(), "kodiak-rep-store-"));

const { appendRunMetrics, readRunMetrics } = await import("./metrics.js");
const { compareToGolden, loadGolden } = await import("./golden.js");
const { promoteToVerified, getVerified } = await import("../verified/store.js");

after(() => {
  for (const d of [process.env.KODIAK_METRICS_DIR!, process.env.KODIAK_GOLDEN_DIR!, process.env.KODIAK_VERIFIED_DIR!]) {
    rmSync(d, { recursive: true, force: true });
  }
});

test("metrics round trip and aggregation source", () => {
  appendRunMetrics({ mapperId: "m1", at: "t1", declaredFields: 10, labeled: 8,
    fromCache: 0, unresolved: 2, crossCheckFlips: 1, toolLoopRuns: 2, toolLoopResolved: 1 });
  appendRunMetrics({ mapperId: "m1", at: "t2", declaredFields: 10, labeled: 0,
    fromCache: 8, unresolved: 0, crossCheckFlips: 0, toolLoopRuns: 0, toolLoopResolved: 0 });
  const runs = readRunMetrics("m1");
  assert.equal(runs.length, 2);
  assert.equal(runs.reduce((a, r) => a + r.crossCheckFlips, 0), 1);
  assert.deepEqual(readRunMetrics("never-ran"), []);
});

test("golden comparison: shape match, mismatch, and missing all reported", () => {
  promoteToVerified({
    mapperId: "gm", fingerprint: "fp",
    mapping: [
      { targetField: "Out.alpha", pipeline: [{ kind: "READ" }, { kind: "TRANSFORM" }] },
      { targetField: "Out.beta", pipeline: [{ kind: "CONSTANT" }] },
    ],
    labeledBy: "test",
  });
  mkdirSync(process.env.KODIAK_GOLDEN_DIR!, { recursive: true });
  writeFileSync(join(process.env.KODIAK_GOLDEN_DIR!, "gm.json"), JSON.stringify({
    mapperId: "gm",
    fields: [
      { targetField: "Out.alpha", pipelineKinds: ["read", "transform"] },
      { targetField: "Out.beta", pipelineKinds: ["read"] },
      { targetField: "Out.gamma", pipelineKinds: ["read"] },
    ],
  }));

  const result = compareToGolden(getVerified("gm", "fp")!, loadGolden("gm")!);
  assert.equal(result.matched, 1, "alpha matches by ordered kinds, case-insensitive");
  assert.equal(result.mismatched.length, 1, "beta kinds differ");
  assert.deepEqual(result.missing, ["Out.gamma"]);
});
