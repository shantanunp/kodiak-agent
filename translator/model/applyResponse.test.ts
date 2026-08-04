import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFieldMappingResponse,
  normalizeKeepDigitsOp,
} from "./applyResponse.js";
import type { FieldMapping } from "../groupMapping.js";

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
      targetField: "StateCode",
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
      targetField: "Order.shipTo.regionCode",
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
      targetField: "PostalCode",
      pipeline: [{ kind: "RAW", meta: { code: "setPostalCode(trimPostal(p));" } }],
    };
    const labeled = applyFieldMappingResponse(entry, {
      recognized: true,
      targetField: "Order.shipTo.postalCode",
      reason: "postal pipeline",
      pipeline: [
        {
          kind: "read",
          sourceField: "address.postalCode",
          summary: "Reads property.postalCode from the source.",
        },
        {
          kind: "transform",
          op: "trim",
          summary: "trimPostal removes leading and trailing whitespace.",
        },
      ],
    });
    assert.equal(
      labeled.pipeline[0]?.summary,
      "Reads property.postalCode from the source.",
    );
    assert.equal(
      labeled.pipeline[1]?.summary,
      "trimPostal removes leading and trailing whitespace.",
    );
  });
});
