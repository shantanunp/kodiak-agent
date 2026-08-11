import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kodiak-view-"));
process.env.KODIAK_VIEW_DIR = dir;

const {
  writePipelineView,
  patchPipelineViewField,
  pipelineViewFile,
  readPipelineView,
  viewHasField,
} = await import("./writePipelineView.js");

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readPipelineView / viewHasField", () => {
  it("reads dump and leaf-matches fields", () => {
    writePipelineView({
      mapperId: "read-demo",
      sourceType: "com.acme.Source",
      targetType: "com.acme.Target",
      mapping: [
        {
          targetField: "Order.platformIdentifier",
          pipeline: [{ kind: "CONSTANT", meta: { value: "X" } }],
        },
      ],
    });
    const view = readPipelineView("read-demo");
    assert.ok(view);
    assert.equal(view.mapperId, "read-demo");
    assert.equal(viewHasField("read-demo", "platformIdentifier"), true);
    assert.equal(viewHasField("read-demo", "Order.platformIdentifier"), true);
    assert.equal(viewHasField("read-demo", "missingField"), false);
    assert.equal(readPipelineView("no-such-mapper"), null);
    assert.equal(viewHasField("no-such-mapper", "x"), false);
  });
});

describe("patchPipelineViewField", () => {
  it("replaces a stale constant with the corrected literal in .view.json", () => {
    writePipelineView({
      mapperId: "patch-demo",
      sourceType: "com.acme.Source",
      targetType: "com.acme.Target",
      mapping: [
        {
          targetField: "Order.platformIdentifier",
          pipeline: [
            { kind: "CONSTANT", meta: { value: "PLATFORM_IDENTIFIER" } },
          ],
        },
        {
          targetField: "Order.schemaVersion",
          pipeline: [{ kind: "CONSTANT", meta: { value: "1.0" } }],
        },
      ],
    });

    patchPipelineViewField({
      mapperId: "patch-demo",
      targetField: "order.platformIdentifier",
      pipeline: [{ kind: "CONSTANT", meta: { value: '"Shopify"' } }],
    });

    const view = JSON.parse(readFileSync(pipelineViewFile("patch-demo"), "utf8"));
    const platform = view.fields.find((f: { targetField: string }) =>
      /platformIdentifier$/i.test(f.targetField),
    );
    const schema = view.fields.find((f: { targetField: string }) =>
      /schemaVersion$/i.test(f.targetField),
    );
    assert.equal(platform.steps[0].value, "Shopify");
    assert.equal(schema.steps[0].value, "1.0", "other fields preserved");
  });
});
