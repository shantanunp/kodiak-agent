import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KODIAK_VERIFIED_DIR = mkdtempSync(join(tmpdir(), "kodiak-explore-store-"));
process.env.KODIAK_DEFECTS_FILE = join(
  mkdtempSync(join(tmpdir(), "kodiak-explore-def-")),
  "defects.jsonl",
);
process.env.KODIAK_EXPLORE_FILE = join(
  mkdtempSync(join(tmpdir(), "kodiak-explore-log-")),
  "explore.jsonl",
);
process.env.MODEL_API_KEY = process.env.MODEL_API_KEY || "test-key-never-used";

const {
  resolveWorktreePath,
  makeWorktreeTools,
  exploreAndJudge,
  formatExploreTrace,
  exploreLogFile,
  logExploreTrace,
  parseJudgeJson,
  isFailedJudgeParse,
} = await import("./explore.js");
const { logDefect, mockDefectId, defectsFile, applyJudgeVerdict } = await import("./judge.js");
const { getVerified } = await import("../verified/store.js");

after(() => {
  rmSync(process.env.KODIAK_VERIFIED_DIR!, { recursive: true, force: true });
});

function makeWt(): string {
  const wt = mkdtempSync(join(tmpdir(), "kodiak-explore-wt-"));
  const dir = join(wt, "src/main/java/com/acme");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "OrderRequestMapper.java"),
    `package com.acme;
public class OrderRequestMapper {
  private String[] splitName(String displayName) {
    String trimmed = displayName.trim();
    int space = trimmed.indexOf(' ');
    return new String[] { trimmed.substring(0, space), trimmed.substring(space + 1).trim() };
  }
  void map() {
    String[] parts = splitName(in.getDisplayName());
    mapped.setFirstName(parts[0]);
    mapped.setLastName(parts[1]);
  }
}
`,
  );
  return wt;
}

test("resolveWorktreePath rejects path traversal", () => {
  const wt = makeWt();
  assert.ok(resolveWorktreePath(wt, "src/main/java/com/acme/OrderRequestMapper.java"));
  assert.equal(resolveWorktreePath(wt, "../outside.java"), null);
  assert.equal(resolveWorktreePath(wt, "src/../../etc/passwd"), null);
  rmSync(wt, { recursive: true, force: true });
});

test("search_worktree finds splitName / setFirstName in fixture", () => {
  const wt = makeWt();
  const exec = makeWorktreeTools(wt);
  const hits = exec("search_worktree", { query: "splitName" });
  assert.match(hits, /OrderRequestMapper\.java:\d+:/);
  assert.match(hits, /splitName/);
  const first = exec("search_worktree", { query: "setFirstName" });
  assert.match(first, /setFirstName/);
  const read = exec("read_file", {
    path: "src/main/java/com/acme/OrderRequestMapper.java",
    start: 3,
    end: 8,
  });
  assert.match(read, /displayName\.trim/);
  assert.match(exec("read_file", { path: "../secret", start: 1, end: 2 }), /path rejected/);
  rmSync(wt, { recursive: true, force: true });
});

test("formatExploreTrace summarizes tool steps", () => {
  const text = formatExploreTrace([
    { tool: "search_worktree", input: { query: "splitName" }, output: "a.java:1: splitName" },
    {
      tool: "read_file",
      input: { path: "a.java", start: 1, end: 10 },
      output: "1: hello",
    },
  ]);
  assert.match(text, /1\. search_worktree/);
  assert.match(text, /query="splitName"/);
  assert.match(text, /2\. read_file/);
});

test("force-defect logging does not touch verified store", () => {
  const defectId = mockDefectId("explore-test:firstName:claim:forced");
  logDefect({
    mapperId: "explore-test",
    field: "firstName",
    userClaim: "claim",
    judgeEvidence: "User forced defect after judge confirmed the pipeline looks correct.",
    defectId,
  });
  assert.ok(existsSync(defectsFile()));
  const rec = JSON.parse(readFileSync(defectsFile(), "utf8").trim().split("\n").pop()!);
  assert.equal(rec.defectId, defectId);
  assert.equal(getVerified("explore-test", "fp-force"), null);
});

test("exploreAndJudge with stubbed tool loop → confirmed + explore.jsonl", async () => {
  const wt = makeWt();
  const source = readFileSync(
    join(wt, "src/main/java/com/acme/OrderRequestMapper.java"),
    "utf8",
  );

  // Stub runToolLoop by calling applyJudgeVerdict path through a minimal fake:
  // monkey-patch via exploreAndJudge's dependency is hard; instead unit-test
  // applyJudgeVerdict with explore-style evidence corpus + logExploreTrace.
  const evidence =
    'line 4: "String trimmed = displayName.trim();" then substring(0, space) — trim before take';
  const outcome = applyJudgeVerdict({
    mapperId: "explore-test",
    fingerprint: "fp-explore",
    field: "firstName",
    sliceText: source,
    sourceJava: source,
    userClaim: "there should be a trim after take first",
    raw: {
      agree: false,
      evidence,
      reason: "current pipeline already matches the code",
    },
  });
  assert.equal(outcome.outcome, "confirmed");

  logExploreTrace({
    mapperId: "explore-test",
    field: "firstName",
    userClaim: "there should be a trim after take first",
    outcome: outcome.outcome,
    trace: [
      {
        tool: "search_worktree",
        input: { query: "splitName" },
        output: execPreview(wt),
      },
    ],
  });
  assert.ok(existsSync(exploreLogFile()));
  const log = JSON.parse(readFileSync(exploreLogFile(), "utf8").trim().split("\n").pop()!);
  assert.equal(log.outcome, "confirmed");
  assert.equal(log.steps[0].tool, "search_worktree");

  rmSync(wt, { recursive: true, force: true });
});

function execPreview(wt: string): string {
  return makeWorktreeTools(wt)("search_worktree", { query: "splitName" });
}

test("exploreAndJudge missing worktree → unverifiable", async () => {
  const out = await exploreAndJudge({
    config: {
      apiKey: "x",
      model: "x",
      temperature: 0,
      baseUrl: "http://127.0.0.1:9",
      apiStyle: "openai",
    },
    worktree: join(tmpdir(), "kodiak-missing-wt-" + Date.now()),
    mapperId: "explore-test",
    fingerprint: "fp-missing",
    field: "firstName",
    userClaim: "trim after take",
    currentPipeline: [],
    sourceJava: "class X {}",
  });
  assert.equal(out.outcome, "unverifiable");
  assert.deepEqual(out.trace, []);
});

test("parseJudgeJson treats prose-only as failed parse", () => {
  const raw = parseJudgeJson(
    "Now I can analyze the code carefully:\nLooking at splitName…",
  );
  assert.ok(isFailedJudgeParse(raw));
});

test("exploreAndJudge prose tool result → finalize JSON → confirmed", async () => {
  const wt = makeWt();
  const source = readFileSync(
    join(wt, "src/main/java/com/acme/OrderRequestMapper.java"),
    "utf8",
  );
  const out = await exploreAndJudge({
    config: {
      apiKey: "x",
      model: "x",
      temperature: 0,
      baseUrl: "http://127.0.0.1:9",
      apiStyle: "openai",
    },
    worktree: wt,
    mapperId: "explore-test",
    fingerprint: "fp-prose",
    field: "firstName",
    userClaim: "there should be a trim after take first",
    currentPipeline: [],
    sourceJava: source,
    runLoop: async ({ executeTool }) => {
      const searchOut = executeTool("search_worktree", { query: "splitName" });
      return {
        text: "Now I can analyze the code carefully:\nLooking at the splitName helper… trim before substring.",
        trace: [
          { tool: "search_worktree", input: { query: "splitName" }, output: searchOut },
        ],
      };
    },
    finalizeGenerate: async () =>
      JSON.stringify({
        agree: false,
        evidence:
          'String trimmed = displayName.trim(); then substring(0, space) — trim is before take first',
        reason: "current pipeline already matches the code",
      }),
  });
  assert.equal(out.outcome, "confirmed");
  assert.equal(out.trace.length, 1);
  rmSync(wt, { recursive: true, force: true });
});

test("exploreAndJudge with fake runLoop → confirmed + trace returned", async () => {
  const wt = makeWt();
  const source = readFileSync(
    join(wt, "src/main/java/com/acme/OrderRequestMapper.java"),
    "utf8",
  );
  const out = await exploreAndJudge({
    config: {
      apiKey: "x",
      model: "x",
      temperature: 0,
      baseUrl: "http://127.0.0.1:9",
      apiStyle: "openai",
    },
    worktree: wt,
    mapperId: "explore-test",
    fingerprint: "fp-loop",
    field: "firstName",
    userClaim: "there should be a trim after take first",
    currentPipeline: [{ kind: "transform", op: "Take first" }],
    sourceJava: source,
    runLoop: async ({ executeTool }) => {
      const searchOut = executeTool("search_worktree", { query: "splitName" });
      const readOut = executeTool("read_file", {
        path: "src/main/java/com/acme/OrderRequestMapper.java",
        start: 1,
        end: 20,
      });
      return {
        text: JSON.stringify({
          agree: false,
          evidence:
            'String trimmed = displayName.trim(); then substring(0, space) — trim is before take first',
          reason: "current pipeline already matches the code",
        }),
        trace: [
          { tool: "search_worktree", input: { query: "splitName" }, output: searchOut },
          {
            tool: "read_file",
            input: {
              path: "src/main/java/com/acme/OrderRequestMapper.java",
              start: 1,
              end: 20,
            },
            output: readOut,
          },
        ],
      };
    },
  });
  assert.equal(out.outcome, "confirmed");
  assert.equal(out.trace.length, 2);
  assert.match(formatExploreTrace(out.trace), /search_worktree/);
  rmSync(wt, { recursive: true, force: true });
});
