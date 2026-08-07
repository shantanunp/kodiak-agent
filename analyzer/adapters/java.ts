/**
 * Adapter #1 (POC source language).
 *
 * Uses the pure-JS `java-parser` package (no compiler toolchain needed) to get
 * exact class/method/field structure, then enumerates write sites inside the
 * parse-verified method bodies. Statement-level extraction is pattern-based
 * over those verified ranges; a prod hardening pass can swap it for full
 * CST/tree-sitter queries without touching the adapter contract.
 */

import { parse, BaseJavaCstVisitorWithDefaults } from "java-parser";
import type {
  LanguageAdapter,
  ParsedSource,
  SourceClass,
  SourceField,
  SourceMethod,
  WriteSite,
} from "../types.js";

interface Loc {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

class StructureVisitor extends BaseJavaCstVisitorWithDefaults {
  classes: Array<SourceClass & { loc: Loc }> = [];
  methods: Array<{
    name: string;
    className: string;
    headerLoc: Loc;
    bodyLoc: Loc;
    modifiers: string[];
  }> = [];
  fields: Array<{ className: string; name: string; type?: string; line: number }> = [];
  private classStack: string[] = [];

  constructor(private source: string) {
    super();
    this.validateVisitor();
  }

  private currentClass(): string {
    return this.classStack[this.classStack.length - 1] ?? "<top>";
  }

  override classDeclaration(ctx: any): void {
    const normal = ctx.normalClassDeclaration?.[0];
    if (!normal) return;
    const name: string =
      normal.children.typeIdentifier?.[0].children.Identifier?.[0].image ?? "<anon>";
    const loc: Loc = normal.location;
    this.classes.push({ name, startLine: loc.startLine, endLine: loc.endLine, loc });
    this.classStack.push(name);
    this.visit(normal);
    this.classStack.pop();
  }

  override methodDeclaration(ctx: any): void {
    const header = ctx.methodHeader?.[0];
    const name: string =
      header?.children.methodDeclarator?.[0].children.Identifier?.[0].image ?? "<anon>";
    const modifiers: string[] = (ctx.methodModifier ?? [])
      .map((m: any) => Object.keys(m.children)[0])
      .filter(Boolean);
    const bodyLoc: Loc = ctx.methodBody[0].location;
    this.methods.push({
      name,
      className: this.currentClass(),
      headerLoc: header.location,
      bodyLoc,
      modifiers,
    });
    this.visit(ctx.methodBody);
  }

  override fieldDeclaration(ctx: any): void {
    const type = this.slice(ctx.unannType?.[0].location);
    for (const decl of ctx.variableDeclaratorList?.[0].children.variableDeclarator ?? []) {
      const id = decl.children.variableDeclaratorId?.[0].children.Identifier?.[0];
      if (!id) continue;
      this.fields.push({
        className: this.currentClass(),
        name: id.image,
        type: type?.trim(),
        line: id.startLine,
      });
    }
  }

  private slice(loc?: Loc): string | undefined {
    if (!loc) return undefined;
    return this.source.slice(loc.startOffset, loc.endOffset + 1);
  }
}

function extractBalanced(source: string, openIdx: number): { text: string; endIdx: number } {
  // openIdx points at "(" — return content up to its matching ")".
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (inStr) {
      if (ch === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { text: source.slice(openIdx + 1, i), endIdx: i };
    }
  }
  return { text: source.slice(openIdx + 1), endIdx: source.length - 1 };
}

function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}

function decap(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export const javaAdapter: LanguageAdapter = {
  language: "java",

  parse(filePath: string, source: string): ParsedSource {
    const cst = parse(source);
    const v = new StructureVisitor(source);
    v.visit(cst);

    const methods: SourceMethod[] = v.methods.map((m) => ({
      className: m.className,
      name: m.name,
      startLine: m.bodyLoc.startLine,
      endLine: m.bodyLoc.endLine,
      bodyText: source.slice(m.bodyLoc.startOffset, m.bodyLoc.endOffset + 1),
      fullText: source.slice(m.headerLoc.startOffset, m.bodyLoc.endOffset + 1),
      isPrivateOrStaticHelper:
        m.modifiers.includes("Private") || m.modifiers.includes("Static"),
    }));

    return {
      filePath,
      classes: v.classes.map(({ name, startLine, endLine }) => ({ name, startLine, endLine })),
      methods,
      fields: v.fields,
    };
  },

  findWriteSites(parsed: ParsedSource, source: string, targetClass: string): WriteSite[] {
    const sites: WriteSite[] = [];

    // 1) Receivers: local vars / params declared with the target type.
    //    e.g. "DeliveryNotice notice = new DeliveryNotice()" or "(DeliveryNotice notice)"
    const receivers = new Set<string>();
    const declRe = new RegExp(`\\b${targetClass}\\b\\s+(\\w+)\\s*[=;,)]`, "g");
    for (const m of source.matchAll(declRe)) receivers.add(m[1]!);
    // `var x = new Target(...)` and untyped reassignment to a fresh instance
    const newRe = new RegExp(`\\b(\\w+)\\s*=\\s*new\\s+${targetClass}\\b`, "g");
    for (const m of source.matchAll(newRe)) receivers.add(m[1]!);

    if (receivers.size === 0) return sites;

    const recvAlt = [...receivers].join("|");

    // 2) Setter calls: recv.setX( ... )
    const setterRe = new RegExp(`\\b(${recvAlt})\\.set([A-Z]\\w*)\\s*\\(`, "g");
    for (const m of source.matchAll(setterRe)) {
      const openIdx = m.index! + m[0].length - 1;
      const { text, endIdx } = extractBalanced(source, openIdx);
      const line = lineOfOffset(source, m.index!);
      sites.push({
        targetField: decap(m[2]!),
        via: "setter",
        receiver: m[1]!,
        expression: text.trim(),
        inMethod: methodAt(parsed, line),
        line,
        statement: source.slice(m.index!, Math.min(endIdx + 2, source.length)).trim(),
      });
    }

    // 3) Direct field assignment: recv.field = expr;
    const assignRe = new RegExp(`\\b(${recvAlt})\\.(\\w+)\\s*=(?!=)\\s*([^;]+);`, "g");
    for (const m of source.matchAll(assignRe)) {
      const line = lineOfOffset(source, m.index!);
      sites.push({
        targetField: m[2]!,
        via: "assignment",
        receiver: m[1]!,
        expression: m[3]!.trim(),
        inMethod: methodAt(parsed, line),
        line,
        statement: m[0].trim(),
      });
    }

    // 4) Builder chains: TargetClass.builder() ... .x(expr) ... .build()
    const builderStartRe = new RegExp(`\\b${targetClass}\\s*\\.\\s*builder\\s*\\(\\)`, "g");
    for (const m of source.matchAll(builderStartRe)) {
      let i = m.index! + m[0].length;
      // walk .name(args) links until .build()
      const linkRe = /\s*\.\s*(\w+)\s*\(/y;
      for (;;) {
        linkRe.lastIndex = i;
        const link = linkRe.exec(source);
        if (!link) break;
        const openIdx = link.index + link[0].length - 1;
        const { text, endIdx } = extractBalanced(source, openIdx);
        i = endIdx + 1;
        if (link[1] === "build") break;
        const line = lineOfOffset(source, link.index);
        sites.push({
          targetField: link[1]!,
          via: "builder",
          receiver: `${targetClass}.builder()`,
          expression: text.trim(),
          inMethod: methodAt(parsed, line),
          line,
          statement: `.${link[1]}(${text.trim()})`,
        });
      }
    }

    // 5) Map-style put: recv.put("key", expr)
    const putRe = new RegExp(`\\b(${recvAlt})\\.put\\s*\\(\\s*"(\\w+)"\\s*,`, "g");
    for (const m of source.matchAll(putRe)) {
      const openIdx = source.indexOf("(", m.index!);
      const { text, endIdx } = extractBalanced(source, openIdx);
      const line = lineOfOffset(source, m.index!);
      sites.push({
        targetField: m[2]!,
        via: "map-put",
        receiver: m[1]!,
        expression: text.slice(text.indexOf(",") + 1).trim(),
        inMethod: methodAt(parsed, line),
        line,
        statement: source.slice(m.index!, Math.min(endIdx + 2, source.length)).trim(),
      });
    }

    return sites.sort((a, b) => a.line - b.line);
  },

  targetFields(parsed: ParsedSource, targetClass: string): SourceField[] {
    const declared = parsed.fields.filter((f) => f.className === targetClass);
    // Union with setter-derived fields, in case the target uses setters without
    // visible backing fields (generated/partial sources).
    const seen = new Set(declared.map((f) => f.name.toLowerCase()));
    for (const m of parsed.methods) {
      if (m.className !== targetClass) continue;
      const setter = /^set([A-Z]\w*)$/.exec(m.name);
      if (!setter) continue;
      const name = decap(setter[1]!);
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        declared.push({ className: targetClass, name, line: m.startLine });
      }
    }
    return declared;
  },
};

function methodAt(parsed: ParsedSource, line: number): string {
  let best: SourceMethod | undefined;
  for (const m of parsed.methods) {
    if (line >= m.startLine && line <= m.endLine) {
      if (!best || m.endLine - m.startLine < best.endLine - best.startLine) best = m;
    }
  }
  return best?.name ?? "<top-level>";
}
