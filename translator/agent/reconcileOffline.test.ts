import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMinerWrites, declaredFieldsFromJob } from "./offlineMiner.js";
import {
  runOfflineReconcile,
  buildOfflineLabelPlan,
} from "./reconcileOffline.js";
import type { AgentJob } from "./types.js";

const SOURCE = Array.from({ length: 50 }, (_, i) =>
  i === 27 ? "    BulkCopy.apply(input, target); // writes several fields" : `line${i + 1}`,
).join("\n");

function baseJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    version: 1,
    mapperId: "m",
    fingerprint: "fp",
    labelModel: "agent:offline",
    createdAt: "now",
    sourceJava: SOURCE,
    schemaJson: "{}",
    mapper: {
      id: "m",
      sourceFile: "M.java",
      class: "M",
      entryMethod: "map",
      sourceType: "In",
      targetType: "Out",
    },
    systemPrompt: "",
    minerPrompt: "test",
    instructions: "",
    vscodeSteps: [],
    fields: [
      {
        businessFieldSelector: "firstName",
        javaTargetField: "firstName",
        slice: "// write site (line 3, in map, via setter)\ntarget.setFirstName(x);",
        auditState: "mapped",
      },
    ],
    audit: {
      declaredFields: 2,
      mapped: 1,
      unmapped: 1,
      unresolved: 0,
      unmappedFields: ["remarks"],
    },
    paths: { jobDir: "", jobFile: "", resultFile: "" },
    ...overrides,
  };
}

test("CST-mapped field with a matching AI candidate -> agreed", () => {
  const job = baseJob();
  const result = runOfflineReconcile(job, {
    candidates: [{ field: "firstName", line: 3, evidence: "line 3: target.setFirstName(x);" }],
  });
  assert.deepEqual(result.agreed, ["firstName"]);
  assert.deepEqual(result.aiOnly, []);
});

test("CST-unmapped field with a citation-verified AI candidate -> aiOnly", () => {
  const job = baseJob();
  const result = runOfflineReconcile(job, {
    candidates: [{ field: "remarks", line: 28, evidence: "line 28: BulkCopy.apply writes it" }],
  });
  assert.equal(result.aiOnly.length, 1);
  assert.equal(result.aiOnly[0]!.field, "remarks");
  assert.deepEqual(result.dropped, []);
});

test("AI candidate with an unverifiable citation is dropped, not aiOnly", () => {
  const job = baseJob();
  const result = runOfflineReconcile(job, {
    candidates: [{ field: "remarks", line: 9999, evidence: "trust me" }],
  });
  assert.deepEqual(result.aiOnly, []);
  assert.equal(result.dropped.length, 1);
  assert.ok(result.dropped[0]!.includes("remarks"));
});

test("AI candidate for an unknown field is dropped", () => {
  const job = baseJob();
  const result = runOfflineReconcile(job, {
    candidates: [{ field: "nonexistentField", line: 28, evidence: "line 28: x" }],
  });
  assert.deepEqual(result.aiOnly, []);
  assert.ok(result.dropped[0]!.includes("unknown field"));
});

test("CST-mapped field with no AI candidate -> cstOnly, CST still wins", () => {
  const job = baseJob();
  const result = runOfflineReconcile(job, { candidates: [] });
  assert.equal(result.cstOnly.length, 1);
  assert.equal(result.cstOnly[0]!.targetField, "firstName");
});

test("malformed candidates payload -> empty, no throw", () => {
  const job = baseJob();
  const result = runOfflineReconcile(job, {});
  assert.deepEqual(result.aiOnly, []);
  assert.deepEqual(result.dropped, []);
});

test("online miner writes[] shape is accepted by reconcileOffline", () => {
  const job = baseJob();
  const result = runOfflineReconcile(job, {
    writes: [{ field: "remarks", line: 28, evidence: "line 28: BulkCopy.apply writes it" }],
  });
  assert.equal(result.aiOnly.length, 1);
  assert.equal(result.aiOnly[0]!.field, "remarks");
});

test("parseMinerWrites mirrors online miner verification", () => {
  const job = baseJob();
  const declared = declaredFieldsFromJob(job);
  const { candidates, dropped } = parseMinerWrites(
    { writes: [{ field: "remarks", line: 28, evidence: "line 28: BulkCopy.apply" }] },
    job.sourceJava,
    declared,
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(dropped, []);

  const bad = parseMinerWrites(
    { writes: [{ field: "remarks", line: 9999, evidence: "nope" }] },
    job.sourceJava,
    declared,
  );
  assert.equal(bad.candidates.length, 0);
  assert.equal(bad.dropped.length, 1);
});

test("label plan demotes aiOnly to demotedUnresolved (online parity)", () => {
  const job = baseJob();
  const result = runOfflineReconcile(job, {
    writes: [{ field: "remarks", line: 28, evidence: "line 28: BulkCopy.apply writes it" }],
  });
  const plan = buildOfflineLabelPlan(job, result);
  assert.deepEqual(plan.fromSlice, ["firstName"]);
  assert.equal(plan.demotedUnresolved.length, 1);
  assert.equal(plan.demotedUnresolved[0]!.field, "remarks");
  assert.match(plan.demotedUnresolved[0]!.note, /ai-miner: possible missed write/);
  assert.deepEqual(plan.unmapped, []);
});

test("label plan keeps hard-unmapped when miner silent", () => {
  const job = baseJob();
  const result = runOfflineReconcile(job, { writes: [] });
  const plan = buildOfflineLabelPlan(job, result);
  assert.deepEqual(plan.unmapped, ["remarks"]);
  assert.deepEqual(plan.demotedUnresolved, []);
});
