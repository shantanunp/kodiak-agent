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

  const first = tasks.tasks.find((t) => t.field === "recipientFirst")!;
  const trim = (first.sharedHelpers ?? []).find((h) => h.name === "trimValue");
  assert.ok(trim, "recipientFirst must flag shared trimValue");
  assert.ok(trim!.fields.includes("recipientLast"));
  assert.ok(trim!.fields.includes("trackingDigits"));
  assert.equal(
    (first.sharedHelpers ?? []).find((h) => h.name === "map"),
    undefined,
    "entry method is not a shared helper",
  );
});

test("loop: slices feed mapped fields, escalation settles or honestly fails unresolved ones", async () => {
  const provider = scriptedProvider();
  const tasks = buildLabelTasks({ mapper: mapperEntry as any, sourceJava });

  const result = await runAgentLoop({ mapperId: "loop-test" }, tasks, provider, {
    fingerprint: "test-fp-1",
    sourceJava,
    noCache: false,
    skipCrossCheck: true,
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
    skipCrossCheck: true,
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

test("nested leaf collision: dotted checklist fields keep non-empty helper slices", async () => {
  // Reproduces OrderRequestMapper: `new Outer.Inner()` registers receiver `mapped`,
  // so a later `Customer mapped = …; mapped.setFirstName(…)` is also scanned as a
  // top-level leaf. Nested expansion used to skip the path-prefixed site as a
  // duplicate, leaving order…firstName mapped but sliceText empty (judge blind).
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-leaf-collide-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(dtoDir, "Envelope.java"), `package com.acme.dto;
public class Envelope {
  private Customer customer;
  private Address address;
  public void setCustomer(Customer v) { this.customer = v; }
  public void setAddress(Address v) { this.address = v; }
  public static class Customer {
    private String firstName;
    private String lastName;
    public void setFirstName(String v) { this.firstName = v; }
    public void setLastName(String v) { this.lastName = v; }
  }
  public static class Address {
    private String street;
    public void setStreet(String v) { this.street = v; }
  }
}`);
  const mapperFile = join(mapDir, "EnvMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.Envelope;
import com.acme.dto.Envelope.Customer;
import com.acme.dto.Envelope.Address;
public class EnvMapper {
  public Envelope map(In in) {
    Envelope env = new Envelope();
    env.setCustomer(buildCustomer(in));
    env.setAddress(buildAddress(in));
    return env;
  }
  private Customer buildCustomer(In in) {
    Customer mapped = new Customer();
    String[] parts = splitName(in.getDisplayName());
    mapped.setFirstName(parts[0]);
    mapped.setLastName(parts[1]);
    return mapped;
  }
  private Address buildAddress(In in) {
    // Same local name "mapped" + Outer.Inner ctor — collides with Customer receiver.
    Address mapped = new Envelope.Address();
    mapped.setStreet(in.getStreet());
    return mapped;
  }
  private String[] splitName(String displayName) {
    String trimmed = displayName.trim();
    int space = trimmed.indexOf(' ');
    return new String[] { trimmed.substring(0, space), trimmed.substring(space + 1).trim() };
  }
}`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "leaf-collide", sourceFile: mapperFile, class: "com.acme.mapper.EnvMapper",
      entryMethod: "map", sourceType: "com.acme.dto.In", targetType: "com.acme.dto.Envelope",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });

  const first = tasks.tasks.find((t) => t.field === "customer.firstName");
  const last = tasks.tasks.find((t) => t.field === "customer.lastName");
  assert.ok(first, `expected customer.firstName, got ${tasks.tasks.map((t) => t.field)}`);
  assert.ok(last, "expected customer.lastName");
  assert.equal(first!.state, "mapped");
  assert.ok(first!.sliceText.length > 0, "firstName must have a non-empty slice for the judge");
  assert.ok(first!.sliceText.includes("setFirstName"), "slice carries the write site");
  assert.ok(first!.sliceText.includes("splitName"), "slice keeps helper closure after path upgrade");
  assert.ok(last!.sliceText.includes("setLastName"));
  assert.ok(last!.sliceText.includes(".trim()"), "lastName helper body visible in slice");
  rmSync(wt, { recursive: true, force: true });
});

test("nested field slices keep helper closure (not write-site-only)", async () => {
  // OrderNumber-style: nested DTO leaf written via normalizeX(helper) — offline/online
  // labelers must see the helper body in sliceText, not just setOrderNumber(...).
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-nested-helpers-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(dtoDir, "OrderMappedResponse.java"), `package com.acme.dto;
public class OrderMappedResponse {
  private Details details;
  public void setDetails(Details v) { this.details = v; }
  public static class Details {
    private Summary summary;
    public void setSummary(Summary v) { this.summary = v; }
  }
  public static class Summary {
    private String orderNumber;
    public void setOrderNumber(String v) { this.orderNumber = v; }
  }
}`);
  const mapperFile = join(mapDir, "OrderRequestMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.OrderMappedResponse;
import com.acme.dto.OrderMappedResponse.Details;
import com.acme.dto.OrderMappedResponse.Summary;
public class OrderRequestMapper {
  public OrderMappedResponse map(In in) {
    OrderMappedResponse out = new OrderMappedResponse();
    Details details = new Details();
    details.setSummary(buildSummary(in));
    out.setDetails(details);
    return out;
  }
  private Summary buildSummary(In in) {
    Summary summary = new Summary();
    summary.setOrderNumber(normalizeOrderNumber(in.getOrderNumber()));
    return summary;
  }
  private String normalizeOrderNumber(String raw) {
    if (raw == null) return null;
    String trimmed = stripEdges(raw);
    if (trimmed.isEmpty()) return null;
    if (!trimmed.startsWith("ORD-") && trimmed.length() < 3) return null;
    return trimmed;
  }
  private String stripEdges(String raw) {
    return raw.trim();
  }
}
class In { String getOrderNumber() { return null; } }
`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "nested-helpers",
      sourceFile: mapperFile,
      class: "com.acme.mapper.OrderRequestMapper",
      entryMethod: "map",
      sourceType: "com.acme.dto.In",
      targetType: "com.acme.dto.OrderMappedResponse",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });

  const order = tasks.tasks.find((t) =>
    t.field.toLowerCase().endsWith("ordernumber") ||
    t.field.toLowerCase().includes("summary.ordernumber"),
  );
  assert.ok(order, `expected …OrderNumber, got ${tasks.tasks.map((t) => t.field)}`);
  assert.equal(order!.state, "mapped");
  assert.ok(
    order!.sliceText.includes("normalizeOrderNumber"),
    `slice must name the helper, got:\n${order!.sliceText}`,
  );
  assert.ok(
    order!.sliceText.includes("stripEdges") || order!.sliceText.includes(".trim()"),
    `slice must carry helper body (stripEdges/trim), got:\n${order!.sliceText}`,
  );
  assert.ok(
    order!.slices.some((s) => s.helperClosure.some((h) => h.name === "normalizeOrderNumber")),
    "helperClosure must list normalizeOrderNumber",
  );
  rmSync(wt, { recursive: true, force: true });
});

test("same-file nested classes flatten without a separate .java per type", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-inner-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  // Real-world shape: Envelope/Order are static nested classes in one file — no Envelope.java.
  writeFileSync(join(dtoDir, "ShipmentResponse.java"), `package com.acme.dto;
public class ShipmentResponse {
  private Envelope envelope;
  public void setEnvelope(Envelope v) { this.envelope = v; }

  public static class Envelope {
    private String dataVersionIdentifier;
    private Order order;
    public void setDataVersionIdentifier(String v) { this.dataVersionIdentifier = v; }
    public void setOrder(Order v) { this.order = v; }
  }
  public static class Order {
    private String orderId;
    public void setOrderId(String v) { this.orderId = v; }
  }
}`);
  const mapperFile = join(mapDir, "ShipmentMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.ShipmentResponse;
public class ShipmentMapper {
  public ShipmentResponse map(In in) {
    ShipmentResponse out = new ShipmentResponse();
    ShipmentResponse.Envelope env = new ShipmentResponse.Envelope();
    env.setDataVersionIdentifier("6.1.00");
    ShipmentResponse.Order order = new ShipmentResponse.Order();
    order.setOrderId(in.getId());
    env.setOrder(order);
    out.setEnvelope(env);
    return out;
  }
}`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "inner", sourceFile: mapperFile, class: "com.acme.mapper.ShipmentMapper",
      entryMethod: "map", sourceType: "com.acme.dto.In",
      targetType: "com.acme.dto.ShipmentResponse",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });

  const names = tasks.tasks.map((t) => t.field).sort();
  assert.deepEqual(
    names,
    ["envelope.dataVersionIdentifier", "envelope.order.orderId"],
    "same-file nested Envelope/Order must flatten; bare 'envelope' must not remain a leaf",
  );
  assert.ok(
    !tasks.diagnostics.some((d) => d.includes("no .java file")),
    `should not fall back to leaf for nested classes, got: ${tasks.diagnostics.join("; ")}`,
  );
  rmSync(wt, { recursive: true, force: true });
});

test("collections: List<Element> flattened to path[].field, element writes attributed", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-coll-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(dtoDir, "Order.java"), `package com.acme.dto;
import java.util.List;
public class Order {
  private String orderId;
  private List<com.acme.dto.Contact> contacts;
  private List<String> tags;
  public void setOrderId(String v) { this.orderId = v; }
  public void setContacts(List<com.acme.dto.Contact> v) { this.contacts = v; }
  public void setTags(List<String> v) { this.tags = v; }
}`);
  writeFileSync(join(dtoDir, "Contact.java"), `package com.acme.dto;
public class Contact {
  private String contactName;
  private String roleCode;
  public void setContactName(String v) { this.contactName = v; }
  public void setRoleCode(String v) { this.roleCode = v; }
}`);
  const mapperFile = join(mapDir, "OrderMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.Order;
import com.acme.dto.Contact;
public class OrderMapper {
  public Order map(In in) {
    Order order = new Order();
    order.setOrderId(in.getId());
    order.setContacts(java.util.List.of(buildContact(in)));
    return order;
  }
  private Contact buildContact(In in) {
    Contact contact = new Contact();
    contact.setContactName(in.getName().trim());
    contact.setRoleCode("CUSTOMER");
    return contact;
  }
}`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "coll", sourceFile: mapperFile, class: "com.acme.mapper.OrderMapper",
      entryMethod: "map", sourceType: "com.acme.dto.In", targetType: "com.acme.dto.Order",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });

  const names = tasks.tasks.map((t) => t.field).sort();
  assert.deepEqual(names, ["contacts[].contactName", "contacts[].roleCode", "orderId", "tags"],
    "project-class element expanded under path[]; scalar-element list stays a leaf");
  const role = tasks.tasks.find((t) => t.field === "contacts[].roleCode")!;
  assert.equal(role.state, "mapped", "writes inside buildContact attributed to contacts[].*");
  assert.ok(role.sliceText.includes('setRoleCode("CUSTOMER")'));
  rmSync(wt, { recursive: true, force: true });
});

test("worktree inference: nested expansion works with no explicit worktree passed", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { inferWorktree } = await import("../../analyzer/resolveType.js");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-infer-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(dtoDir, "Wrap.java"), `package com.acme.dto;
public class Wrap {
  private com.acme.dto.Inner inner;
  public void setInner(com.acme.dto.Inner v) { this.inner = v; }
}`);
  writeFileSync(join(dtoDir, "Inner.java"), `package com.acme.dto;
public class Inner {
  private String code;
  public String getCode() { return code; }
}`);
  const rel = "src/main/java/com/acme/mapper/WMapper.java";
  const mapperFile = join(mapDir, "WMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.Wrap;
public class WMapper {
  public Wrap map(In in) { Wrap w = new Wrap(); return w; }
}`);

  const inferred = inferWorktree(mapperFile, rel);
  assert.equal(inferred, wt, "root derived from sourcePath minus registry sourceFile");

  const tasks = buildLabelTasks({
    mapper: {
      id: "infer", sourceFile: rel, class: "com.acme.mapper.WMapper",
      entryMethod: "map", sourceType: "com.acme.dto.In", targetType: "com.acme.dto.Wrap",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: inferred!,
  });
  assert.deepEqual(tasks.tasks.map((t) => t.field), ["inner.code"],
    "getter-only Inner class still yields its field; nested expansion via inferred worktree");
  assert.equal(tasks.tasks[0]!.state, "unmapped");
  rmSync(wt, { recursive: true, force: true });
});

test("diagnostics: missing worktree and unresolvable types are named, not silent", () => {
  const src = readFileSync("fixtures/ShipmentNoticeMapper.java", "utf8");
  const noWt = buildLabelTasks({
    mapper: {
      id: "d1", sourceFile: "x/M.java", class: "M",
      entryMethod: "map", sourceType: "In",
      targetType: "com.missing.Elsewhere",
    } as any,
    sourceJava: "public class M { public void map(In i) { Elsewhere e = new Elsewhere(); e.setCode(i.getC()); } }",
  });
  assert.equal(noWt.checklistSource, "write-sites");
  assert.ok(noWt.diagnostics.some((d) => d.includes("no worktree available")),
    "missing worktree is called out");
  void src;
});

test("cross-file closure: static util and superclass helpers inlined into slices", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-xfile-"));
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  const utilDir = join(wt, "src/main/java/com/acme/util");
  mkdirSync(mapDir, { recursive: true });
  mkdirSync(utilDir, { recursive: true });
  writeFileSync(join(utilDir, "TextUtils.java"), `package com.acme.util;
public class TextUtils {
  public static String squeeze(String v) { return v.replaceAll("\\\\s+", ""); }
}`);
  writeFileSync(join(mapDir, "BaseMapper.java"), `package com.acme.mapper;
public abstract class BaseMapper {
  protected String pad(String v) { return v == null ? "" : v; }
}`);
  const mapperFile = join(mapDir, "XMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.util.TextUtils;
public class XMapper extends BaseMapper {
  public Out map(In in) {
    Out out = new Out();
    out.setCode(TextUtils.squeeze(pad(in.getRaw())));
    return out;
  }
}
class Out { private String code; public void setCode(String v){this.code=v;} }`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "xfile", sourceFile: "src/main/java/com/acme/mapper/XMapper.java",
      class: "com.acme.mapper.XMapper", entryMethod: "map",
      sourceType: "In", targetType: "Out",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });

  const code = tasks.tasks.find((t) => t.field === "code")!;
  assert.ok(code.sliceText.includes("TextUtils.squeeze"), "qualified call named");
  assert.ok(code.sliceText.includes('replaceAll'), "static util BODY inlined cross-file");
  assert.ok(code.sliceText.includes("v == null"), "superclass helper body inlined");
  rmSync(wt, { recursive: true, force: true });
});

test("multi-instance: same nested type feeding two parent fields attributed by receiver/helper", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-multi-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(dtoDir, "Record.java"), `package com.acme.dto;
public class Record {
  private com.acme.dto.Contact primary;
  private com.acme.dto.Contact secondary;
  public void setPrimary(com.acme.dto.Contact v) { this.primary = v; }
  public void setSecondary(com.acme.dto.Contact v) { this.secondary = v; }
}`);
  writeFileSync(join(dtoDir, "Contact.java"), `package com.acme.dto;
public class Contact {
  private String email;
  public void setEmail(String v) { this.email = v; }
}`);
  const mapperFile = join(mapDir, "RMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.Record;
import com.acme.dto.Contact;
public class RMapper {
  public Record map(In in) {
    Record r = new Record();
    Contact c1 = new Contact();
    c1.setEmail(in.getMainEmail().toLowerCase());
    r.setPrimary(c1);
    r.setSecondary(buildBackup(in));
    return r;
  }
  private Contact buildBackup(In in) {
    Contact c2 = new Contact();
    c2.setEmail(in.getAltEmail().trim());
    return c2;
  }
}`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "multi", sourceFile: "src/main/java/com/acme/mapper/RMapper.java",
      class: "com.acme.mapper.RMapper", entryMethod: "map",
      sourceType: "In", targetType: "com.acme.dto.Record",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });

  const names = tasks.tasks.map((t) => t.field).sort();
  assert.deepEqual(names, ["primary.email", "secondary.email"],
    "same type expands under BOTH parent prefixes");
  const primary = tasks.tasks.find((t) => t.field === "primary.email")!;
  const secondary = tasks.tasks.find((t) => t.field === "secondary.email")!;
  assert.ok(primary.sliceText.includes("toLowerCase") && !primary.sliceText.includes("trim()"),
    "var-routed write (c1 -> setPrimary) attributed to primary only");
  assert.ok(secondary.sliceText.includes("trim()") && !secondary.sliceText.includes("toLowerCase"),
    "helper-routed write (buildBackup -> setSecondary) attributed to secondary only");
  rmSync(wt, { recursive: true, force: true });
});

test("multi-instance: builder .x(var) parent inject + nested builder write", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-multi-b-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(dtoDir, "Record.java"), `package com.acme.dto;
public class Record {
  private com.acme.dto.Contact primary;
  private com.acme.dto.Contact secondary;
  public static Builder builder() { return new Builder(); }
  public static class Builder {
    private final Record r = new Record();
    public Builder primary(com.acme.dto.Contact v) { r.primary = v; return this; }
    public Builder secondary(com.acme.dto.Contact v) { r.secondary = v; return this; }
    public Record build() { return r; }
  }
}`);
  writeFileSync(join(dtoDir, "Contact.java"), `package com.acme.dto;
public class Contact {
  private String email;
  public void setEmail(String v) { this.email = v; }
  public static Builder builder() { return new Builder(); }
  public static class Builder {
    private final Contact c = new Contact();
    public Builder email(String v) { c.email = v; return this; }
    public Contact build() { return c; }
  }
}`);
  const mapperFile = join(mapDir, "RMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.Record;
import com.acme.dto.Contact;
public class RMapper {
  public Record map(In in) {
    Contact c1 = Contact.builder()
      .email(in.getMainEmail().toLowerCase())
      .build();
    return Record.builder()
      .primary(c1)
      .secondary(buildBackup(in))
      .build();
  }
  private Contact buildBackup(In in) {
    Contact c2 = new Contact();
    c2.setEmail(in.getAltEmail().trim());
    return c2;
  }
}`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "multi-b", sourceFile: "src/main/java/com/acme/mapper/RMapper.java",
      class: "com.acme.mapper.RMapper", entryMethod: "map",
      sourceType: "In", targetType: "com.acme.dto.Record",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });
  const primary = tasks.tasks.find((t) => t.field === "primary.email")!;
  const secondary = tasks.tasks.find((t) => t.field === "secondary.email")!;
  assert.ok(primary && secondary, `fields=${tasks.tasks.map((t) => t.field)}`);
  assert.ok(primary.sliceText.includes("toLowerCase") && !primary.sliceText.includes("trim()"),
    "builder-bound nested write attributed to primary");
  assert.ok(secondary.sliceText.includes("trim()") && !secondary.sliceText.includes("toLowerCase"),
    "helper-routed write attributed to secondary");
  assert.ok(!(tasks.diagnostics ?? []).some((d) => d.includes("could not be attributed")),
    "no unattributed taint diagnostic");
  rmSync(wt, { recursive: true, force: true });
});

test("multi-instance: reassigned variable tracks lifetime segments", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const wt = mkdtempSync(join(tmpdir(), "kodiak-multi-r-"));
  const dtoDir = join(wt, "src/main/java/com/acme/dto");
  const mapDir = join(wt, "src/main/java/com/acme/mapper");
  mkdirSync(dtoDir, { recursive: true });
  mkdirSync(mapDir, { recursive: true });
  writeFileSync(join(dtoDir, "Record.java"), `package com.acme.dto;
public class Record {
  private com.acme.dto.Contact primary;
  private com.acme.dto.Contact secondary;
  public void setPrimary(com.acme.dto.Contact v) { this.primary = v; }
  public void setSecondary(com.acme.dto.Contact v) { this.secondary = v; }
}`);
  writeFileSync(join(dtoDir, "Contact.java"), `package com.acme.dto;
public class Contact {
  private String email;
  public void setEmail(String v) { this.email = v; }
}`);
  const mapperFile = join(mapDir, "RMapper.java");
  writeFileSync(mapperFile, `package com.acme.mapper;
import com.acme.dto.Record;
import com.acme.dto.Contact;
public class RMapper {
  public Record map(In in) {
    Record r = new Record();
    Contact c = new Contact();
    c.setEmail(in.getMainEmail().toLowerCase());
    r.setPrimary(c);
    c = new Contact();
    c.setEmail(in.getAltEmail().trim());
    r.setSecondary(c);
    return r;
  }
}`);

  const tasks = buildLabelTasks({
    mapper: {
      id: "multi-r", sourceFile: "src/main/java/com/acme/mapper/RMapper.java",
      class: "com.acme.mapper.RMapper", entryMethod: "map",
      sourceType: "In", targetType: "com.acme.dto.Record",
    } as any,
    sourceJava: readFileSync(mapperFile, "utf8"),
    worktree: wt,
  });
  const primary = tasks.tasks.find((t) => t.field === "primary.email")!;
  const secondary = tasks.tasks.find((t) => t.field === "secondary.email")!;
  assert.ok(primary.sliceText.includes("toLowerCase") && !primary.sliceText.includes("trim()"),
    "first lifetime of c → primary only");
  assert.ok(secondary.sliceText.includes("trim()") && !secondary.sliceText.includes("toLowerCase"),
    "reassigned lifetime of c → secondary only");
  rmSync(wt, { recursive: true, force: true });
});

test("loop: empty pipelines are not accepted as labels (mapped fields stay unlabeled)", async () => {
  const calls: string[] = [];
  const provider: ModelProvider = {
    model: "fake-model",
    async labelFieldMapping(req) {
      calls.push(req.javaTargetField);
      // Always "recognize" priority with an empty pipeline — must not land in mapping.
      if (req.javaTargetField === "priority") {
        return { recognized: true, targetField: "Notice.priority", pipeline: [], reason: "confused" };
      }
      return {
        recognized: true,
        targetField: `Notice.${req.javaTargetField}`,
        pipeline: [{ kind: "read", sourceField: "x", summary: "Reads." }],
        reason: "ok",
      };
    },
    async discoverMappings() { throw new Error("no"); },
    async labelStep() { throw new Error("no"); },
  };
  const tasks = buildLabelTasks({ mapper: mapperEntry as any, sourceJava });
  const result = await runAgentLoop({ mapperId: "loop-empty" }, tasks, provider, {
    fingerprint: "empty-pipe-fp",
    sourceJava,
    noCache: true,
    skipCrossCheck: true,
  });
  assert.ok(!result.mapping.some((m) => m.targetField === "priority" || m.targetField.endsWith(".priority")),
    "empty-pipeline priority must not appear in mapping");
  assert.ok(result.audit.unresolvedFields.includes("priority"),
    "mapped field with empty pipeline becomes unresolved");
  assert.ok(calls.filter((c) => c === "priority").length >= 2, "mapped empty-pipeline fields are retried with full source");
});

