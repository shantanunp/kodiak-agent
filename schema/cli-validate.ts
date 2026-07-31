#!/usr/bin/env tsx
/**
 * Validate a Kodiak schema JSON file.
 *   npm run schema:validate -- registry/schemas/my-mapper.schema.json
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { validateSchemaDocument } from "./validate.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string", short: "f" },
  },
});

const file = values.file ?? positionals[0];
if (!file) {
  console.error("Usage: schema:validate -- <file.schema.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
const result = validateSchemaDocument(raw);

if (result.ok) {
  console.log(`Valid schema for mapper: ${result.doc.mapperId}`);
} else {
  console.error("Validation errors:");
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
