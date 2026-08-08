import { test } from "node:test";
import assert from "node:assert/strict";
import { pipelinesDiverge, pipelineSignatures, verifyFieldConsistency } from "./verify.js";
import type { ModelProvider, FieldMappingResponse } from "../model/provider.js";
import type { FieldTask } from "./tasks.js";

test("pipelineSignatures are stable for same shape", () => {
  const a = [
    { kind: "READ", sourceField: "a.b" },
    { kind: "TRANSFORM", meta: { op: "trim" } },
  ];
  const b = [
    { kind: "read", sourceField: "a.b" },
    { kind: "transform", meta: { op: "trim" } },
  ];
  assert.equal(JSON.stringify(pipelineSignatures(a)), JSON.stringify(pipelineSignatures(b)));
  assert.equal(pipelinesDiverge(a, b), false);
});

test("pipelinesDiverge when kinds differ", () => {
  assert.equal(
    pipelinesDiverge(
      [{ kind: "READ", sourceField: "x" }],
      [{ kind: "CONSTANT", meta: { value: 1 } }],
    ),
    true,
  );
});

test("verifyFieldConsistency reports divergence", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    model: "fake",
    async labelFieldMapping(): Promise<FieldMappingResponse> {
      calls++;
      // Second pass disagrees with the already-accepted first pipeline.
      return {
        recognized: true,
        targetField: "tier",
        pipeline: [{ kind: "constant", value: "B" }],
      };
    },
    async discoverMappings() {
      return { hits: [] };
    },
    async labelStep() {
      return { summary: "" };
    },
  };
  const task = {
    field: "tier",
    state: "mapped",
    slices: [],
    sliceText: "o.setTier(\"A\")",
  } as FieldTask;
  const div = await verifyFieldConsistency({
    provider,
    task,
    first: {
      targetField: "tier",
      pipeline: [{ kind: "CONSTANT", meta: { value: "A" } }],
    },
    indexerOps: [{ kind: "RAW", meta: { code: "x" } }],
  });
  assert.ok(div, "expected divergence on value A vs B");
  assert.equal(div!.field, "tier");
  assert.equal(calls, 1);
});
