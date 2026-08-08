import { test } from "node:test";
import assert from "node:assert/strict";
import { criticField } from "./critic.js";
import type { ModelProvider } from "../model/provider.js";

const SOURCE = `class M {
  Out map(String s) {
    Out o = new Out();
    o.setName(s.trim()); // line with trim
    return o;
  }
}
`;

test("critic drops claims without verifiable citations", async () => {
  const provider = {
    model: "fake",
    async generate() {
      return JSON.stringify({
        missingSteps: [
          {
            kind: "transform",
            detail: "trim",
            line: 9999,
            evidence: "line 9999: imaginary",
          },
        ],
      });
    },
    async labelFieldMapping() {
      return { recognized: false };
    },
    async discoverMappings() {
      return { hits: [] };
    },
    async labelStep() {
      return { summary: "" };
    },
  } as unknown as ModelProvider;

  const { findings, dropped } = await criticField({
    provider,
    field: "name",
    sliceText: SOURCE,
    sourceJava: SOURCE,
    mapping: {
      targetField: "name",
      pipeline: [{ kind: "READ", sourceField: "s" }],
    },
  });
  assert.equal(findings.length, 0);
  assert.ok(dropped.length >= 1);
});

test("critic keeps cited missing transform", async () => {
  const lines = SOURCE.split("\n");
  const trimLine = lines.findIndex((l) => l.includes("trim()")) + 1;
  const provider = {
    model: "fake",
    async generate() {
      return JSON.stringify({
        missingSteps: [
          {
            kind: "transform",
            detail: "trim missing",
            line: trimLine,
            evidence: `line ${trimLine}: o.setName(s.trim())`,
          },
        ],
      });
    },
    async labelFieldMapping() {
      return { recognized: false };
    },
    async discoverMappings() {
      return { hits: [] };
    },
    async labelStep() {
      return { summary: "" };
    },
  } as unknown as ModelProvider;

  const { findings } = await criticField({
    provider,
    field: "name",
    sliceText: SOURCE,
    sourceJava: SOURCE,
    mapping: {
      targetField: "name",
      pipeline: [{ kind: "READ", sourceField: "s" }],
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.kind, "transform");
});
