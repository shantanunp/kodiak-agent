import type { MappingSchemaDocument, SchemaNode, StructureSide } from "./types.js";
import { walkTree } from "./nodes.js";

const VALID_TYPES = new Set(["string", "integer", "number", "boolean", "date", "object", "array"]);
const VALID_METHODS = new Set(["manual", "schema", "sample"]);

function validateNode(node: SchemaNode, path: string, errors: string[]): void {
  if (!node.id) errors.push(`${path}: missing id`);
  if (!node.name?.trim()) errors.push(`${path}: missing name`);
  if (!VALID_TYPES.has(node.type)) errors.push(`${path}: invalid type ${node.type}`);

  if (node.type === "array" && node.itemType && !VALID_TYPES.has(node.itemType) && node.itemType !== "object") {
    errors.push(`${path}: invalid itemType ${node.itemType}`);
  }

  for (const child of node.children ?? []) {
    validateNode(child, `${path}.${child.name}`, errors);
  }
}

function validateSide(side: StructureSide, label: string, errors: string[]): void {
  if (!VALID_METHODS.has(side.method)) {
    errors.push(`${label}: invalid method ${side.method}`);
  }
  if (!side.root) {
    errors.push(`${label}: missing root`);
    return;
  }
  validateNode(side.root, `${label}.root`, errors);
}

export function validateSchemaDocument(doc: unknown): { ok: true; doc: MappingSchemaDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const d = doc as Partial<MappingSchemaDocument>;

  if (!d || typeof d !== "object") {
    return { ok: false, errors: ["Document must be an object"] };
  }
  if (d.version !== 1) errors.push("version must be 1");
  if (!d.mapperId?.trim()) errors.push("mapperId is required");
  if (!d.savedAt) errors.push("savedAt is required");
  if (!d.source) errors.push("source is required");
  if (!d.target) errors.push("target is required");

  if (d.source) validateSide(d.source, "source", errors);
  if (d.target) validateSide(d.target, "target", errors);

  if (errors.length) return { ok: false, errors };

  return { ok: true, doc: d as MappingSchemaDocument };
}

export function sideHasContent(side: StructureSide): boolean {
  let has = false;
  walkTree(side.root, (node, parent) => {
    if (parent && node.name !== "new_field") has = true;
    if (parent && node.children?.length) has = true;
  });
  return (side.root.children?.length ?? 0) > 0 || has;
}
