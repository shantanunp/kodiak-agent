import type { SchemaNode } from "./types.js";

export interface FlatField {
  path: string;
  type: string;
  required: boolean;
  description?: string;
}

function nodeTypeLabel(node: SchemaNode): string {
  if (!node.type) return "any";
  if (node.type === "array" && node.itemType) {
    return node.itemType === "object" ? "array" : `array<${node.itemType}>`;
  }
  return node.type;
}

function hasNestedChildren(node: SchemaNode): boolean {
  const kids = node.children ?? [];
  if (kids.length === 0) return false;
  // Typed object / object-array, or untyped node used as a container.
  return (
    node.type === "object" ||
    !node.type ||
    (node.type === "array" && node.itemType === "object")
  );
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

  if (hasNestedChildren(node)) {
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

/**
 * Leaf paths only — skip structural object / object-array containers that
 * exist so children can nest. Used as the agent/checklist universe.
 */
export function flattenLeafPaths(root: SchemaNode): string[] {
  const leaves: string[] = [];

  function walk(node: SchemaNode, prefix: string): void {
    const segment = node.type === "array" ? `${node.name}[]` : node.name;
    const path = prefix ? `${prefix}.${segment}` : segment;
    const kids = node.children ?? [];
    // Object / untyped-with-children / object-array are structural; scalar arrays are leaves.
    const isContainer =
      node.type === "object" ||
      (!node.type && kids.length > 0) ||
      (node.type === "array" &&
        (node.itemType === "object" || kids.length > 0));

    if (isContainer && kids.length > 0) {
      for (const child of kids) walk(child, path);
      return;
    }
    leaves.push(path);
  }

  for (const child of root.children ?? []) walk(child, "");
  return leaves;
}

export function mergeFieldLists(...lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort();
}
