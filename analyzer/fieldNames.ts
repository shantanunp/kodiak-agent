/**
 * Shared field-name normalization (KOD-6).
 *
 * Strips punctuation and lowercases, so "recipient_first", "recipientFirst",
 * and "RecipientFirst" all compare equal. Used anywhere a write-site field, a
 * checklist field, or an AI-claimed field need to be matched against each
 * other despite different casing/spelling conventions.
 */
export function normalizeFieldName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}
