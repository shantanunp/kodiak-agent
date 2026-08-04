import type { SchemaNode } from "./types.js";

export interface FlatField {
  path: string;
  type: string;
  required: boolean;
  description?: string;
}

function nodeTypeLabel(node: SchemaNode): string {
  if (node.type === "array" && node.itemType) {
    return node.itemType === "object" ? "array" : `array<${node.itemType}>`;
  }
  return node.type;
}

function flattenRecursive(node: SchemaNode, prefix: string, fields: FlatField[]): void {
  const segment = node.type === "array" ? `${node.name}[]` : node.name;
  const path = prefix ? `${prefix}.${segment}` : segment;

  fields.push({
    path,
    type: nodeTypeLabel(node),
    required: node.required ?? false,
    description: node.description || undefined,
  });

  if (node.type === "object" || (node.type === "array" && node.itemType === "object")) {
    for (const child of node.children ?? []) {
      flattenRecursive(child, path, fields);
    }
  }
}

/** Flatten a schema tree to dotted paths, e.g. customer.orders[].id */
export function flattenSchema(root: SchemaNode, skipRoot = true): FlatField[] {
  const fields: FlatField[] = [];
  if (skipRoot) {
    for (const child of root.children ?? []) {
      flattenRecursive(child, "", fields);
    }
  } else {
    flattenRecursive(root, "", fields);
  }
  return fields;
}

export function flattenPaths(root: SchemaNode): string[] {
  return flattenSchema(root).map((f) => f.path);
}

export function mergeFieldLists(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}
