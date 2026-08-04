#!/usr/bin/env tsx
/**
 * Export labeled pipeline → UI view JSON for pipeline-viewer.
 *
 * Usage:
 *   npm run view:export -- --mapper demo-ai-recognition-mapper
 *   npm run view:export -- --mapper demo-ai-recognition-mapper --label
 */

import { parseArgs } from "node:util";
import { paths } from "../src/config/env.js";
import {
  operationsOf,
  StepLabeler,
  isModelConfigured,
  type FieldMappingJson,
  type PipelineJson,
} from "./model/index.js";
import { groupOperationsByTarget } from "./groupMapping.js";
import { resolveAstForMapper } from "./resolvePipeline.js";
import { writePipelineView } from "./writePipelineView.js";

const { values } = parseArgs({
  options: {
    mapper: { type: "string", short: "m" },
    label: { type: "boolean", default: false },
    registry: { type: "string", default: paths.registry },
  },
});

async function main(): Promise<void> {
  if (!values.mapper) {
    console.error("Usage: view:export -- --mapper <id> [--label]");
    process.exit(1);
  }

  let pipeline: PipelineJson;

  if (values.label) {
    if (!isModelConfigured()) {
      console.error("MODEL_API_KEY (or ANTHROPIC_API_KEY / COPILOT_TOKEN) required for --label");
      process.exit(1);
    }
    const ast = await resolveAstForMapper(values.mapper, values.registry);
    pipeline = await new StepLabeler().labelIndex(ast);
  } else {
    const ast = await resolveAstForMapper(values.mapper, values.registry);
    pipeline = {
      ...ast,
      mapping: groupOperationsByTarget(
        operationsOf(ast).map((s) => ({
          ...s,
          labelSource: "deterministic" as const,
        })),
      ) as FieldMappingJson[],
    };
  }

  const { path: outFile, view } = writePipelineView(pipeline);

  console.error(`Wrote ${outFile} (${view.steps.length} view steps)`);
  console.log(
    JSON.stringify(
      { path: outFile, mapperId: view.mapperId, steps: view.steps.length, fields: view.fields?.length },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
