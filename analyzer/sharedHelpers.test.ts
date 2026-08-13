import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scanWriteSites } from "./scanWriteSites.js";
import { fieldsSharingWith, sharedHelpersByField } from "./sharedHelpers.js";

const FIXTURE = "fixtures/ShipmentNoticeMapper.java";

function slicesAsTasks() {
  const source = readFileSync(FIXTURE, "utf8");
  const { slices } = scanWriteSites({
    filePath: FIXTURE,
    language: "java",
    mapperClass: "ShipmentNoticeMapper",
    targetClass: "DeliveryNotice",
    source,
  });
  const byField = new Map<string, typeof slices>();
  for (const slice of slices) {
    const list = byField.get(slice.targetField) ?? [];
    list.push(slice);
    byField.set(slice.targetField, list);
  }
  return [...byField.entries()].map(([field, fieldSlices]) => ({
    field,
    slices: fieldSlices,
  }));
}

test("trimValue is shared across name, tracking, and region writes", () => {
  const index = sharedHelpersByField(slicesAsTasks(), ["map"]);
  const first = index.get("recipientFirst") ?? [];
  const trim = first.find((h) => h.name === "trimValue");
  assert.ok(trim, "recipientFirst must flag trimValue as shared");
  assert.ok(trim!.fields.includes("recipientLast"));
  assert.ok(trim!.fields.includes("trackingDigits"));
  assert.ok(trim!.fields.includes("regionCode"));
  assert.ok(!trim!.fields.includes("recipientFirst"));
});

test("splitName is shared only by the two name fields", () => {
  const index = sharedHelpersByField(slicesAsTasks(), ["map"]);
  const first = index.get("recipientFirst") ?? [];
  const split = first.find((h) => h.name === "splitName");
  assert.ok(split);
  assert.deepEqual(split!.fields, ["recipientLast"]);

  const tracking = index.get("trackingDigits") ?? [];
  assert.equal(
    tracking.find((h) => h.name === "splitName"),
    undefined,
    "trackingDigits does not call splitName",
  );
});

test("keepDigits is field-private and is not flagged", () => {
  const index = sharedHelpersByField(slicesAsTasks(), ["map"]);
  const tracking = index.get("trackingDigits") ?? [];
  assert.equal(tracking.find((h) => h.name === "keepDigits"), undefined);
  assert.ok(tracking.some((h) => h.name === "trimValue"));
});

test("entry method is excluded from the shared index", () => {
  const index = sharedHelpersByField(slicesAsTasks(), ["map"]);
  for (const refs of index.values()) {
    assert.equal(refs.find((h) => h.name === "map"), undefined);
  }
});

test("fieldsSharingWith unions every other field on shared helpers", () => {
  const index = sharedHelpersByField(slicesAsTasks(), ["map"]);
  const others = fieldsSharingWith("recipientFirst", index);
  assert.ok(others.includes("recipientLast"));
  assert.ok(others.includes("trackingDigits"));
  assert.ok(others.includes("regionCode"));
  assert.ok(!others.includes("recipientFirst"));
});

test("inline-only fields with empty closures are not shared", () => {
  const index = sharedHelpersByField(
    [
      { field: "a", slices: [{ helperClosure: [] }] },
      { field: "b", slices: [{ helperClosure: [] }] },
    ],
    [],
  );
  assert.deepEqual(index.get("a"), []);
  assert.deepEqual(index.get("b"), []);
});
