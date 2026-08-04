import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mergeAstAndAiDiscovery,
  mergeAstOnlyEscapeHatch,
  preferRicherCode,
  discoverAndMerge,
} from "./discoverMerge.js";
import type { IndexAst } from "./labeler.js";
import type { ModelProvider } from "./provider.js";
import type { FieldMapping } from "../groupMapping.js";
import type { DiscoverHit } from "./provider.js";

describe("preferRicherCode", () => {
  it("prefers helper body with trim over bare setter", () => {
    const short = "collateral.setAddressLineText(mapAddressLineViaOptional(property));";
    const rich =
      short +
      "\n\nprivate String mapAddressLineViaOptional(PropertyInfo property) {\n" +
      "  return Optional.ofNullable(property).map(PropertyInfo::getStreet).map(String::trim).orElse(null);\n}";
    assert.equal(preferRicherCode(rich, short), rich);
    assert.equal(preferRicherCode(short, rich), rich);
  });
});

describe("mergeAstAndAiDiscovery (AI-primary)", () => {
  const astGroups: FieldMapping[] = [
    {
      targetField: "LpaMappedResponse.Message.Deal.Collateral.addressLineText",
      pipeline: [
        {
          kind: "RAW",
          meta: {
            code:
              "collateral.setAddressLineText(mapAddressLineViaOptional(property));\n\n" +
              "private String mapAddressLineViaOptional(PropertyInfo property) {\n" +
              "  return Optional.ofNullable(property).map(PropertyInfo::getStreet).map(String::trim).orElse(null);\n}",
          },
        },
      ],
    },
    {
      targetField: "LpaMappedResponse.Message.Deal.Loan.noteAmount",
      pipeline: [{ kind: "READ", sourceField: "LoanApplicationRequest.mortgage.amount" }],
    },
  ];

  it("matches AI+AST → both, confidence 1, richer code with trim", () => {
    const aiHits: DiscoverHit[] = [
      {
        javaTargetHint: "setAddressLineText",
        codeSnippet: "collateral.setAddressLineText(mapAddressLineViaOptional(property));",
      },
    ];
    const { groups, meta } = mergeAstAndAiDiscovery(astGroups, aiHits);
    assert.equal(groups.length, 1);
    assert.equal(meta.both, 1);
    assert.equal(meta.aiOnly, 0);
    assert.equal(meta.astOnly, 1);
    const op = groups[0]!.pipeline[0]!;
    assert.equal(op.meta?.discoverySource, "both");
    assert.equal(op.meta?.confidence, 1);
    assert.match(String(op.meta?.code ?? ""), /String::trim/);
  });

  it("AI-only hit → ai, confidence 0.6, still a labeling candidate", () => {
    const aiHits: DiscoverHit[] = [
      {
        javaTargetHint: "Party.fullName",
        codeSnippet: 'party.setFullName(applicant.getDisplayName());',
      },
    ];
    const { groups, meta } = mergeAstAndAiDiscovery(astGroups, aiHits);
    assert.equal(groups.length, 1);
    assert.equal(meta.aiOnly, 1);
    assert.equal(meta.both, 0);
    assert.equal(meta.astOnly, 2);
    const op = groups[0]!.pipeline[0]!;
    assert.equal(op.meta?.discoverySource, "ai");
    assert.equal(op.meta?.confidence, 0.6);
    assert.equal(groups[0]!.targetField, "Party.fullName");
  });

  it("AST-only fields are absent from groups but counted in meta.astOnly", () => {
    const { groups, meta } = mergeAstAndAiDiscovery(astGroups, []);
    assert.equal(groups.length, 0);
    assert.equal(meta.mergedTargets, 0);
    assert.equal(meta.astOnly, 2);
    assert.equal(meta.aiTargets, 0);
  });
});

describe("mergeAstOnlyEscapeHatch", () => {
  it("emits AST groups with confidence 0.4", () => {
    const astGroups: FieldMapping[] = [
      {
        targetField: "Collateral.addressLineText",
        pipeline: [{ kind: "WRITE", sourceField: "mapAddressLineViaOptional(property)" }],
      },
    ];
    const { groups, meta } = mergeAstOnlyEscapeHatch(astGroups);
    assert.equal(groups.length, 1);
    assert.equal(meta.astOnly, 1);
    assert.equal(groups[0]!.pipeline[0]!.meta?.discoverySource, "ast");
    assert.equal(groups[0]!.pipeline[0]!.meta?.confidence, 0.4);
  });
});

describe("discoverAndMerge useAst flag", () => {
  const ast: IndexAst = {
    mapperId: "t",
    className: "T",
    entryMethod: "map",
    operations: [
      {
        kind: "RAW",
        targetField: "Collateral.addressLineText",
        meta: { code: "setAddressLineText(x); private String h(){ return s.trim(); }" },
      },
    ],
  };

  it("default useAst=false ignores AST ops (AI-only confidence)", async () => {
    const provider = {
      model: "test",
      async discoverMappings() {
        return {
          mappings: [
            {
              javaTargetHint: "addressLineText",
              codeSnippet: "collateral.setAddressLineText(mapAddressLineViaOptional(property));",
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
      useAst: false,
      noCache: true,
    });
    assert.equal(meta.astTargets, 0);
    assert.equal(groups[0]!.pipeline[0]!.meta?.discoverySource, "ai");
    assert.equal(groups[0]!.pipeline[0]!.meta?.confidence, 0.6);
  });

  it("useAst=true corroborates AI hit as both", async () => {
    const provider = {
      model: "test",
      async discoverMappings() {
        return {
          mappings: [
            {
              javaTargetHint: "addressLineText",
              codeSnippet: "collateral.setAddressLineText(x);",
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
      useAst: true,
      noCache: true,
    });
    assert.equal(meta.astTargets, 1);
    assert.equal(meta.both, 1);
    assert.equal(groups[0]!.pipeline[0]!.meta?.discoverySource, "both");
    assert.equal(groups[0]!.pipeline[0]!.meta?.confidence, 1);
  });
});
