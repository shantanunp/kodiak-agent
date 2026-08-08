import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "kodiak-runs-"));
process.env.KODIAK_RUNS_FILE = join(dir, "runs.jsonl");

const { appendRun, readRuns, sourceSha } = await import("./journal.js");

after(() => rmSync(dir, { recursive: true, force: true }));

test("appendRun writes one JSON line; readRuns filters by mapper", () => {
  appendRun({
    at: "2026-08-08T10:00:00Z",
    mapperId: "m1",
    sourceSha: sourceSha("class A {}"),
    language: "java",
    declared: 10,
    mapped: 8,
    unmapped: 1,
    unresolved: 1,
    gatePassed: false,
    resultSource: { verified: 5, cache: 2, model: 1 },
    modelCalls: 1,
    durationMs: 42,
    promoted: false,
    checklistSource: "target-type",
    diagnostics: 2,
    outcome: "ok",
    path: "agent-loop",
  });
  appendRun({
    at: "2026-08-08T11:00:00Z",
    mapperId: "m2",
    sourceSha: "deadbeef",
    language: "java",
    declared: 3,
    mapped: 0,
    unmapped: 0,
    unresolved: 3,
    gatePassed: false,
    resultSource: {},
    durationMs: 1,
    promoted: false,
    outcome: "error",
    error: "boom",
    path: "cli-analyzer",
  });

  const all = readRuns();
  assert.equal(all.length, 2);
  assert.equal(all[0]!.mapperId, "m1");
  assert.equal(all[0]!.sourceSha.length, 12);
  assert.equal(all[0]!.resultSource.verified, 5);

  const onlyM2 = readRuns({ mapperId: "m2" });
  assert.equal(onlyM2.length, 1);
  assert.equal(onlyM2[0]!.outcome, "error");
  assert.equal(onlyM2[0]!.error, "boom");
});

test("failed-run shape still records (error outcome)", () => {
  appendRun({
    at: "2026-08-08T12:00:00Z",
    mapperId: "m1",
    sourceSha: "abc",
    language: "java",
    declared: 0,
    mapped: 0,
    unmapped: 0,
    unresolved: 0,
    gatePassed: false,
    resultSource: {},
    durationMs: 0,
    promoted: false,
    outcome: "error",
    error: "network blocked",
    path: "cli-analyzer",
  });
  const rows = readRuns({ mapperId: "m1" });
  assert.ok(rows.some((r) => r.outcome === "error" && r.error === "network blocked"));
});
