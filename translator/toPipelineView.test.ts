import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coerceViewParam, toPipelineView } from "./toPipelineView.js";
import type { PipelineJson } from "./model/index.js";

describe("coerceViewParam", () => {
  it("keeps whitespace delimiters as strings (Number(' ') is 0 in JS)", () => {
    assert.equal(coerceViewParam(" "), " ");
    assert.equal(coerceViewParam("\t"), "\t");
    assert.equal(coerceViewParam("\n"), "\n");
    assert.equal(coerceViewParam("  "), "  ");
    assert.equal(coerceViewParam(""), "");
  });

  it("coerces real numeric strings and numbers", () => {
    assert.equal(coerceViewParam("0"), 0);
    assert.equal(coerceViewParam("1000"), 1000);
    assert.equal(coerceViewParam(2), 2);
    assert.equal(coerceViewParam("3.14"), 3.14);
  });

  it("keeps non-numeric strings as strings", () => {
    assert.equal(coerceViewParam(","), ",");
    assert.equal(coerceViewParam("|"), "|");
    assert.equal(coerceViewParam("kg"), "kg");
  });

  it("handles nullish", () => {
    assert.equal(coerceViewParam(null), undefined);
    assert.equal(coerceViewParam(undefined), undefined);
  });
});

describe("toPipelineView transform param", () => {
  it("preserves split-by-space delimiter instead of collapsing to 0", () => {
    const pipeline: PipelineJson = {
      mapperId: "test-mapper",
      sourceType: "com.acme.Source",
      targetType: "com.acme.Target",
      mapping: [
        {
          targetField: "firstName",
          pipeline: [
            { kind: "READ", sourceField: "displayName" },
            {
              kind: "TRANSFORM",
              meta: { op: "split", value: " " },
              summary: "Split on space.",
            },
            { kind: "TRANSFORM", meta: { op: "takeFirst" } },
          ],
        },
      ],
    };

    const view = toPipelineView(pipeline);
    const split = view.fields?.[0]?.steps.find(
      (s) => s.kind === "transform" && s.op === "Split",
    );
    assert.ok(split);
    assert.equal(split!.param, " ");
  });

  it("still coerces numeric transform params", () => {
    const pipeline: PipelineJson = {
      mapperId: "test-mapper",
      sourceType: "com.acme.Source",
      targetType: "com.acme.Target",
      mapping: [
        {
          targetField: "weightGrams",
          pipeline: [
            { kind: "READ", sourceField: "weightKg" },
            {
              kind: "TRANSFORM",
              meta: { op: "multiply", value: "1000" },
            },
          ],
        },
      ],
    };

    const view = toPipelineView(pipeline);
    const mul = view.fields?.[0]?.steps.find(
      (s) => s.kind === "transform" && s.op === "Multiply",
    );
    assert.ok(mul);
    assert.equal(mul!.param, 1000);
  });
});
