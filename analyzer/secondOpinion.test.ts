import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findPossibleMissedWrites,
  findUnmappedMentions,
  missDiagnostics,
} from "./secondOpinion.js";
import type { WriteSite } from "./types.js";

test("PAR-1: loose scan flags setter the CST list missed", () => {
  const source = `
public class M {
  void map() {
    Notice n = new Notice();
    n.setKnown(true);
    n.setHidden(false);   // CST "forgot" this one
  }
}`;
  const cst: WriteSite[] = [
    {
      targetField: "known",
      via: "setter",
      receiver: "n",
      expression: "true",
      inMethod: "map",
      line: 5,
      statement: "n.setKnown(true);",
    },
  ];
  const misses = findPossibleMissedWrites(source, cst);
  assert.ok(
    misses.some((m) => m.evidence.includes("setHidden")),
    `expected setHidden miss, got ${JSON.stringify(misses)}`,
  );
  assert.ok(!misses.some((m) => m.evidence.includes("setKnown")));
});

test("PAR-2: unmapped field mentioned via setter is flagged", () => {
  const source = `
public class M {
  void map() {
    // remarks never written, but name appears in a comment-free call that was removed
    String x = notice.getRemarks();
  }
}`;
  const hits = findUnmappedMentions(source, ["remarks"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, "unmapped-but-mentioned");
  assert.ok(hits[0]!.evidence.includes("getRemarks"));
});

test("missDiagnostics formats both kinds", () => {
  const source = `class C { void m(){ t.setZ(1); String a = t.getOrphan(); } }`;
  const diags = missDiagnostics(source, [], ["orphan"]);
  assert.ok(diags.some((d) => d.startsWith("possible-missed-write")));
  assert.ok(diags.some((d) => d.startsWith("unmapped-but-mentioned")));
});
