---
description: "Offline field labeling — complete agent-jobs result.json from job.json (no external model API). Use when asked to complete/label an offline agent job, or when .cache/agent-jobs/**/job.json is open."
applyTo: ".cache/agent-jobs/**/*"
---

# Kodiak offline field labeling

When asked to complete an offline label job (or `.cache/agent-jobs/**/job.json` is in context):

1. Read `job.json` in the same folder — **all data is in the file**:
   - `sourceJava` — full mapper class source
   - `schemaJson` + `schemaContext` — allowed business paths
   - `mapper` — registry metadata (class, entryMethod, sourceType, targetType)
   - `fields[]` — each `businessFieldSelector` the user asked to label
   - `audit.unmappedFields` — fields the CST scan found no write for at all (see step 3b)
2. Follow `systemPrompt` and `schemaContext` exactly — same rules as the live model API.
3. For **each** entry in `fields[]`, find the Java write in `sourceJava` (prefer `fields[].slice` when present) and produce a `FieldMappingResponse`:
   - `recognized` (boolean)
   - `targetField` (business path from schema, e.g. `DeliveryPayload.shipTo.postalCode`)
   - `pipeline` (array of steps: read / filter / transform / constant / …)
   - `reason` (short string)
   - If the slice has `// control flow:` headers, each header **must** become a `filter` step (even for plain getter→setter).
3b. Also act as the AI write-site miner for `job.audit.unmappedFields` (the deterministic CST
   scan found no write for these at all — this is the same role
   `translator/agentloop/aiWriteSiteMiner.ts` plays online, except offline you can resolve the
   field directly instead of only flagging it). Re-scan the full `sourceJava` for each field in
   that list; if you find a real write the CST patterns missed (reflection, bulk-copy utility,
   lambda, method reference, unusual builder/collection call) **and can cite its exact line**,
   add a new entry for it to `result.json`'s `fields[]` even though it wasn't in `job.fields[]`.
   No citation, no entry — leave it unmapped rather than guess.
4. Write **only** `result.json` next to `job.json`:

```json
{
  "mapperId": "<same as job>",
  "fingerprint": "<same as job>",
  "labelModel": "agent:offline",
  "fields": [
    {
      "javaTargetField": "<from job.fields[i].javaTargetField>",
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
6. Do **not** run npm commands yourself.
7. After writing `result.json`, print `vscodeSteps` from the job for the user — they run these in the **VS Code integrated terminal**:

```
npm run label:import -- --result <path-to-result.json> [--fields ...]
npm run label -- --mapper <id> --from-cache-only [--fields ...]
npm run ui:serve
```

Copy the exact commands from `job.vscodeSteps` (steps 3 onward).
