export type SchemaNodeType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "object"
  | "array";

export type StructureMethod = "manual" | "schema" | "sample";

export interface SchemaNode {
  id: string;
  name: string;
  /** Optional — omit or leave unset when the concrete type is unknown. */
  type?: SchemaNodeType;
  /** When type === "array", type of each item (primitive or "object"). */
  itemType?: SchemaNodeType | "object";
  required?: boolean;
  description?: string;
  children?: SchemaNode[];
}

export interface StructureSide {
  method: StructureMethod;
  format?: string;
  root: SchemaNode;
}

export interface MappingSchemaDocument {
  version: 1;
  mapperId: string;
  source: StructureSide;
  target: StructureSide;
  savedAt: string;
}

export type ImportMode = "payload-json" | "json-schema" | "payload-xml" | "xsd" | "kodiak";

export interface ParseImportRequest {
  mode: ImportMode;
  text: string;
  rootName?: string;
}

export interface ParseImportResult {
  root: SchemaNode;
  format: string;
  fieldCount: number;
}
