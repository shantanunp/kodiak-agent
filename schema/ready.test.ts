import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isSchemaReadyForMapping, schemaFilePath } from "./io.js";

const ID = `ready-test-${Date.now()}`;

function writeDoc(sourceKids: unknown[], targetKids: unknown[]) {
  const file = schemaFilePath(ID);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      mapperId: ID,
      savedAt: new Date().toISOString(),
      source: {
        method: "manual",
        root: { id: "s", name: "In", type: "object", children: sourceKids },
      },
      target: {
        method: "manual",
        root: { id: "t", name: "Out", type: "object", children: targetKids },
      },
    }),
  );
  return file;
}

test("isSchemaReadyForMapping requires both sides", () => {
  const file = writeDoc(
    [{ id: "1", name: "a", type: "string", children: [] }],
    [],
  );
  try {
    assert.equal(isSchemaReadyForMapping(ID), false);
    writeDoc(
      [{ id: "1", name: "a", type: "string", children: [] }],
      [{ id: "2", name: "b", type: "string", children: [] }],
    );
    assert.equal(isSchemaReadyForMapping(ID), true);
    assert.equal(isSchemaReadyForMapping("no-such-mapper-xyz"), false);
  } finally {
    if (existsSync(file)) unlinkSync(file);
  }
});
