/**
 * Offline agent job field groups — no JavaParser indexer required.
 */

import { groupAst, mergeAstOnlyEscapeHatch } from "../model/discoverMerge.js";
import type { FieldMapping } from "../groupMapping.js";
import type { IndexAst } from "../model/index.js";
import { filterMappingByFields } from "../filterByFields.js";

export interface BuildOfflineFieldGroupsOptions {
  ast: IndexAst;
  selectors: string[];
  /** Opt-in JavaParser discovery (needs JDK + build:indexer). Default false. */
  withAst?: boolean;
}

/**
 * Build field groups for an offline export job.
 * Without --with-ast, requires --fields (agent labels from Java source + schema).
 */
export function buildOfflineFieldGroups(
  opts: BuildOfflineFieldGroupsOptions,
): FieldMapping[] {
  const { ast, selectors, withAst = false } = opts;

  let groups: FieldMapping[];
  if (withAst) {
    groups = mergeAstOnlyEscapeHatch(groupAst(ast)).groups;
  } else if (selectors.length === 0) {
    throw new Error(
      "Offline export without indexer requires --fields (e.g. --fields Summary.displayName). " +
        "Or pass --with-ast to use JavaParser field discovery (needs JDK and npm run build:indexer).",
    );
  } else {
    groups = selectors.map((sel) => ({
      targetField: sel,
      pipeline: [],
    }));
  }

  if (selectors.length > 0) {
    groups = filterMappingByFields(groups, selectors);
  }

  return groups;
}
