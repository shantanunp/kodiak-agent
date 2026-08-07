import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KODIAK_VERIFIED_DIR = mkdtempSync(join(tmpdir(), "kodiak-judge-store-"));
process.env.KODIAK_DEFECTS_FILE = join(mkdtempSync(join(tmpdir(), "kodiak-judge-def-")), "defects.jsonl");
process.env.MODEL_API_KEY = process.env.MODEL_API_KEY || "test-key-never-used";

const { judgeSuggestion, verifyCitations, mockDefectId, defectsFile } = await import("./judge.js");
const { getVerified } = await import("../verified/store.js");

after(() => {
  rmSync(process.env.KODIAK_VERIFIED_DIR!, { recursive: true, force: true });
});

const SLICE = '// write site (line 62, in map, via setter)\nnotice.setRecipientFirst(parts[0]);\n// helper: splitName\nString[] splitName(String raw) { String trimmed = trimValue(raw); return trimmed.split("\\\\s+"); }';
const SOURCE = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");

function fakeJudgeProvider(reply: unknown) {
  return {
    model: "fake-judge",
    async generate() { return JSON.stringify(reply); },
    async labelFieldMapping() { throw new Error("unused"); },
    async discoverMappings() { throw new Error("unused"); },
    async labelStep() { throw new Error("unused"); },
  } as never;
}

test("citation verification: line numbers and quoted fragments checked mechanically", () => {
  assert.equal(verifyCitations("line 62: trimValue runs first", SLICE, SOURCE), true);
  assert.equal(verifyCitations("line 9999 proves it", SLICE, SOURCE), false);
  assert.equal(verifyCitations('the code calls "trimValue(raw)"', SLICE, SOURCE), true);
  assert.equal(verifyCitations("trust me, it is there", SLICE, SOURCE), false);
});

test("agreement with verified evidence -> corrected pipeline lands in the store", async () => {
  const out = await judgeSuggestion({
    provider: fakeJudgeProvider({
      agree: true,
      evidence: "line 62: splitName calls trimValue before split",
      reason: "trim happens in the helper",
      pipeline: [
        { kind: "read", sourceField: "shipment.customerName", summary: "Reads name." },
        { kind: "transform", op: "trim", summary: "Trims." },
        { kind: "transform", op: "split", value: " ", summary: "Splits." },
        { kind: "transform", op: "takeFirst", summary: "First part." },
      ],
    }),
    mapperId: "judge-test", fingerprint: "fp-1",
    field: "recipientFirst", sliceText: SLICE, sourceJava: SOURCE,
    currentPipeline: [], userClaim: "there should be a trim before the split",
  });

  assert.equal(out.outcome, "corrected");
  const entry = getVerified("judge-test", "fp-1")!;
  const f = entry.fields.find((x) => x.targetField === "recipientFirst")!;
  assert.equal(f.status, "user-corrected");
  assert.equal(f.pipeline.length, 4);
  assert.equal(f.correction?.userClaim, "there should be a trim before the split");
});

test("agreement WITHOUT checkable evidence never reaches the store", async () => {
  const out = await judgeSuggestion({
    provider: fakeJudgeProvider({
      agree: true, evidence: "yes the user is right",
      pipeline: [{ kind: "read", sourceField: "x", summary: "." }],
    }),
    mapperId: "judge-test", fingerprint: "fp-2",
    field: "weightGrams", sliceText: SLICE, sourceJava: SOURCE,
    currentPipeline: [], userClaim: "multiply by 1000",
  });
  assert.equal(out.outcome, "invalid");
  assert.equal(getVerified("judge-test", "fp-2"), null);
});

test("disagreement -> mock defect id + defects.jsonl record, store untouched", async () => {
  const out = await judgeSuggestion({
    provider: fakeJudgeProvider({
      agree: false,
      evidence: 'line 62: only "trimValue(raw)" and split exist; no uppercase anywhere',
      reason: "code contradicts the claim",
    }),
    mapperId: "judge-test", fingerprint: "fp-3",
    field: "recipientFirst", sliceText: SLICE, sourceJava: SOURCE,
    currentPipeline: [], userClaim: "it should uppercase the name",
  });

  assert.equal(out.outcome, "rejected");
  assert.match((out as { defectId: string }).defectId, /^KOD-\d{4}$/);
  assert.ok(existsSync(defectsFile()));
  const rec = JSON.parse(readFileSync(defectsFile(), "utf8").trim().split("\n").pop()!);
  assert.equal(rec.userClaim, "it should uppercase the name");
  assert.equal(rec.defectId, (out as { defectId: string }).defectId);
  // deterministic id for the same claim
  assert.equal(mockDefectId("judge-test:recipientFirst:it should uppercase the name"), rec.defectId);
});

test("offline judge round trip: export -> agent verdict -> import applies with same rigor", async () => {
  const { exportJudgeJob, importJudgeResult } = await import("./offline.js");
  const { writeFileSync } = await import("node:fs");

  // registry temp entry via existing fixture mapper
  const exported = await exportJudgeJob({
    mapper: "judge-offline-test",
    field: "trackingDigits",
    claim: "there should be a trim before keeping digits",
    worktree: ".",
    registry: "/tmp/judge-offline-registry.yaml",
  }).catch(async () => {
    // build a minimal registry on the fly, then retry
    writeFileSync("/tmp/judge-offline-registry.yaml", `repo: "x/y"
branch: "main"
scope: ["fixtures/**/*.java"]
mappers:
  - id: judge-offline-test
    sourceFile: fixtures/ShipmentNoticeMapper.java
    class: com.kodiak.fixtures.ShipmentNoticeMapper
    entryMethod: map
    sourceType: com.kodiak.fixtures.ShipmentNoticeMapper$Shipment
    targetType: com.kodiak.fixtures.ShipmentNoticeMapper$DeliveryNotice
`);
    const { exportJudgeJob: e2 } = await import("./offline.js");
    return e2({
      mapper: "judge-offline-test",
      field: "trackingDigits",
      claim: "there should be a trim before keeping digits",
      worktree: ".",
      registry: "/tmp/judge-offline-registry.yaml",
    });
  });

  const job = JSON.parse(readFileSync(exported.jobFile, "utf8"));
  assert.equal(job.kind, "judge");
  assert.ok(job.sliceText.includes("keepDigits"), "job carries the slice");
  assert.ok(job.systemPrompt.includes("verification judge"));

  // Agent agrees WITH checkable evidence (quotes real code)
  writeFileSync(exported.resultFile, JSON.stringify({
    mapperId: job.mapperId, fingerprint: job.fingerprint, field: job.field,
    verdict: {
      agree: true,
      evidence: 'the helper calls "keepDigits(trimValue(raw))" so trim precedes digit filtering',
      reason: "trim is already in the chain",
      pipeline: [
        { kind: "read", sourceField: "shipment.refCode", summary: "Reads ref." },
        { kind: "transform", op: "trim", summary: "Trims." },
        { kind: "transform", op: "keepDigits", summary: "Digits only." },
      ],
    },
  }));

  const outcome = importJudgeResult(exported.resultFile);
  assert.equal(outcome.outcome, "corrected");
  const entry = getVerified(job.mapperId, job.fingerprint)!;
  const f = entry.fields.find((x) => x.targetField === "trackingDigits")!;
  assert.equal(f.status, "user-corrected");

  // Agent agrees WITHOUT checkable evidence -> import refuses, store untouched
  writeFileSync(exported.resultFile, JSON.stringify({
    mapperId: job.mapperId, fingerprint: job.fingerprint, field: job.field,
    verdict: { agree: true, evidence: "the user is clearly right",
      pipeline: [{ kind: "read", sourceField: "x", summary: "." }] },
  }));
  const invalid = importJudgeResult(exported.resultFile);
  assert.equal(invalid.outcome, "invalid", "offline import enforces citation check too");
  const still = getVerified(job.mapperId, job.fingerprint)!;
  assert.equal(
    still.fields.find((x) => x.targetField === "trackingDigits")!.pipeline.length, 3,
    "bogus verdict did not overwrite the good correction");
});
