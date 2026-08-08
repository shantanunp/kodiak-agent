# Miss-Detection Backlog — parser (CST) layer and agent layer

Companion to `MONITORING-BACKLOG.md`. That one answers *"what happened?"*; this one answers *"did we miss anything, and how would we know?"*

There are two independent failure layers. The audit gate protects against **silent absence**, but neither layer's *quality* is measured yet.

---

## Layer A — did the parser (CST) miss a write?

### What already catches misses

| Signal | Catches |
|---|---|
| Audit gate `unmapped` state | A declared field with no write found anywhere — visible, never silent |
| `orphanWrites` | A write to something not declared on the target — signals a wrong `targetType` or a nested type not flattened |
| Opaque-escape tainting → `unresolved` | Target object handed to unseen code |
| Flatten `diagnostics[]` | Every nested type not expanded, with cause |
| Parse failure | Caught and surfaced as a diagnostic, falls back to write-site checklist |

### The blind spot (important)

If the parser doesn't recognise a **write pattern** (e.g. a builder variant, a fluent `with*()` API, `Optional.ifPresent(t::setX)`, MapStruct-generated code, reflection copy), the field shows as **`unmapped`** — which looks identical to a field that is genuinely never written. The gate stays "passed". That is the one way a miss can hide.

### Work items

**PAR-1 — Second-opinion scan (highest value).** Run a deliberately *loose* regex sweep over the mapper source for anything resembling a write (`\.set[A-Z]`, `\.with[A-Z]`, `\.\w+\(` inside a builder chain, `put(`, `::set`) and diff it against the CST write-site list. Anything the loose scan finds that the CST scan didn't becomes a `possible-missed-write` diagnostic with line numbers. Cheap, deterministic, no model. This converts the blind spot into a visible warning.

**PAR-2 — Unmapped justification pass.** For every field the gate marks `unmapped`, do a targeted source search for the field name (and its setter/getter forms). A hit means "field name appears in the source but no write site was attributed" → flag `unmapped-but-mentioned` for human review. Zero false-negative tolerance where it matters most.

**PAR-3 — Write-pattern conformance corpus.** A fixture file per supported write pattern (setter, builder chain, fluent `with`, direct assignment, map put, method-reference setter, constructor-arg mapping, ternary/conditional branches, loop writes, stream `collect` into target). One test asserts each pattern is enumerated. New pattern found in the wild → add a fixture, then fix the adapter. This is how adapter coverage stops being guesswork.

**PAR-4 — Adapter coverage metric.** Emit into the run journal: write sites found per pattern kind, count of `possible-missed-write` diagnostics, parse-failure count. Trend it — a sudden drop in per-pattern counts after an adapter change is a regression signal.

---

## Layer B — did the AI agent miss or mislabel?

### What already catches misses

| Signal | Catches |
|---|---|
| Audit gate | Agent skipping a field entirely — impossible, gate sends it back |
| `recognized=false` + reason | Agent honestly declining (preferred over guessing) |
| Escalation + tool loop | Fields the slice alone couldn't settle |
| `deterministic` fallback tagging | Model didn't recognise the field → passthrough rather than drop |
| Judge + citation verification | A *user-reported* mistake, checked against code |

### The blind spot

The gate proves every field got **an answer**, not a **correct** answer. A plausible-but-wrong pipeline (missed filter, wrong transform order, invented step) passes everything today unless a user happens to notice and challenge it. Req 1's original complaint — "AI is missing a filter/transformation in the pipeline" — lives here.

### Work items

**AGT-1 — Grounding check (rule-based, no model).** For each labeled pipeline, verify mechanically against the slice: every `TRANSFORM` op names a method/operation that actually appears in the slice text; every `READ` `sourceField` exists in the schema paths; every `CONSTANT` value appears as a literal in the slice. Violations → `ungrounded-step` warning on that field. This directly catches invented steps.

**AGT-2 — Step-count sanity vs helper closure.** The slice knows how many helper methods are in the chain. A pipeline with 2 steps derived from a 6-method closure is suspicious (that was exactly the earlier "collapsed into one BUILD" symptom). Flag fields where `steps << closure depth` for review. Heuristic, but a cheap and effective smell detector.

**AGT-3 — Self-consistency double-run.** Optional `--verify` mode: label a field twice at temperature 0 (or once per configured vendor) and diff. Divergence means the field is genuinely ambiguous to the model — exactly the fields a human should look at first. Only run on demand; cost-aware.

**AGT-4 — Critic pass.** One extra model call per field (or per mapper): "here is the slice and the proposed pipeline — list any transform or filter present in the code but missing from the pipeline." Must cite lines; reuse `verifyCitations`. This is the direct automated answer to the original requirement, and it costs roughly +1 call per field, so make it opt-in (`--critic`).

**AGT-5 — Mutation testing (strongest, most work).** Programmatically remove one transform from a fixture mapper, re-label, and assert the pipeline changes accordingly. If the label is identical before and after, the agent isn't actually reading the code. A handful of mutations over the fixture corpus is a genuine quality gate for prompt or model changes.

**AGT-6 — Correction-rate metric.** Track judge outcomes per mapper: `agree` (agent was wrong) vs `reject` (user was wrong). A rising agree-rate on a mapper is the clearest empirical signal that labeling quality is degrading there. Feeds `npm run report`.

---

## Suggested order

1. **PAR-1**, **PAR-2**, **AGT-1** — all deterministic, no model cost, close the two blind spots directly.
2. **AGT-6**, **PAR-4** — metrics, once the run journal (MON-1) exists.
3. **AGT-2**, **PAR-3** — smell detection and pattern corpus.
4. **AGT-4**, **AGT-3** — model-cost items, opt-in.
5. **AGT-5** — mutation testing, when the fixture corpus is mature.

## Note on cost

Cost visibility (model calls, tokens, latency, cache-hit ratio) is **MON-2 + MON-3** in `MONITORING-BACKLOG.md`. The cheapest cost lever already exists and needs no work: the verified store means a promoted mapper costs zero model calls on every subsequent run — so the cost metric to watch is the `resultSource` breakdown (`verified` vs `model`). A high `model` share on unchanged sources means promotions aren't happening, not that the model is expensive.
