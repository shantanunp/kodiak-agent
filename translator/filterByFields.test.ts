import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesTargetField } from "./filterByFields.js";

describe("matchesTargetField", () => {
  const sel = ["MESSAGE.DEAL.COLLATERAL.AddressLineText"];

  it("matches AI setX hints against business --fields", () => {
    assert.equal(matchesTargetField("setAddressLineText", sel), true);
    assert.equal(matchesTargetField("addressLineText", sel), true);
    assert.equal(matchesTargetField("Collateral.addressLineText", sel), true);
  });

  it("still matches full AST java paths", () => {
    assert.equal(
      matchesTargetField(
        "LpaMappedResponse.Message.Deal.Collateral.addressLineText",
        sel,
      ),
      true,
    );
  });
});
