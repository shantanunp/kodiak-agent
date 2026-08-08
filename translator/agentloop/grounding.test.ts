import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPipelineGrounding } from "./grounding.js";

test("AGT-1: grounded READ/TRANSFORM/CONSTANT pass", () => {
  const slice = `
if ("EXPRESS".equals(shipment.getStatus())) {
  notice.setPriority(true);
}
`;
  const warnings = checkPipelineGrounding({
    field: "priority",
    sliceText: slice,
    schemaPaths: ["shipment.status"],
    pipeline: [
      { kind: "READ", sourceField: "shipment.status", labelSource: "model" },
      { kind: "CONSTANT", meta: { value: true }, labelSource: "model" },
    ],
  });
  assert.deepEqual(warnings, []);
});

test("AGT-1: invented TRANSFORM op is ungrounded", () => {
  const warnings = checkPipelineGrounding({
    field: "regionCode",
    sliceText: "notice.setRegionCode(region.trim());",
    pipeline: [
      { kind: "READ", sourceField: "region", labelSource: "model" },
      {
        kind: "TRANSFORM",
        meta: { op: "base64Encode" },
        labelSource: "model",
      },
    ],
  });
  assert.ok(warnings.some((w) => w.detail.includes("base64Encode")));
});

test("AGT-1: READ path missing from schema and slice is ungrounded", () => {
  const warnings = checkPipelineGrounding({
    field: "x",
    sliceText: "notice.setX(1);",
    schemaPaths: ["order.id"],
    pipeline: [
      { kind: "READ", sourceField: "totally.invented", labelSource: "model" },
    ],
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.detail, /totally\.invented/);
});
