import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOfflineFieldGroups } from "./offlineFields.js";
import type { IndexAst } from "../model/index.js";

const stubAst: IndexAst = {
  mapperId: "demo",
  className: "DemoMapper",
  entryMethod: "map",
  operations: [],
  steps: [],
};

describe("buildOfflineFieldGroups", () => {
  it("builds empty-pipeline groups from --fields without indexer", () => {
    const groups = buildOfflineFieldGroups({
      ast: stubAst,
      selectors: ["Summary.displayName", "Order.shipTo.postalCode"],
    });
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0], { targetField: "Summary.displayName", pipeline: [] });
  });

  it("requires --fields when not using --with-ast", () => {
    assert.throws(
      () => buildOfflineFieldGroups({ ast: stubAst, selectors: [] }),
      /--fields/,
    );
  });
});
