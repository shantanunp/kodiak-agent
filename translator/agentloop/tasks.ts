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
import { missDiagnostics } from "../../analyzer/secondOpinion.js";
import { schemaTargetLeafPaths } from "../../schema/io.js";
import { injectionDiagnostics } from "./promptInjection.js";
import { attributeMultiInstanceWrites, type NestedTypeRef } from "./multiInstance.js";
import type { AuditReport, WriteSlice } from "../../analyzer/types.js";
import type { MapperEntry } from "../../src/registry/loadRegistry.js";

export type { NestedTypeRef };

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
   *   schema       — saved registry schema target leaf paths (agent universe =
   *                  only fields the user defined)
   *   target-type  — declared fields of the target type (full guarantee:
   *                  unmapped fields are detectable)
   *   write-sites  — target type source not found; checklist derived from the
   *                  writes themselves (weaker: cannot detect unmapped fields)
   */
  checklistSource: "target-type" | "write-sites" | "schema";
  /** File the target type was read from, when found outside the mapper file. */
  targetTypeFile?: string;
  /** Human-readable notes on why nested expansion did or didn't happen. */
  diagnostics: string[];
}

/** "com.acme.dto.Out$Notice" -> "Notice"; "Notice" -> "Notice". */
export function simpleTypeName(fqcn: string): string {
  const afterDot = fqcn.includes(".") ? fqcn.slice(fqcn.lastIndexOf(".") + 1) : fqcn;
  return afterDot.includes("$") ? afterDot.slice(afterDot.lastIndexOf("$") + 1) : afterDot;
}

function norm(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/**
 * findWriteSites treats receivers as file-global, so two methods that both use
 * `mapped` (Customer vs Address) cross-contaminate when scanning each type.
 * Keep a site only when its enclosing method actually declares that receiver
 * as the requested type (or constructs it with new Type / new Outer.Type).
 */
export function writeSiteBelongsToType(
  parsed: { methods: Array<{ name: string; bodyText: string; startLine: number; endLine: number }> },
  site: WriteSite,
  typeName: string,
): boolean {
  // Builder chains are already scoped to Type.builder() by findWriteSites.
  if (site.via === "builder" || /\.builder\s*\(\s*\)$/.test(site.receiver)) {
    return true;
  }
  const simple = simpleTypeName(typeName);
  const enclosing =
    parsed.methods.find(
      (m) =>
        m.name === site.inMethod && site.line >= m.startLine && site.line <= m.endLine,
    ) ?? parsed.methods.find((m) => m.name === site.inMethod);
  const body = enclosing?.bodyText ?? "";
  if (!body) return false;
  const recv = site.receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bare Type, Outer.Type, or deeper FQCN ending in Type.
  const typeAlt = `(?:[\\w.]+\\.)?${simple}`;
  const decl = new RegExp(`\\b${typeAlt}\\b\\s+${recv}\\b`);
  const constructed = new RegExp(`\\b${recv}\\s*=\\s*new\\s+${typeAlt}\\b`);
  // Contact c1 = Contact.builder()… — receiver is c1, constructed via builder.
  const built = new RegExp(`\\b${recv}\\s*=\\s*${typeAlt}\\s*\\.\\s*builder\\s*\\(`);
  return decl.test(body) || constructed.test(body) || built.test(body);
}

/** Deep enough for typical nested DTO graphs (Message → Deal → Loan → …). */
const MAX_NEST_DEPTH = 6;
const SCALAR_TYPES = new Set([
  "string", "int", "integer", "long", "double", "float", "boolean", "char",
  "byte", "short", "bigdecimal", "biginteger", "localdate", "localdatetime",
  "date", "instant", "uuid", "object",
]);

function isScalarType(type?: string): boolean {
  if (!type) return true;
  const t = type.trim();
  if (t.includes("<")) return true; // handled by collectionElementType first
  return SCALAR_TYPES.has(t.replace(/\[\]$/, "").toLowerCase());
}

/** "List<com.a.Item>" / "Set<Item>" / "Item[]" -> element type, else null. */
function collectionElementType(type?: string): string | null {
  if (!type) return null;
  const t = type.trim();
  const generic = t.match(/^(?:java\.util\.)?(?:List|Set|Collection|ArrayList|LinkedList)\s*<\s*([\w.$]+)\s*>$/);
  if (generic) return generic[1]!;
  if (t.endsWith("[]")) return t.slice(0, -2).trim();
  return null;
}

/**
 * Resolve a nested/project type to a source file. Prefers a dedicated file via
 * findTypeFile; falls back to the current file when the type is a static/inner
 * class declared there (e.g. LpaMappedResponse.Message — no Message.java).
 */
function resolveNestedTypeSource(options: {
  adapter: ReturnType<typeof adapterFor>;
  worktree?: string;
  typeName: string;
  currentFile: string;
  currentSource: string;
  currentParsed: ReturnType<ReturnType<typeof adapterFor>["parse"]>;
}): { file: string; source: string; via: "file" | "same-file" } | null {
  const simple = simpleTypeName(options.typeName);
  if (options.worktree) {
    const found = findTypeFile(options.worktree, options.typeName);
    if (found) {
      return { file: found, source: readFileSync(found, "utf8"), via: "file" };
    }
  }
  const declaredInFile =
    options.currentParsed.classes.some((c) => c.name === simple) ||
    options.adapter.targetFields(options.currentParsed, simple).length > 0;
  if (declaredInFile) {
    return {
      file: options.currentFile,
      source: options.currentSource,
      via: "same-file",
    };
  }
  return null;
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
  diagnostics: string[];
}): SourceField[] {
  const { adapter, worktree, typeName, prefix, depth, visitedTypes, nested, diagnostics } = options;
  const parsed = adapter.parse(options.typeFilePath, options.typeSource);
  const fields = adapter.targetFields(parsed, typeName);
  const out: SourceField[] = [];

  for (const f of fields) {
    const dotted = prefix ? `${prefix}.${f.name}` : f.name;

    // Collections: expand the ELEMENT type under "path[]." when it is a
    // resolvable project class; scalar-element collections stay a leaf.
    const elementType = collectionElementType(f.type);
    if (elementType && depth < MAX_NEST_DEPTH && !isScalarType(elementType)) {
      const elemSimple = simpleTypeName(elementType);
      if (visitedTypes.has(elemSimple)) {
        diagnostics.push(`${dotted}: type "${elemSimple}" is an ancestor (cycle guard); kept as leaf`);
        out.push({ ...f, name: dotted });
        continue;
      }
      const resolved = resolveNestedTypeSource({
        adapter,
        worktree,
        typeName: elementType,
        currentFile: options.typeFilePath,
        currentSource: options.typeSource,
        currentParsed: parsed,
      });
      if (!resolved) {
        diagnostics.push(
          `${dotted}: collection element type "${elementType}" — no .java file or same-file nested class; kept as leaf`,
        );
        out.push({ ...f, name: dotted });
        continue;
      }
      const listPrefix = `${dotted}[]`;
      nested.push({ pathPrefix: listPrefix, typeName: elemSimple });
      try {
        out.push(
          ...flattenTargetType({
            adapter, worktree,
            typeName: elemSimple,
            typeSource: resolved.source,
            typeFilePath: resolved.file,
            prefix: listPrefix,
            depth: depth + 1,
            visitedTypes: new Set([...visitedTypes, elemSimple]),
            nested, diagnostics,
          }),
        );
        continue;
      } catch (err) {
        diagnostics.push(
          `${dotted}: element type "${elemSimple}" found but parse failed (${(err as Error).message}); kept as leaf`,
        );
      }
      out.push({ ...f, name: dotted });
      continue;
    }

    if (isScalarType(f.type)) {
      out.push({ ...f, name: dotted });
      continue;
    }
    if (depth >= MAX_NEST_DEPTH) {
      diagnostics.push(`${dotted}: type "${f.type}" not expanded — depth limit ${MAX_NEST_DEPTH}`);
      out.push({ ...f, name: dotted });
      continue;
    }
    const childType = simpleTypeName(f.type!.replace(/\[\]$/, ""));
    if (visitedTypes.has(childType)) {
      diagnostics.push(`${dotted}: type "${childType}" is an ancestor (cycle guard); kept as leaf`);
      out.push({ ...f, name: dotted });
      continue;
    }
    const resolved = resolveNestedTypeSource({
      adapter,
      worktree,
      typeName: f.type!,
      currentFile: options.typeFilePath,
      currentSource: options.typeSource,
      currentParsed: parsed,
    });
    if (!resolved) {
      diagnostics.push(
        worktree
          ? `${dotted}: type "${f.type}" — no .java file or same-file nested class; kept as leaf`
          : `${dotted}: type "${f.type}" not expanded — no worktree available (set MAPPER_WORKTREE or pass --worktree)`,
      );
      out.push({ ...f, name: dotted });
      continue;
    }
    nested.push({ pathPrefix: dotted, typeName: childType });
    try {
      out.push(
        ...flattenTargetType({
          adapter, worktree,
          typeName: childType,
          typeSource: resolved.source,
          typeFilePath: resolved.file,
          prefix: dotted,
          depth: depth + 1,
          visitedTypes: new Set([...visitedTypes, childType]),
          nested, diagnostics,
        }),
      );
    } catch (err) {
      diagnostics.push(
        `${dotted}: type "${childType}" (${resolved.via}) parse failed (${(err as Error).message}); kept as leaf`,
      );
      out.push({ ...f, name: dotted });
    }
  }
  return out;
}

/**
 * When a saved schema exists, its target leaf paths are the checklist universe
 * (and what the agent may label). Analyzer write sites still attach as slices.
 * Schema fields without a matching write stay labelable (`unresolved`), not
 * hard-`unmapped` — the user explicitly asked for those fields.
 */
function applySchemaChecklist(
  schemaPaths: string[],
  targetClass: string,
  slices: WriteSlice[],
  sourceJava: string,
  diagnostics: string[],
): {
  declared: SourceField[];
  checklistSource: "schema";
  report: AuditReport;
  tasks: FieldTask[];
} {
  const declared: SourceField[] = schemaPaths.map((name) => ({
    className: targetClass,
    name,
    line: 0,
  }));
  diagnostics.push(
    `checklist from saved schema (${schemaPaths.length} target leaf field${schemaPaths.length === 1 ? "" : "s"})`,
  );

  const byField = new Map<string, WriteSlice[]>();
  for (const s of slices) {
    const key = norm(s.targetField);
    if (!byField.has(key)) byField.set(key, []);
    byField.get(key)!.push(s);
  }
  function slicesFor(fieldName: string): WriteSlice[] {
    const full = byField.get(norm(fieldName));
    if (full?.length) return full;
    return byField.get(norm(fieldName.split(".").pop()!.replace(/\[\]$/, ""))) ?? [];
  }

  const checklist = schemaPaths.map((field) => {
    const fieldSlices = slicesFor(field);
    if (fieldSlices.length > 0) {
      return {
        field,
        state: "mapped" as const,
        writes: fieldSlices.map((w) => ({
          line: w.line,
          via: w.via,
          inMethod: w.inMethod,
        })),
      };
    }
    return {
      field,
      state: "unresolved" as const,
      writes: [],
      note: "schema field; no matching write site — agent may label from full mapper source",
    };
  });

  const mapped = checklist.filter((c) => c.state === "mapped").length;
  const unresolved = checklist.filter((c) => c.state === "unresolved").length;
  const report: AuditReport = {
    sourceFile: "",
    targetClass,
    declaredFields: declared.length,
    mapped,
    unmapped: 0,
    unresolved,
    gatePassed: true,
    checklist,
    orphanWrites: [],
  };

  diagnostics.push(
    ...missDiagnostics(
      sourceJava,
      slices,
      checklist.filter((c) => c.state === "unresolved").map((c) => c.field),
    ),
  );

  const tasks: FieldTask[] = checklist.map((entry) => {
    const fieldSlices = slicesFor(entry.field);
    return {
      field: entry.field,
      state: entry.state,
      slices: fieldSlices,
      sliceText: fieldSlices.map((s) => s.sliceText).join("\n\n"),
      note: entry.note,
    };
  });

  return { declared, checklistSource: "schema", report, tasks };
}

function schemaOnlyFallback(
  options: { mapper: MapperEntry; sourceJava: string },
  schemaPaths: string[],
  err: unknown,
): LabelTasks {
  const mapperClass = simpleTypeName(options.mapper.class);
  const targetClass = simpleTypeName(options.mapper.targetType);
  const diagnostics = [
    `analyzer unavailable (${err instanceof Error ? err.message : String(err)}); using schema fields only`,
  ];
  const { report, tasks, checklistSource } = applySchemaChecklist(
    schemaPaths,
    targetClass,
    [],
    options.sourceJava,
    diagnostics,
  );
  diagnostics.push(
    ...injectionDiagnostics(tasks.map((t) => ({ field: t.field, sliceText: t.sliceText }))),
  );
  return {
    report,
    tasks,
    mapperClass,
    targetClass,
    checklistSource,
    diagnostics,
  };
}

/**
 * --no-cst (KOD-1/2/7/8): skip the deterministic CST write-site scan entirely
 * and hand every schema field to the agent as "unresolved" (no slice), so the
 * AI write-site miner + escalation path become the sole source of the
 * checklist. This is the escape hatch for a CST parser bug on new syntax —
 * requires a saved schema, since without one there is no other source for the
 * checklist universe at all.
 */
function skipCstFallback(
  options: { mapper: MapperEntry; sourceJava: string },
  schemaPaths: string[],
): LabelTasks {
  const mapperClass = simpleTypeName(options.mapper.class);
  const targetClass = simpleTypeName(options.mapper.targetType);
  if (schemaPaths.length === 0) {
    throw new Error(
      `--no-cst requires a saved schema (registry/schemas/${options.mapper.id}.schema.json) — ` +
        "the CST scan is skipped, so there is no other source for the checklist universe. " +
        "Save a schema in the pipeline viewer (Edit schema) first, or drop --no-cst.",
    );
  }
  const diagnostics = [
    "--no-cst: CST scan skipped; checklist from saved schema only — every field starts " +
      "unresolved and is settled by the AI write-site miner / escalation path",
  ];
  const { report, tasks, checklistSource } = applySchemaChecklist(
    schemaPaths,
    targetClass,
    [], // no slices — the CST scan did not run
    options.sourceJava,
    diagnostics,
  );
  diagnostics.push(
    ...injectionDiagnostics(tasks.map((t) => ({ field: t.field, sliceText: t.sliceText }))),
  );
  return { report, tasks, mapperClass, targetClass, checklistSource, diagnostics };
}

/**
 * Deterministic pre-pass. Throws if the source cannot be parsed and no saved
 * schema supplies field paths — callers may fall back to selector-only export.
 */
export function buildLabelTasks(options: {
  mapper: MapperEntry;
  sourceJava: string;
  language?: string;
  /** Worktree root — used to resolve the target type when it lives in another file. */
  worktree?: string;
  /** --no-cst — skip the CST scan; see skipCstFallback. Default false. */
  skipCst?: boolean;
}): LabelTasks {
  const schemaPaths = schemaTargetLeafPaths(options.mapper.id);
  const language = options.language ?? "java";
  const mapperClass = simpleTypeName(options.mapper.class);
  const targetClass = simpleTypeName(options.mapper.targetType);

  if (options.skipCst) {
    return skipCstFallback(options, schemaPaths);
  }

  let parsed: ReturnType<typeof scanWriteSites>["parsed"];
  let slices: WriteSlice[];
  try {
    ({ parsed, slices } = scanWriteSites({
      filePath: options.mapper.sourceFile,
      language,
      mapperClass,
      targetClass,
      source: options.sourceJava,
      worktree: options.worktree,
    }));
  } catch (err) {
    if (schemaPaths.length > 0) return schemaOnlyFallback(options, schemaPaths, err);
    throw err;
  }

  const adapter = adapterFor(language);
  let declared = adapter.targetFields(parsed, targetClass);
  let checklistSource: "target-type" | "write-sites" | "schema" = "target-type";
  let targetTypeFile: string | undefined;

  // Target type in a separate file (the common real-world case): resolve it
  // via package-path convention / bounded walk, parse it, read its fields.
  const nestedTypes: NestedTypeRef[] = [];
  const diagnostics: string[] = [];
  if (declared.length === 0 && !options.worktree) {
    diagnostics.push(
      `target type "${options.mapper.targetType}" not declared in the mapper file and no worktree available — ` +
        "nested fields cannot be expanded (set MAPPER_WORKTREE in .env or pass --worktree)",
    );
  }
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
          diagnostics,
        });
        if (declared.length > 0) targetTypeFile = file;
      } catch (err) {
        diagnostics.push(
          `target type file found but parse failed (${(err as Error).message}) — falling back`,
        );
      }
    } else {
      diagnostics.push(
        `target type "${options.mapper.targetType}" — no .java file found under worktree "${options.worktree}"`,
      );
    }
  }

  // Nested writes: instances of nested types are usually built inside the
  // mapper (or its helpers); scan write sites against each nested type in the
  // mapper source and prefix them with the nested path.
  // Multi-instance: setX(var) / setX(helper) / builder .x(var) / withX(var),
  // plus reassignment-aware var segments and nested Type.builder() chains.
  const extraSites: WriteSite[] = [];
  const byType = new Map<string, NestedTypeRef[]>();
  for (const ref of nestedTypes) {
    if (!byType.has(ref.typeName)) byType.set(ref.typeName, []);
    byType.get(ref.typeName)!.push(ref);
  }
  for (const [typeName, refs] of byType) {
    const sites = adapter
      .findWriteSites(parsed, options.sourceJava, typeName)
      .filter((site) => writeSiteBelongsToType(parsed, site, typeName));
    if (sites.length === 0) continue;

    if (refs.length === 1) {
      for (const site of sites) {
        extraSites.push({ ...site, targetField: `${refs[0]!.pathPrefix}.${site.targetField}` });
      }
      continue;
    }

    const { attributed, unattributed } = attributeMultiInstanceWrites({
      source: options.sourceJava,
      typeName,
      refs,
      sites,
    });
    for (const { site, pathPrefix } of attributed) {
      extraSites.push({
        ...site,
        targetField: `${pathPrefix}.${site.targetField}`,
      });
    }
    for (const site of unattributed) {
      diagnostics.push(
        `multi-instance-unattributed type "${typeName}" line ${site.line} ` +
          `field ${site.targetField} — applied to all ${refs.length} parent candidates`,
      );
    }
  }
  if (extraSites.length > 0) {
    // Nested expansion produces path-prefixed sites (order.details.customer.firstName).
    // The top-level scan may already have a same-line LEAF site (firstName) — e.g. when
    // `new Outer.Inner()` registers a receiver name that collides with a nested var.
    // Skipping the prefixed site left checklist fields "mapped" (auditGate leaf-matches)
    // but with empty task.sliceText (exact-path lookup). Upgrade the leaf in place and
    // keep its rich helper-closure slice text. Never let a different dotted path steal
    // an already-attributed nested site.
    for (const site of extraSites) {
      const leaf = norm(site.targetField.split(".").pop()!);
      const existingIdx = slices.findIndex(
        (x) => x.line === site.line && norm(x.targetField.split(".").pop()!) === leaf,
      );
      if (existingIdx >= 0) {
        const existing = slices[existingIdx]!;
        if (norm(existing.targetField) === norm(site.targetField)) continue;
        if (!existing.targetField.includes(".")) {
          slices[existingIdx] = { ...existing, targetField: site.targetField };
        }
        continue;
      }
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

  // Prefer saved schema as the agent/checklist universe when present.
  if (schemaPaths.length > 0) {
    const applied = applySchemaChecklist(
      schemaPaths,
      targetClass,
      slices,
      options.sourceJava,
      diagnostics,
    );
    checklistSource = applied.checklistSource;
    diagnostics.push(
      ...injectionDiagnostics(
        applied.tasks.map((t) => ({ field: t.field, sliceText: t.sliceText })),
      ),
    );
    return {
      report: applied.report,
      tasks: applied.tasks,
      mapperClass,
      targetClass,
      checklistSource,
      targetTypeFile,
      diagnostics,
    };
  }

  // Last resort: derive the checklist from the writes themselves. Functional,
  // but explicitly weaker — unmapped fields cannot be detected this way.
  if (declared.length === 0) {
    checklistSource = "write-sites";
    diagnostics.push(
      "checklist derived from write sites only — unmapped fields cannot be detected in this mode",
    );
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
        `Save a schema in the pipeline viewer (Edit schema), check registry targetType/class, or pass --worktree.`,
    );
  }

  const report = runAuditGate({
    parsed,
    source: options.sourceJava,
    targetClass,
    declaredFields: declared,
    writeSites: slices,
  });

  // PAR-1 / PAR-2 — convert the "unmapped looks like a miss" blind spot into diagnostics.
  diagnostics.push(
    ...missDiagnostics(
      options.sourceJava,
      slices,
      report.checklist.filter((c) => c.state === "unmapped").map((c) => c.field),
    ),
  );

  const byField = new Map<string, WriteSlice[]>();
  for (const s of slices) {
    const key = norm(s.targetField);
    if (!byField.has(key)) byField.set(key, []);
    byField.get(key)!.push(s);
  }

  /** Same leaf fallback auditGate uses when matching writes to dotted checklist paths. */
  function slicesFor(fieldName: string): WriteSlice[] {
    const full = byField.get(norm(fieldName));
    if (full?.length) return full;
    return byField.get(norm(fieldName.split(".").pop()!)) ?? [];
  }

  const tasks: FieldTask[] = report.checklist.map((entry) => {
    const fieldSlices = slicesFor(entry.field);
    return {
      field: entry.field,
      state: entry.state,
      slices: fieldSlices,
      sliceText: fieldSlices.map((s) => s.sliceText).join("\n\n"),
      note: entry.note,
    };
  });

  // Prompt-injection posture — suspicious imperative comments in slices.
  diagnostics.push(
    ...injectionDiagnostics(tasks.map((t) => ({ field: t.field, sliceText: t.sliceText }))),
  );

  return { report, tasks, mapperClass, targetClass, checklistSource, targetTypeFile, diagnostics };
}
