import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLabelTasks } from "./tasks.js";
import { schemaFilePath } from "../../schema/io.js";

const MAPPER_ID = `schema-checklist-test-${Date.now()}`;

function writeTestSchema(targetChildren: unknown[]) {
  const file = schemaFilePath(MAPPER_ID);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      mapperId: MAPPER_ID,
      savedAt: new Date().toISOString(),
      source: {
        method: "manual",
        root: { id: "s", name: "In", type: "object", children: [] },
      },
      target: {
        method: "manual",
        root: {
          id: "t",
          name: "Out",
          type: "object",
          children: targetChildren,
        },
      },
    }),
  );
  return file;
}

test("saved schema becomes checklist universe (JAR-style mapper with getX().add)", () => {
  const schemaFile = writeTestSchema([
    { id: "1", name: "items", type: "array", itemType: "string", children: [] },
    { id: "2", name: "label", type: "string", children: [] },
  ]);

  try {
    const sourceJava = `
public class M {
  public Out map(String a) {
    Out o = new Out();
    o.getItems().add(a);
    return o;
  }
}
class Out {
  java.util.List<String> getItems() { return null; }
}
`;
    const tasks = buildLabelTasks({
      mapper: {
        id: MAPPER_ID,
        sourceFile: "M.java",
        class: "M",
        entryMethod: "map",
        sourceType: "In",
        targetType: "com.external.jar.Out",
      },
      sourceJava,
    });

    assert.equal(tasks.checklistSource, "schema");
    assert.deepEqual(
      tasks.tasks.map((t) => t.field).sort(),
      ["items[]", "label"].sort(),
    );
    const items = tasks.tasks.find((t) => t.field === "items[]");
    assert.equal(items?.state, "mapped", "getItems().add matches schema items[] by leaf");
    assert.ok(items?.sliceText.includes("getItems"));
    // Schema-only field with no write site stays labelable (unresolved, not hard-unmapped).
    assert.equal(tasks.tasks.find((t) => t.field === "label")?.state, "unresolved");
  } finally {
    if (existsSync(schemaFile)) unlinkSync(schemaFile);
  }
});

test("schema checklist works when analyzer finds zero Java declared fields", () => {
  const schemaFile = writeTestSchema([
    { id: "1", name: "code", type: "string", children: [] },
  ]);
  try {
    const wt = mkdtempSync(join(tmpdir(), "kodiak-schema-empty-"));
    const mapDir = join(wt, "src/main/java");
    mkdirSync(mapDir, { recursive: true });
    const mapperFile = join(mapDir, "EmptyMap.java");
    writeFileSync(
      mapperFile,
      `public class EmptyMap {
  public ExternalOut map(Object in) {
    return null;
  }
}`,
    );

    const tasks = buildLabelTasks({
      mapper: {
        id: MAPPER_ID,
        sourceFile: "src/main/java/EmptyMap.java",
        class: "EmptyMap",
        entryMethod: "map",
        sourceType: "Object",
        targetType: "com.external.ExternalOut",
      },
      sourceJava: readFileSync(mapperFile, "utf8"),
      worktree: wt,
    });

    assert.equal(tasks.checklistSource, "schema");
    assert.equal(tasks.tasks.length, 1);
    assert.equal(tasks.tasks[0]!.field, "code");
    assert.equal(tasks.tasks[0]!.state, "unresolved");
    rmSync(wt, { recursive: true, force: true });
  } finally {
    if (existsSync(schemaFile)) unlinkSync(schemaFile);
  }
});
