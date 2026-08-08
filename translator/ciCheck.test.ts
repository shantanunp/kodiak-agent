import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mappersTouchedByDiff } from "./ciCheck.js";

test("mappersTouchedByDiff matches registry sourceFile paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "kodiak-ci-"));
  try {
    const reg = join(dir, "registry.yaml");
    writeFileSync(
      reg,
      `repo: a/b
branch: main
scope:
  - "**/*.java"
mappers:
  - id: order-request-mapper
    sourceFile: src/main/java/com/kodiakservice/mapper/OrderRequestMapper.java
    class: com.kodiakservice.mapper.OrderRequestMapper
    entryMethod: map
    sourceType: com.kodiakservice.dto.input.OrderRequest
    targetType: com.kodiakservice.dto.output.OrderMappedResponse
`,
    );
    const hit = mappersTouchedByDiff(reg, [
      "src/main/java/com/kodiakservice/mapper/OrderRequestMapper.java",
      "README.md",
    ]);
    assert.deepEqual(hit, ["order-request-mapper"]);
    const miss = mappersTouchedByDiff(reg, ["docs/note.md"]);
    assert.deepEqual(miss, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
