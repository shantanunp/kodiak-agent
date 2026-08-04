#!/usr/bin/env tsx
/**
 * Clear translator pipeline + label caches.
 *
 *   npm run cache:clear
 *   npm run cache:clear -- --mapper demo-ai-recognition-mapper
 */

import { parseArgs } from "node:util";
import { clearAllTranslatorCaches } from "./index.js";

const { values } = parseArgs({
  options: {
    mapper: { type: "string", short: "m" },
  },
});

const result = clearAllTranslatorCaches(values.mapper);
console.log(
  JSON.stringify(
    {
      cleared: true,
      mapperId: values.mapper ?? null,
      pipelineFilesRemoved: result.pipelines,
      discoveryFilesRemoved: result.discovery,
      fieldFilesRemoved: result.fields,
      labelFilesRemoved: result.labels,
    },
    null,
    2,
  ),
);
