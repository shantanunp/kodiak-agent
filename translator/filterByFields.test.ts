import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterMappingByFields, matchesTargetField } from "./filterByFields.js";

describe("matchesTargetField", () => {
  const sel = ["DeliveryPayload.shipTo.streetLine"];

  it("matches AI setX hints against business --fields", () => {
    assert.equal(matchesTargetField("setStreetLine", sel), true);
    assert.equal(matchesTargetField("setCity", sel), false);
  });

  it("still matches full AST java paths", () => {
    assert.equal(
      matchesTargetField(
        "example.mapper.Target.Destination.streetLine",
        ["streetLine"],
      ),
      true,
    );
    assert.equal(
      matchesTargetField("DeliveryPayload.shipTo.streetLine", [
        "DeliveryPayload.shipTo.streetLine",
      ]),
      true,
    );
  });
});

describe("filterMappingByFields", () => {
  it("filters mapping entries by business path", () => {
    const mapping = [
      {
        targetField: "DeliveryPayload.shipTo.streetLine",
        pipeline: [{ kind: "READ", sourceField: "Customer.address.line" }],
      },
      {
        targetField: "DeliveryPayload.fullName",
        pipeline: [{ kind: "READ", sourceField: "Customer.profile.firstName" }],
      },
    ];
    const filtered = filterMappingByFields(mapping, [
      "DeliveryPayload.shipTo.streetLine",
    ]);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.targetField, "DeliveryPayload.shipTo.streetLine");
  });
});
