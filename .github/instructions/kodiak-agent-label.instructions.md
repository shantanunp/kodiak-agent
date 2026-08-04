---
description: "Offline field labeling — complete agent-jobs result.json from job.json (no external model API). Use when asked to complete/label an offline agent job, or when .cache/agent-jobs/**/job.json is open."
applyTo: ".cache/agent-jobs/**/*"
---

# Kodiak offline field labeling

When asked to complete an offline label job (or `.cache/agent-jobs/**/job.json` is in context):

1. Read `job.json` in the same folder.
2. Follow `systemPrompt` and `schemaContext` exactly — same rules as the live model API.
3. For **each** entry in `fields[]`, produce a `FieldMappingResponse`:
   - `recognized` (boolean)
   - `targetField` (business path from schema, e.g. `DeliveryPayload.shipTo.postalCode`)
   - `pipeline` (array of steps: read / transform / constant / …)
   - `reason` (short string)
4. Write **only** `result.json` next to `job.json` with this shape:

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
6. After writing `result.json`, tell the user to run `npm run label:import`, then
   `npm run label -- --mapper <id> --from-cache-only`.
