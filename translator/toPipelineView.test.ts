import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coerceViewParam,
  foldConditionalBranches,
  toPipelineView,
} from "./toPipelineView.js";
import type { PipelineJson } from "./model/index.js";
import type { ViewStep } from "./toPipelineView.js";

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

  it("unwraps quoted constant literals from verified-store meta.value", () => {
    const pipeline: PipelineJson = {
      mapperId: "test-mapper",
      sourceType: "com.acme.Source",
      targetType: "com.acme.Target",
      mapping: [
        {
          targetField: "platformIdentifier",
          pipeline: [
            {
              kind: "CONSTANT",
              meta: { value: '"Shopify"' },
              summary: "Sets platform to Shopify.",
            },
          ],
        },
      ],
    };
    const view = toPipelineView(pipeline);
    const c = view.fields?.[0]?.steps.find((s) => s.kind === "constant");
    assert.equal(c?.value, "Shopify");
  });

  it("nests filter→constant branches for if/else cascades", () => {
    const pipeline: PipelineJson = {
      mapperId: "test-mapper",
      sourceType: "com.acme.Source",
      targetType: "com.acme.Target",
      mapping: [
        {
          targetField: "deliveryNotes",
          pipeline: [
            { kind: "READ", sourceField: "payment.orderType" },
            { kind: "FILTER", condition: "equalsIgnoreCase Express" },
            { kind: "CONSTANT", meta: { value: "Priority handoff" } },
            { kind: "FILTER", condition: "equalsIgnoreCase Pickup" },
            { kind: "CONSTANT", meta: { value: "Hold at counter" } },
            { kind: "CONSTANT", meta: { value: "Standard porch delivery" } },
          ],
        },
      ],
    };

    const view = toPipelineView(pipeline);
    const steps = view.fields?.[0]?.steps ?? [];
    assert.equal(steps[0]?.kind, "read");
    assert.equal(steps[1]?.kind, "filter");
    assert.equal(steps[1]?.children?.[0]?.kind, "constant");
    assert.equal(steps[1]?.children?.[0]?.value, "Priority handoff");
    assert.equal(steps[2]?.kind, "filter");
    assert.equal(steps[2]?.children?.[0]?.value, "Hold at counter");
    assert.equal(steps[3]?.kind, "constant");
    assert.equal(steps[3]?.value, "Standard porch delivery");
  });
});

describe("foldConditionalBranches", () => {
  it("nests transforms under filter and leaves trailing constant as else", () => {
    const steps: ViewStep[] = [
      { kind: "filter", value: "not blank" },
      { kind: "transform", op: "Trim" },
      { kind: "constant", value: "fallback" },
      { kind: "write", target: "notes" },
    ];
    const folded = foldConditionalBranches(steps);
    assert.equal(folded.length, 3);
    assert.equal(folded[0]?.kind, "filter");
    assert.deepEqual(
      folded[0]?.children?.map((c) => c.kind),
      ["transform"],
    );
    assert.equal(folded[1]?.kind, "constant");
    assert.equal(folded[1]?.value, "fallback");
    assert.equal(folded[2]?.kind, "write");
  });
});
