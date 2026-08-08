import { test } from "node:test";
import assert from "node:assert/strict";
import { findStepSmells } from "./smells.js";
import type { FieldTask } from "./tasks.js";

test("AGT-2: flags short pipeline against deep helper closure", () => {
  const task: FieldTask = {
    field: "trackingDigits",
    state: "mapped",
    slices: [
      {
        targetField: "trackingDigits",
        via: "setter",
        receiver: "n",
        expression: "sanitizeRef(x)",
        inMethod: "map",
        line: 1,
        statement: "n.setTrackingDigits(sanitizeRef(x));",
        helperClosure: [
          { name: "sanitizeRef", text: "..." },
          { name: "keepDigits", text: "..." },
          { name: "trimValue", text: "..." },
          { name: "normalize", text: "..." },
        ],
        sliceText: "…",
      },
    ],
    sliceText: "…",
  };
  const smells = findStepSmells(
    [
      {
        targetField: "trackingDigits",
        pipeline: [
          { kind: "READ", sourceField: "ref", labelSource: "model" },
          { kind: "WRITE", labelSource: "model" },
        ],
      },
    ],
    [task],
  );
  assert.equal(smells.length, 1);
  assert.match(smells[0]!.detail, /4 method/);
});

test("AGT-2: ignores fields with enough steps", () => {
  const task: FieldTask = {
    field: "x",
    state: "mapped",
    slices: [
      {
        targetField: "x",
        via: "setter",
        receiver: "n",
        expression: "h(x)",
        inMethod: "map",
        line: 1,
        statement: "n.setX(h(x));",
        helperClosure: [
          { name: "a", text: "" },
          { name: "b", text: "" },
          { name: "c", text: "" },
          { name: "d", text: "" },
        ],
        sliceText: "",
      },
    ],
    sliceText: "",
  };
  const smells = findStepSmells(
    [
      {
        targetField: "x",
        pipeline: [
          { kind: "READ", labelSource: "model" },
          { kind: "TRANSFORM", labelSource: "model" },
          { kind: "TRANSFORM", labelSource: "model" },
          { kind: "WRITE", labelSource: "model" },
        ],
      },
    ],
    [task],
  );
  assert.equal(smells.length, 0);
});
