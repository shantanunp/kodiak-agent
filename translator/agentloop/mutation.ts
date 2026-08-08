/**
 * AGT-5 — mutation testing (offline quality gate).
 *
 * Programmatically alter the fixture mapper, rebuild slices, and assert that a
 * previously-correct golden pipeline becomes ungrounded (or the field drops to
 * unmapped). If the baseline pipeline still "grounds" after the evidence was
 * removed from the code, labeling is not actually reading the source.
 *
 * Zero model calls — CI-safe. Optional live re-label is out of scope here
 * (use --verify / e2e:online for that).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/env.js";
import { buildLabelTasks } from "./tasks.js";
import { groundingDiagnostics } from "./grounding.js";
import type { FieldMappingJson } from "../model/labeler.js";
import type { MapperEntry } from "../../src/registry/loadRegistry.js";
import { loadGoldenCase, type GoldenCase } from "../report/goldenHarness.js";

export interface MutationCase {
  id: string;
  description: string;
  /** Golden target field leaf this mutation attacks. */
  field: string;
  mutate: (source: string) => string;
  /**
   * ungrounded — baseline pipeline must fail grounding on mutated slice
   * demoted — field must leave mapped (unmapped or unresolved / opaque taint)
   */
  expect: "ungrounded" | "demoted";
}

export const SHIPMENT_MUTATIONS: MutationCase[] = [
  {
    id: "drop-multiply",
    description: "remove * 1000 from weightGrams write",
    field: "weightGrams",
    expect: "ungrounded",
    mutate: (s) =>
      s.replace(
        "notice.setWeightGrams((long) (shipment.getWeightKg() * 1000));",
        "notice.setWeightGrams((long) shipment.getWeightKg());",
      ),
  },
  {
    id: "flip-internal-flag",
    description: "change internalFlag = true to false",
    field: "internalFlag",
    expect: "ungrounded",
    mutate: (s) => s.replace("notice.internalFlag = true;", "notice.internalFlag = false;"),
  },
  {
    id: "drop-weight-write",
    description: "delete setWeightGrams write entirely",
    field: "weightGrams",
    expect: "demoted",
    mutate: (s) =>
      s.replace(/\s*notice\.setWeightGrams\(\(long\) \(shipment\.getWeightKg\(\) \* 1000\)\);/, "\n"),
  },
  {
    id: "drop-priority-true",
    description: "EXPRESS branch no longer writes true",
    field: "priority",
    expect: "ungrounded",
    mutate: (s) =>
      s.replace(
        'if ("EXPRESS".equals(shipment.getStatus())) {\n      notice.setPriority(true);\n    } else {\n      notice.setPriority(false);\n    }',
        'if ("EXPRESS".equals(shipment.getStatus())) {\n      notice.setPriority(false);\n    } else {\n      notice.setPriority(false);\n    }',
      ),
  },
];

export interface MutationResult {
  id: string;
  ok: boolean;
  detail: string;
}

function fixtureMapperEntry(golden: GoldenCase): MapperEntry {
  return {
    id: golden.mapperId,
    sourceFile: golden.sourceFixture ?? "fixtures/ShipmentNoticeMapper.java",
    class: golden.mapperClass ?? "ShipmentNoticeMapper",
    entryMethod: golden.entryMethod ?? "map",
    sourceType: "Shipment",
    targetType: golden.targetClass ?? "DeliveryNotice",
  };
}

function baselinePipeline(golden: GoldenCase, field: string): FieldMappingJson | null {
  const f = golden.fields.find(
    (x) =>
      x.targetField === field ||
      x.targetField.split(".").pop()?.toLowerCase() === field.toLowerCase(),
  );
  if (!f?.pipeline?.length) return null;
  return {
    targetField: f.targetField,
    pipeline: f.pipeline as FieldMappingJson["pipeline"],
  };
}

/** Sanity: baseline (unmutated) golden pipelines must ground against original slices. */
export function assertBaselineGrounded(goldenId = "shipment-notice"): MutationResult[] {
  const golden = loadGoldenCase(goldenId);
  if (!golden?.sourceFixture) {
    return [{ id: "baseline", ok: false, detail: "golden case missing" }];
  }
  const source = readFileSync(join(paths.root, golden.sourceFixture), "utf8");
  const tasks = buildLabelTasks({
    mapper: fixtureMapperEntry(golden),
    sourceJava: source,
  });
  const sliceByField = new Map(tasks.tasks.map((t) => [t.field, t.sliceText] as const));
  // Only fields whose CONSTANT/TRANSFORM evidence appears in the write slice.
  // (channel→DEFAULT_CHANNEL is resolved by the model, not the slice text.)
  const sliceGroundable = new Set(["weightGrams", "internalFlag", "priority"]);
  const mapping = golden.fields
    .filter(
      (f) =>
        f.pipeline?.length &&
        sliceGroundable.has(f.targetField.split(".").pop()!),
    )
    .map((f) => ({
      targetField: f.targetField,
      pipeline: f.pipeline as FieldMappingJson["pipeline"],
    }));
  const diags = groundingDiagnostics(mapping, sliceByField);
  return [
    {
      id: "baseline-grounded",
      ok: diags.length === 0,
      detail:
        diags.length === 0
          ? "golden pipelines ground against original fixture"
          : diags.join("; "),
    },
  ];
}

export function runMutation(mut: MutationCase, goldenId = "shipment-notice"): MutationResult {
  const golden = loadGoldenCase(goldenId);
  if (!golden?.sourceFixture) {
    return { id: mut.id, ok: false, detail: "golden case missing" };
  }
  const original = readFileSync(join(paths.root, golden.sourceFixture), "utf8");
  const mutated = mut.mutate(original);
  if (mutated === original) {
    return { id: mut.id, ok: false, detail: "mutate() did not change source" };
  }

  const tasks = buildLabelTasks({
    mapper: fixtureMapperEntry(golden),
    sourceJava: mutated,
  });
  const task = tasks.tasks.find(
    (t) =>
      t.field === mut.field ||
      t.field.split(".").pop()?.toLowerCase() === mut.field.toLowerCase(),
  );

  if (mut.expect === "demoted") {
    const state = task?.state ?? "missing";
    const ok = state === "unmapped" || state === "unresolved";
    return {
      id: mut.id,
      ok,
      detail: ok
        ? `${mut.field} demoted to ${state}`
        : `${mut.field} state=${state} (expected unmapped|unresolved)`,
    };
  }

  // expect ungrounded
  const pipe = baselinePipeline(golden, mut.field);
  if (!pipe) {
    return { id: mut.id, ok: false, detail: `no golden pipeline for ${mut.field}` };
  }
  if (!task || task.state === "unmapped") {
    // Write gone entirely — also proves the agent would have to change.
    return {
      id: mut.id,
      ok: true,
      detail: `${mut.field} unmapped after mutation (stronger than ungrounded)`,
    };
  }
  const sliceByField = new Map([[task.field, task.sliceText] as const]);
  const diags = groundingDiagnostics([pipe], sliceByField);
  return {
    id: mut.id,
    ok: diags.length > 0,
    detail:
      diags.length > 0
        ? `baseline pipeline ungrounded as expected: ${diags[0]}`
        : `FAIL: baseline pipeline still grounded after mutation — agent may ignore code`,
  };
}

export function runAllMutations(goldenId = "shipment-notice"): MutationResult[] {
  return [
    ...assertBaselineGrounded(goldenId),
    ...SHIPMENT_MUTATIONS.map((m) => runMutation(m, goldenId)),
  ];
}
