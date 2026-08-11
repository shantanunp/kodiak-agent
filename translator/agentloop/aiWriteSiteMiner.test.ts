import { test } from "node:test";
import assert from "node:assert/strict";
import { mineWriteSites } from "./aiWriteSiteMiner.js";

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

test("verified claim becomes a candidate; citation is mechanically checked", async () => {
  const { candidates, dropped } = await mineWriteSites({
    provider: fakeProvider({
      writes: [{ field: "remarks", line: 28, evidence: "line 28: BulkCopy.apply writes it" }],
    }),
    sourceJava: SOURCE,
    declaredFields: ["remarks", "notes"],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.field, "remarks");
  assert.equal(dropped.length, 0);
});

test("claims without verifiable citations or for unknown fields are dropped", async () => {
  const { candidates, dropped } = await mineWriteSites({
    provider: fakeProvider({
      writes: [
        { field: "remarks", line: 9999, evidence: "trust me" },
        { field: "nonexistentField", line: 28, evidence: "line 28: x" },
      ],
    }),
    sourceJava: SOURCE,
    declaredFields: ["remarks"],
  });
  assert.equal(candidates.length, 0, "no candidate without checkable evidence");
  assert.equal(dropped.length, 2);
});

test("empty declared-field list -> zero model calls; invalid JSON -> ignored safely", async () => {
  const none = await mineWriteSites({
    provider: { model: "x", async generate() { throw new Error("must not be called"); } } as never,
    sourceJava: SOURCE,
    declaredFields: [],
  });
  assert.deepEqual(none, { candidates: [], dropped: [] });

  const bad = await mineWriteSites({
    provider: { model: "x", async generate() { return "not json"; } } as never,
    sourceJava: SOURCE,
    declaredFields: ["remarks"],
  });
  assert.equal(bad.candidates.length, 0);
  assert.ok(bad.dropped[0]!.includes("invalid JSON"));
});

test("covers multiple declared fields in one call", async () => {
  const { candidates } = await mineWriteSites({
    provider: fakeProvider({
      writes: [
        { field: "remarks", line: 28, evidence: "line 28: BulkCopy.apply writes it" },
        { field: "notes", line: 28, evidence: "line 28: BulkCopy.apply writes it" },
      ],
    }),
    sourceJava: SOURCE,
    declaredFields: ["remarks", "notes", "other"],
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((c) => c.field).sort(), ["notes", "remarks"]);
});
