/**
 * Multi-instance attribution — when the same nested type feeds several parent
 * fields, route each nested write to the right dotted path.
 *
 * Routes (parent ← inject):
 *   parent.setX(var) / .withX(var) / builder .x(var)  → by variable
 *   parent.setX(helper(...))                           → by helper method
 *
 * Edges beyond the original setX(var)/setX(helper) path:
 *   - builder-chain parent inject: Record.builder().primary(c1)…
 *   - nested builder writes: Contact.builder().email(…).build() bound to c1
 *   - reassigned variables: Contact c = …; setPrimary(c); c = …; setSecondary(c)
 */

import type { WriteSite } from "../../analyzer/types.js";

/** Nested type under a dotted target path (e.g. primary → Contact). */
export interface NestedTypeRef {
  pathPrefix: string;
  typeName: string;
}

export interface ParentRoute {
  ref: NestedTypeRef;
  /** var name → source lines where it is injected into this parent field. */
  vars: Map<string, number[]>;
  /** Helper method names whose return value is injected (setX(helper(...))). */
  methods: Set<string>;
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/** Lines where `varName` is assigned (`x =` / `Type x =`). */
export function varAssignmentLines(source: string, varName: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`\\b${varName}\\s*=(?!=)`, "g");
  for (const m of source.matchAll(re)) {
    out.push(lineOf(source, m.index!));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Segment of a variable's lifetime containing `atLine` (between reassignments). */
export function varSegment(
  assignments: number[],
  atLine: number,
): { start: number; end: number } {
  let start = 0;
  for (const a of assignments) {
    if (a <= atLine) start = a;
    else break;
  }
  const next = assignments.find((a) => a > atLine);
  return { start, end: next ?? Number.POSITIVE_INFINITY };
}

export function sameVarSegment(
  assignments: number[],
  writeLine: number,
  consumeLine: number,
): boolean {
  if (assignments.length === 0) {
    // No assignments found — fall back to "any write on this var matches".
    return true;
  }
  const a = varSegment(assignments, writeLine);
  const b = varSegment(assignments, consumeLine);
  return a.start === b.start && a.end === b.end;
}

/**
 * Collect parent-field inject routes for a nested type that appears under
 * multiple path prefixes.
 */
export function collectParentRoutes(
  source: string,
  refs: NestedTypeRef[],
): ParentRoute[] {
  return refs.map((ref) => {
    const leaf = ref.pathPrefix.replace(/\[\]$/, "").split(".").pop()!;
    const cap = leaf.charAt(0).toUpperCase() + leaf.slice(1);
    const vars = new Map<string, number[]>();
    const methods = new Set<string>();

    const patterns = [
      // setPrimary(c) / setPrimary(buildBackup(...))
      new RegExp(`\\.set${cap}\\s*\\(\\s*(\\w+)\\s*(\\()?`, "g"),
      // withPrimary(c) fluent
      new RegExp(`\\.with${cap}\\s*\\(\\s*(\\w+)\\s*(\\()?`, "g"),
      // builder .primary(c) / .primary(buildBackup(...))
      new RegExp(`\\.${leaf}\\s*\\(\\s*(\\w+)\\s*(\\()?`, "g"),
    ];

    for (const re of patterns) {
      for (const m of source.matchAll(re)) {
        const name = m[1]!;
        const line = lineOf(source, m.index!);
        if (m[2]) {
          methods.add(name);
        } else {
          if (!vars.has(name)) vars.set(name, []);
          vars.get(name)!.push(line);
        }
      }
    }
    return { ref, vars, methods };
  });
}

/**
 * Variables bound to a `Type.builder()…build()` chain that covers `siteLine`.
 */
export function builderBoundVars(
  source: string,
  typeName: string,
  siteLine: number,
): string[] {
  const out: string[] = [];
  const startRe = new RegExp(
    `\\b(\\w+)\\s*=\\s*${typeName}\\s*\\.\\s*builder\\s*\\(`,
    "g",
  );
  for (const m of source.matchAll(startRe)) {
    const varName = m[1]!;
    const startLine = lineOf(source, m.index!);
    // Find .build() after this builder() — approximate by scanning forward.
    const from = m.index! + m[0].length;
    const rest = source.slice(from);
    const build = rest.match(/\.build\s*\(/);
    const endOffset = build ? from + (build.index ?? 0) : source.length;
    const endLine = lineOf(source, endOffset);
    if (siteLine >= startLine && siteLine <= endLine) {
      out.push(varName);
    }
  }
  return out;
}

function routeMatchesSite(
  route: ParentRoute,
  site: WriteSite,
  source: string,
  typeName: string,
): boolean {
  if (route.methods.has(site.inMethod)) return true;

  const candidateVars = new Set<string>();
  if (route.vars.has(site.receiver)) candidateVars.add(site.receiver);
  if (site.receiver === `${typeName}.builder()`) {
    for (const v of builderBoundVars(source, typeName, site.line)) {
      if (route.vars.has(v)) candidateVars.add(v);
    }
  }

  for (const v of candidateVars) {
    const consumeLines = route.vars.get(v) ?? [];
    const assignments = varAssignmentLines(source, v);
    if (consumeLines.length === 0) continue;
    // Match if the write shares a lifetime segment with any inject of this var.
    if (
      consumeLines.some((c) => sameVarSegment(assignments, site.line, c))
    ) {
      return true;
    }
  }
  return false;
}

export interface AttributionResult {
  attributed: Array<{ site: WriteSite; pathPrefix: string }>;
  /** Write sites that matched no single route (tainted onto all candidates). */
  unattributed: WriteSite[];
}

/**
 * Attribute nested-type write sites to path prefixes under multi-instance parents.
 */
export function attributeMultiInstanceWrites(options: {
  source: string;
  typeName: string;
  refs: NestedTypeRef[];
  sites: WriteSite[];
}): AttributionResult {
  const routes = collectParentRoutes(options.source, options.refs);
  const attributed: AttributionResult["attributed"] = [];
  const unattributed: WriteSite[] = [];

  for (const site of options.sites) {
    const matches = routes.filter((r) =>
      routeMatchesSite(r, site, options.source, options.typeName),
    );
    if (matches.length === 1) {
      attributed.push({ site, pathPrefix: matches[0]!.ref.pathPrefix });
    } else if (matches.length > 1) {
      // Ambiguous (e.g. two parents share the same var in one segment) — taint all matches.
      unattributed.push(site);
      for (const r of matches) {
        attributed.push({ site, pathPrefix: r.ref.pathPrefix });
      }
    } else {
      unattributed.push(site);
      for (const r of routes) {
        attributed.push({ site, pathPrefix: r.ref.pathPrefix });
      }
    }
  }
  return { attributed, unattributed };
}
