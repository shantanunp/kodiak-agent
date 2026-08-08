import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMissLive, journalMissTotal } from "./missLive.js";

test("classifyMissLive: diagnostic prefixes + gate states", () => {
  const miss = classifyMissLive({
    diagnostics: [
      "possible-missed-write line 12 (setter): foo.setBar(",
      "unmapped-but-mentioned orderId line 40: getOrderId",
      'multi-instance-unattributed type "Contact" line 9 field email — applied to all 2 parent candidates',
      'prompt-injection-risk orderId: imperative "ignore previous"',
      "depth limit — ignored",
    ],
    fields: [
      {
        field: "alt.email",
        state: "unresolved",
        note: "cross-check: possible missed write at line 3 — setAlt",
      },
      { field: "ghost", state: "unmapped" },
      { field: "ok", state: "mapped" },
    ],
  });

  const kinds = miss.map((m) => m.kind);
  assert.ok(kinds.includes("possible-missed-write"));
  assert.ok(kinds.includes("unmapped-but-mentioned"));
  assert.ok(kinds.includes("multi-instance-unattributed"));
  assert.ok(kinds.includes("prompt-injection-risk"));
  assert.ok(kinds.includes("cross-check"));
  assert.ok(kinds.includes("unmapped"));
  assert.ok(kinds.includes("unresolved"));

  const um = miss.find((m) => m.kind === "unmapped-but-mentioned");
  assert.equal(um?.field, "orderId");
  assert.equal(um?.line, 40);

  const mi = miss.find((m) => m.kind === "multi-instance-unattributed");
  assert.equal(mi?.field, "email");
  assert.equal(mi?.line, 9);

  const inj = miss.find((m) => m.kind === "prompt-injection-risk");
  assert.equal(inj?.field, "orderId");
});

test("journalMissTotal sums known miss counters", () => {
  assert.equal(
    journalMissTotal({
      possibleMissedWrites: 1,
      unmappedButMentioned: 2,
      multiInstanceUnattributed: 3,
      promptInjectionRisks: 0,
      crossCheckFlips: 1,
      groundingWarnings: 4,
      stepSmells: 0,
      verifyDivergences: 0,
      criticFindings: 1,
    }),
    12,
  );
});
