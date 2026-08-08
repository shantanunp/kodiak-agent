# First setup — monitoring & miss detection

Get from a clean slate to a verified scorecard + viewer. Bash from the `kodiak-agent` repo root.

---

## You need

| Tool | Notes |
| --- | --- |
| Node.js 20+ | `node -v` |
| Mapper checkout | path in `.env` as `MAPPER_WORKTREE`, or pass `--worktree` |
| Optional model key | live `label`; offline path works without it |

```bash
cp .env.example .env   # if needed
# set MAPPER_WORKTREE, and MODEL_* if you want online labeling
npm install
```

Registry mapper used below: `order-request-mapper` (edit `registry/mapping-registry.yaml` for yours).

---

## What changed (UI vs report)

| Surface | What it shows |
| --- | --- |
| `npm run report` | Miss signals + provenance + store `pending=` |
| `/api/health` | Includes `pendingReview` (viewer mainly uses health for `modelConfigured`) |
| Viewer checklist | Provenance badges, pending pill, approve bar, diagnostics — restart `ui:serve` after code changes |

The scorecard journal line is CLI-focused. The UI does **not** render the full miss-signal summary; it shows per-field diagnostics / provenance from `/api/checklist` and `/api/label-field`.

---

## 1. Start fresh (wipe old monitoring noise)

**Safe wipe (keeps verified store / corrections):**

```bash
# Runtime label/pipeline caches
npm run cache:clear
# or one mapper:
# npm run cache:clear -- --mapper order-request-mapper

# Run journal (gitignored)
rm -f registry/runs.jsonl

# Per-run metrics that feed scorecard "flips/toolloop"
rm -rf .cache/metrics

# Optional: mock judge rejects only
# rm -f registry/defects.jsonl
```

**Do not delete** `registry/verified/` unless you intentionally want to forget promoted/corrected labels.

**Hard reset of labels for one mapper** (only if you want a clean store too):

```bash
rm -rf registry/verified/order-request-mapper
```

Restart the UI if it’s already running:

```bash
npm run ui:serve
```

Open: `http://localhost:4173/pipeline-viewer/?mapper=order-request-mapper`

---

## 2. Automated offline tests (no model key)

```bash
# Monitoring aggregation
npm run test:journal
npm run test:report
npm run test:drift

# Miss-detection pieces
npm run test:agentloop          # grounding, smells, verify, critic, multi-instance, injection
npx tsx --test analyzer/secondOpinion.test.ts analyzer/writePatterns.test.ts

# Or everything offline
npm run test:all
```

Expect all green. That proves journal/report math and miss detectors, not your real mapper.

---

## 3. Manual smoke on a real mapper

Use `$MAPPER_WORKTREE` from `.env`, or export it:

```bash
export MAPPER_WORKTREE=/path/to/your-mapper-repo
```

### A. Deterministic checklist / miss diagnostics (no model)

```bash
npm run analyze -- \
  --file "$MAPPER_WORKTREE/src/main/java/com/kodiakservice/mapper/OrderRequestMapper.java" \
  --mapper-class OrderRequestMapper \
  --target-class OrderMappedResponse \
  --slices
```

Or via report (zero model calls):

```bash
npm run report -- --worktree "$MAPPER_WORKTREE" --mapper order-request-mapper
npm run report -- --worktree "$MAPPER_WORKTREE" --mapper order-request-mapper --json | less
npm run drift -- --worktree "$MAPPER_WORKTREE"
```

On a **fresh** journal, report’s Journal section says empty until you label once.

### B. Label once so journal fills

```bash
npm run label -- \
  --mapper order-request-mapper \
  --worktree "$MAPPER_WORKTREE" \
  --analyzer
# optional miss/agent checks:
#   --verify --critic
# optional store:
#   --promote          # → pending-review
#   --promote --approve
```

### C. Confirm journal wrote new fields

```bash
tail -n 1 registry/runs.jsonl | python -m json.tool
```

Look for:

- `possibleMissedWrites`, `unmappedButMentioned`
- `multiInstanceUnattributed`, `promptInjectionRisks`
- `crossCheckFlips`, `writePatterns`
- `groundingWarnings`, `stepSmells`, `provenance`
- `scores`, `tokens` (tokens only if the model ran)

### D. Re-run report — miss line should be non-empty

```bash
npm run report -- --worktree "$MAPPER_WORKTREE" --mapper order-request-mapper
```

Expect something like:

```text
miss signals: possible-missed-write=… unmapped-but-mentioned=… multi-instance=…
  prompt-injection=… cross-check-flips=… grounding=… …
```

---

## 4. UI checks (after restart)

```bash
npm run ui:serve
```

Health (includes `pendingReview`):

```bash
curl -s http://localhost:4173/api/health | python -m json.tool
```

Check `pendingReview`, `userCorrected`, `verifiedEntries`, `staleMappers`, `modelConfigured`.

Viewer:

1. Field list loads instantly (checklist, no model).
2. Pills: `checklist: …`, `pending N` if store has pending-review.
3. Per-field provenance badge after label (slice / cache / tool-loop / pending-review / …).
4. Expansion / diagnostics in the panel (or browser console for checklist diagnostics).
5. If you `--promote`’d without `--approve`, the Approve bar should appear.

Hard-refresh the browser (Ctrl+Shift+R) so old JS isn’t cached.

---

## 5. Optional: pending-review / approve path

```bash
npm run label -- --mapper order-request-mapper --worktree "$MAPPER_WORKTREE" --analyzer --promote
npm run report -- --worktree "$MAPPER_WORKTREE" --mapper order-request-mapper
# expect concern: "N field(s) pending review"

npm run verified:approve -- --mapper order-request-mapper --worktree "$MAPPER_WORKTREE"
# report pending should clear; /api/health pendingReview drops
```

---

## 6. “Am I looking at stale data?”

| Symptom | Likely cause |
| --- | --- |
| Report miss signals all 0 forever | Never labeled after wipe, or wrong `runs.jsonl` |
| Report still shows old flips/toolloop | Forgot `rm -rf .cache/metrics` |
| UI field still “labeled” after cache clear | Hit came from `registry/verified/` (by design) |
| UI looks unchanged | Old `ui:serve` process / browser cache |
| Journal missing new keys | Label path didn’t use `--analyzer` (agent-loop) |

---

## Minimal happy path

```bash
cd /path/to/kodiak-agent
npm run cache:clear
rm -f registry/runs.jsonl
rm -rf .cache/metrics

npm run test:journal && npm run test:report

npm run report -- --worktree "$MAPPER_WORKTREE" --mapper order-request-mapper
npm run label -- --mapper order-request-mapper --worktree "$MAPPER_WORKTREE" --analyzer
npm run report -- --worktree "$MAPPER_WORKTREE" --mapper order-request-mapper
tail -n 1 registry/runs.jsonl | python -m json.tool

npm run ui:serve
# then: curl /api/health + open viewer
```

Gotcha: npm may print a banner on stdout — when parsing CLI JSON, slice from the first `{`.

More context: [HANDOFF.md](./HANDOFF.md), [ARCHITECTURE.md](./ARCHITECTURE.md).
