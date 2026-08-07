import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CACHE_DIR = mkdtempSync(join(tmpdir(), "kodiak-loop-cache-"));
process.env.MODEL_API_KEY = process.env.MODEL_API_KEY || "test-key-never-used";

const { buildLabelTasks } = await import("./tasks.js");
const { runAgentLoop } = await import("./loop.js");
import type { ModelProvider, FieldMappingRequest } from "../model/provider.js";

after(() => rmSync(process.env.CACHE_DIR!, { recursive: true, force: true }));

const mapperEntry = {
  id: "loop-test",
  sourceFile: "fixtures/ShipmentNoticeMapper.java",
  class: "com.kodiak.fixtures.ShipmentNoticeMapper",
  entryMethod: "map",
  sourceType: "com.kodiak.fixtures.ShipmentNoticeMapper$Shipment",
  targetType: "com.kodiak.fixtures.ShipmentNoticeMapper$DeliveryNotice",
};

const sourceJava = readFileSync("fixtures/ShipmentNoticeMapper.java", "utf8");

function scriptedProvider(): ModelProvider & { calls: FieldMappingRequest[] } {
  const calls: FieldMappingRequest[] = [];
  return {
    model: "fake-model",
    calls,
    async labelFieldMapping(req: FieldMappingRequest) {
      calls.push(req);
      const code = String((req.indexerOps[0] as any)?.meta?.code ?? "");
      // Escalation pass carries the full source; the agent "settles" stampedBy
      // but honestly declines remarks (never written).
      if (req.javaTargetField === "stampedBy" && code.includes("class ShipmentNoticeMapper")) {
        return {
          recognized: true,
          targetField: "Notice.stampedBy",
          pipeline: [{ kind: "constant", value: "AUDIT", summary: "Set by AuditStamper." }],
          reason: "written inside AuditStamper.stamp",
        };
      }
      if (req.javaTargetField === "remarks") {
        return { recognized: false, reason: "no write anywhere, including AuditStamper" };
      }
      return {
        recognized: true,
        targetField: `Notice.${req.javaTargetField}`,
        pipeline: [{ kind: "read", sourceField: "shipment.value", summary: "Reads." }],
        reason: "from slice",
      };
    },
    async discoverMappings() {
      throw new Error("agent loop must not call discovery");
    },
    async labelStep() {
      throw new Error("not used");
    },
  };
}

test("tasks: parser resolves simple names from FQCN and yields all three states", () => {
  const tasks = buildLabelTasks({ mapper: mapperEntry as any, sourceJava });
  assert.equal(tasks.mapperClass, "ShipmentNoticeMapper");
  assert.equal(tasks.targetClass, "DeliveryNotice");
  assert.equal(tasks.report.declaredFields, 10);
  assert.equal(tasks.tasks.filter((t) => t.state === "mapped").length, 8);
  assert.equal(tasks.tasks.filter((t) => t.state === "unresolved").length, 2);

  const tracking = tasks.tasks.find((t) => t.field === "trackingDigits")!;
  assert.ok(tracking.sliceText.includes("keepDigits"), "slice carries helper closure");
});

test("loop: slices feed mapped fields, escalation settles or honestly fails unresolved ones", async () => {
  const provider = scriptedProvider();
  const tasks = buildLabelTasks({ mapper: mapperEntry as any, sourceJava });

  const result = await runAgentLoop({ mapperId: "loop-test" }, tasks, provider, {
    fingerprint: "test-fp-1",
    sourceJava,
    noCache: false,
  });

  // 8 mapped-from-slice + stampedBy settled on escalation = 9 in mapping.
  assert.equal(result.mapping.length, 9);
  assert.equal(result.audit.unresolved, 1);
  assert.deepEqual(result.audit.unresolvedFields, ["remarks"]);
  assert.equal(result.audit.gatePassed, false, "gate must fail while a field is unresolved");
  assert.equal(result.audit.unmapped, 0);

  // The call for trackingDigits carried its slice (helpers included), not the whole file.
  const trackingCall = provider.calls.find((c) => c.javaTargetField === "trackingDigits")!;
  const code = String((trackingCall.indexerOps[0] as any).meta.code);
  assert.ok(code.includes("keepDigits") && !code.includes("class Shipment {"),
    "mapped fields get the focused slice, not the full source");

  // remarks got the escalation pass with full source, and more than one attempt.
  const remarksCalls = provider.calls.filter((c) => c.javaTargetField === "remarks");
  assert.ok(remarksCalls.length >= 2, "unresolved fields are retried");
  assert.ok(String((remarksCalls[0]!.indexerOps[0] as any).meta.code).includes("AuditStamper"));
});

test("loop: second run reuses the field cache — zero model calls for mapped fields", async () => {
  const provider = scriptedProvider();
  const tasks = buildLabelTasks({ mapper: mapperEntry as any, sourceJava });

  const result = await runAgentLoop({ mapperId: "loop-test" }, tasks, provider, {
    fingerprint: "test-fp-1",
    sourceJava,
    noCache: false,
  });

  assert.equal(result.fieldsFromCache, 9, "all previously labeled fields come from cache");
  const cachedFieldCalls = provider.calls.filter((c) => c.javaTargetField !== "remarks");
  assert.equal(cachedFieldCalls.length, 0, "no model calls for cached fields");
});

test("split files: target type resolved from its own file; var-receiver writes found", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-split-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(dtoDir, "Out.java"), `package com.acme.dto;
public class Out {
  private String name;
  private String note;
  public void setName(String v) { this.name = v; }
  public void setNote(String v) { this.note = v; }
}`);
  const mapperFile = join(mapDir, "M.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.Out;
public class M {
  public Out map(In in) {
    var out = new Out();
    out.setName(in.getName().trim());
    return out;
  }
}`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "split", sourceFile: mapperFile, class: "com.acme.mapper.M",
      entryMethod: "map", sourceType: "com.acme.dto.In", targetType: "com.acme.dto.Out",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });

  assert.equal(tasks.checklistSource, "target-type", "checklist from the DTO's own file");
  assert.ok(tasks.targetTypeFile?.endsWith("Out.java"));
  assert.equal(tasks.report.declaredFields, 2);
  assert.equal(tasks.tasks.find((t) => t.field === "name")?.state, "mapped", "var receiver detected");
  assert.equal(tasks.tasks.find((t) => t.field === "note")?.state, "unmapped");
  rmSync(wt, { recursive: true, force: true });
});

test("nested target: fields flattened to dotted paths, nested writes attributed", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-nested-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(dtoDir, "Envelope.java"), `package com.acme.dto;
public class Envelope {
  private com.acme.dto.Payload payload;
  private String traceId;
  public void setPayload(com.acme.dto.Payload v) { this.payload = v; }
  public void setTraceId(String v) { this.traceId = v; }
}`);
  writeFileSync(join(dtoDir, "Payload.java"), `package com.acme.dto;
public class Payload {
  private String versionTag;
  private String regionCode;
  public void setVersionTag(String v) { this.versionTag = v; }
  public void setRegionCode(String v) { this.regionCode = v; }
}`);
  const mapperFile = join(mapDir, "EnvMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.Envelope;
import com.acme.dto.Payload;
public class EnvMapper {
  public Envelope map(In in) {
    Envelope env = new Envelope();
    env.setTraceId(in.getTrace());
    env.setPayload(buildPayload(in));
    return env;
  }
  private Payload buildPayload(In in) {
    Payload p = new Payload();
    p.setVersionTag("6.1.00");
    p.setRegionCode(in.getRegion().toUpperCase());
    return p;
  }
}`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "nested", sourceFile: mapperFile, class: "com.acme.mapper.EnvMapper",
      entryMethod: "map", sourceType: "com.acme.dto.In", targetType: "com.acme.dto.Envelope",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });

  const names = tasks.tasks.map((t) => t.field).sort();
  assert.deepEqual(names, ["payload.regionCode", "payload.versionTag", "traceId"],
    "nested scalars flattened to dotted paths; container field itself not listed");
  assert.ok(tasks.tasks.every((t) => t.state === "mapped"),
    "writes inside buildPayload attributed to payload.* fields");
  const version = tasks.tasks.find((t) => t.field === "payload.versionTag")!;
  assert.ok(version.sliceText.includes('setVersionTag("6.1.00")'));
  rmSync(wt, { recursive: true, force: true });
});
