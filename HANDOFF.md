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

## Done ✅

- [x] Deterministic write-site scanner (setter/builder/assignment/map-put, `var` receivers) + local dataflow tracing
- [x] Helper closure in slices: same-class, **superclass chain (cross-file)**, **static utils (`Utils.method`, cross-file)**
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
- [x] Network policy test; PROJECT.md decision log + increment log

## Pending — pick up here

- [ ] **Multi-instance nested types** (diagnostic exists; attribution not implemented). Design: in `tasks.ts` nested scanning, track receiver *variables* per `new Type(...)` (the adapter's `newRe` already captures the variable name); build a var→pathPrefix map by matching which setter on the PARENT receives which variable (`parent.setX(var)` / builder arg); attribute each nested write site by its receiver variable instead of by type. Test: two `Party` instances (borrower/coBorrower) with different values.
- [ ] **Python adapter**. Contract is `analyzer/types.ts::LanguageAdapter` — implement `analyzer/adapters/python.ts` with tree-sitter (`web-tree-sitter` + `tree-sitter-python` WASM; both installable from npm, satisfies network policy). Write patterns: `obj.attr = expr`, dataclass/pydantic ctor kwargs, `dict["k"] = v`, `setattr`. Register in `scanWriteSites.ADAPTERS`; add `language:` per mapper in the registry (default java). Consider migrating the Java adapter to tree-sitter-java at the same time (error-tolerant parsing; current `java-parser` throws on constructs it doesn't know — that failure is caught and surfaced in diagnostics, but tolerance is better).
- [ ] **Real defect tracker**. Integration point is exactly `translator/judge/judge.ts::logDefect` + `mockDefectId`. Replace with a provider interface (Jira/ADO webhook via env). NOTE: this adds a network call — extend the policy test allowlist deliberately and document it.
- [ ] **Native tool-use loop (online)** for fields the escalation pass can't settle: give the model `search_source`/`read_lines` tools via raw HTTP tool-calling (Anthropic `tools` vs OpenAI `functions` schemas differ — implement per style inside `provider.ts`, keep the ModelProvider interface unchanged). Log every tool call into the cache entry for replay.
- [ ] **Offline parity for bulk-label**: current bulk button stops in offline mode; make it export ONE multi-field job (exportAgentJob already accepts selectors) instead.
- [ ] **Viewer polish**: refresh availability dots after bulk without reload; "re-label" button per field (`noCache: true`); show `checklistSource`/`worktreeUsed` in the meta bar.
- [ ] **Registry `language` field** + per-mapper `subMappers` hint (closure walker seed) when multi-file mapper families arrive.
- [ ] **Golden dataset harness**: assert verified-store outputs stay stable in CI (`validator/golden-dataset/` was the Phase 0 placeholder).

## Field-report protocol (how issues got fixed so far — keep doing this)

Every real-mapper problem so far was diagnosed from: (a) the viewer screenshot, (b) the `audit`/`diagnostics` block, (c) `declaredFields` vs expected count. When something looks wrong: open the panel's "expansion note(s)", run `npm run analyze -- ... --json`, and fix the named cause. The system is built to never fail silently — if it does, that's the bug to fix first.
