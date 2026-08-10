import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config/env.js";
import type { MappingSchemaDocument } from "./types.js";
import { validateSchemaDocument } from "./validate.js";
import { flattenLeafPaths, flattenPaths } from "./flatten.js";
import { sideHasContent } from "./validate.js";

export const SCHEMAS_DIR = join(paths.root, "registry/schemas");

export function schemaFilePath(mapperId: string): string {
  return join(SCHEMAS_DIR, `${mapperId}.schema.json`);
}

export function loadSchema(mapperId: string): MappingSchemaDocument | null {
  const file = schemaFilePath(mapperId);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const result = validateSchemaDocument(raw);
  if (!result.ok) {
    throw new Error(`Invalid schema file ${file}: ${result.errors.join(", ")}`);
  }
  return result.doc;
}

/** Target leaf paths from a saved schema, or [] when none / empty. */
export function schemaTargetLeafPaths(mapperId: string): string[] {
  const doc = loadSchema(mapperId);
  if (!doc?.target?.root) return [];
  return flattenLeafPaths(doc.target.root);
}

/** True when saved schema has at least one field on both source and target. */
export function isSchemaReadyForMapping(mapperId: string): boolean {
  try {
    const doc = loadSchema(mapperId);
    if (!doc) return false;
    return sideHasContent(doc.source) && sideHasContent(doc.target);
  } catch {
    return false;
  }
}

export function saveSchema(doc: MappingSchemaDocument): string {
  const result = validateSchemaDocument(doc);
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  mkdirSync(SCHEMAS_DIR, { recursive: true });
  const file = schemaFilePath(doc.mapperId);
  writeFileSync(file, JSON.stringify(result.doc, null, 2));
  return file;
}

export function schemaContextForLabeler(mapperId: string): string | undefined {
  const doc = loadSchema(mapperId);
  if (!doc) return undefined;

  const sourcePaths = flattenPaths(doc.source.root);
  const targetPaths = flattenPaths(doc.target.root);

  return [
    "Known source fields:",
    ...sourcePaths.map((p) => `  - ${p}`),
    "Known target fields:",
    ...targetPaths.map((p) => `  - ${p}`),
  ].join("\n");
}
