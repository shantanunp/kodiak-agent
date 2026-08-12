---
description: "Offline field labeling — complete agent-jobs result.json from job.json (no external model API). Use when asked to complete/label an offline agent job, or when .cache/agent-jobs/**/job.json is open."
applyTo: ".cache/agent-jobs/**/*"
---

# Kodiak offline field labeling

## Unified parity rule for online and offline labeling

The online and offline labeling paths must remain functionally identical:

1. Always run the same two-leg structure: deterministic CST scan first, then independent AI write-site miner.
2. Always reconcile with the same rule: CST wins on agreement; AI-only writes may only demote a CST `unmapped` field to `unresolved`; they never assert `mapped` on their own.
3. Always label from the same bucket semantics:
   - `fromSlice` → use the CST slice / `systemPrompt`
   - `unresolved` → escalate from sourceJava / audit note
   - `demotedUnresolved` → label from sourceJava using the miner note as a hint only; never set `recognized: true` from miner claim alone
   - `unmapped` → omit or `recognized: false`
4. Always write the same output shape: a `result.json` with `mapperId`, `fingerprint`, `labelModel`, and one field entry per accepted target.
5. Always verify from cache / verified-store after import in the same way; never bypass the cache check when a mapper was already labeled.

When asked to complete an offline label job (or `.cache/agent-jobs/**/job.json` is in context):

1. Read `job.json` in the same folder — **all data is in the file**:
   - `sourceJava` — full mapper class source
   - `schemaJson` + `schemaContext` — allowed business paths
   - `mapper` — registry metadata (class, entryMethod, sourceType, targetType)
   - `fields[]` — CST leg (same `buildLabelTasks` as online)
   - `audit.unmappedFields` — CST hard-unmapped
   - `minerPrompt` — **exact** online `AI_MINER_PROMPT` (leg 2)
   - `systemPrompt` — **exact** online `FIELD_MAPPING_PROMPT` (labeler)
2. **Leg 2 miner** — follow `minerPrompt` against the full checklist
   (`fields[].javaTargetField` + `audit.unmappedFields`). Write `ai-leg-writes.json`:
   ```json
   { "writes": [{ "field": "remarks", "line": 42, "evidence": "line 42: BulkCopy.apply(…)" }] }
   ```
   Same JSON shape the online miner returns. No citation, no claim.
3. If you can execute commands, run:
   ```
   npx tsx translator/agent/offlineMiner.ts --job <job.json> --writes <ai-leg-writes.json>
   npx tsx translator/agent/reconcileOffline.ts --job <job.json> --candidates <ai-leg-candidates.json>
   ```
   Then label from `label-plan.json` (written next to the job):
   - `fromSlice` — CST wins; use `fields[].slice` + `systemPrompt`
   - `unresolved` — escalate from `sourceJava` (`auditNote`)
   - `demotedUnresolved` — same as online aiOnly demote → unresolved; label from
     `sourceJava` with the note as a **hint**; never assert mapped from the miner alone
   - `unmapped` — omit (or `recognized: false`)
   If you cannot execute: apply the same citation + demote rules yourself and note that
   the scripts were not run.
4. Write **only** `result.json` next to `job.json`:

```json
{
  "mapperId": "<same as job>",
  "fingerprint": "<same as job>",
  "labelModel": "agent:offline",
  "fields": [
    {
      "javaTargetField": "<fromSlice | unresolved | demotedUnresolved>",
      "response": {
        "recognized": true,
        "targetField": "DeliveryPayload.…",
        "pipeline": [{ "kind": "read", "sourceField": "…", "summary": "…" }],
        "reason": "…"
      }
    }
  ]
}
```

5. Do **not** call external model HTTP APIs. Do **not** invent schema field paths.
6. Do **not** run npm import/from-cache yourself — print `job.vscodeSteps` for the user.
7. If the online path is being used, follow the same parity rules and do not let online mode skip the CST/miner/reconcile gate or treat miner-only claims as mapped.
