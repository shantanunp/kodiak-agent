import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const storeDir = mkdtempSync(join(tmpdir(), "kodiak-drift-store-"));
const regDir = mkdtempSync(join(tmpdir(), "kodiak-drift-reg-"));
const wt = mkdtempSync(join(tmpdir(), "kodiak-drift-wt-"));
process.env.KODIAK_VERIFIED_DIR = storeDir;

after(() => {
  for (const d of [storeDir, regDir, wt]) rmSync(d, { recursive: true, force: true });
});

test("drift: current / stale / never-verified", async () => {
  const mapDir = join(wt, "src/main/java/com/acme");
  mkdirSync(mapDir, { recursive: true });
  const srcA = `package com.acme; public class M { public Out map(In in){ Out o=new Out(); o.setX(in.getX()); return o; } }`;
  const srcB = srcA + " /* changed */";
  writeFileSync(join(mapDir, "M.java"), srcA);

  // Minimal registry pointing at the worktree file.
  writeFileSync(
    join(regDir, "mapping-registry.yaml"),
    `repo: "x/y"\nbranch: main\nscope: ["**/*.java"]\nmappers:\n` +
      `  - id: m-current\n    sourceFile: src/main/java/com/acme/M.java\n` +
      `    class: com.acme.M\n    entryMethod: map\n` +
      `    sourceType: com.acme.In\n    targetType: com.acme.Out\n` +
      `  - id: m-never\n    sourceFile: src/main/java/com/acme/Missing.java\n` +
      `    class: com.acme.Missing\n    entryMethod: map\n` +
      `    sourceType: com.acme.In\n    targetType: com.acme.Out\n`,
  );

  const { computeVerifiedFingerprint, promoteToVerified } = await import(
    "../verified/store.js"
  );
  const fpA = computeVerifiedFingerprint({ sourceJava: srcA, schemaJson: "" });
  promoteToVerified({
    mapperId: "m-current",
    fingerprint: fpA,
    mapping: [{ targetField: "x", pipeline: [{ kind: "READ", labelSource: "model" }] }],
    labeledBy: "test",
  });

  // Stale: promote under old fp, then change source so current fp has no entry.
  const fpOld = computeVerifiedFingerprint({ sourceJava: srcB, schemaJson: "" });
  promoteToVerified({
    mapperId: "m-stale",
    fingerprint: fpOld,
    mapping: [{ targetField: "x", pipeline: [{ kind: "CONSTANT", meta: { value: 1 }, labelSource: "model" }] }],
    labeledBy: "test",
  });
  // Registry needs m-stale with current source = srcA (different from fpOld).
  writeFileSync(
    join(regDir, "mapping-registry.yaml"),
    `repo: "x/y"\nbranch: main\nscope: ["**/*.java"]\nmappers:\n` +
      `  - id: m-current\n    sourceFile: src/main/java/com/acme/M.java\n` +
      `    class: com.acme.M\n    entryMethod: map\n` +
      `    sourceType: com.acme.In\n    targetType: com.acme.Out\n` +
      `  - id: m-stale\n    sourceFile: src/main/java/com/acme/M.java\n` +
      `    class: com.acme.M\n    entryMethod: map\n` +
      `    sourceType: com.acme.In\n    targetType: com.acme.Out\n` +
      `  - id: m-never\n    sourceFile: src/main/java/com/acme/Missing.java\n` +
      `    class: com.acme.Missing\n    entryMethod: map\n` +
      `    sourceType: com.acme.In\n    targetType: com.acme.Out\n`,
  );

  // m-stale has only fpOld; current source is srcA → fingerprint fpA → never for m-stale... 
  // Actually both m-current and m-stale share same file srcA. m-current has fpA entry → current.
  // For m-stale we need entry only under a different fingerprint. fpOld was for srcB.
  // Current source srcA → fpA. m-stale store has only fpOld → status stale. Good.
  // m-never: missing file → unresolvable or never.

  const { checkDrift } = await import("./drift.js");
  const rows = await checkDrift({
    registryPath: join(regDir, "mapping-registry.yaml"),
    worktree: wt,
  });
  const byId = Object.fromEntries(rows.map((r) => [r.mapperId, r]));

  assert.equal(byId["m-current"]?.status, "current");
  assert.equal(byId["m-stale"]?.status, "stale");
  assert.ok(
    byId["m-never"]?.status === "never-verified" ||
      byId["m-never"]?.status === "unresolvable",
  );
});
