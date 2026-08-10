import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFieldMappingResponse,
  controlFlowHeadersFromSlice,
  mergeControlFlowFilters,
  normalizeKeepDigitsOp,
} from "./applyResponse.js";
import type { FieldMapping } from "../groupMapping.js";
import type { PipelineStep } from "./labeler.js";

describe("normalizeKeepDigitsOp", () => {
  it("normalizes invented digit-filter op names", () => {
    const out = normalizeKeepDigitsOp([
      { kind: "transform", op: "keepDigitsAndHyphen" },
      { kind: "transform", op: "trim" },
    ]);
    assert.equal(out[0]?.op, "keepdigits");
    assert.equal(out[1]?.op, "trim");
  });
});

describe("applyFieldMappingResponse", () => {
  it("keeps the model pipeline as-is (no lettersOnly repair)", () => {
    const entry: FieldMapping = {
      targetField: "regionCode",
      pipeline: [
        {
          kind: "RAW",
          meta: {
            code: "sanitizeAlpha(region.trim()); return toUpperToken(keepDigits(token));",
          },
        },
      ],
    };
    const labeled = applyFieldMappingResponse(entry, {
      recognized: true,
      targetField: "DeliveryPayload.shipTo.regionCode",
      reason: "trim → keepDigits → uppercase; sanitizeAlpha wraps keepDigits",
      pipeline: [
        { kind: "read", sourceField: "address.region", summary: "Reads region." },
        { kind: "transform", op: "trim", summary: "Trims whitespace." },
        { kind: "transform", op: "keepdigits", summary: "keepDigits keeps digits." },
        { kind: "transform", op: "uppercase", summary: "Uppercases." },
      ],
    });
    assert.deepEqual(
      labeled.pipeline.map((s) =>
        s.kind === "TRANSFORM" ? String(s.meta?.op) : s.kind,
      ),
      ["READ", "trim", "keepdigits", "uppercase"],
    );
  });

  it("keeps per-step summary from the model response", () => {
    const entry: FieldMapping = {
      targetField: "postalCode",
      pipeline: [{ kind: "RAW", meta: { code: "setPostalCode(trimValue(p));" } }],
    };
    const labeled = applyFieldMappingResponse(entry, {
      recognized: true,
      targetField: "DeliveryPayload.shipTo.postalCode",
      reason: "postal pipeline",
      pipeline: [
        {
          kind: "read",
          sourceField: "address.postalCode",
          summary: "Reads address.postalCode from the source.",
        },
        {
          kind: "transform",
          op: "trim",
          summary: "trimValue removes leading and trailing whitespace.",
        },
      ],
    });
    assert.equal(
      labeled.pipeline[0]?.summary,
      "Reads address.postalCode from the source.",
    );
    assert.equal(
      labeled.pipeline[1]?.summary,
      "trimValue removes leading and trailing whitespace.",
    );
  });

  it("keeps model pipeline when targetField is omitted (falls back to entry)", () => {
    const entry: FieldMapping = {
      targetField: "priority",
      pipeline: [],
    };
    const labeled = applyFieldMappingResponse(entry, {
      recognized: true,
      reason: "conditional constant",
      pipeline: [
        { kind: "read", sourceField: "shipment.status", summary: "Reads status." },
        { kind: "constant", value: true, summary: "EXPRESS -> true." },
      ],
    });
    assert.equal(labeled.targetField, "priority");
    assert.equal(labeled.pipeline.length, 2);
    assert.equal(labeled.pipeline[0]?.kind, "READ");
    assert.equal(labeled.pipeline[1]?.kind, "CONSTANT");
  });

  it("injects FILTER from slice control-flow when the model omitted it", () => {
    const slice = [
      "// write site (line 69, in buildCustomer, via setter)",
      "// control flow:",
      'if("By".lastIndexOf("c") > 100)',
      "mapped.setEmail(customer.getEmail());",
    ].join("\n");
    const labeled = applyFieldMappingResponse(
      { targetField: "ORDER.DETAILS.CUSTOMER.Email", pipeline: [] },
      {
        recognized: true,
        targetField: "ORDER.DETAILS.CUSTOMER.Email",
        reason: "direct getter",
        pipeline: [
          {
            kind: "read",
            sourceField: "customer.email",
            summary: "Reads customer.email from the source.",
          },
        ],
      },
      "model",
      slice,
    );
    assert.deepEqual(
      labeled.pipeline.map((s) => s.kind),
      ["READ", "FILTER"],
    );
    assert.equal(labeled.pipeline[1]?.condition, '"By".lastIndexOf("c") > 100');
    assert.equal(labeled.pipeline[1]?.labelSource, "deterministic");
  });

  it("does not duplicate FILTER when the model already emitted one", () => {
    const slice = [
      "// control flow:",
      'if("By".lastIndexOf("c") > 100)',
      "mapped.setEmail(customer.getEmail());",
    ].join("\n");
    const labeled = applyFieldMappingResponse(
      { targetField: "Email", pipeline: [] },
      {
        recognized: true,
        targetField: "Email",
        pipeline: [
          { kind: "read", sourceField: "customer.email", summary: "Reads email." },
          {
            kind: "filter",
            condition: '"By".lastIndexOf("c") > 100',
            summary: "Guarded write.",
          },
        ],
      },
      "model",
      slice,
    );
    assert.equal(labeled.pipeline.filter((s) => s.kind === "FILTER").length, 1);
    assert.equal(labeled.pipeline[1]?.labelSource, "model");
  });
});

describe("controlFlowHeadersFromSlice / mergeControlFlowFilters", () => {
  it("parses headers and inserts after READ", () => {
    const headers = controlFlowHeadersFromSlice(
      "// control flow:\nif (a)\nif (b)\nx.setY(1);",
    );
    assert.deepEqual(headers, ["if (a)", "if (b)"]);
    const pipeline: PipelineStep[] = [
      { kind: "READ", sourceField: "x", labelSource: "model" },
      { kind: "TRANSFORM", meta: { op: "trim" }, labelSource: "model" },
    ];
    const merged = mergeControlFlowFilters(pipeline, "// control flow:\nif (a)\nx.setY(1);");
    assert.deepEqual(
      merged.map((s) => s.kind),
      ["READ", "FILTER", "TRANSFORM"],
    );
  });
});

