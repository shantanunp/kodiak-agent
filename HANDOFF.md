# HANDOFF — Kodiak Agent

Read this file first, then [ARCHITECTURE.md](./ARCHITECTURE.md) (design) and [PROJECT.md](./PROJECT.md) (decision log + increments). This file is the working plan for whoever continues — human, Cursor, Copilot, or Claude.

## The system in five lines

1. A deterministic **analyzer** parses the mapper source and produces a checklist of every declared target field (nested types flattened to dotted paths, collections as `path[].field`) plus, per field, a self-contained **slice** (write statement + local dataflow + transitive helper bodies, cross-file).
2. One **agent** labels each field from its slice (online HTTP or offline editor-agent job). It cannot skip fields: a deterministic **audit gate** requires every field to end mapped / unmapped / unresolved.
3. A git-tracked **verified store** (`registry/verified/`, content-only fingerprint = source+schema, no model name) is consulted before any cache or model call — same source in, same answer out, forever. `--promote` writes to it; the gate blocks promotion of unresolved results.
4. A **judge** verifies user corrections against the code with mechanically checked citations; agree → user-corrected store entry (outranks all re-labels); disagree → mock defect `KOD-nnnn` + `registry/defects.jsonl`. Works offline via `judge:export`/`judge:import`.
5. The **viewer** (`ui:serve`, port 4173) shows the full checklist instantly (no model calls), labels fields on click, bulk-labels, triages unresolved fields by cause, and hosts the correction box.

## Invariants — do not break

- [ ] AI calls live ONLY under `translator/` (and `ui/serve.ts` endpoints delegating there). `src/` and `analyzer/` stay deterministic.
- [ ] No vendor model SDKs — plain `fetch` in `translator/model/provider.ts`; vendor switch is `.env` only (`MODEL_API_STYLE=claude|openai|gemini|copilot`). Wire formats pinned by `npm run test:wire`.
- [ ] No network except: `npm install`, the model API (only when a key is configured), GitHub (only `--remote`). UI is self-contained; enforced by `npm run test:policy`.
- [ ] Verified store fingerprint = SHA-256(source + schema) ONLY. Never add model/prompt version to it. Runtime-cache fingerprint DOES include model + `PIPELINE_CACHE_VERSION` — bump that constant whenever prompts/merge rules change.
- [ ] User-corrected store fields must never be overwritten by re-labels (`promoteToVerified` preserves them — keep it that way).
- [ ] Citation check (`verifyCitations`) runs on every judge verdict, online and offline. Agreement without checkable evidence saves nothing.
- [ ] The gate's verdict is a count, never a model opinion. `--promote` refuses on unresolved fields (both analyzer and legacy paths).
- [ ] Precedence everywhere: verified store > field/pipeline cache > model/agent.

## Run / test

```bash
npm install                 # only network call needed
npm run test:all            # offline suites including test:golden (no model)
npm run test:golden         # EVAL-1 shape harness (add -- --model for guidance only)
npm run report / npm run drift
npm run e2e:online          # ONLY script that calls the real model API (needs key)
npm run ui:serve            # viewer at :4173/pipeline-viewer/?mapper=<id>
npm run analyze -- --file <f> --mapper-class <C> --target-class <C> [--slices]
npm run label -- --mapper <id> --worktree <path> --analyzer [--promote] [--verify] [--critic]
npm run label:export / label:import          # offline labeling jobs (Copilot agent mode)
npm run judge:export / judge:import          # offline corrections
```

Gotcha: npm prints a banner on stdout — when parsing CLI JSON output programmatically, slice from the first `{`.

## Repo map

| Path | What |
|---|---|
| `analyzer/` | Parser adapter(s), write-site scan + slices, audit gate, type/worktree resolution, policy test |
| `translator/agentloop/` | Checklist→tasks (flattening, diagnostics), agent loop, tests |
| `translator/verified/` | Verified store |
| `translator/judge/` | Online judge + offline export/import |
| `translator/agent/` | Offline labeling jobs (export/import, gap re-export) |
| `translator/model/` | Provider (fetch-only), config, prompts, wire tests |
| `translator/e2e/` | Online smoke |
| `ui/serve.ts` | All HTTP endpoints (`/api/checklist`, `/api/label-field`, `/api/verify-suggestion`, legacy label/apply-change/schema) |
| `ui/pipeline-viewer/` | Field panel (dynamic), on-demand labeling, bulk, triage, correction box |
| `registry/` | Mapper registry, schemas, verified store, defects.jsonl |
| `fixtures/` | `ShipmentNoticeMapper.java` exercises every pattern + all three audit states |

## Requirement status (the three original goals)

### Req 1 — no missing mappings on complex mappers
| # | Work item | Status |
|---|---|---|
| 1.1 | Write-site scanner (setter/builder/assignment/put, `var` receivers) | ✅ |
| 1.2 | Per-field slices: local dataflow + same-class helper closure | ✅ |
| 1.3 | Cross-file closure: static utils + superclass helpers inlined | ✅ |
| 1.4 | Audit gate: mapped/unmapped/unresolved + opaque-escape tainting | ✅ |
| 1.5 | Split-file target DTOs resolved (package path + walk) | ✅ |
| 1.6 | Nested types flattened to dotted paths | ✅ |
| 1.7 | Collections flattened (`items[].field`); scalar lists stay leaves | ✅ |
| 1.8 | Getter-only (generated) classes contribute fields | ✅ |
| 1.9 | Flatten diagnostics — every skipped expansion named in API/CLI/UI | ✅ |
| 1.10 | Agent loop: slice-fed labeling, escalation pass, gate-controlled | ✅ |
| 1.11 | Investigation tool loop (search/read tools via raw HTTP tool-calling) for fields escalation can't settle — claude + openai wire styles, trace logged | ✅ |
| 1.12 | Multi-instance nested types: same type under multiple parent fields expanded per-path; writes attributed by receiver variable or builder helper; unattributable writes applied to all candidates + diagnostic | ✅ |
| 1.13 | Validate checklist coverage on a real production mapper (field count + expansion notes) | ⬜ project owner only |
| 1.14 | Cross-check verifier: parallel AI pass over UNMAPPED fields; verified citations demote to unresolved (never assert mapped); unverifiable claims dropped with diagnostics | ✅ |

### Req 2 — reproducibility
| # | Work item | Status |
|---|---|---|
| 2.1 | Verified store (git-tracked, content-only fingerprint) | ✅ |
| 2.2 | Precedence verified > cache > model, all paths | ✅ |
| 2.3 | `--promote` gated on audit (both label paths) | ✅ |
| 2.4 | Stale-on-change + previous entry as convergence context | ✅ |
| 2.5 | Golden-dataset CI harness — `validator/golden-dataset/*.json` compared by pipeline shape, surfaced in `npm run report`, `--strict` for CI | ✅ |

### Req 3 — steering
| # | Work item | Status |
|---|---|---|
| 3.1–3.6 | Judge + citation verification, sticky corrections, mock defects + defects.jsonl, viewer box, offline judge, fingerprint-scoped staleness | ✅ |
| 3.7 | Real defect-tracker integration (deliberate network-policy exception) | ⬜ |

## Onboarding any Spring/Java app (goal: minutes, not days)

1. Add one entry to `registry/mapping-registry.yaml`: `id`, `sourceFile` (repo-relative), `class`, `entryMethod`, `sourceType`, `targetType` (FQCNs).
2. `npm run label -- --mapper <id> --worktree <path-to-checkout> --analyzer` — or open the viewer. Worktree is inferred for UI reads; DTOs are found by package path or bounded walk. Nothing in the engine is domain- or project-specific: fixtures use a generic logistics domain, all matching is structural (setters/builders/types), and any remaining domain words in `registry/` or `schema/` are the owner's own config data, not engine code.

## Done ✅

- [x] Deterministic write-site scanner (setter/builder/assignment/map-put, `var` receivers) + local dataflow tracing
- [x] Helper closure in slices: same-class, **superclass chain (cross-file)**, **static utils (`Utils.method`, cross-file)**
- [x] Cross-check verifier (1.14): one call only when UNMAPPED fields exist; demote-only, citation-gated, `skipCrossCheck` opt-out
- [x] Investigation tool loop (1.11): search_source/read_lines over resolved source, raw HTTP tool-calling both wire styles, capped rounds, trace returned
- [x] Multi-instance attribution (1.12): per-path expansion of repeated types, receiver-variable + helper routing, taint-all + diagnostic when unattributable
- [x] Audit gate: mapped/unmapped/unresolved, opaque-escape tainting, dotted/leaf matching, orphan detection
- [x] Nested-type flattening to dotted paths; collections `List<X>` → `path[].field`; getter-only (JAXB) classes
- [x] Split-file target resolution (package-path + bounded walk); worktree inference from source path
- [x] Flatten diagnostics surfaced in API/CLI/viewer — no silent expansion skips
- [x] Verified store + precedence + `--promote` (+ gate on both promote paths) + correction stickiness
- [x] Agent loop (slice-fed, escalation for unresolved, field cache) + `label --analyzer`
- [x] Offline labeling jobs with slices + audit; gap re-export on import
- [x] Judge online + offline (export/import), citation verification, mock defects + defects.jsonl
- [x] Viewer: dynamic field panel, on-demand label, bulk-label with stop, unresolved triage by cause, correction box, offline job steps inline
- [x] Vendor switch config-only (claude/openai/gemini alias/copilot), wire tests, `e2e:online`
- [x] Canonical step-kind vocabulary (`CANONICAL_STEP_KINDS`) — model-invented kinds normalize to RAW, original kept in `meta.originalKind`
- [x] Scorecard `npm run report` + run metrics + golden-dataset shape comparison
- [x] Prompt hardening: source treated as data, not instructions (all three prompts)
- [x] Network policy test; PROJECT.md decision log + increment log

## Architecture hardening roadmap

Reviewed gaps beyond the core loop. Item 1 is built; the rest are specced for whoever continues.

- [x] **1. Measurement / scorecard** — `npm run report [-- --json] [--strict] [--worktree <p>] [--mapper <id>]`. Runs the deterministic pipeline over every registry entry (zero model calls) and prints per mapper: declared fields, mapped %, unmapped, unresolved, checklist source, verified-store status + correction count + stale entries, recorded run signals (cross-check flip rate = scanner pattern gaps, tool-loop fire/resolve rate = slice quality), and golden-dataset accuracy where a golden file exists. `--strict` exits 2 on any concern (CI-ready). Run metrics are appended per label run to `.cache/metrics/{mapperId}.jsonl`; golden files live in `validator/golden-dataset/{mapperId}.json` comparing pipeline SHAPE (ordered step kinds), not prose.
- [ ] **2. Prompt-injection posture.** Source code is untrusted input flowing into prompts. Mitigated so far: all three prompts (labeler, cross-check, judge) now state that code/comments/strings are data, never instructions; deterministic checks cap the blast radius (a poisoned label still can't pass the gate, enter the store without a verified citation, or write code). Still to do: flag suspicious imperative comments in slices as a diagnostic, and document the threat model in ARCHITECTURE.md.
- [ ] **3. Change lifecycle / CI mode.** `incrementalScan` detects changed files but isn't wired to labeling. Build `npm run ci:check`: for mappers touched in a diff, recompute the verified fingerprint and fail (or auto-export a re-label job) when the store went stale — makes drift between code and documented mappings impossible to merge. Related: prune policy for `registry/verified/` (keep latest N fingerprints per mapper; `listStaleFingerprints` already enumerates them).
- [ ] **4. Review/approval state in the store.** `--promote` trusts the runner. Add a third status beside `verified` / `user-corrected`: `pending-review`, plus a viewer diff against the previous fingerprint's entry and an approve action. Today git review of the store JSON is the only checkpoint.
- [ ] **5. Scale ergonomics.** `label:all` batch mode (store-aware, so warm runs are free); parallel field labeling with a concurrency cap (fields are independent); `registry:check` validating every `sourceFile` exists and every `targetType` resolves before onboarding.
- [ ] **6. Confidence surfacing.** Per-field provenance badge in the viewer — labeled from slice / needed escalation / needed tool loop / cross-check flip. The data already exists in the run path; this is purely surfacing so reviewers know where to look.

Explicitly rejected: a second discovery agent (verifier, not discoverer — see PROJECT.md), a database (git + JSON is right at this scale), a workflow engine (the pipeline is a function-call chain by design).

## Pending — pick up here

**Next increment (do in this order):** `AGT-5` mutation testing, then scale ergonomics / confidence surfacing. See backlog sections below.

- [x] **MON-1** Run journal → `registry/runs.jsonl` (`translator/telemetry/journal.ts`; wired in agent-loop + import-job + cli-legacy)
- [x] **MON-2** Provider metrics (tokens/latency/retries on `HttpModelProvider`)
- [x] **MON-3** Journal-backed `npm run report` (+ `--since`, judge agree/reject, miss signals)
- [x] **MON-4** `npm run drift` (current / stale / never-verified; exit 1 on stale)
- [x] **MON-5** `GET /api/health` (no secrets, no model calls)
- [x] **PAR-1** Second-opinion loose write scan (possible-missed-write diagnostics)
- [x] **PAR-2** Unmapped justification pass (unmapped-but-mentioned)
- [x] **PAR-3** Write-pattern conformance corpus (`fixtures/write-patterns/`, `analyzer/writePatterns.test.ts`)
- [x] **PAR-4** Write-pattern counts into run journal
- [x] **EVAL-1** `npm run test:golden` (offline verified-store shape; `--model` guidance only)
- [x] **EVAL-2** Rule-based scorers → journal + report
- [x] **AGT-1** Grounding check on labeled pipelines (ungrounded-step warnings)
- [x] **AGT-2** Step-count vs helper-closure smell
- [x] **AGT-3** Opt-in `--verify` double-run at temp 0
- [x] **AGT-4** Opt-in `--critic` cited missing transforms
- [x] **AGT-6** Judge agree/reject surfaced in report (corrected store vs defects.jsonl)
- [ ] **Cross-check trace surfacing**: flips currently land in the task note + stderr; also surface them in the viewer checklist response as diagnostics.
- [ ] **Tool-loop trace persistence**: `runAgentLoop` currently logs the investigation trace to stderr; persist it into the field-cache entry (add optional `toolTrace` to the cache entry type) so agentic runs are replayable evidence.
- [ ] **Multi-instance edge**: attribution routes by `setX(var)` and `setX(helper(...))`; add builder-chain routing (`.x(var)`) and reassigned-variable tracking if a real mapper hits them (diagnostics will name it).

- [ ] **Python adapter**. Contract is `analyzer/types.ts::LanguageAdapter` — implement `analyzer/adapters/python.ts` with tree-sitter (`web-tree-sitter` + `tree-sitter-python` WASM; both installable from npm, satisfies network policy). Write patterns: `obj.attr = expr`, dataclass/pydantic ctor kwargs, `dict["k"] = v`, `setattr`. Register in `scanWriteSites.ADAPTERS`; add `language:` per mapper in the registry (default java). Consider migrating the Java adapter to tree-sitter-java at the same time (error-tolerant parsing; current `java-parser` throws on constructs it doesn't know — that failure is caught and surfaced in diagnostics, but tolerance is better).
- [ ] **Real defect tracker**. Integration point is exactly `translator/judge/judge.ts::logDefect` + `mockDefectId`. Replace with a provider interface (Jira/ADO webhook via env). NOTE: this adds a network call — extend the policy test allowlist deliberately and document it.
- [ ] **Offline parity for bulk-label**: current bulk button stops in offline mode; make it export ONE multi-field job (exportAgentJob already accepts selectors) instead.
- [ ] **Viewer polish**: refresh availability dots after bulk without reload; "re-label" button per field (`noCache: true`); show `checklistSource`/`worktreeUsed` in the meta bar.
- [ ] **Registry `language` field** + per-mapper `subMappers` hint (closure walker seed) when multi-file mapper families arrive.
- [x] **Golden dataset harness**: `npm run test:golden` offline shape check (`validator/golden-dataset/`).

## Field-report protocol (how issues got fixed so far — keep doing this)

Every real-mapper problem so far was diagnosed from: (a) the viewer screenshot, (b) the `audit`/`diagnostics` block, (c) `declaredFields` vs expected count. When something looks wrong: open the panel's "expansion note(s)", run `npm run analyze -- ... --json`, and fix the named cause. The system is built to never fail silently — if it does, that's the bug to fix first.

---

## Monitoring & evaluation backlog

Evaluated Mastra: two useful gaps (tracing/token-cost, evals), five things a framework would duplicate or damage (deterministic write-site scan + gate, content-only verified store, citation judge, offline jobs, no-SDK posture). **Build the two missing capabilities locally; no agent framework.** Constraint: local files and stdout only — no telemetry endpoint, no APM SDK, no new network calls.

### MON-1 — Run journal (foundation; do first) ✅
Append one JSON line per label run to `registry/runs.jsonl` (override via `KODIAK_RUNS_FILE`). Module `translator/telemetry/journal.ts` — `appendRun` / `readRuns`. Wired via agent-loop (covers `cli --analyzer` + `/api/label-field`), `cli` legacy path, and `label:import`. Gitignore by default.

### MON-2 — Provider metrics wrapper ✅
`HttpModelProvider` records calls, prompt/completion tokens (Anthropic + OpenAI usage shapes), retries, latency; folded into journal `tokens` block.

### MON-3 — `npm run report` (journal-backed) ✅
Report reads `runs.jsonl` + `defects.jsonl`: cost, cache/model/verified breakdown, miss signals, judge agree/reject. Flags `--mapper`, `--since`, `--json`.

### MON-4 — Drift check ✅
`npm run drift`: `current` / `stale` / `never-verified`; exit 1 on stale.

### MON-5 — `/api/health` ✅
`GET /api/health` — registry count, modelConfigured, style/name, verified + corrected, stale count, uptime. No model calls.

### EVAL-1 — Golden dataset harness ✅
`validator/golden-dataset/` + `npm run test:golden` (verified-store seed + shape compare, zero model). Optional `--model` prints guidance only (not a CI fail path). Included in `test:all` offline.

### EVAL-2 — Labeling scorers (rule-based) ✅
Coverage, grounding, specificity (RAW share), provenance via `translator/report/scorers.ts`. Emitted on each agent-loop journal line; mean scores in `npm run report`.

**Suggested order:** MON-1 → MON-2 → MON-3 → MON-4 + MON-5 → EVAL-1 → EVAL-2. Stopping after MON-3 is a valid resting point.

---

## Miss-detection backlog — parser (CST) layer and agent layer

Companion to monitoring. Monitoring answers *"what happened?"*; this answers *"did we miss anything, and how would we know?"* The audit gate prevents silent absence, but neither layer's *quality* is measured yet.

### Layer A — did the parser miss a write?

Already catches: unmapped, orphanWrites, opaque-escape → unresolved, flatten diagnostics, parse failure. **Blind spot:** unrecognized write patterns look identical to genuinely unmapped fields — gate still "passes".

| ID | Work | Notes |
|---|---|---|
| **PAR-1** ✅ | Second-opinion loose regex scan vs CST write sites → `possible-missed-write` diagnostics | `analyzer/secondOpinion.ts`; folded into checklist diagnostics |
| **PAR-2** ✅ | For each `unmapped`, search setter/getter/name mentions → `unmapped-but-mentioned` | Same module |
| **PAR-3** ✅ | Write-pattern conformance corpus (one fixture + test per pattern) | `fixtures/write-patterns/` + `writePatterns.test.ts`; builder-only returns no longer early-exit |
| **PAR-4** ✅ | Adapter coverage metrics into run journal | `writePatterns` + `possibleMissedWrites` on each run |

### Layer B — did the AI agent miss or mislabel?

Already catches: gate (can't skip), recognized=false, escalation/tool-loop, judge+citations. **Blind spot:** plausible-but-wrong pipelines pass unless a user challenges them.

| ID | Work | Notes |
|---|---|---|
| **AGT-1** ✅ | Grounding check: TRANSFORM ops / READ paths / CONSTANT literals must appear in slice/schema | `translator/agentloop/grounding.ts`; warnings on stderr + journal diagnostics count |
| **AGT-2** ✅ | Step-count sanity vs helper-closure depth | `translator/agentloop/smells.ts` |
| **AGT-3** ✅ | Optional `--verify` double-run at temp 0 | `label --analyzer --verify`; divergences on stderr + journal |
| **AGT-4** ✅ | Opt-in `--critic` model pass with cited missing transforms | `label --analyzer --critic`; reuse verifyCitations |
| **AGT-5** | Mutation testing on fixtures | Strongest quality gate; later |
| **AGT-6** ✅ | Correction-rate metric (judge agree vs reject) | Report: corrected store vs `defects.jsonl` |

**Suggested order:** PAR-1 + PAR-2 + AGT-1 → AGT-6 + PAR-4 → AGT-2 + PAR-3 → AGT-4 + AGT-3 → AGT-5.

**Cost note:** cheapest lever already exists — verified store → zero model calls on warm sources. Watch `resultSource` breakdown (`verified` vs `model`); a high `model` share on unchanged sources means promotions aren't happening.
