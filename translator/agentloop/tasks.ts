/**
 * Agent loop — task building.
 *
 * Turns the deterministic analyzer output (checklist + per-field slices) into
 * the agent's work items. The checklist is the agent's contract: every
 * declared target field must end mapped / unmapped / unresolved.
 */

import { readFileSync } from "node:fs";
import type { SourceField, WriteSite } from "../../analyzer/types.js";
import { scanWriteSites, adapterFor } from "../../analyzer/scanWriteSites.js";
import { runAuditGate } from "../../analyzer/auditGate.js";
import { findTypeFile } from "../../analyzer/resolveType.js";
import type { AuditReport, WriteSlice } from "../../analyzer/types.js";
import type { MapperEntry } from "../../src/registry/loadRegistry.js";

export interface FieldTask {
  /** Declared target field (leaf, from the target type). */
  field: string;
  state: "mapped" | "unmapped" | "unresolved";
  /** Self-contained code slices for this field (empty for unmapped/unresolved). */
  slices: WriteSlice[];
  /** Combined slice text handed to the agent. */
  sliceText: string;
  note?: string;
}

export interface LabelTasks {
  report: AuditReport;
  tasks: FieldTask[];
  mapperClass: string;
  targetClass: string;
  /**
   * Where the checklist universe came from:
   *   target-type  — declared fields of the target type (full guarantee:
   *                  unmapped fields are detectable)
   *   write-sites  — target type source not found; checklist derived from the
   *                  writes themselves (weaker: cannot detect unmapped fields)
   */
  checklistSource: "target-type" | "write-sites";
  /** File the target type was read from, when found outside the mapper file. */
  targetTypeFile?: string;
}

/** "com.acme.dto.Out$Notice" -> "Notice"; "Notice" -> "Notice". */
export function simpleTypeName(fqcn: string): string {
  const afterDot = fqcn.includes(".") ? fqcn.slice(fqcn.lastIndexOf(".") + 1) : fqcn;
  return afterDot.includes("$") ? afterDot.slice(afterDot.lastIndexOf("$") + 1) : afterDot;
}

function norm(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

const MAX_NEST_DEPTH = 3;
const SCALAR_TYPES = new Set([
  "string", "int", "integer", "long", "double", "float", "boolean", "char",
  "byte", "short", "bigdecimal", "biginteger", "localdate", "localdatetime",
  "date", "instant", "uuid", "object",
]);

function isScalarType(type?: string): boolean {
  if (!type) return true;
  const t = type.trim();
  if (t.includes("<")) return true; // collections: not expanded in this POC
  return SCALAR_TYPES.has(t.replace(/\[\]$/, "").toLowerCase());
}

export interface NestedTypeRef {
  /** Dotted path prefix on the target, e.g. "message". */
  pathPrefix: string;
  /** Simple type name, e.g. "MessageType". */
  typeName: string;
}

/**
 * Recursively flatten the target type: scalar fields become dotted checklist
 * paths ("message.dataVersionIdentifier"); each nested project type is also
 * returned so write sites against it can be scanned and path-prefixed.
 */
function flattenTargetType(options: {
  adapter: ReturnType<typeof adapterFor>;
  worktree?: string;
  typeName: string;
  typeSource: string;
  typeFilePath: string;
  prefix: string;
  depth: number;
  visitedTypes: Set<string>;
  nested: NestedTypeRef[];
}): SourceField[] {
  const { adapter, worktree, typeName, prefix, depth, visitedTypes, nested } = options;
  const parsed = adapter.parse(options.typeFilePath, options.typeSource);
  const fields = adapter.targetFields(parsed, typeName);
  const out: SourceField[] = [];

  for (const f of fields) {
    const dotted = prefix ? `${prefix}.${f.name}` : f.name;
    if (isScalarType(f.type) || depth >= MAX_NEST_DEPTH || !worktree) {
      out.push({ ...f, name: dotted });
      continue;
    }
    const childType = simpleTypeName(f.type!.replace(/\[\]$/, ""));
    if (visitedTypes.has(childType)) {
      out.push({ ...f, name: dotted });
      continue;
    }
    const childFile = findTypeFile(worktree, f.type!);
    if (!childFile) {
      out.push({ ...f, name: dotted });
      continue;
    }
    visitedTypes.add(childType);
    nested.push({ pathPrefix: dotted, typeName: childType });
    try {
      out.push(
        ...flattenTargetType({
          adapter, worktree,
          typeName: childType,
          typeSource: readFileSync(childFile, "utf8"),
          typeFilePath: childFile,
          prefix: dotted,
          depth: depth + 1,
          visitedTypes, nested,
        }),
      );
    } catch {
      out.push({ ...f, name: dotted });
    }
  }
  return out;
}

/**
 * Deterministic pre-pass. Throws if the source cannot be parsed — callers
 * decide whether to fall back to the legacy discovery path.
 */
export function buildLabelTasks(options: {
  mapper: MapperEntry;
  sourceJava: string;
  language?: string;
  /** Worktree root — used to resolve the target type when it lives in another file. */
  worktree?: string;
}): LabelTasks {
  const language = options.language ?? "java";
  const mapperClass = simpleTypeName(options.mapper.class);
  const targetClass = simpleTypeName(options.mapper.targetType);

  const { parsed, slices } = scanWriteSites({
    filePath: options.mapper.sourceFile,
    language,
    mapperClass,
    targetClass,
    source: options.sourceJava,
  });

  const adapter = adapterFor(language);
  let declared = adapter.targetFields(parsed, targetClass);
  let checklistSource: "target-type" | "write-sites" = "target-type";
  let targetTypeFile: string | undefined;

  // Target type in a separate file (the common real-world case): resolve it
  // via package-path convention / bounded walk, parse it, read its fields.
  const nestedTypes: NestedTypeRef[] = [];
  if (declared.length === 0 && options.worktree) {
    const file = findTypeFile(options.worktree, options.mapper.targetType);
    if (file) {
      try {
        declared = flattenTargetType({
          adapter,
          worktree: options.worktree,
          typeName: targetClass,
          typeSource: readFileSync(file, "utf8"),
          typeFilePath: file,
          prefix: "",
          depth: 0,
          visitedTypes: new Set([targetClass]),
          nested: nestedTypes,
        });
        if (declared.length > 0) targetTypeFile = file;
      } catch {
        // fall through to write-site checklist
      }
    }
  }

  // Nested writes: instances of nested types are usually built inside the
  // mapper (or its helpers); scan write sites against each nested type in the
  // mapper source and prefix them with the nested path.
  // POC assumption: one instance per nested type (typical for DTO builders).
  const extraSites: WriteSite[] = [];
  for (const ref of nestedTypes) {
    const nestedSites = adapter.findWriteSites(parsed, options.sourceJava, ref.typeName);
    for (const site of nestedSites) {
      extraSites.push({ ...site, targetField: `${ref.pathPrefix}.${site.targetField}` });
    }
  }
  if (extraSites.length > 0) {
    const known = new Set(slices.map((x) => `${x.line}:${norm(x.targetField)}`));
    for (const site of extraSites) {
      const key = `${site.line}:${norm(site.targetField.split(".").pop()!)}`;
      if (known.has(key)) continue;
      const helperClosure: Array<{ name: string; text: string }> = [];
      slices.push({
        ...site,
        helperClosure,
        sliceText: [
          `// write site (line ${site.line}, in ${site.inMethod}, via ${site.via})`,
          site.statement,
        ].join("\n"),
      });
    }
    slices.sort((a, b) => a.line - b.line);
  }

  // Last resort: derive the checklist from the writes themselves. Functional,
  // but explicitly weaker — unmapped fields cannot be detected this way.
  if (declared.length === 0) {
    checklistSource = "write-sites";
    const seen = new Set<string>();
    declared = [];
    for (const site of slices) {
      const key = norm(site.targetField);
      if (seen.has(key)) continue;
      seen.add(key);
      declared.push({
        className: targetClass,
        name: site.targetField,
        line: site.line,
      });
    }
  }

  if (declared.length === 0) {
    throw new Error(
      `No declared fields for target type "${options.mapper.targetType}" and no write sites ` +
        `against "${targetClass}" found in ${options.mapper.sourceFile}. ` +
        `Check registry targetType/class, or pass the correct --worktree.`,
    );
  }

  const report = runAuditGate({
    parsed,
    source: options.sourceJava,
    targetClass,
    declaredFields: declared,
    writeSites: slices,
  });

  const byField = new Map<string, WriteSlice[]>();
  for (const s of slices) {
    const key = norm(s.targetField);
    if (!byField.has(key)) byField.set(key, []);
    byField.get(key)!.push(s);
  }

  const tasks: FieldTask[] = report.checklist.map((entry) => {
    const fieldSlices = byField.get(norm(entry.field)) ?? [];
    return {
      field: entry.field,
      state: entry.state,
      slices: fieldSlices,
      sliceText: fieldSlices.map((s) => s.sliceText).join("\n\n"),
      note: entry.note,
    };
  });

  return { report, tasks, mapperClass, targetClass, checklistSource, targetTypeFile };
}
