import { test } from "node:test";
import assert from "node:assert/strict";
import { crossCheckUnmapped } from "./crossCheck.js";

const SOURCE = Array.from({ length: 50 }, (_, i) =>
  i === 27 ? "    BulkCopy.apply(input, target); // writes several fields" : `line${i + 1}`,
).join("\n");

function fakeProvider(reply: unknown) {
  return {
    model: "fake",
    async generate() { return JSON.stringify(reply); },
    async labelFieldMapping() { throw new Error("unused"); },
    async discoverMappings() { throw new Error("unused"); },
    async labelStep() { throw new Error("unused"); },
  } as never;
}

test("verified claim flips a field; citation is mechanically checked", async () => {
  const { flips, dropped } = await crossCheckUnmapped({
    provider: fakeProvider({
      missedWrites: [{ field: "remarks", line: 28, evidence: "line 28: BulkCopy.apply writes it" }],
    }),
    sourceJava: SOURCE,
    unmappedFields: ["remarks", "notes"],
  });
  assert.equal(flips.length, 1);
  assert.equal(flips[0]!.field, "remarks");
  assert.equal(dropped.length, 0);
});

test("claims without verifiable citations or for unknown fields are dropped", async () => {
  const { flips, dropped } = await crossCheckUnmapped({
    provider: fakeProvider({
      missedWrites: [
        { field: "remarks", line: 9999, evidence: "trust me" },
        { field: "nonexistentField", line: 28, evidence: "line 28: x" },
      ],
    }),
    sourceJava: SOURCE,
    unmappedFields: ["remarks"],
  });
  assert.equal(flips.length, 0, "no flip without checkable evidence");
  assert.equal(dropped.length, 2);
});

test("empty unmapped list -> zero model calls; invalid JSON -> ignored safely", async () => {
  const none = await crossCheckUnmapped({
    provider: { model: "x", async generate() { throw new Error("must not be called"); } } as never,
    sourceJava: SOURCE,
    unmappedFields: [],
  });
  assert.deepEqual(none, { flips: [], dropped: [] });

  const bad = await crossCheckUnmapped({
    provider: { model: "x", async generate() { return "not json"; } } as never,
    sourceJava: SOURCE,
    unmappedFields: ["remarks"],
  });
  assert.equal(bad.flips.length, 0);
  assert.ok(bad.dropped[0]!.includes("invalid JSON"));
});
