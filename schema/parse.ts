import type { ImportMode, ParseImportRequest, ParseImportResult, SchemaNode, SchemaNodeType } from "./types.js";
import { makeNode, newNodeId, resetNodeIds } from "./nodes.js";
import { countNodes } from "./nodes.js";

function jsPrimitiveType(value: unknown): SchemaNodeType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
  return "string";
}

function jsonSchemaType(t: string | undefined): SchemaNodeType {
  if (t === "integer") return "integer";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "object") return "object";
  if (t === "array") return "array";
  return "string";
}

function inferFromJsonValue(name: string, value: unknown): SchemaNode {
  if (Array.isArray(value)) {
    const node = makeNode(name, "array");
    if (value.length && typeof value[0] === "object" && value[0] !== null && !Array.isArray(value[0])) {
      node.itemType = "object";
      node.children = Object.keys(value[0] as Record<string, unknown>).map((k) =>
        inferFromJsonValue(k, (value[0] as Record<string, unknown>)[k]),
      );
    } else if (value.length) {
      node.itemType = jsPrimitiveType(value[0]);
    } else {
      node.itemType = "string";
    }
    return node;
  }

  if (value !== null && typeof value === "object") {
    const node = makeNode(name, "object");
    node.children = Object.keys(value as Record<string, unknown>).map((k) =>
      inferFromJsonValue(k, (value as Record<string, unknown>)[k]),
    );
    return node;
  }

  return makeNode(name, jsPrimitiveType(value));
}

function jsonSchemaPropToNode(name: string, schema: Record<string, unknown>): SchemaNode {
  const t = schema.type as string | undefined;
  let node: SchemaNode;

  if (t === "array") {
    node = makeNode(name, "array");
    const items = (schema.items ?? {}) as Record<string, unknown>;
    if (items.type === "object") {
      node.itemType = "object";
      node.children = Object.keys((items.properties as Record<string, unknown>) ?? {}).map((k) =>
        jsonSchemaPropToNode(k, ((items.properties as Record<string, unknown>) ?? {})[k] as Record<string, unknown>),
      );
    } else {
      node.itemType = jsonSchemaType(items.type as string | undefined);
    }
  } else if (t === "object") {
    node = makeNode(name, "object");
    node.children = Object.keys((schema.properties as Record<string, unknown>) ?? {}).map((k) =>
      jsonSchemaPropToNode(k, ((schema.properties as Record<string, unknown>) ?? {})[k] as Record<string, unknown>),
    );
  } else {
    node = makeNode(name, jsonSchemaType(t));
  }

  if (typeof schema.description === "string") {
    node.description = schema.description;
  }
  if (Array.isArray(schema.required) && (schema.required as string[]).includes(name)) {
    node.required = true;
  }
  return node;
}

function parseJsonSchemaDocument(data: Record<string, unknown>, rootName: string): SchemaNode {
  const props = (data.properties as Record<string, unknown>) ?? {};
  const root = makeNode(rootName, "object");
  root.children = Object.keys(props).map((k) =>
    jsonSchemaPropToNode(k, props[k] as Record<string, unknown>),
  );
  return root;
}

function inferFromJsonPayload(text: string, rootName: string): ParseImportResult {
  const data = JSON.parse(text) as unknown;
  resetNodeIds();
  const root = inferFromJsonValue(rootName, data);
  const normalized =
    root.type === "object" && root.children?.length
      ? root
      : makeNode(rootName, "object", { children: [root] });
  return {
    root: normalized,
    format: "JSON sample",
    fieldCount: countNodes(normalized),
  };
}

function parseJsonSchema(text: string, rootName: string): ParseImportResult {
  const data = JSON.parse(text) as Record<string, unknown>;
  resetNodeIds();
  const root = parseJsonSchemaDocument(data, rootName);
  return {
    root,
    format: "JSON Schema",
    fieldCount: countNodes(root),
  };
}

interface XmlElement {
  tag: string;
  attrs: Array<{ name: string; value: string }>;
  children: XmlElement[];
  text: string;
}

function parseXmlDocument(xml: string): XmlElement {
  const tagRe = /<(\/?)([\w:-]+)([^>]*)>/g;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let lastIndex = 0;

  const selfCloseRe = /\/>$/;
  const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xml)) !== null) {
    const closing = match[1] === "/";
    const tag = match[2]!;
    const attrsPart = match[3] ?? "";
    const full = match[0];

    if (closing) {
      stack.pop();
      lastIndex = tagRe.lastIndex;
      continue;
    }

    const attrs: Array<{ name: string; value: string }> = [];
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(attrsPart)) !== null) {
      attrs.push({ name: attrMatch[1]!, value: attrMatch[2]! });
    }

    const el: XmlElement = { tag, attrs, children: [], text: "" };

    if (selfCloseRe.test(full)) {
      if (stack.length) stack[stack.length - 1]!.children.push(el);
      else root = el;
      lastIndex = tagRe.lastIndex;
      continue;
    }

    if (!stack.length) root = el;
    else stack[stack.length - 1]!.children.push(el);
    stack.push(el);
    lastIndex = tagRe.lastIndex;
  }

  if (!root) {
    throw new Error("No XML root element found");
  }
  return root;
}

function inferFromXmlElement(el: XmlElement): SchemaNode {
  const attrNodes = el.attrs.map((a) => makeNode(`@${a.name}`, jsPrimitiveType(a.value)));
  const groups = new Map<string, XmlElement[]>();
  for (const child of el.children) {
    const list = groups.get(child.tag) ?? [];
    list.push(child);
    groups.set(child.tag, list);
  }

  const childNodes: SchemaNode[] = [];
  for (const [tag, group] of groups) {
    if (group.length > 1) {
      const listNode = makeNode(tag, "array");
      const sample = inferFromXmlElement(group[0]!);
      if (sample.type === "object" || sample.children?.length) {
        listNode.itemType = "object";
        listNode.children = sample.children ?? [];
      } else {
        listNode.itemType = sample.type;
      }
      childNodes.push(listNode);
    } else {
      childNodes.push(inferFromXmlElement(group[0]!));
    }
  }

  if (childNodes.length === 0 && attrNodes.length === 0) {
    return makeNode(el.tag, jsPrimitiveType(el.text.trim()));
  }

  const node = makeNode(el.tag, "object");
  node.children = [...attrNodes, ...childNodes];
  return node;
}

function inferFromXmlPayload(text: string, rootName: string): ParseImportResult {
  const doc = parseXmlDocument(text.trim());
  resetNodeIds();
  const root = inferFromXmlElement(doc);
  const normalized = makeNode(rootName || root.name, "object", {
    children: root.name === rootName ? root.children ?? [] : [root],
  });
  return {
    root: normalized,
    format: "XML",
    fieldCount: countNodes(normalized),
  };
}

function parseXsd(text: string, rootName: string): ParseImportResult {
  resetNodeIds();
  const elementBlocks = [...text.matchAll(/<xs:element\s+([^>]+)\/?>/g)];
  const root = makeNode(rootName, "object");
  root.children = elementBlocks.slice(0, 50).map((m) => {
    const attrs = m[1] ?? "";
    const nameMatch = attrs.match(/name="([^"]+)"/);
    const typeMatch = attrs.match(/type="xs:(\w+)"/);
    const name = nameMatch?.[1] ?? "element";
    const xsType = typeMatch?.[1];
    const type =
      xsType === "integer"
        ? "integer"
        : xsType === "decimal" || xsType === "double"
          ? "number"
          : xsType === "boolean"
            ? "boolean"
            : xsType === "date"
              ? "date"
              : "string";
    return makeNode(name, type);
  });
  return {
    root,
    format: "XSD",
    fieldCount: countNodes(root),
  };
}

function parseKodiakDocument(text: string): ParseImportResult {
  const doc = JSON.parse(text) as { source?: { root: SchemaNode }; target?: { root: SchemaNode }; version?: number };
  if (doc.version !== 1 || !doc.source?.root) {
    throw new Error("Not a valid Kodiak schema document (version 1)");
  }
  resetNodeIds();
  reassignIds(doc.source.root);
  return {
    root: doc.source.root,
    format: "Kodiak schema",
    fieldCount: countNodes(doc.source.root),
  };
}

function reassignIds(node: SchemaNode): void {
  node.id = newNodeId();
  for (const child of node.children ?? []) {
    reassignIds(child);
  }
}

export function parseImport(req: ParseImportRequest): ParseImportResult {
  const rootName = req.rootName ?? "root";
  const text = req.text.trim();
  if (!text) throw new Error("Empty content");

  switch (req.mode) {
    case "payload-json": {
      const trimmed = text;
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      if (data.$schema || (data.type && data.properties)) {
        return parseJsonSchema(trimmed, rootName);
      }
      return inferFromJsonPayload(trimmed, rootName);
    }
    case "json-schema":
      return parseJsonSchema(text, rootName);
    case "payload-xml":
      return inferFromXmlPayload(text, rootName);
    case "xsd":
      return parseXsd(text, rootName);
    case "kodiak":
      return parseKodiakDocument(text);
    default:
      throw new Error(`Unknown import mode: ${req.mode as string}`);
  }
}

export function parseSideImport(mode: ImportMode, text: string, sideName: string): ParseImportResult {
  return parseImport({ mode, text, rootName: sideName });
}
