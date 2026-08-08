# Monitoring & Evaluation Backlog

Append this to `HANDOFF.md` (or keep alongside it). These are the items that close the observability gap without adopting an agent framework.

## Decision: no agent framework (Mastra et al.)

Evaluated Mastra. Two things it offers that this project lacks — **tracing/token-cost observability** and **evals/scorers**. Five things it would duplicate or damage: deterministic write-site enumeration + audit gate, the content-only-fingerprint verified store, the citation-verified judge, the offline job export/import path (a framework assuming live model access fights this constraint), and the no-SDK/no-extra-network posture.

Verdict: **build the two missing capabilities locally** (below), don't import the framework. Revisit only if the project grows into a multi-agent platform with conversational memory, RAG, and non-developer agent authoring — then a framework earns its keep.

Constraint for every item here: **local files and stdout only.** No telemetry endpoint, no APM SDK, no new network calls. Shipping the journal to Datadog/Prometheus later is an ops decision, not a code dependency.

---

## MON-1 — Run journal (foundation; do this first)

**Why:** nothing today records what happened across runs. Everything else depends on this.

**Do:** append one JSON line per label run to `registry/runs.jsonl`.

```json
{"at":"2026-08-08T10:12:03Z","mapperId":"x","sourceSha":"ab12…","language":"java",
 "declared":42,"mapped":38,"unmapped":3,"unresolved":1,"gatePassed":false,
 "resultSource":{"verified":30,"cache":6,"model":6},
 "modelCalls":6,"toolLoopCalls":1,"durationMs":18432,"promoted":false,
 "checklistSource":"target-type","diagnostics":2}
```

- New module `translator/telemetry/journal.ts` — `appendRun(entry)`, `readRuns(filter?)`. Same atomic-append style as `defects.jsonl`.
- Wire at three call sites: `translator/cli.ts` (analyzer + legacy label paths), `ui/serve.ts` `/api/label-field`, `translator/agent/importJob.ts`.
- Path overridable via `KODIAK_RUNS_FILE` (tests use a temp file).
- Gitignore by default; document that committing it gives cross-team history.

**Done when:** every label path appends exactly one line; a test asserts the entry shape and that a failed run still records.

---

## MON-2 — Provider metrics wrapper

**Why:** model calls, tokens, latency, and retries are invisible — real money at 100+ fields.

**Do:** decorator around `HttpModelProvider` (no call-site changes) counting per run: calls, prompt/completion tokens (both wire styles return usage — Anthropic `usage.input_tokens`/`output_tokens`, OpenAI `usage.prompt_tokens`/`completion_tokens`), retries, total and p95 latency. Expose `getMetrics()`; fold into the MON-1 entry.

**Done when:** a stubbed-fetch test asserts token/latency capture for both wire styles; `runs.jsonl` carries a `tokens` block.

---

## MON-3 — `npm run report`

**Why:** the journal is only useful if it answers questions in one command.

**Do:** new `translator/telemetry/report.ts`, script `report`. Reads `runs.jsonl` + `defects.jsonl` + `registry/verified/` and prints:

- Coverage trend per mapper (declared / mapped / unresolved over time)
- Cost: model calls + tokens per run, and cache-hit ratio (`resultSource` breakdown)
- Top unresolved fields by frequency across runs
- Judge agree-vs-reject ratio (best single quality signal available)
- Verified-store size and how many entries are user-corrected

Flags: `--mapper <id>`, `--since <date>`, `--json`.

**Done when:** runs offline against a fixture journal; test asserts aggregation math.

---

## MON-4 — Drift check

**Why:** mapper source changes silently invalidate verified entries; nobody is told today.

**Do:** `npm run drift` — walk the registry, resolve each mapper's source, recompute the content fingerprint, compare against `registry/verified/`. Report per mapper: `current` / `stale (verified for an older source)` / `never verified`. Include the count of user-corrected fields that went stale (highest-value signal — a correction that needs re-verification). Exit non-zero when any stale entry exists so it can gate CI or feed the existing cron poller.

**Done when:** test covers current / stale / never-verified; exit codes correct.

---

## MON-5 — `/api/health`

**Why:** the server is unmonitorable by whatever your org already runs.

**Do:** add to `ui/serve.ts`: registry mapper count, `modelConfigured` (bool, never the key), model style/name, verified entry + user-corrected counts, stale count (reuse MON-4 logic), analyzer adapter languages available, uptime. Plain JSON, no auth (bind `127.0.0.1` — see the existing note about the dev server binding).

**Done when:** endpoint returns in <100 ms with no model calls; policy test still passes.

---

## EVAL-1 — Golden dataset harness (also closes Req 2.5)

**Why:** proves reproducibility in CI and catches prompt/model regressions before users do.

**Do:** `validator/golden-dataset/` with N committed cases: mapper source snapshot + expected pipeline JSON. `npm run test:golden` labels each from the verified store (zero model calls) and asserts byte-identical output; a `--model` flag optionally re-labels against the live model and reports a *diff summary* rather than failing (model drift is information, not a build break). Seed from `fixtures/ShipmentNoticeMapper.java` plus one anonymized real mapper.

**Done when:** `test:golden` runs in the offline suite; the `--model` mode is excluded from `test:all`.

---

## EVAL-2 — Labeling scorers

**Why:** "did the agent do well?" is currently a human eyeball.

**Do:** rule-based scorers over any labeling result, no model needed:
- **Coverage** — mapped ÷ declared
- **Grounding** — every `READ` step's `sourceField` exists in the mapper's schema paths
- **Specificity** — share of steps that are `RAW`/unclassified (lower is better)
- **Provenance** — every mapped field has at least one write-site line reference

Emit into the MON-1 entry and surface in MON-3. Optional model-graded scorer later; keep rule-based as the CI gate.

**Done when:** scorers computed per run and trended by `report`.

---

## Suggested order

`MON-1` → `MON-2` → `MON-3` (one increment: journal, metrics, report) → `MON-4` + `MON-5` (ops surface) → `EVAL-1` → `EVAL-2`.

MON-1 alone answers most operational questions; stopping after MON-3 is a legitimate resting point.
