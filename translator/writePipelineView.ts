/**
 * Write labeled pipeline → ui/pipeline-viewer/data/{mapperId}.view.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/env.js";
import { toPipelineView, type PipelineViewModel } from "./toPipelineView.js";
import type { PipelineJson } from "./model/index.js";

export function pipelineViewDataDir(): string {
  return join(paths.root, "ui/pipeline-viewer/data");
}

export function pipelineViewFile(mapperId: string): string {
  return join(pipelineViewDataDir(), `${mapperId}.view.json`);
}

export function writePipelineView(pipeline: PipelineJson): {
  path: string;
  view: PipelineViewModel;
} {
  const view = toPipelineView(pipeline);
  const outDir = pipelineViewDataDir();
  mkdirSync(outDir, { recursive: true });
  const outFile = pipelineViewFile(view.mapperId);
  writeFileSync(outFile, JSON.stringify(view, null, 2));
  return { path: outFile, view };
}
