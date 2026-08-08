/**
 * Verified store — permanent, git-tracked labeled mappings.
 *
 * registry/verified/{mapperId}/{fingerprint}.json
 *
 * Fingerprint = SHA-256 of (source bytes + mapper schema) ONLY.
 * Deliberately excludes model name and prompt version: the truth of a mapping
 * does not depend on which model (or which agent) found it. Same unchanged
 * source -> same fingerprint -> same stored answer, byte for byte, forever.
 *
 * Precedence everywhere: verified store > runtime caches > model/agent.
 * Deleting .cache/ never affects this store. Entries land here in two ways:
 *   - promotion of a labeling result (label --promote → pending-review by default)
 *   - a user correction confirmed by the judge (field-level upsert)
 * Approve flips pending-review → verified (review checkpoint before "done").
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "../../src/config/env.js";

export const VERIFIED_STORE_FORMAT = 1;

export type VerifiedFieldStatus = "verified" | "user-corrected" | "pending-review";

export interface VerifiedFieldEntry {
  targetField: string;
  pipeline: unknown[];
  status: VerifiedFieldStatus;
  /** Who produced it: model id, "agent:offline", or "judge" for corrections. */
  labeledBy: string;
  labeledAt: string;
  /** For user corrections: the user's claim and the judge's evidence. */
  correction?: {
    userClaim: string;
    judgeEvidence: string;
    correctedAt: string;
  };
}

export interface VerifiedEntry {
  format: number;
  mapperId: string;
  /** Content fingerprint (source + schema). */
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  fields: VerifiedFieldEntry[];
}

export function verifiedRoot(): string {
  return process.env.KODIAK_VERIFIED_DIR ?? join(paths.root, "registry", "verified");
}

function entryFile(mapperId: string, fingerprint: string): string {
  return join(verifiedRoot(), mapperId, `${fingerprint}.json`);
}

/** Content-only fingerprint — no model, no prompt version. */
export function computeVerifiedFingerprint(parts: {
  sourceJava: string;
  schemaJson: string;
}): string {
  return createHash("sha256")
    .update(`${parts.schemaJson}\n---\n${parts.sourceJava}`)
    .digest("hex");
}

export function getVerified(mapperId: string, fingerprint: string): VerifiedEntry | null {
  const file = entryFile(mapperId, fingerprint);
  if (!existsSync(file)) return null;
  const entry = JSON.parse(readFileSync(file, "utf8")) as VerifiedEntry;
  return entry.format === VERIFIED_STORE_FORMAT ? entry : null;
}

function writeEntry(entry: VerifiedEntry): string {
  const file = entryFile(entry.mapperId, entry.fingerprint);
  mkdirSync(join(verifiedRoot(), entry.mapperId), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2));
  renameSync(tmp, file);
  return file;
}

/**
 * Promote a full labeled mapping into the store. Existing user-corrected
 * fields for the same fingerprint always win over the incoming version —
 * a re-label must never overwrite a confirmed correction.
 *
 * Default status is `pending-review` (human checkpoint). Pass
 * `status: "verified"` or call `approveVerified` after review.
 */
export function promoteToVerified(options: {
  mapperId: string;
  fingerprint: string;
  mapping: Array<{ targetField: string; pipeline: unknown[] }>;
  labeledBy: string;
  /** Default pending-review. */
  status?: "pending-review" | "verified";
}): { file: string; fields: number; keptCorrections: number; status: VerifiedFieldStatus } {
  const now = new Date().toISOString();
  const status: VerifiedFieldStatus = options.status ?? "pending-review";
  const existing = getVerified(options.mapperId, options.fingerprint);
  const corrected = new Map(
    (existing?.fields ?? [])
      .filter((f) => f.status === "user-corrected")
      .map((f) => [f.targetField, f]),
  );

  const fields: VerifiedFieldEntry[] = options.mapping.map((m) => {
    const kept = corrected.get(m.targetField);
    if (kept) return kept;
    return {
      targetField: m.targetField,
      pipeline: m.pipeline,
      status,
      labeledBy: options.labeledBy,
      labeledAt: now,
    };
  });

  // Upsert semantics: any existing field absent from the incoming mapping is
  // kept (corrections and previously verified fields alike), so a partial
  // --fields promote never drops the rest of the entry.
  for (const f of existing?.fields ?? []) {
    if (!fields.some((x) => x.targetField === f.targetField)) fields.push(f);
  }

  const entry: VerifiedEntry = {
    format: VERIFIED_STORE_FORMAT,
    mapperId: options.mapperId,
    fingerprint: options.fingerprint,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    fields: fields.sort((a, b) => a.targetField.localeCompare(b.targetField)),
  };

  return {
    file: writeEntry(entry),
    fields: fields.length,
    keptCorrections: corrected.size,
    status,
  };
}

/** Flip pending-review → verified for an entry (user-corrected unchanged). */
export function approveVerified(options: {
  mapperId: string;
  fingerprint: string;
}): { file: string; approved: number } | null {
  const entry = getVerified(options.mapperId, options.fingerprint);
  if (!entry) return null;
  let approved = 0;
  const fields = entry.fields.map((f) => {
    if (f.status !== "pending-review") return f;
    approved++;
    return { ...f, status: "verified" as const };
  });
  if (approved === 0) {
    return { file: entryFile(entry.mapperId, entry.fingerprint), approved: 0 };
  }
  const file = writeEntry({
    ...entry,
    updatedAt: new Date().toISOString(),
    fields,
  });
  return { file, approved };
}

export function countByStatus(entry: VerifiedEntry): Record<VerifiedFieldStatus, number> {
  const out: Record<VerifiedFieldStatus, number> = {
    verified: 0,
    "user-corrected": 0,
    "pending-review": 0,
  };
  for (const f of entry.fields) out[f.status] = (out[f.status] ?? 0) + 1;
  return out;
}

export interface FieldDiffRow {
  targetField: string;
  change: "added" | "removed" | "kinds-changed" | "unchanged";
  previousKinds?: string[];
  currentKinds?: string[];
}

function kindsOf(pipeline: unknown[]): string[] {
  return pipeline.map((s) => String((s as { kind?: string }).kind ?? "?").toUpperCase());
}

/** Diff current entry vs previous fingerprint (for review UI). */
export function diffAgainstPrevious(
  mapperId: string,
  fingerprint: string,
): { previousFingerprint: string | null; rows: FieldDiffRow[] } {
  const current = getVerified(mapperId, fingerprint);
  if (!current) return { previousFingerprint: null, rows: [] };
  const prev = findPreviousVerified(mapperId, fingerprint);
  if (!prev) {
    return {
      previousFingerprint: null,
      rows: current.fields.map((f) => ({
        targetField: f.targetField,
        change: "added" as const,
        currentKinds: kindsOf(f.pipeline),
      })),
    };
  }
  const prevByLeaf = new Map(
    prev.fields.map((f) => [f.targetField.split(".").pop()!.toLowerCase(), f]),
  );
  const seen = new Set<string>();
  const rows: FieldDiffRow[] = [];
  for (const f of current.fields) {
    const leaf = f.targetField.split(".").pop()!.toLowerCase();
    seen.add(leaf);
    const p = prevByLeaf.get(leaf);
    if (!p) {
      rows.push({
        targetField: f.targetField,
        change: "added",
        currentKinds: kindsOf(f.pipeline),
      });
      continue;
    }
    const a = kindsOf(f.pipeline);
    const b = kindsOf(p.pipeline);
    rows.push({
      targetField: f.targetField,
      change: JSON.stringify(a) === JSON.stringify(b) ? "unchanged" : "kinds-changed",
      previousKinds: b,
      currentKinds: a,
    });
  }
  for (const f of prev.fields) {
    const leaf = f.targetField.split(".").pop()!.toLowerCase();
    if (seen.has(leaf)) continue;
    rows.push({
      targetField: f.targetField,
      change: "removed",
      previousKinds: kindsOf(f.pipeline),
    });
  }
  return { previousFingerprint: prev.fingerprint, rows };
}

/**
 * Keep the current fingerprint plus the newest (keepTotal - 1) stale entries;
 * delete older fingerprints. Default keepTotal = 3.
 */
export function pruneStaleFingerprints(
  mapperId: string,
  currentFingerprint: string,
  keepTotal = 3,
  options?: { dryRun?: boolean },
): { kept: string[]; removed: string[] } {
  const dir = join(verifiedRoot(), mapperId);
  if (!existsSync(dir)) return { kept: [], removed: [] };
  const keep = Math.max(1, keepTotal);
  const stale = listStaleFingerprints(mapperId, currentFingerprint)
    .map((fp) => {
      const e = getVerified(mapperId, fp);
      return { fp, updatedAt: e?.updatedAt ?? "" };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  const keepStale = stale.slice(0, Math.max(0, keep - 1)).map((s) => s.fp);
  const remove = stale.slice(Math.max(0, keep - 1)).map((s) => s.fp);
  if (!options?.dryRun) {
    for (const fp of remove) {
      const file = entryFile(mapperId, fp);
      if (existsSync(file)) unlinkSync(file);
    }
  }
  const kept = [
    ...(existsSync(entryFile(mapperId, currentFingerprint)) ? [currentFingerprint] : []),
    ...keepStale,
  ];
  return { kept, removed: remove };
}

/** Field-level upsert — the judge's path for confirmed user corrections. */
export function upsertCorrectedField(options: {
  mapperId: string;
  fingerprint: string;
  targetField: string;
  pipeline: unknown[];
  userClaim: string;
  judgeEvidence: string;
}): string {
  const now = new Date().toISOString();
  const existing = getVerified(options.mapperId, options.fingerprint);
  const fields = (existing?.fields ?? []).filter(
    (f) => f.targetField !== options.targetField,
  );
  fields.push({
    targetField: options.targetField,
    pipeline: options.pipeline,
    status: "user-corrected",
    labeledBy: "judge",
    labeledAt: now,
    correction: {
      userClaim: options.userClaim,
      judgeEvidence: options.judgeEvidence,
      correctedAt: now,
    },
  });

  return writeEntry({
    format: VERIFIED_STORE_FORMAT,
    mapperId: options.mapperId,
    fingerprint: options.fingerprint,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    fields: fields.sort((a, b) => a.targetField.localeCompare(b.targetField)),
  });
}

/** Stale entries for a mapper (any fingerprint other than the current one). */
export function listStaleFingerprints(mapperId: string, currentFingerprint: string): string[] {
  const dir = join(verifiedRoot(), mapperId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((fp) => fp !== currentFingerprint);
}

/**
 * Previous verified entry for a changed source — handed to the agent as
 * convergence context ("the prior version of this source mapped like this").
 */
export function findPreviousVerified(
  mapperId: string,
  currentFingerprint: string,
): VerifiedEntry | null {
  const stale = listStaleFingerprints(mapperId, currentFingerprint);
  let best: VerifiedEntry | null = null;
  for (const fp of stale) {
    const entry = getVerified(mapperId, fp);
    if (entry && (!best || entry.updatedAt > best.updatedAt)) best = entry;
  }
  return best;
}
