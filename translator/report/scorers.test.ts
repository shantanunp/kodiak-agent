import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreLabeling } from "./scorers.js";
import type { LabelTasks } from "../agentloop/tasks.js";

function tasksStub(fields: string[]): LabelTasks {
  return {
    report: {
      sourceFile: "M.java",
      targetClass: "Out",
      declaredFields: fields.length,
      mapped: fields.length,
      unmapped: 0,
      unresolved: 0,
      gatePassed: true,
      checklist: fields.map((field) => ({
        field,
        state: "mapped" as const,
        writes: [{ line: 10, via: "setter" as const, inMethod: "map" }],
      })),
      orphanWrites: [],
    },
    tasks: fields.map((field) => ({
      field,
      state: "mapped" as const,
      slices: [
        {
          targetField: field,
          via: "setter" as const,
          receiver: "o",
          expression: "x",
          inMethod: "map",
          line: 10,
          statement: `o.setX(x)`,
          helperClosure: [],
          sliceText: `line 10: o.setX(src.trim());`,
        },
      ],
      sliceText: `line 10: o.setX(src.trim());`,
    })),
    mapperClass: "M",
    targetClass: "Out",
    checklistSource: "target-type",
    diagnostics: [],
  };
}

test("scoreLabeling: full coverage + grounded read/transform", () => {
  const tasks = tasksStub(["name"]);
  const scores = scoreLabeling({
    tasks,
    mapping: [
      {
        targetField: "name",
        pipeline: [
          { kind: "READ", sourceField: "src" },
          { kind: "TRANSFORM", meta: { op: "trim" } },
        ],
      },
    ],
  });
  assert.equal(scores.coverage, 1);
  assert.ok(scores.grounding >= 0.5);
  assert.equal(scores.specificity, 1);
  assert.equal(scores.provenance, 1);
  assert.equal(scores.rawSteps, 0);
});

test("scoreLabeling: RAW lowers specificity", () => {
  const tasks = tasksStub(["a", "b"]);
  const scores = scoreLabeling({
    tasks,
    mapping: [
      {
        targetField: "a",
        pipeline: [{ kind: "RAW", meta: { code: "x" } }],
      },
    ],
  });
  assert.equal(scores.coverage, 0.5);
  assert.equal(scores.specificity, 0);
  assert.equal(scores.rawSteps, 1);
});
