# First setup — monitoring, miss detection, labeling

Bash from the `kodiak-agent` repo root. Mapper used below: `order-request-mapper` (edit `registry/mapping-registry.yaml` for yours).

Two labeling paths:

1. **[With model agent](#1-with-model-agent-online)** — HTTP API (`MODEL_API_KEY` set); Kodiak’s agent-loop labels fields.
2. **[VS Code offline](#2-vscode-offline)** — no API key; export `job.json` → VS Code Copilot/Cursor agent → import.

Shared pieces (wipe, Scorecard, tests) apply to both.

---

## You need


| Tool                           | Notes                                                                      |
| ------------------------------ | -------------------------------------------------------------------------- |
| Node.js 20+                    | `node -v`                                                                  |
| Mapper checkout                | `MAPPER_WORKTREE` in `.env`, or pass `--worktree`                          |
| Model key **or** VS Code agent | online path needs `MODEL_API_KEY`; offline needs Copilot/Cursor agent mode |


```bash
cp .env.example .env   # if needed
npm install
```

```env
MAPPER_WORKTREE=/home/shantanu/Workspace/VS_CODE_V2/ktransform
```

Shell tip: `npm run` does **not** load `$MAPPER_WORKTREE` from `.env` into the shell — `export` it or pass the path literally. Gotcha: npm may print a banner on stdout — when parsing CLI JSON, slice from the first `{`.

---



## Where to see monitoring & miss


| Surface                    | What it shows                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Viewer Scorecard**       | Expand “Scorecard” on `/pipeline-viewer/?mapper=…` — coverage, journal miss signals, live miss list (click → field), recent runs |
| `GET /api/report?mapper=…` | Same payload (uses `MAPPER_WORKTREE` when set)                                                                                   |
| `npm run report`           | CLI scorecard                                                                                                                    |
| `/api/health`              | Ops snapshot (`pendingReview`, stale, `modelConfigured`)                                                                         |
| Viewer field list          | Provenance badges, pending pill, approve bar, expansion diagnostics                                                              |


---



## Shared: wipe old data

**Safe wipe** (keeps verified store):

```bash
npm run cache:clear
rm -f registry/runs.jsonl
rm -rf .cache/metrics
rm -f ui/pipeline-viewer/data/*.view.json   # viewer demo export — otherwise pipelines still show
# optional: rm -f registry/defects.jsonl
```

**Zero old data** (blank slate for one mapper — also clears verified + offline jobs):

```bash
npm run cache:clear
rm -f registry/runs.jsonl registry/defects.jsonl
rm -rf .cache/metrics .cache/agent-jobs .cache/fields
rm -rf registry/verified/order-request-mapper
rm -f ui/pipeline-viewer/data/*.view.json
```

Restart `ui:serve` if running; hard-refresh the browser (Ctrl+Shift+R).

**Shared tests** (no model):

```bash
npm run test:journal && npm run test:report && npm run test:drift
# or: npm run test:all
```

**Shared Scorecard after any label path:**

```bash
export MAPPER_WORKTREE=/home/shantanu/Workspace/VS_CODE_V2/ktransform
npm run report -- --worktree "$MAPPER_WORKTREE" --mapper order-request-mapper
npm run ui:serve
# http://localhost:4173/pipeline-viewer/?mapper=order-request-mapper → expand Scorecard → Refresh
```

---



# 1. With model agent (online)

HTTP model labels fields via Kodiak’s agent-loop. No VS Code job export required.

### 1a. `.env`

```env
MAPPER_WORKTREE=/home/shantanu/Workspace/VS_CODE_V2/ktransform
MODEL_API_STYLE=claude
MODEL_BASE_URL=https://api.anthropic.com/v1
MODEL_NAME=claude-sonnet-4-5
MODEL_API_KEY=sk-ant-...
```



### 1b. Optional wipe, then label

```bash
export MAPPER_WORKTREE=/home/shantanu/Workspace/VS_CODE_V2/ktransform
# optional: shared safe wipe or zero wipe above

npm run label -- \
  --mapper order-request-mapper \
  --worktree "$MAPPER_WORKTREE" \
  --analyzer

npm run label -- --mapper order-request-mapper --worktree /home/shantanu/Workspace/VS_CODE_V2/ktransform --analyzer --fields ORDER.DETAILS.SUMMARY.OrderNumber

# optional: --verify --critic
# optional: --promote          → pending-review
# optional: --promote --approve
```

Viewer: open a field or **Label all mapped** — labels call the model (shows “Labeled from model”).

### 1c. Check journal + Scorecard

```bash
tail -n 1 registry/runs.jsonl | python -m json.tool
npm run report -- --worktree "$MAPPER_WORKTREE" --mapper order-request-mapper
npm run ui:serve
```

Expect journal keys such as `possibleMissedWrites`, `unmappedButMentioned`, `groundingWarnings`, `provenance`, `scores`, `tokens`.

### 1d. Promote / approve (optional)

```bash
npm run label -- --mapper order-request-mapper --worktree "$MAPPER_WORKTREE" --analyzer --promote
npm run verified:approve -- --mapper order-request-mapper --worktree "$MAPPER_WORKTREE"
```



### 1e. Minimal copy-paste (online)

```bash
cd /home/shantanu/Workspace/VS_CODE_V2/kodiak-agent
export MAPPER_WORKTREE=/home/shantanu/Workspace/VS_CODE_V2/ktransform
# .env: MODEL_API_KEY set

npm run cache:clear
rm -f registry/runs.jsonl
rm -rf .cache/metrics .cache/fields
rm -f ui/pipeline-viewer/data/*.view.json

npm run label -- --mapper order-request-mapper --worktree "$MAPPER_WORKTREE" --analyzer
npm run report -- --worktree "$MAPPER_WORKTREE" --mapper order-request-mapper
npm run ui:serve
```

---



# 2. VS Code offline

No HTTP model. Export a job → VS Code (or Cursor) agent writes `result.json` → import.

### 2a. Force offline in `.env`

```env
MAPPER_WORKTREE=/home/shantanu/Workspace/VS_CODE_V2/ktransform
# MODEL_API_KEY=
```

If the key is still set, field clicks refill `.cache/fields/` with “Labeled from model” and you are not offline.

### 2b. Zero old data

```bash
cd /home/shantanu/Workspace/VS_CODE_V2/kodiak-agent

npm run cache:clear
rm -f registry/runs.jsonl registry/defects.jsonl
rm -rf .cache/metrics .cache/agent-jobs .cache/fields
rm -rf registry/verified/order-request-mapper
rm -f ui/pipeline-viewer/data/*.view.json

ls .cache/fields 2>/dev/null || echo "no field cache"
test ! -f registry/runs.jsonl && echo "no runs.jsonl"
ls ui/pipeline-viewer/data/*.view.json 2>/dev/null || echo "no view.json"
```



### 2c. Export offline job

```bash
export MAPPER_WORKTREE=/home/shantanu/Workspace/VS_CODE_V2/ktransform

npm run label:export -- \
  --mapper order-request-mapper \
  --worktree "$MAPPER_WORKTREE"
```

Or (auto-exports when no key):

```bash
npm run label -- \
  --mapper order-request-mapper \
  --worktree "$MAPPER_WORKTREE" \
  --analyzer
```

Copy: `.cache/agent-jobs/order-request-mapper/<fingerprint>/job.json`

### 2d. VS Code custom agent (full E2E) or fill `result.json`

**Terminal approvals:** workspace `[.vscode/settings.json](.vscode/settings.json)` turns on `chat.tools.terminal.autoApproveWorkspaceNpmScripts` so `npm run …` scripts from this repo’s `package.json` (e.g. `label:export`, `label:import`) can auto-approve. Requires a **trusted** workspace and `chat.tools.terminal.enableAutoApprove`. Org policy can still force prompts. Session bypass: permissions picker → Bypass Approvals, or `/autoApprove`.

**Preferred — custom agent (includes export):** in Copilot chat, select agent **kodiak-label**. The input hint shows:

```text
Label order-request-mapper offline with worktree /home/shantanu/Workspace/VS_CODE_V2/ktransform
```

Send that (or your mapper/worktree). The agent runs `label:export` → fills `result.json` → `label:import` → `from-cache-only`.

**Or — job already exported:** open `job.json` and paste:

```text
Complete the offline label job in <full-path-to-job.json>
```

Agent writes `result.json` beside `job.json`. Instructions auto-attach (`.github/instructions/kodiak-agent-label.instructions.md` / `.cursor/rules/kodiak-agent-label.mdc`). Only use fields listed in `job.json`.

### 2e. Import + load from cache

```bash
npm run label:import -- \
  --result .cache/agent-jobs/order-request-mapper/<fingerprint>/result.json

npm run label -- \
  --mapper order-request-mapper \
  --from-cache-only
```

If import prints a **gap job**, complete it in VS Code the same way, then `label:import` again.

Optional promote:

```bash
npm run label -- \
  --mapper order-request-mapper \
  --worktree "$MAPPER_WORKTREE" \
  --from-cache-only --promote

npm run verified:approve -- \
  --mapper order-request-mapper \
  --worktree "$MAPPER_WORKTREE"
```



### 2f. Viewer + Scorecard

```bash
npm run ui:serve
```

`http://localhost:4173/pipeline-viewer/?mapper=order-request-mapper` → expand **Scorecard** → Refresh.

With key still commented, **Label all mapped** / field click exports another offline job (does not call the API).

### 2g. UI-only offline variant

After §2b wipe → `npm run ui:serve` → **Label all mapped** (or click a field) → canvas shows job path → complete in VS Code (§2d) → `label:import` → hard-refresh / Scorecard Refresh.

### 2h. Minimal copy-paste (VS Code offline)

```bash
cd /home/shantanu/Workspace/VS_CODE_V2/kodiak-agent
# .env: MAPPER_WORKTREE=… and # MODEL_API_KEY=

npm run cache:clear
rm -f registry/runs.jsonl registry/defects.jsonl
rm -rf .cache/metrics .cache/agent-jobs .cache/fields registry/verified/order-request-mapper
rm -f ui/pipeline-viewer/data/*.view.json

export MAPPER_WORKTREE=/home/shantanu/Workspace/VS_CODE_V2/ktransform
npm run label:export -- --mapper order-request-mapper --worktree "$MAPPER_WORKTREE"
# → VS Code agent completes job.json → writes result.json

npm run label:import -- --result .cache/agent-jobs/order-request-mapper/<fingerprint>/result.json
npm run label -- --mapper order-request-mapper --from-cache-only
npm run ui:serve
```

---



## UI URLs

After `npm run ui:serve` (port `4173`):


| URL                                                | Purpose                                            |
| -------------------------------------------------- | -------------------------------------------------- |
| `http://localhost:4173/kodiak`                     | Main entry (schema → pipeline when ready)          |
| `http://localhost:4173/kodiak/frame/schema`        | Schema builder without the `/kodiak` iframe shell  |
| `http://localhost:4173/kodiak/frame/pipeline`      | Pipeline viewer without the `/kodiak` iframe shell |
| `http://localhost:4173/schema-builder/index.html`  | Same schema page via static path                   |
| `http://localhost:4173/pipeline-viewer/index.html` | Same pipeline page via static path                 |


Use a frame or `index.html` URL for Cursor **Select Element** (Design Mode cannot pick inside the `/kodiak` iframe). Bare `/schema-builder` and `/pipeline-viewer` redirect to `/kodiak`.

---



## Stale data checklist


| Symptom                                             | Likely cause                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Report miss signals all 0                           | Never labeled/imported after wipe                                                                   |
| Field still labeled after wipe                      | New label after wipe, verified store not deleted, or leftover `ui/pipeline-viewer/data/*.view.json` |
| “Labeled from model” while intending offline        | `MODEL_API_KEY` still set                                                                           |
| UI looks unchanged                                  | Old `ui:serve` / browser cache / uncleared `.view.json`                                             |
| Select Element only gets outer iframe / “Not found” | Open a `/kodiak/frame/…` or `…/index.html` URL (see UI URLs)                                        |


---

More context: [HANDOFF.md](./HANDOFF.md), [ARCHITECTURE.md](./ARCHITECTURE.md).