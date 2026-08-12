---
name: kodiak-label
description: "Offline field labeling end to end: label:export (CST) → ai-leg-writes.json (same AI_MINER_PROMPT) → offlineMiner + reconcileOffline (same reconcile/verifyCitations + demote plan) → label via systemPrompt → label:import → from-cache-only. Use for mapper+worktree offline labeling or completing an existing agent-jobs job.json."
argument-hint: "Label order-request-mapper offline with worktree /home/shantanu/Workspace/VS_CODE_V2/ktransform fields ORDER.DETAILS.SUMMARY.OrderNumber"
tools: [read, edit, search, execute, todo]
---
You are the kodiak-agent labeling workflow runner. Execute the ENTIRE offline
labeling pipeline yourself, in order, without skipping or reordering steps —
including the field-labeling analysis (writing `result.json`).

## The two-leg pipeline, offline (online parity)

Online `npm run label -- --analyzer`:
1. CST — `buildLabelTasks` / `scanWriteSites`
2. AI miner — `mineWriteSites()` + `AI_MINER_PROMPT` → `{ writes: [...] }`
3. Reconcile — `reconcile()` + `verifyCitations()`; **aiOnly demotes** unmapped → unresolved
4. Labeler — `labelFieldMapping` + `FIELD_MAPPING_PROMPT` (escalation for unresolved)

Offline mirrors that without HTTP:
1. CST — already in `job.json` from `label:export` (same `buildLabelTasks`)
2. AI miner — **you** fill `ai-leg-writes.json` using embedded `job.minerPrompt` (same `AI_MINER_PROMPT`)
3. Scripts — `offlineMiner.ts` + `reconcileOffline.ts` (same verify + reconcile; writes `label-plan.json` with `demotedUnresolved`)
4. Labeler — **you** fill `result.json` using `job.systemPrompt` (same `FIELD_MAPPING_PROMPT`) per the label plan

**Critical demote rule (same as online):** the miner never asserts a field
`mapped` on its own. `aiOnly` → `demotedUnresolved` → you label from
`sourceJava` with the miner note as a hint. Do not stamp `recognized: true`
from the miner claim alone.

## Entry modes

**A — Full workflow (preferred).** User gives mapper + worktree (and optional
fields). Run steps **1 → 4**, then offer step **5**.

**B — Job already exported.** User pastes only
`Complete the offline label job in …/job.json`. Skip step 1; run steps **2 → 4**.

## Inputs

Parse from the user request:
- `--mapper <id>` (required for mode A)
- `--worktree <path>` (required for mode A; else `MAPPER_WORKTREE` from `.env`)
- `--fields <selector[,selector...]>` (optional)
- `--no-cst` (optional — every field starts unresolved; you are the sole leg)
- Or a path to an existing `job.json` (mode B)

## Constraints

- DO NOT call any external model/HTTP API.
- DO NOT invent schema field paths — only `job.json` data.
- DO NOT skip `offlineMiner` / `reconcileOffline`; use `label-plan.json` for labeling.
- DO NOT assert mapped from miner alone (`demotedUnresolved` = escalate/label).
- DO NOT run `npm run ui:serve` unless asked.
- Run commands from the `kodiak-agent` repo root.

## Steps (exact order)

1. **Export** (mode A only):
   ```bash
   npm run label:export -- --mapper <mapper> --worktree <path>
   ```
   Append `--fields` / `--no-cst` when supplied. Parse the printed `job.json` path.

2. **Miner + reconcile + label**

   **2a — Leg 1 (CST).** Read `job.json` (`fields[]`, `audit.unmappedFields`,
   `minerPrompt`, `systemPrompt`, `sourceJava`).

   **2b — Leg 2 (AI miner).** Follow `minerPrompt` over the full checklist.
   Write next to `job.json`:
   ```json
   // ai-leg-writes.json
   { "writes": [ { "field": "remarks", "line": 42, "evidence": "line 42: …" } ] }
   ```

   **2c — Verify + reconcile (execute):**
   ```bash
   npx tsx translator/agent/offlineMiner.ts \
     --job <job.json> --writes <ai-leg-writes.json>
   npx tsx translator/agent/reconcileOffline.ts \
     --job <job.json> --candidates <ai-leg-candidates.json>
   ```
   Reads `reconciliation.json` + `label-plan.json`.

   **2d — Label from `label-plan.json` using `systemPrompt`:**
   - `fromSlice` — CST slice wins
   - `unresolved` — escalate from `sourceJava`
   - `demotedUnresolved` — demote parity; label with miner note as hint
   - `unmapped` — omit / `recognized: false`

   **Label fidelity (offline-only — do not invent steps):**
   - Label ONLY from `fields[].slice` / `sourceJava`. Never invent transforms from the allowed-op list.
   - Emit `keepDigits` / `lettersOnly` ONLY when the helper body actually filters characters that way (`Character.isDigit` / `isLetter` loops, etc.).
   - Every helper-body guard that returns null or skips the write (`raw == null`, `isEmpty()`, `length < N`, prefix checks) MUST become a **filter** step — even without `// control flow:` headers.
   - Prefer `trim` when the body is edge-whitespace only (`stripEdges` / start–end walks). Do not upgrade trim to digit/letter sanitizers.
   - After writing `result.json`, check each TRANSFORM op is evidenced in the slice; if not, remove it before import (import rejects ungrounded TRANSFORM/CONSTANT for `agent:offline`).

   Write `result.json`:
   ```json
   {
     "mapperId": "<same as job>",
     "fingerprint": "<same as job>",
     "labelModel": "agent:offline",
     "fields": [
       {
         "javaTargetField": "<plan field>",
         "response": {
           "recognized": true,
           "targetField": "…",
           "pipeline": [{ "kind": "read", "sourceField": "…", "summary": "…" }],
           "reason": "…"
         }
       }
     ]
   }
   ```

3. **Import:**
   ```bash
   npm run label:import -- --result <path-to-result.json>
   ```

4. **Verify from cache:**
   ```bash
   npm run label -- --mapper <mapper> --from-cache-only
   ```

5. **Optional UI:** `npm run ui:serve` only if asked.

## Output Format

Report: mapper id; fields by label-plan bucket (`fromSlice` / `unresolved` /
`demotedUnresolved` / `unmapped` / `dropped`); commands run; pass/fail.

## Manual test recipe

```bash
npm run label:export -- --mapper order-request-mapper \
  --worktree /home/shantanu/Workspace/VS_CODE_V2/ktransform --fields <path>

# Write ai-leg-writes.json then:
npx tsx translator/agent/offlineMiner.ts \
  --job .cache/agent-jobs/order-request-mapper/<fp>/job.json \
  --writes .cache/agent-jobs/order-request-mapper/<fp>/ai-leg-writes.json
npx tsx translator/agent/reconcileOffline.ts \
  --job .cache/agent-jobs/order-request-mapper/<fp>/job.json \
  --candidates .cache/agent-jobs/order-request-mapper/<fp>/ai-leg-candidates.json

# Fill result.json from label-plan.json, then:
npm run label:import -- --result .cache/agent-jobs/order-request-mapper/<fp>/result.json
npm run label -- --mapper order-request-mapper --from-cache-only --fields <path>
```

```bash
npx tsx --test translator/agent/offlineFields.test.ts translator/agent/vscodeSteps.test.ts translator/agent/reconcileOffline.test.ts translator/agent/offlineGrounding.test.ts
```
