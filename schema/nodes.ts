import type { SchemaNode, SchemaNodeType } from "./types.js";

let uid = 1;

export function resetNodeIds(): void {
  uid = 1;
}

export function newNodeId(): string {
  return `n${uid++}`;
}

export function makeNode(
  name: string,
  type: SchemaNodeType,
  extra: Partial<Omit<SchemaNode, "id" | "name" | "type">> = {},
): SchemaNode {
  return {
    id: newNodeId(),
    name,
    type,
    itemType: extra.itemType,
    required: extra.required ?? false,
    description: extra.description ?? "",
    children: extra.children ?? [],
  };
}

export function emptyRoot(name: string): SchemaNode {
  return makeNode(name, "object", { children: [] });
}

export function findNode(
  id: string,
  root: SchemaNode,
  parent: SchemaNode | null = null,
): { node: SchemaNode; parent: SchemaNode | null } | null {
  if (root.id === id) return { node: root, parent };
  for (const child of root.children ?? []) {
    const found = findNode(id, child, root);
    if (found) return found;
  }
  return null;
}

export function countNodes(root: SchemaNode): number {
  let count = 0;
  walkTree(root, () => {
    count += 1;
  });
  return Math.max(0, count - 1);
}

export function walkTree(root: SchemaNode, fn: (node: SchemaNode, parent: SchemaNode | null) => void): void {
  function walk(node: SchemaNode, parent: SchemaNode | null): void {
    fn(node, parent);
    for (const child of node.children ?? []) {
      walk(child, node);
    }
  }
  walk(root, null);
}

export function cloneNode(node: SchemaNode): SchemaNode {
  resetNodeIds();
  function clone(n: SchemaNode): SchemaNode {
    return {
      ...n,
      id: newNodeId(),
      children: (n.children ?? []).map(clone),
    };
  }
  return clone(node);
}
