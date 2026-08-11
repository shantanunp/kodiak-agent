import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./reconcile.js";
import type { WriteSite } from "./types.js";

function site(targetField: string, line = 10): WriteSite {
  return {
    targetField,
    via: "setter",
    receiver: "target",
    expression: "value",
    inMethod: "map",
    line,
    statement: `target.set${targetField}(value);`,
  };
}

test("both legs find the field -> agreed, CST site not surfaced as cstOnly", () => {
  const result = reconcile(
    [site("remarks")],
    [{ field: "remarks", line: 10, evidence: "line 10: ..." }],
    ["remarks"],
  );
  assert.deepEqual(result.agreed, ["remarks"]);
  assert.deepEqual(result.aiOnly, []);
  assert.deepEqual(result.cstOnly, []);
});

test("AI finds it, CST silent -> aiOnly (never asserted as agreed/mapped)", () => {
  const result = reconcile(
    [],
    [{ field: "remarks", line: 28, evidence: "line 28: BulkCopy.apply" }],
    ["remarks"],
  );
  assert.deepEqual(result.agreed, []);
  assert.equal(result.aiOnly.length, 1);
  assert.equal(result.aiOnly[0]!.field, "remarks");
  assert.deepEqual(result.cstOnly, []);
});

test("CST finds it, AI silent -> cstOnly, CST still wins", () => {
  const result = reconcile([site("remarks")], [], ["remarks"]);
  assert.deepEqual(result.agreed, []);
  assert.deepEqual(result.aiOnly, []);
  assert.equal(result.cstOnly.length, 1);
  assert.equal(result.cstOnly[0]!.targetField, "remarks");
});

test("neither leg finds it -> field absent from every bucket", () => {
  const result = reconcile([], [], ["remarks"]);
  assert.deepEqual(result, { agreed: [], aiOnly: [], cstOnly: [] });
});

test("matches on normalized leaf across dotted checklist paths and case", () => {
  const result = reconcile(
    [site("Remarks")],
    [{ field: "remarks", line: 10, evidence: "line 10: ..." }],
    ["DeliveryPayload.remarks"],
  );
  assert.deepEqual(result.agreed, ["DeliveryPayload.remarks"]);
});
