import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "kodiak-reset-"));
process.env.KODIAK_VERIFIED_DIR = join(root, "verified");
process.env.KODIAK_VIEW_DIR = join(root, "views");
process.env.KODIAK_METRICS_DIR = join(root, "metrics");
process.env.KODIAK_RUNS_FILE = join(root, "runs.jsonl");
process.env.KODIAK_DEFECTS_FILE = join(root, "defects.jsonl");
process.env.CACHE_DIR = join(root, "cache");
process.env.MODEL_API_KEY = process.env.MODEL_API_KEY || "test-key-never-used";

const { promoteToVerified, getVerified } = await import("./verified/store.js");
const { writePipelineView, pipelineViewFile } = await import("./writePipelineView.js");
const { agentJobDir } = await import("./agent/paths.js");
const { appendRunMetrics } = await import("./report/metrics.js");
const { appendRun } = await import("./telemetry/journal.js");
const { logDefect } = await import("./judge/judge.js");
const { resetMappingData } = await import("./resetMappingData.js");
const {
  setPipelineCache,
  getPipelineCache,
  computePipelineFingerprint,
} = await import("./cache/index.js");

after(() => rmSync(root, { recursive: true, force: true }));

test("resetMappingData wipes verified, view, caches, jobs, and telemetry for one mapper", () => {
  const mapperId = "reset-demo-mapper";
  const other = "keep-other-mapper";
  const fp = "a".repeat(64);

  promoteToVerified({
    mapperId,
    fingerprint: fp,
    mapping: [{ targetField: "Order.n", pipeline: [{ kind: "CONSTANT", meta: { value: "1" } }] }],
    labeledBy: "test",
  });
  promoteToVerified({
    mapperId: other,
    fingerprint: fp,
    mapping: [{ targetField: "X.y", pipeline: [{ kind: "CONSTANT", meta: { value: "2" } }] }],
    labeledBy: "test",
  });

  writePipelineView({
    mapperId,
    sourceType: "S",
    targetType: "T",
    mapping: [{ targetField: "Order.n", pipeline: [{ kind: "CONSTANT", meta: { value: "1" } }] }],
  });
  writePipelineView({
    mapperId: other,
    sourceType: "S",
    targetType: "T",
    mapping: [{ targetField: "X.y", pipeline: [{ kind: "CONSTANT", meta: { value: "2" } }] }],
  });

  const cacheFp = computePipelineFingerprint({
    sourceJava: "class M{}",
    schemaJson: "",
    model: "test-model",
  });
  setPipelineCache({
    fingerprint: cacheFp,
    mapperId,
    mapping: [{ targetField: "Order.n", pipeline: [] }],
    labeledAt: new Date().toISOString(),
    labelModel: "test-model",
    cachedAt: new Date().toISOString(),
  });

  const jobDir = agentJobDir(mapperId, fp);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "job.json"), "{}");

  appendRunMetrics({
    mapperId,
    at: new Date().toISOString(),
    declaredFields: 1,
    labeled: 1,
    fromCache: 0,
    unresolved: 0,
    crossCheckFlips: 0,
    toolLoopRuns: 0,
    toolLoopResolved: 0,
  });
  appendRun({
    at: new Date().toISOString(),
    mapperId,
    sourceSha: "abc",
    language: "java",
    declared: 1,
    mapped: 1,
    unmapped: 0,
    unresolved: 0,
    gatePassed: true,
    resultSource: {},
    durationMs: 1,
    promoted: true,
    outcome: "ok",
  });
  appendRun({
    at: new Date().toISOString(),
    mapperId: other,
    sourceSha: "def",
    language: "java",
    declared: 1,
    mapped: 1,
    unmapped: 0,
    unresolved: 0,
    gatePassed: true,
    resultSource: {},
    durationMs: 1,
    promoted: false,
    outcome: "ok",
  });
  logDefect({
    mapperId,
    field: "Order.n",
    userClaim: "wrong",
    judgeEvidence: "no",
    defectId: "KOD-1001",
  });

  const result = resetMappingData(mapperId);
  assert.equal(result.mapperId, mapperId);
  assert.equal(result.verified, 1);
  assert.equal(result.views, 1);
  assert.ok(result.caches.pipelines >= 1);
  assert.ok(result.agentJobs >= 1);
  assert.equal(result.metrics, 1);
  assert.equal(result.runs, 1);
  assert.equal(result.defects, 1);

  assert.equal(getVerified(mapperId, fp), null);
  assert.ok(getVerified(other, fp), "other mapper verified kept");
  assert.equal(existsSync(pipelineViewFile(mapperId)), false);
  assert.ok(existsSync(pipelineViewFile(other)), "other mapper view kept");
  assert.equal(getPipelineCache(mapperId, cacheFp), null);
  assert.equal(existsSync(jobDir), false);

  const runs = readFileSync(process.env.KODIAK_RUNS_FILE!, "utf8").trim().split("\n");
  assert.equal(runs.length, 1);
  assert.equal(JSON.parse(runs[0]!).mapperId, other);
});
