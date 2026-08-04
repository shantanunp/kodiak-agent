import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFieldMappingResponse,
  ensureLettersOnlyTransform,
  hasLettersOnlyEvidence,
} from "./applyResponse.js";
import type { FieldMapping } from "../groupMapping.js";

describe("ensureLettersOnlyTransform", () => {
  it("detects sanitizeAlpha evidence", () => {
    assert.equal(hasLettersOnlyEvidence("return sanitizeAlpha(region.trim());"), true);
    assert.equal(hasLettersOnlyEvidence("Character.isLetter(c)"), true);
    assert.equal(hasLettersOnlyEvidence("region.trim().toUpperCase()"), false);
  });

  it("inserts lettersOnly after trim when missing", () => {
    const out = ensureLettersOnlyTransform(
      [
        { kind: "read", sourceField: "property.region" },
        { kind: "transform", op: "trim" },
        { kind: "transform", op: "uppercase" },
      ],
      "sanitizeAlpha(region.trim())",
    );
    assert.deepEqual(
      out.map((o) => o.op ?? o.kind),
      ["read", "trim", "lettersonly", "uppercase"],
    );
  });

  it("does not duplicate lettersOnly", () => {
    const out = ensureLettersOnlyTransform(
      [
        { kind: "transform", op: "trim" },
        { kind: "transform", op: "lettersonly" },
        { kind: "transform", op: "uppercase" },
      ],
      "sanitizeAlpha",
    );
    assert.equal(out.filter((o) => o.op === "lettersonly").length, 1);
  });
});

describe("applyFieldMappingResponse", () => {
  it("repairs lettersOnly from reason text when model omits it", () => {
    const entry: FieldMapping = {
      targetField: "StateCode",
      pipeline: [{ kind: "RAW", meta: { code: "collateral.setStateCode(mapStateCode(p));" } }],
    };
    const labeled = applyFieldMappingResponse(entry, {
      recognized: true,
      targetField: "MESSAGE.DEAL.COLLATERAL.StateCode",
      reason: "reads region, trim, sanitizeAlpha keep letters, uppercase",
      pipeline: [
        { kind: "read", sourceField: "property.region" },
        { kind: "transform", op: "trim" },
        { kind: "transform", op: "uppercase" },
      ],
    });
    assert.deepEqual(
      labeled.pipeline.map((s) =>
        s.kind === "TRANSFORM" ? String(s.meta?.op) : s.kind,
      ),
      ["READ", "trim", "lettersonly", "uppercase"],
    );
  });
});
