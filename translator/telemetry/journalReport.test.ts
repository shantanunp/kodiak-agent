import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "kodiak-jrep-"));
process.env.KODIAK_RUNS_FILE = join(dir, "runs.jsonl");
process.env.KODIAK_DEFECTS_FILE = join(dir, "defects.jsonl");

after(() => rmSync(dir, { recursive: true, force: true }));

test("summarizeJournal aggregates cost and miss signals", async () => {
  const { appendRun } = await import("./journal.js");
  appendRun({
    at: "2026-08-08T10:00:00Z",
    mapperId: "m1",
    sourceSha: "abc",
    language: "java",
    declared: 10,
    mapped: 8,
    unmapped: 1,
    unresolved: 1,
    gatePassed: false,
    resultSource: { cache: 2, model: 6, verified: 0 },
    modelCalls: 6,
    durationMs: 100,
    promoted: false,
    tokens: { prompt: 100, completion: 40, retries: 1, latencyMs: 90, p95LatencyMs: 50 },
    writePatterns: { setter: 5, assignment: 1 },
    possibleMissedWrites: 2,
    groundingWarnings: 1,
    stepSmells: 1,
    scores: { coverage: 0.8, grounding: 1, specificity: 0.9, provenance: 1 },
    verifyDivergences: 1,
    criticFindings: 2,
    outcome: "ok",
    path: "agent-loop",
  });
  writeFileSync(
    process.env.KODIAK_DEFECTS_FILE!,
    JSON.stringify({
      at: "2026-08-08T10:01:00Z",
      mapperId: "m1",
      field: "x",
      userClaim: "c",
      judgeEvidence: "e",
      defectId: "KOD-1001",
    }) + "\n",
  );

  const { summarizeJournal } = await import("./journalReport.js");
  const s = summarizeJournal({ mapperId: "m1" });
  assert.equal(s.runs, 1);
  assert.equal(s.cost.modelCalls, 6);
  assert.equal(s.cost.promptTokens, 100);
  assert.equal(s.cost.completionTokens, 40);
  assert.equal(s.cost.cacheHits, 2);
  assert.equal(s.possibleMissedWrites, 2);
  assert.equal(s.groundingWarnings, 1);
  assert.equal(s.stepSmells, 1);
  assert.equal(s.writePatterns.setter, 5);
  assert.equal(s.judge.rejects, 1);
  assert.equal(s.verifyDivergences, 1);
  assert.equal(s.criticFindings, 2);
  assert.ok(s.scores);
  assert.equal(s.scores!.coverage, 0.8);
  assert.equal(s.scores!.specificity, 0.9);
});
