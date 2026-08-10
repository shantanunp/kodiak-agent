/**
 * Offline agent job field groups — derived from --fields selectors.
 */

import type { FieldMapping } from "../groupMapping.js";
import { filterMappingByFields } from "../filterByFields.js";

export interface BuildOfflineFieldGroupsOptions {
  selectors: string[];
}

/**
 * Build field groups for an offline export job.
 * Requires --fields (agent labels from Java source + schema).
 */
export function buildOfflineFieldGroups(
  opts: BuildOfflineFieldGroupsOptions,
): FieldMapping[] {
  const { selectors } = opts;

  if (selectors.length === 0) {
    throw new Error(
      "Source could not be analyzed and no field selectors given. " +
        "Save a schema in the pipeline viewer (Edit schema) or pass --fields " +
        "(e.g. --fields Summary.displayName).",
    );
  }

  let groups = selectors.map((sel) => ({
    targetField: sel,
    pipeline: [],
  }));

  groups = filterMappingByFields(groups, selectors);
  return groups;
}
