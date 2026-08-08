/**
 * AGT-5 — mutation testing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAllMutations, runMutation, SHIPMENT_MUTATIONS } from "./mutation.js";

test("AGT-5: baseline golden pipelines ground against original fixture", () => {
  const results = runAllMutations();
  const baseline = results.find((r) => r.id === "baseline-grounded");
  assert.ok(baseline?.ok, baseline?.detail);
});

test("AGT-5: each mutation invalidates the prior pipeline or unmaps the field", () => {
  for (const mut of SHIPMENT_MUTATIONS) {
    const r = runMutation(mut);
    assert.ok(r.ok, `${mut.id}: ${r.detail}`);
  }
});

test("AGT-5: harness reports a failure when mutate is a no-op", () => {
  const r = runMutation({
    id: "noop",
    description: "no-op",
    field: "channel",
    expect: "ungrounded",
    mutate: (s) => s,
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /did not change/);
});

