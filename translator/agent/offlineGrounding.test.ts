import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertOfflineImportGrounded,
  collectOfflineGroundingViolations,
  OFFLINE_LABEL_FIDELITY,
  ungroundedOfflineTransformOrConstant,
} from "./offlineGrounding.js";

const ORDER_NUMBER_SLICE = `// write site (line 64, in buildSummary, via setter)
summary.setOrderNumber(normalizeOrderNumber(input.getOrderNumber()));

// helper: normalizeOrderNumber
String normalizeOrderNumber(String raw) {
    if (raw == null) {
      return null;
    }
    String trimmed = stripEdges(raw);
    if (trimmed.isEmpty()) {
      return null;
    }

    boolean knownPrefix = false;
    for (int i = 0; i < LEGACY_ORDER_PREFIXES.length; i++) {
      String prefix = LEGACY_ORDER_PREFIXES[i];
      if (trimmed.regionMatches(true, 0, prefix, 0, prefix.length())) {
        knownPrefix = true;
        break;
      }
    }

    if (!knownPrefix && trimmed.length() < 3) {
      return null;
    }
    return trimmed;
  }

// helper: stripEdges
String stripEdges(String raw) {
    int start = 0;
    int end = raw.length();
    while (start < end && Character.isWhitespace(raw.charAt(start))) {
      start++;
    }
    while (end > start && Character.isWhitespace(raw.charAt(end - 1))) {
      end--;
    }
    return start == 0 && end == raw.length() ? raw : raw.substring(start, end);
  }`;

test("offline fidelity addendum mentions keepDigits and helper-body filters", () => {
  assert.match(OFFLINE_LABEL_FIDELITY, /keepDigits/);
  assert.match(OFFLINE_LABEL_FIDELITY, /helper-body guard/i);
  assert.match(OFFLINE_LABEL_FIDELITY, /stripEdges/);
});

test("invented keepDigits on OrderNumber-like slice is ungrounded", () => {
  const violations = ungroundedOfflineTransformOrConstant({
    field: "ORDER.DETAILS.SUMMARY.OrderNumber",
    sliceText: ORDER_NUMBER_SLICE,
    pipeline: [
      {
        kind: "read",
        sourceField: "orderNumber",
        summary: "Reads the raw order number.",
      },
      {
        kind: "transform",
        op: "trim",
        summary: "stripEdges trims leading and trailing whitespace.",
      },
      {
        kind: "filter",
        condition: "trimmed is not empty",
        summary: "Returns null if empty.",
      },
      {
        kind: "transform",
        op: "keepDigits",
        summary: "Invented digit filter.",
      },
    ],
  });
  assert.ok(
    violations.some((v) => v.detail.includes("keepDigits")),
    `expected keepDigits violation, got ${JSON.stringify(violations)}`,
  );
});

test("trim + helper-body filters (no keepDigits) pass grounding", () => {
  const violations = ungroundedOfflineTransformOrConstant({
    field: "ORDER.DETAILS.SUMMARY.OrderNumber",
    sliceText: ORDER_NUMBER_SLICE,
    pipeline: [
      {
        kind: "read",
        sourceField: "orderNumber",
        summary: "Reads orderNumber from the source input.",
      },
      {
        kind: "transform",
        op: "trim",
        summary: "stripEdges trims leading and trailing whitespace.",
      },
      {
        kind: "filter",
        condition: "trimmed is not empty",
        summary: "Returns null if the trimmed value is empty.",
      },
      {
        kind: "filter",
        condition: "trimmed length >= 3 or known prefix",
        summary:
          "Returns null if shorter than 3 characters and has no known legacy prefix.",
      },
    ],
  });
  assert.deepEqual(violations, []);
});

test("collectOfflineGroundingViolations skips fields without slice", () => {
  const violations = collectOfflineGroundingViolations([
    {
      javaTargetField: "ORDER.DETAILS.SUMMARY.OrderNumber",
      sliceText: undefined,
      response: {
        recognized: true,
        targetField: "ORDER.DETAILS.SUMMARY.OrderNumber",
        pipeline: [{ kind: "transform", op: "keepDigits", summary: "bad" }],
      },
    },
  ]);
  assert.deepEqual(violations, []);
});

test("assertOfflineImportGrounded rejects offline keepDigits", () => {
  assert.throws(
    () =>
      assertOfflineImportGrounded({
        labelModel: "agent:offline",
        fields: [
          {
            javaTargetField: "ORDER.DETAILS.SUMMARY.OrderNumber",
            sliceText: ORDER_NUMBER_SLICE,
            response: {
              recognized: true,
              targetField: "ORDER.DETAILS.SUMMARY.OrderNumber",
              pipeline: [
                { kind: "read", sourceField: "orderNumber", summary: "…" },
                { kind: "transform", op: "keepDigits", summary: "bad" },
              ],
            },
          },
        ],
      }),
    /ungrounded TRANSFORM\/CONSTANT/,
  );
});

test("assertOfflineImportGrounded no-op for online labelModel", () => {
  assert.doesNotThrow(() =>
    assertOfflineImportGrounded({
      labelModel: "gpt-4.1",
      fields: [
        {
          javaTargetField: "ORDER.DETAILS.SUMMARY.OrderNumber",
          sliceText: ORDER_NUMBER_SLICE,
          response: {
            recognized: true,
            targetField: "ORDER.DETAILS.SUMMARY.OrderNumber",
            pipeline: [{ kind: "transform", op: "keepDigits", summary: "bad" }],
          },
        },
      ],
    }),
  );
});

test("assertOfflineImportGrounded allowUngrounded escape hatch", () => {
  assert.doesNotThrow(() =>
    assertOfflineImportGrounded({
      labelModel: "agent:offline",
      allowUngrounded: true,
      fields: [
        {
          javaTargetField: "ORDER.DETAILS.SUMMARY.OrderNumber",
          sliceText: ORDER_NUMBER_SLICE,
          response: {
            recognized: true,
            targetField: "ORDER.DETAILS.SUMMARY.OrderNumber",
            pipeline: [{ kind: "transform", op: "keepDigits", summary: "bad" }],
          },
        },
      ],
    }),
  );
});
