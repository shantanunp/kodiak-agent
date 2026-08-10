import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenLeafPaths, flattenPaths } from "./flatten.js";
import type { SchemaNode } from "./types.js";

function node(
  name: string,
  type: SchemaNode["type"],
  children: SchemaNode[] = [],
  extra: Partial<SchemaNode> = {},
): SchemaNode {
  return { id: name, name, type, children, ...extra };
}

test("flattenLeafPaths skips object containers", () => {
  const root = node("OrderMappedResponse", "object", [
    node("header", "object", [
      node("orderId", "string"),
      node("status", "string"),
    ]),
    node("total", "number"),
  ]);
  assert.deepEqual(flattenLeafPaths(root).sort(), [
    "header.orderId",
    "header.status",
    "total",
  ]);
  // Full flatten still includes the container path.
  assert.ok(flattenPaths(root).includes("header"));
});

test("flattenLeafPaths keeps scalar arrays as leaves", () => {
  const root = node("Out", "object", [
    node("tags", "array", [], { itemType: "string" }),
  ]);
  assert.deepEqual(flattenLeafPaths(root), ["tags[]"]);
});

test("flattenLeafPaths expands object arrays", () => {
  const root = node("Out", "object", [
    node(
      "items",
      "array",
      [node("sku", "string"), node("qty", "integer")],
      { itemType: "object" },
    ),
  ]);
  assert.deepEqual(flattenLeafPaths(root).sort(), [
    "items[].qty",
    "items[].sku",
  ]);
});

test("flattenLeafPaths includes untyped leaves", () => {
  const root = node("Out", "object", [
    { id: "x", name: "mystery", children: [] },
  ]);
  assert.deepEqual(flattenLeafPaths(root), ["mystery"]);
});
