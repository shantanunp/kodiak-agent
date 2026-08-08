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
npm run test:all            # 7 suites, all must pass
npm run e2e:online          # ONLY script that calls the real model API (needs key)
npm run ui:serve            # viewer at :4173/pipeline-viewer/?mapper=<id>
npm run analyze -- --file <f> --mapper-class <C> --target-class <C> [--slices]
npm run label -- --mapper <id> --worktree <path> --analyzer [--promote]
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

- [ ] **Cross-check trace surfacing**: flips currently land in the task note + stderr; also surface them in the viewer checklist response as diagnostics.
- [ ] **Tool-loop trace persistence**: `runAgentLoop` currently logs the investigation trace to stderr; persist it into the field-cache entry (add optional `toolTrace` to the cache entry type) so agentic runs are replayable evidence.
- [ ] **Multi-instance edge**: attribution routes by `setX(var)` and `setX(helper(...))`; add builder-chain routing (`.x(var)`) and reassigned-variable tracking if a real mapper hits them (diagnostics will name it).

- [ ] **Python adapter**. Contract is `analyzer/types.ts::LanguageAdapter` — implement `analyzer/adapters/python.ts` with tree-sitter (`web-tree-sitter` + `tree-sitter-python` WASM; both installable from npm, satisfies network policy). Write patterns: `obj.attr = expr`, dataclass/pydantic ctor kwargs, `dict["k"] = v`, `setattr`. Register in `scanWriteSites.ADAPTERS`; add `language:` per mapper in the registry (default java). Consider migrating the Java adapter to tree-sitter-java at the same time (error-tolerant parsing; current `java-parser` throws on constructs it doesn't know — that failure is caught and surfaced in diagnostics, but tolerance is better).
- [ ] **Real defect tracker**. Integration point is exactly `translator/judge/judge.ts::logDefect` + `mockDefectId`. Replace with a provider interface (Jira/ADO webhook via env). NOTE: this adds a network call — extend the policy test allowlist deliberately and document it.
- [ ] **Offline parity for bulk-label**: current bulk button stops in offline mode; make it export ONE multi-field job (exportAgentJob already accepts selectors) instead.
- [ ] **Viewer polish**: refresh availability dots after bulk without reload; "re-label" button per field (`noCache: true`); show `checklistSource`/`worktreeUsed` in the meta bar.
- [ ] **Registry `language` field** + per-mapper `subMappers` hint (closure walker seed) when multi-file mapper families arrive.
- [ ] **Golden dataset harness**: assert verified-store outputs stay stable in CI (`validator/golden-dataset/` was the Phase 0 placeholder).

## Field-report protocol (how issues got fixed so far — keep doing this)

Every real-mapper problem so far was diagnosed from: (a) the viewer screenshot, (b) the `audit`/`diagnostics` block, (c) `declaredFields` vs expected count. When something looks wrong: open the panel's "expansion note(s)", run `npm run analyze -- ... --json`, and fix the named cause. The system is built to never fail silently — if it does, that's the bug to fix first.
