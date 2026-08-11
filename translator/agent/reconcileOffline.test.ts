import { test } from "node:test";
import assert from "node:assert/strict";
import { runOfflineReconcile } from "./reconcileOffline.js";
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
    instructions: "",
    vscodeSteps: [],
    fields: [
      { businessFieldSelector: "firstName", javaTargetField: "firstName", slice: "// write site (line 3, in map, via setter)\ntarget.setFirstName(x);" },
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
