/**
 * Invert per-field helper closures: a helper used by two or more target
 * fields is "shared". Deterministic — no model call.
 *
 * Sharing is defined by the Java method appearing in helperClosure, not by
 * two pipelines happening to have the same TRANSFORM op (inline .trim() on
 * two write sites is not shared).
 */

export interface HelperClosureName {
  name: string;
}

export interface FieldHelperInput {
  field: string;
  slices: Array<{ helperClosure?: HelperClosureName[] }>;
}

export interface SharedHelperRef {
  /** Helper as recorded on the slice (`trimValue` or `Utils.trimValue`). */
  name: string;
  /** Other target fields whose closures also include this helper. */
  fields: string[];
}

function helperSimpleName(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes(".") ? trimmed.slice(trimmed.lastIndexOf(".") + 1) : trimmed;
}

function isExcluded(name: string, exclude: Set<string>): boolean {
  if (!name) return true;
  return exclude.has(name) || exclude.has(helperSimpleName(name));
}

/**
 * For each field, list helpers that also appear in another field's closure.
 * `excludeNames` is typically the mapper entry method (`map`) so the entry
 * itself never counts as a shared helper.
 */
export function sharedHelpersByField(
  tasks: FieldHelperInput[],
  excludeNames: readonly string[] = [],
): Map<string, SharedHelperRef[]> {
  const exclude = new Set(excludeNames.map((n) => n.trim()).filter(Boolean));
  const helperToFields = new Map<string, Set<string>>();

  for (const task of tasks) {
    const names = new Set<string>();
    for (const slice of task.slices ?? []) {
      for (const helper of slice.helperClosure ?? []) {
        if (isExcluded(helper.name, exclude)) continue;
        names.add(helper.name);
      }
    }
    for (const name of names) {
      let set = helperToFields.get(name);
      if (!set) {
        set = new Set();
        helperToFields.set(name, set);
      }
      set.add(task.field);
    }
  }

  const out = new Map<string, SharedHelperRef[]>();
  for (const task of tasks) {
    const refs: SharedHelperRef[] = [];
    const seen = new Set<string>();
    for (const slice of task.slices ?? []) {
      for (const helper of slice.helperClosure ?? []) {
        if (seen.has(helper.name) || isExcluded(helper.name, exclude)) continue;
        seen.add(helper.name);
        const users = helperToFields.get(helper.name);
        if (!users || users.size < 2) continue;
        const others = [...users].filter((field) => field !== task.field).sort((a, b) =>
          a.localeCompare(b),
        );
        if (others.length === 0) continue;
        refs.push({ name: helper.name, fields: others });
      }
    }
    out.set(task.field, refs);
  }
  return out;
}

/** Union of every other field that shares a helper with `field`. */
export function fieldsSharingWith(
  field: string,
  byField: Map<string, SharedHelperRef[]>,
): string[] {
  const refs = byField.get(field) ?? [];
  return [...new Set(refs.flatMap((r) => r.fields))].sort((a, b) => a.localeCompare(b));
}
