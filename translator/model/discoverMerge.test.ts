import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverAndMerge } from "./discoverMerge.js";
import type { IndexAst } from "./labeler.js";
import type { ModelProvider } from "./provider.js";

describe("discoverAndMerge (AI-only)", () => {
  const ast: IndexAst = {
    mapperId: "t",
    className: "T",
    entryMethod: "map",
    operations: [],
  };

  it("emits AI hits as labeling groups with confidence 0.6", async () => {
    const provider = {
      model: "test",
      async discoverMappings() {
        return {
          mappings: [
            {
              javaTargetHint: "Customer.fullName",
              codeSnippet: "target.setFullName(source.getDisplayName());",
            },
          ],
        };
      },
      async labelFieldMapping() {
        return { recognized: false };
      },
      async labelStep() {
        return { recognized: false };
      },
    } as unknown as ModelProvider;

    const { groups, meta } = await discoverAndMerge(ast, "class T {}", provider, {
      noCache: true,
    });
    assert.equal(meta.aiTargets, 1);
    assert.equal(meta.mergedTargets, 1);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.targetField, "Customer.fullName");
    const op = groups[0]!.pipeline[0]!;
    assert.equal(op.meta?.discoverySource, "ai");
    assert.equal(op.meta?.confidence, 0.6);
  });

  it("returns empty groups when AI finds nothing", async () => {
    const provider = {
      model: "test",
      async discoverMappings() {
        return { mappings: [] };
      },
      async labelFieldMapping() {
        return { recognized: false };
      },
      async labelStep() {
        return { recognized: false };
      },
    } as unknown as ModelProvider;

    const { groups, meta } = await discoverAndMerge(ast, "class T {}", provider, {
      noCache: true,
    });
    assert.equal(groups.length, 0);
    assert.equal(meta.mergedTargets, 0);
    assert.equal(meta.aiTargets, 0);
  });
});
