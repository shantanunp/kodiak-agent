import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkMapperEntry, checkRegistry } from "./checkRegistry.js";
import type { MapperEntry } from "./loadRegistry.js";

const dir = mkdtempSync(join(tmpdir(), "kodiak-regcheck-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const base: MapperEntry = {
  id: "demo",
  sourceFile: "src/DemoMapper.java",
  class: "com.demo.DemoMapper",
  entryMethod: "map",
  sourceType: "com.demo.In",
  targetType: "com.demo.Out",
};

test("checkMapperEntry: missing required fields are errors", () => {
  const issues = checkMapperEntry(
    { ...base, sourceFile: "", targetType: "" },
    null,
  );
  assert.ok(issues.some((i) => i.code === "missing-sourceFile"));
  assert.ok(issues.some((i) => i.code === "missing-targetType"));
});

test("checkMapperEntry: worktree validates source + types on disk", () => {
  mkdirSync(join(dir, "src/main/java/com/demo"), { recursive: true });
  writeFileSync(join(dir, "src/DemoMapper.java"), "class DemoMapper {}");
  writeFileSync(
    join(dir, "src/main/java/com/demo/Out.java"),
    "package com.demo; public class Out {}",
  );
  writeFileSync(
    join(dir, "src/main/java/com/demo/In.java"),
    "package com.demo; public class In {}",
  );

  const ok = checkMapperEntry(base, dir);
  assert.equal(
    ok.filter((i) => i.severity === "error").length,
    0,
    JSON.stringify(ok),
  );

  const bad = checkMapperEntry(
    { ...base, sourceFile: "src/Missing.java", targetType: "com.demo.Nope" },
    dir,
  );
  assert.ok(bad.some((i) => i.code === "sourceFile-missing"));
  assert.ok(bad.some((i) => i.code === "targetType-unresolved"));
});

test("checkRegistry: loads real registry without worktree (warns only)", () => {
  const result = checkRegistry({ worktree: null });
  assert.ok(result.checked >= 1);
  // Without worktree, shape errors only — sourceFile existence is warn/no-worktree.
  assert.equal(
    result.issues.filter((i) => i.code === "missing-sourceFile").length,
    0,
  );
});
