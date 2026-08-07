# Kodiak Agent — Project Plan & Progress

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) (the finalized design). This file tracks the plan, the decisions behind it, and what is done vs. pending.

## Plan (build order)

1. Deterministic analyzer — write-site scanner, slices, checklist gate
2. Verified store — reproducibility + sticky corrections
3. Agent loop — slices drive the agent, gate decides done; offline gap-jobs
4. Multi-file reality — target types in separate files, nested flattening
5. On-demand UI — full checklist instantly, label per field on click
6. Steering judge — evidence-checked corrections, mock defect notices
7. Later — more language adapters (Python next), cross-file helper closure, real ticket integration, viewer bulk actions

## Brainstorm log (decisions and why)

**Missing pipelines on complex mappers.** One-shot "read the whole class, list the mappings" misses conditional writes, deep helper chains, and misleadingly named helpers. Decision: completeness is not an AI job. A parser enumerates every write site deterministically; the AI explains each one from a self-contained slice (statement + local dataflow + transitive helper bodies). A field can then only be mislabeled, never silently missed.

**Copilot-style (tool-loop) discovery?** Considered and split. Discovery of *which* fields get written is a parsing problem for a known file set — a tool loop is recall-capped (the model decides when to stop looking) and path-dependent (different greps → different answers). Labeling *what a write means* keeps a tool-style escape hatch: unresolved fields get an escalation pass with the full source; the offline editor agent has its own workspace search tools. Verdict: agent drives the investigation; a deterministic checklist and gate referee the result.

**Prod confidence.** No static analysis guarantees 100% on arbitrary code (reflection, DI, generated code). The guarantee shipped instead: **no silent miss**. Every declared target field ends in exactly one visible state — mapped (with line provenance), unmapped (explicit), or unresolved (red, must be settled). Opaque receiver escapes (target object handed to unseen code) taint unaccounted fields conservatively.

**Reproducibility.** Model calls are never deterministic (temperature 0 reduces, does not eliminate, variance). Decision: determinism comes from the *system* — a git-tracked verified store keyed by a content-only fingerprint (source + schema; deliberately no model name or prompt version). Unchanged source → stored answer byte-for-byte, zero model calls, immune to cache deletion. Changed source → stale by construction; the previous entry is offered as convergence context, never as truth.

**User steering.** Corrections go through a judge that re-checks the code and must cite line numbers; citations are mechanically verified, so an agreeable hallucination cannot enter the store. Agree → user-corrected field in the verified store (outranks every future re-label for that source version; re-verified, not blindly reapplied, when source changes). Disagree → mock defect notice (KOD-nnnn) + append to `registry/defects.jsonl` for future ticket integration.

**Agents in the driver's seat + future Python.** Architecture inverted to agent-first with a deterministic toolbelt (scan_write_sites, resolve_symbol, search/read, schema paths — all read-only, all scope-bound) and non-negotiable gates. Language specifics live behind a `LanguageAdapter`; onboarding Python = one more adapter (tree-sitter is the intended prod parser family), nothing else changes.

**Offline offices (no model API).** Same architecture, different driver: the editor's coding agent (agent mode) fills the agent seat via job export/import. Jobs now embed the checklist and per-field slices; the gate runs at import and auto-re-exports a gap job for unaccounted fields. Guarantees identical online and offline.

**Multi-file mappers (real-world report).** Target DTOs live in their own files; mappers use `var` receivers. Fixed: package-path + bounded-walk type resolution, `var x = new T()` receivers, and a write-site-derived fallback checklist (explicitly marked weaker) when the target type cannot be found.

**Nested targets / the "one giant message field" problem (real-world report).** A target with one nested container field collapsed into a single BUILD pipeline. Fixed: recursive flattening of nested project types into dotted checklist paths (`message.dataVersionIdentifier`), depth-capped, cycle-guarded; write sites against nested types are scanned in the mapper source and path-prefixed (POC assumption: one instance per nested type). Collections are not expanded yet (todo).

**100-field targets / UI scale.** Users click fields one by one and may never need most pipelines. Decision: the viewer loads the *deterministic checklist* instantly (no model calls — fine at 100+ fields) and labels a field only when opened, with precedence verified → cache → model. Repeat opens are free.

**Network policy.** No external calls of any kind except: `npm install`, the model API (only when a key is configured), and GitHub (only with `--remote`). The UI is fully self-contained — no CDN fonts/scripts/styles — enforced by `npm run test:policy`.

## Progress

### Done

| Piece | Where | Verify |
|---|---|---|
| Write-site scanner + slices (local dataflow, helper closure) | `analyzer/` | `npm run analyze`, `npm run test:analyzer` |
| Checklist audit gate (mapped/unmapped/unresolved, opaque escapes) | `analyzer/auditGate.ts` | same |
| Verified store + precedence + `--promote` | `translator/verified/` | `npm run test:verified` |
| Agent loop (slice-fed, escalation, gate-controlled promote) | `translator/agentloop/`, `label --analyzer` | `npm run test:agentloop` |
| Offline jobs with slices + gap re-export on import | `translator/agent/` | export → import round trip |
| Split-file target resolution, `var` receivers | `analyzer/resolveType.ts` | agentloop tests |
| Nested-type flattening to dotted paths | `translator/agentloop/tasks.ts` | agentloop tests |
| Checklist API + on-demand per-field labeling UI | `ui/serve.ts`, `ui/pipeline-viewer/` | `/api/checklist`, `/api/label-field` |
| Steering judge + verified-correction + mock defects | `translator/judge/` | `npm run test:judge` |
| No-external-network policy test | `analyzer/noExternal.test.ts` | `npm run test:policy` |
| All suites | — | `npm run test:all` |

### Todo

- Offline steering: judge as an exported job (today the judge needs the model API; offline offices raise defects manually)
- Collections in nested flattening (`List<Item>` element fields as `items[].x`)
- Multiple instances of the same nested type (attribution currently assumes one)
- Cross-file helper closure (helpers in other classes inlined into slices)
- Python language adapter (tree-sitter core, per-language queries)
- Real defect-tracker integration (replace `defects.jsonl` + mock KOD ids)
- Viewer: bulk "label all mapped fields" action with progress; unresolved-field triage view
- Wire the audit gate into `--promote` on the legacy (non-analyzer) label path
