/**
 * Write labeled pipeline → ui/pipeline-viewer/data/{mapperId}.view.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/env.js";
import {
  toPipelineView,
  type FieldPipelineView,
  type PipelineViewModel,
} from "./toPipelineView.js";
import type { PipelineJson, PipelineStep } from "./model/index.js";

export function pipelineViewDataDir(): string {
  return process.env.KODIAK_VIEW_DIR ?? join(paths.root, "ui/pipeline-viewer/data");
}

export function pipelineViewFile(mapperId: string): string {
  return join(pipelineViewDataDir(), `${mapperId}.view.json`);
}

/** Remove viewer dump(s). Pass mapperId for one file; omit to clear all `.view.json`. */
export function clearPipelineView(mapperId?: string): number {
  const dir = pipelineViewDataDir();
  if (!existsSync(dir)) return 0;
  const files = mapperId
    ? [pipelineViewFile(mapperId)]
    : readdirSync(dir)
        .filter((f) => f.endsWith(".view.json"))
        .map((f) => join(dir, f));
  let n = 0;
  for (const file of files) {
    if (!existsSync(file)) continue;
    unlinkSync(file);
    n += 1;
  }
  return n;
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

function fieldLeaf(path: string): string {
  return (path.split(".").pop() ?? path).replace(/\[\]$/, "").toLowerCase();
}

/**
 * Merge one field's pipeline into the existing viewer dump.
 * Used when the judge writes a user-corrected answer — otherwise .view.json
 * stays stale and the warm cache on refresh shadows the verified store.
 */
export function patchPipelineViewField(options: {
  mapperId: string;
  targetField: string;
  pipeline: PipelineStep[] | unknown[];
  sourceType?: string;
  targetType?: string;
}): { path: string; view: PipelineViewModel } {
  const file = pipelineViewFile(options.mapperId);
  let existing: PipelineViewModel | null = null;
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, "utf8")) as PipelineViewModel;
    } catch {
      existing = null;
    }
  }

  const slice = toPipelineView({
    mapperId: options.mapperId,
    sourceType: options.sourceType ?? existing?.sourceType ?? "Source",
    targetType: options.targetType ?? existing?.targetType ?? "Target",
    mapping: [
      {
        targetField: options.targetField,
        pipeline: options.pipeline as PipelineStep[],
      },
    ],
  });
  const patched = slice.fields?.[0];
  if (!patched) {
    throw new Error(`patchPipelineViewField: no view steps for ${options.targetField}`);
  }

  const fields: FieldPipelineView[] = [...(existing?.fields ?? [])];
  const want = fieldLeaf(patched.targetField);
  const idx = fields.findIndex((f) => fieldLeaf(f.targetField) === want);
  if (idx >= 0) fields[idx] = patched;
  else fields.push(patched);

  const view: PipelineViewModel = {
    ...(existing ?? slice),
    mapperId: options.mapperId,
    fields,
    steps: fields.flatMap((f) => f.steps),
    readOnly: true,
  };

  mkdirSync(pipelineViewDataDir(), { recursive: true });
  writeFileSync(file, JSON.stringify(view, null, 2));
  return { path: file, view };
}
