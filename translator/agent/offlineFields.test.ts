import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOfflineFieldGroups } from "./offlineFields.js";

describe("buildOfflineFieldGroups", () => {
  it("builds empty-pipeline groups from --fields", () => {
    const groups = buildOfflineFieldGroups({
      selectors: ["Summary.displayName", "Order.amount"],
    });
    assert.equal(groups.length, 2);
    assert.equal(groups[0]!.targetField, "Summary.displayName");
    assert.deepEqual(groups[0]!.pipeline, []);
  });

  it("requires --fields", () => {
    assert.throws(
      () => buildOfflineFieldGroups({ selectors: [] }),
      /--fields/,
    );
  });
});
