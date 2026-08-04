/**
 * Filter pipeline/index steps by target field selectors.
 * No selectors → return all steps unchanged.
 */

export interface FieldFilterableStep {
  kind?: string;
  targetField?: string;
  children?: FieldFilterableStep[];
  [key: string]: unknown;
}

function normalize(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function leaf(path: string): string {
  const part = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : path;
  return part.replace(/\[\]$/, "");
}

/** Strip JavaBean get/set/is so setStreetLine matches streetLine. */
function beanLeaf(path: string): string {
  return normalize(leaf(path)).replace(/^(set|get|is)/, "");
}

/** True if targetField matches any selector (leaf, path, or FQN; case/punct insensitive). */
export function matchesTargetField(targetField: string, selectors: string[]): boolean {
  if (!targetField || selectors.length === 0) return false;
  const targetNorm = normalize(targetField);
  const targetLeaf = normalize(leaf(targetField));
  const targetBean = beanLeaf(targetField);

  for (const raw of selectors) {
    const sel = raw.trim();
    if (!sel) continue;
    const selNorm = normalize(sel);
    const selLeaf = normalize(leaf(sel));
    const selBean = beanLeaf(sel);
    if (!selNorm) continue;

    if (targetNorm === selNorm) return true;
    if (targetLeaf === selNorm || targetLeaf === selLeaf) return true;
    if (targetBean && selBean && targetBean === selBean) return true;
    if (targetNorm.endsWith(selNorm) || selNorm.endsWith(targetLeaf)) return true;
    if (targetBean && (selNorm.endsWith(targetBean) || targetNorm.endsWith(selBean))) return true;
  }
  return false;
}

/**
 * Keep steps whose targetField matches any selector, or that have matching children.
 * Empty selectors → identity.
 */
export function filterStepsByFields<T extends FieldFilterableStep>(
  steps: T[],
  fields: string[],
): T[] {
  const selectors = fields.map((f) => f.trim()).filter(Boolean);
  if (selectors.length === 0) return steps;

  const out: T[] = [];
  for (const step of steps) {
    const childFiltered = step.children?.length
      ? filterStepsByFields(step.children as T[], selectors)
      : undefined;
    const selfMatch =
      typeof step.targetField === "string" &&
      matchesTargetField(step.targetField, selectors);

    if (selfMatch) {
      out.push({
        ...step,
        ...(childFiltered ? { children: childFiltered } : {}),
      });
    } else if (childFiltered && childFiltered.length > 0) {
      // Prefer matching leaf steps over wrapper FILTER/BUILD parents
      out.push(...childFiltered);
    }
  }
  return out;
}

/** Parse CLI `--field` repeats and/or `--fields` comma-list into one selector array. */
export function parseFieldSelectors(options: {
  field?: string | string[];
  fields?: string;
}): string[] {
  const fromRepeat = options.field
    ? Array.isArray(options.field)
      ? options.field
      : [options.field]
    : [];
  const fromList = options.fields
    ? options.fields.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return [...fromRepeat, ...fromList];
}

/** Filter grouped mapping entries by targetField. */
export function filterMappingByFields<T extends { targetField?: string }>(
  mapping: T[],
  fields: string[],
): T[] {
  const selectors = fields.map((f) => f.trim()).filter(Boolean);
  if (selectors.length === 0) return mapping;
  return mapping.filter(
    (m) => typeof m.targetField === "string" && matchesTargetField(m.targetField, selectors),
  );
}
