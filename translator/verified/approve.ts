/**
 * Approve pending-review fields in the verified store.
 *
 *   npm run verified:approve -- --mapper <id> --worktree <path>
 */

import { parseArgs } from "node:util";
import { paths, getEnvOptional } from "../../src/config/env.js";
import { resolveMapperAst } from "../resolvePipeline.js";
import { loadSchemaJson } from "../model/index.js";
import {
  approveVerified,
  computeVerifiedFingerprint,
  countByStatus,
  diffAgainstPrevious,
  getVerified,
} from "./store.js";

const isMain =
  process.argv[1]?.endsWith("approve.ts") ||
  process.argv[1]?.endsWith("approve.js");

if (isMain) {
  const { values } = parseArgs({
    options: {
      mapper: { type: "string" },
      worktree: { type: "string" },
      registry: { type: "string", default: paths.registry },
      fingerprint: { type: "string" },
      json: { type: "boolean", default: false },
      diff: { type: "boolean", default: false },
    },
  });
  if (!values.mapper) {
    console.error("Usage: npm run verified:approve -- --mapper <id> --worktree <path>");
    process.exit(1);
  }
  const worktree =
    values.worktree ?? (getEnvOptional("MAPPER_WORKTREE") || undefined);
  let fingerprint = values.fingerprint;
  if (!fingerprint) {
    const resolved = await resolveMapperAst(values.mapper, values.registry!, {
      worktree,
      remote: false,
    });
    fingerprint = computeVerifiedFingerprint({
      sourceJava: resolved.sourceJava,
      schemaJson: loadSchemaJson(values.mapper),
    });
  }
  const before = getVerified(values.mapper, fingerprint);
  if (!before) {
    console.error(`No verified entry for ${values.mapper} @ ${fingerprint.slice(0, 12)}…`);
    process.exit(1);
  }
  if (values.diff) {
    const d = diffAgainstPrevious(values.mapper, fingerprint);
    console.log(
      JSON.stringify(
        {
          fingerprint,
          previousFingerprint: d.previousFingerprint,
          counts: countByStatus(before),
          diff: d.rows.filter((r) => r.change !== "unchanged"),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  const res = approveVerified({ mapperId: values.mapper, fingerprint });
  if (!res) {
    console.error("approve failed");
    process.exit(1);
  }
  const after = getVerified(values.mapper, fingerprint)!;
  if (values.json) {
    console.log(
      JSON.stringify(
        { approved: res.approved, file: res.file, counts: countByStatus(after) },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Approved ${res.approved} field(s) → verified  (${res.file})\n` +
        `counts: ${JSON.stringify(countByStatus(after))}`,
    );
  }
}
