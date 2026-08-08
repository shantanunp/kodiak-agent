import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scanWriteSites, adapterFor } from "./scanWriteSites.js";
import { runAuditGate } from "./auditGate.js";

const FIXTURE = "fixtures/ShipmentNoticeMapper.java";

function analyze(source: string) {
  const { parsed, slices } = scanWriteSites({
    filePath: FIXTURE,
    language: "java",
    mapperClass: "ShipmentNoticeMapper",
    targetClass: "DeliveryNotice",
    source,
  });
  const declared = adapterFor("java").targetFields(parsed, "DeliveryNotice");
  const report = runAuditGate({
    parsed,
    source,
    targetClass: "DeliveryNotice",
    declaredFields: declared,
    writeSites: slices,
  });
  return { report, slices };
}

test("finds every write site and accounts for every declared field", () => {
  const source = readFileSync(FIXTURE, "utf8");
  const { report } = analyze(source);

  assert.equal(report.declaredFields, 10);
  assert.equal(report.mapped, 8);
  assert.equal(report.unresolved, 2, "opaque escape must taint unaccounted fields");
  assert.equal(report.gatePassed, false, "gate must not pass with unresolved fields");

  const priority = report.checklist.find((c) => c.field === "priority");
  assert.equal(priority?.writes.length, 2, "both conditional branches recorded");

  const internal = report.checklist.find((c) => c.field === "internalFlag");
  assert.equal(internal?.writes[0]?.via, "assignment");
});

test("gate passes once the opaque escape is gone; missing fields become explicit unmapped", () => {
  const source = readFileSync(FIXTURE, "utf8").replace("AuditStamper.stamp(notice);", "");
  const { report } = analyze(source);

  assert.equal(report.unresolved, 0);
  assert.equal(report.unmapped, 2, "remarks + stampedBy are explicit unmapped, not silent");
  assert.equal(report.gatePassed, true);
});

test("slices carry transitive helper closure and local dataflow", () => {
  const source = readFileSync(FIXTURE, "utf8");
  const { slices } = analyze(source);

  const tracking = slices.find((s) => s.targetField === "trackingDigits");
  const helpers = tracking?.helperClosure.map((h) => h.name) ?? [];
  assert.ok(helpers.includes("sanitizeRef"));
  assert.ok(helpers.includes("keepDigits"), "misleadingly named helper's real body included");
  assert.ok(helpers.includes("trimValue"));

  const first = slices.find((s) => s.targetField === "recipientFirst");
  assert.ok(first?.sliceText.includes("splitName(shipment.getCustomerName())"),
    "local dataflow statement included");
  assert.ok(first?.helperClosure.some((h) => h.name === "splitName"));
});

test("conditional writes include enclosing if/else guards in the slice", () => {
  const source = readFileSync(FIXTURE, "utf8");
  const { slices } = analyze(source);
  const priority = slices.filter((s) => s.targetField === "priority");
  assert.equal(priority.length, 2);
  for (const s of priority) {
    assert.ok(
      s.sliceText.includes("control flow:") && s.sliceText.includes("EXPRESS"),
      `priority slice must carry the if-predicate, got:\n${s.sliceText}`,
    );
  }
  assert.ok(
    priority.some((s) => s.sliceText.includes("setPriority(true)") && s.sliceText.includes("if (")),
  );
  assert.ok(
    priority.some((s) => s.sliceText.includes("setPriority(false)") && /\belse\b/.test(s.sliceText)),
  );
  const elseSlice = priority.find((s) => s.sliceText.includes("setPriority(false)"))!;
  assert.ok(
    elseSlice.sliceText.includes("{ … } else") || elseSlice.sliceText.includes("{ ... } else"),
    `else branch must render if+else as one header, got:\n${elseSlice.sliceText}`,
  );
  assert.ok(
    !/if \(.*\)\nelse\n/.test(elseSlice.sliceText),
    "must not emit broken two-line if\\nelse control flow",
  );
});

