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
3b. Also act as the AI leg for the **full** declared checklist (`fields[].javaTargetField` +
   `audit.unmappedFields`), independently of what `fields[]`/`auditState` already say — the
   same role `translator/agentloop/aiWriteSiteMiner.ts` plays online, except offline you produce
   the second opinion yourself instead of a second HTTP call. For any write you find, note the
   field, exact line, and a one-line evidence snippet — only if you can cite a real line; no
   citation, no candidate.
   - If you can execute commands in this context: write your candidates to a JSON file next to
     `job.json` (`{ "candidates": [{ "field": "…", "line": 12, "evidence": "…" }] }`) and run
     `npx tsx translator/agent/reconcileOffline.ts --job <job.json> --candidates <candidates.json>`
     — it calls the *same* `reconcile()` / `verifyCitations()` functions the online path uses, so
     the merge rule is identical, not re-derived from a prompt. Only add a `result.json` entry
     for a field its `aiOnly` bucket confirms.
   - If you cannot execute commands here (plain chat, no terminal access): apply the same rule
     yourself — add an entry only for a candidate you can cite a real line for — and tell the
     user in your summary that `reconcileOffline.ts` was not run, so they can re-verify with it
     later if they want the same guarantee the script gives.
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
