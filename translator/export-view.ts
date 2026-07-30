#!/usr/bin/env tsx
/**
 * Export labeled pipeline → UI view JSON for pipeline-viewer.
 *
 * Usage:
 *   npm run view:export -- --mapper demo-ai-recognition-mapper
 *   npm run view:export -- --mapper demo-ai-recognition-mapper --label
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/env.js";
import { toPipelineView } from "./toPipelineView.js";
import type { PipelineJson } from "./labeler.js";
import { resolveAstForMapper } from "./resolvePipeline.js";
import { StepLabeler } from "./labeler.js";
import { isGeminiConfigured } from "./config.js";

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
    if (!isGeminiConfigured()) {
      console.error("GEMINI_API_KEY required for --label");
      process.exit(1);
    }
    const ast = await resolveAstForMapper(values.mapper, values.registry);
    pipeline = await new StepLabeler().labelIndex(ast);
  } else {
    const ast = await resolveAstForMapper(values.mapper, values.registry);
    pipeline = { ...ast, steps: ast.steps.map((s) => ({ ...s, labelSource: "deterministic" as const })) };
  }

  const view = toPipelineView(pipeline);
  const outDir = join(paths.root, "ui/pipeline-viewer/data");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${values.mapper}.view.json`);
  writeFileSync(outFile, JSON.stringify(view, null, 2));

  console.error(`Wrote ${outFile} (${view.steps.length} view steps)`);
  console.log(JSON.stringify({ path: outFile, mapperId: view.mapperId, steps: view.steps.length }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
