# AI write-site miner — implementation plan

Status: **KOD-1 through KOD-9 implemented** (2026-08-11) — flags, the miner, the deterministic
reconciler, gate wiring, and diagnostics are live and tested. **KOD-10 (golden-harness
regression coverage), KOD-11 (drift telemetry), and KOD-12 (docs) are not done** — KOD-12 got a
short interim note in `CLAUDE.md` instead of the full write-up. See "Implementation notes"
at the bottom for the few places the shipped code deviates from the ticket text below.

Adds a second, AI-driven write-site miner that runs in **parallel** with the deterministic
`analyzer/scanWriteSites.ts` CST scan, reconciles the two lists with plain code (not a third
agent), and lets either leg be disabled with a flag. Rationale and architecture discussion:
this session's earlier turns. No architectural invariant in `CLAUDE.md` changes — AI stays in
`translator/`, the checklist gate stays deterministic, the CST leg stays the zero-AI-call
default that keeps the verified-store fingerprint hit meaningful.

Tickets are sized for one sitting each (S = <2h, M = half day, L = full day). Do them in order
within an epic; epics can overlap once KOD-1 lands.

**Both legs on by default.** Unlike the original draft of this plan, `--cst` and `--ai-miner`
both default to `true` from KOD-1 onward — every `npm run label -- --analyzer` run does one
CST scan and one AI-miner call per field checklist, reconciled deterministically (Epic C),
unless a flag explicitly turns a leg off. This trades one extra model call per run for
catching CST parser gaps immediately rather than gating the trade-off behind drift data. KOD-11
(disagreement-rate telemetry) still matters — it's now a signal for *tuning/fixing* the miner
or the parser, not a gate on whether to enable it.

---

## Epic A — Flag plumbing (no behavior change)

### KOD-1 — Add `--ai-miner` / `--cst` flags to the CLI
**Size:** S
**Files:** `translator/cli.ts`

Add to the `parseArgs` options block (next to `analyzer`/`verify`/`critic`, `translator/cli.ts:69-76`):

```ts
"ai-miner": { type: "boolean", default: true },
"cst": { type: "boolean", default: true },
"no-ai-miner": { type: "boolean", default: false },  // shorthand off-switch, see note
"no-cst": { type: "boolean", default: false },
```

Node's `parseArgs` booleans don't support `--no-x` auto-negation, so provide explicit
`--no-ai-miner` / `--no-cst` off-switches rather than relying on users passing
`--ai-miner=false`; the CLI resolves the final boolean as `flag && !negation`.

**Acceptance criteria:**
- `npm run label -- --help`-equivalent (reading the file) shows all four flags with a one-line
  comment matching the style of the existing `analyzer`/`verify`/`critic` comments.
- Passing no flags means **both legs run** once wired (Epic D) — this ticket only adds the
  parsed values, no runtime effect yet since nothing reads them until KOD-8.
- `--no-cst` and `--no-ai-miner` are documented as the escape hatches for "the other leg is
  broken/too expensive right now."

---

### KOD-2 — Thread `useCst` / `useAiMiner` through `AgentLoopOptions`
**Size:** S
**Files:** `translator/agentloop/loop.ts`
**Depends on:** KOD-1

Add to `AgentLoopOptions` (`loop.ts:44`), mirroring `skipCrossCheck`/`verify`/`critic`:

```ts
/** Deterministic CST write-site scan. Default true. */
useCst?: boolean;
/** AI write-site miner, run in parallel with the CST scan. Default true. */
useAiMiner?: boolean;
```

**Acceptance criteria:**
- Both default to `true` when omitted — this is a deliberate behavior change from today
  (CST-only), landing in full once KOD-8 wires the miner call in; this ticket just adds the
  option with its intended default.
- `translator/cli.ts` passes `values["cst"] && !values["no-cst"]` /
  `values["ai-miner"] && !values["no-ai-miner"]` into `runAgentLoop` options.
- Existing tests in `translator/agentloop/loop.test.ts` still pass unmodified (they don't
  exercise the miner path until KOD-8, so `useAiMiner: true` with no miner call wired yet is a
  no-op).

---

## Epic B — The AI miner leg

### KOD-3 — Extract `crossCheckUnmapped`'s prompt/verify shape into a reusable miner
**Size:** M
**Files:** new `translator/agentloop/aiWriteSiteMiner.ts`, `translator/agentloop/crossCheck.ts`
**Depends on:** none (can start in parallel with Epic A)

Generalize `crossCheckUnmapped` (`crossCheck.ts`) from "only fields the CST called unmapped"
to "every declared field, always." Same citation-verification contract:
- one model call, full source in, full declared-field checklist in
- claims **must** cite a line number that exists in source (`verifyCitations`, reused as-is)
- no citation → dropped, logged as a diagnostic, never silently accepted
- output is candidates only — never asserted as ground truth

```ts
export interface AiWriteCandidate {
  field: string;
  line: number;
  evidence: string;
}
export async function mineWriteSites(options: {
  provider: ModelProvider;
  sourceJava: string;
  declaredFields: string[];
}): Promise<{ candidates: AiWriteCandidate[]; dropped: string[] }>
```

Keep `crossCheckUnmapped` itself unchanged (still used narrowly by the existing unmapped-only
path) — `mineWriteSites` is the new, broader sibling, not a replacement.

**Acceptance criteria:**
- New file, new prompt constant (`AI_MINER_PROMPT`), same JSON-parse/drop-on-failure pattern
  as `crossCheck.ts` and `critic.ts`.
- Unit test: malformed JSON → empty candidates + diagnostic, not a throw.
- Unit test: claim citing a nonexistent line → dropped.
- Unit test: claim citing a real line → kept.

---

### KOD-4 — Unit tests for the miner against the existing fixture
**Size:** S
**Files:** `translator/agentloop/aiWriteSiteMiner.test.ts`
**Depends on:** KOD-3

Run the miner (with a stub `ModelProvider`, no live API calls — same pattern as
`translator/agentloop/loop.test.ts`) against `fixtures/ShipmentNoticeMapper.java` and assert
the candidate shape, dropped-claim handling, and that an empty `declaredFields` list short-
circuits to `{ candidates: [], dropped: [] }` without a model call (mirror
`crossCheckUnmapped`'s existing empty-input guard, `crossCheck.ts:45`).

**Acceptance criteria:**
- Added to `test:agentloop` script in `package.json`.
- Test passes with `tsx --test translator/agentloop/aiWriteSiteMiner.test.ts`.

---

## Epic C — Reconciliation (deterministic, not a third agent)

### KOD-5 — Deterministic diff between CST sites and AI candidates
**Size:** M
**Files:** new `analyzer/reconcile.ts`
**Depends on:** KOD-3

Plain code, no model call — same spirit as `analyzer/secondOpinion.ts`'s `findPossibleMissedWrites`.

```ts
export interface ReconcileResult {
  agreed: string[];              // fields both legs found (or only CST ran)
  aiOnly: AiWriteCandidate[];    // AI found it, CST silent
  cstOnly: WriteSite[];          // CST found it, AI silent — CST still wins here
}
export function reconcile(
  cstSites: WriteSite[],
  aiCandidates: AiWriteCandidate[],
  declaredFields: string[],
): ReconcileResult
```

Rule: when only one leg ran (the other disabled via KOD-1/KOD-2 flags), skip reconciliation
entirely and pass that leg's output straight through — this ticket only fires when both legs
ran.

**Acceptance criteria:**
- Pure function, no I/O, no provider dependency — testable without mocks.
- Unit tests: both agree; AI-only; CST-only; both silent (field stays unmapped).
- Field-name matching reuses the same normalize/decap logic already in
  `secondOpinion.ts:129-141` (extract it to a shared helper rather than duplicating it —
  see KOD-6).

---

### KOD-6 — Extract shared field-name normalization helper
**Size:** S
**Files:** `analyzer/secondOpinion.ts`, `analyzer/reconcile.ts`, new `analyzer/fieldNames.ts`
**Depends on:** KOD-5

Small cleanup ticket: `secondOpinion.ts` already has the `leaf.replace(/[^a-zA-Z0-9]/g,
"").toLowerCase()` + decap normalization inline (lines 129, 138-140). Pull it into
`analyzer/fieldNames.ts` as `normalizeFieldName(name: string): string` and use it from both
`secondOpinion.ts` and the new `reconcile.ts` so the two miss-detection paths can't drift.

**Acceptance criteria:**
- `analyzer/secondOpinion.test.ts` still passes unmodified (behavior-preserving extraction).
- `reconcile.ts` imports the same helper instead of reimplementing it.

---

### KOD-7 — Feed `aiOnly` candidates into the audit gate as `unresolved`
**Size:** M
**Files:** `analyzer/auditGate.ts`, `translator/agentloop/loop.ts`
**Depends on:** KOD-5

When `reconcile()` returns `aiOnly` candidates for a field the CST checklist called
`unmapped`, flip that field to `unresolved` before the gate runs — same effect
`crossCheckUnmapped`'s flip already has today (`crossCheck.ts` docblock: "it can only DEMOTE
confidence... never assert truth"), just sourced from the broader miner instead of the
unmapped-only cross-check. This routes straight into the existing escalation / tool-loop path
(`loop.ts` — `investigateField`), no new resolution logic needed.

**Acceptance criteria:**
- A field the CST missed but the AI miner found (with a verified citation) ends the run as
  `unresolved`, never silently `unmapped`, when both legs are on.
- A field neither leg found stays `unmapped` (unchanged behavior).
- `analyzer/analyzer.test.ts` / `translator/agentloop/loop.test.ts` gain a case covering this.

---

## Epic D — Wiring both legs together in the loop

### KOD-8 — Run CST and AI miner in parallel inside `runAgentLoop`
**Size:** M
**Files:** `translator/agentloop/loop.ts`
**Depends on:** KOD-2, KOD-7

Inside `runAgentLoop`, branch on `useCst`/`useAiMiner`:
- both true (**the default from this ticket on**) → `Promise.all([scanWriteSites(...),
  mineWriteSites(...)])`, then `reconcile()`, then proceed with the adjusted
  mapped/unmapped/unresolved lists.
- `--no-ai-miner` → CST only, byte-identical to the pre-this-plan behavior, zero extra model
  calls. Escape hatch for cost control or when the miner itself is misbehaving.
- `--no-cst` → AI miner is the sole source of the checklist; skip `reconcile()` entirely
  (KOD-5's pass-through rule). Escape hatch for a CST parser bug on new syntax.
- both off → error out early with a clear message ("at least one of --cst / --ai-miner must
  be enabled") rather than silently producing an empty checklist.

**Acceptance criteria:**
- Default invocation (`npm run label -- --analyzer`, no new flags) now runs **both** legs —
  one CST scan plus one AI-miner model call per run — and this is called out in the run's
  stderr summary so it isn't a silent cost surprise.
- `--no-ai-miner` reproduces the pre-this-plan output and model-call count exactly — verified
  by diffing against a golden run captured before Epic D landed.
- `--no-cst --ai-miner` (or bare `--no-cst`, since ai-miner defaults on) runs with zero CST
  parsing and no `reconcile()` call.
- `--no-cst --no-ai-miner` exits with the guard error, no partial run.

---

### KOD-9 — Surface reconciliation diagnostics in run output
**Size:** S
**Files:** `translator/agentloop/loop.ts`, `translator/report/metrics.ts` or wherever
`groundingWarnings`/`criticFindings` are already surfaced (`loop.ts:81-88`)

Add `reconciliationDiagnostics?: string[]` to `AgentLoopResult`, populated from
`reconcile()`'s dropped/aiOnly/cstOnly lists, following the exact pattern
`groundingWarnings` and `criticFindings` already use. Log to stderr the same way.

**Acceptance criteria:**
- `aiOnly` and `cstOnly` disagreements are visible in CLI stderr output and in the JSON result
  written by `translator/cli.ts`, not just swallowed into the gate's pass/fail.
- No new diagnostic channel invented — reuse the existing `diags: string[]` convention from
  `secondOpinion.ts`'s `missDiagnostics`.

---

## Epic E — Telemetry, tests, docs

### KOD-10 — Golden-harness run with `--ai-miner` on the existing fixture
**Size:** M
**Files:** `translator/report/goldenHarness.ts`, `fixtures/ShipmentNoticeMapper.java`
**Depends on:** KOD-8

Add a golden-harness variant that runs with `--ai-miner` enabled and asserts it does **not**
regress field count or introduce spurious `unresolved` fields on a fixture the CST already
handles correctly today. This is the regression guard against the miner degrading the common
case.

**Acceptance criteria:**
- `npm run test:golden` covers both `--ai-miner` on and off without manual setup.
- A deliberately mangled/renamed-syntax variant of the fixture (simulating "CST breaks on new
  syntax") demonstrates `--cst=false --ai-miner` still recovers the checklist.

---

### KOD-11 — Drift/telemetry: track AI-miner disagreement rate over time
**Size:** S
**Files:** `translator/telemetry/drift.ts`, `translator/telemetry/journal.ts`
**Depends on:** KOD-9

Log `aiOnly`/`cstOnly` counts per run into the existing journal (`journal.ts` —
`appendRun`/`sourceSha`, already called from `loop.ts:27`), and add a `drift.ts` check that
flags a mapper whose disagreement rate spikes run over run (possible sign the CST parser needs
a fix for new syntax appearing in that repo).

**Acceptance criteria:**
- `npm run drift` reports disagreement-rate trend per mapper, not just today's existing drift
  signal.
- `translator/telemetry/drift.test.ts` gains a case for a spiking disagreement rate.

---

### KOD-12 — Update CLAUDE.md / ARCHITECTURE.md for the two-leg default
**Size:** S
**Files:** `CLAUDE.md`, `ARCHITECTURE.md`
**Depends on:** KOD-8 (can go out ahead of KOD-10/11 since the default is already decided)

Document the two-leg design in `ARCHITECTURE.md` (extend the "toolbox" / flow diagram
sections) and add the flags — including that both default to `true` and cost one extra model
call per run — to `CLAUDE.md`'s command list and "key architectural rules" section (the
"verified store outranks caches" / fingerprint rule should note the miner call happens
pre-fingerprint-hit-check same as today's labeler, i.e. a verified-store hit still short-
circuits both legs, zero calls).

**Acceptance criteria:**
- Both docs mention `--ai-miner` / `--cst` / `--no-ai-miner` / `--no-cst`, the default-on
  state, and the reconciliation rule.
- `CLAUDE.md`'s fingerprint/verified-store section explicitly confirms a store hit still
  skips both legs — this is the one place "zero AI calls on a hit" must stay true regardless
  of the new default.

---

## Explicitly out of scope for this plan

- A fourth "arbitration agent" that picks between disagreeing legs with its own judgment —
  the reconciler (KOD-5) is deterministic code; genuine unresolved disagreements go through
  the **existing** escalation/tool-loop path (`investigateField` in `loop.ts`), not a new
  agent role.
- Changing what `scanWriteSites` itself parses — this plan adds a parallel leg, it does not
  patch the CST.
- A cost/rate-limit guard on the extra default model call (e.g. skipping the miner leg above
  some field-count threshold) — flag it if run cost becomes a problem in practice, but it's
  not blocking this plan since `--no-ai-miner` is always available as a manual override.

## Implementation notes (where the shipped code deviates from the tickets above)

- **KOD-3**: one `mineWriteSites()` call covers the *entire* declared-field checklist in a
  single request (not just currently-unmapped fields) — cheaper (one call either way) and lets
  the reconciler compute `agreed`/`cstOnly` too, not just `aiOnly`. `crossCheckUnmapped` /
  `crossCheck.ts` is untouched and still has its own tests; it's just no longer called from
  `runAgentLoop` (superseded there by the miner).
- **KOD-2 / "AgentLoopOptions"**: `useAiMiner` lives on `AgentLoopOptions` as planned. `useCst`
  does **not** — it's a task-*building*-time decision, so it surfaced as `skipCst?: boolean` on
  `buildLabelTasks()` (`translator/agentloop/tasks.ts`) instead, wired from the CLI's `--no-cst`.
  `AgentLoopOptions.skipCrossCheck` is kept as a deprecated alias (`useAiMiner ?? !skipCrossCheck`).
- **KOD-1**: `parseArgs` booleans don't auto-negate, so the CLI exposes both `--cst`/`--ai-miner`
  (default true) and explicit `--no-cst`/`--no-ai-miner` off-switches, resolved together.
- **KOD-7 / "--no-cst" fields**: rather than skipping reconciliation outright, an AI candidate
  for an already-`unresolved` field (the state every field starts in under `--no-cst`) is
  attached as a hint note for the escalation pass, since `reconcile()` still runs — this was
  simpler than special-casing "only one leg ran" and has the same effect (AI never asserts
  `mapped` on its own either way).
- **KOD-10 / KOD-11**: not implemented. `reconciliationDiagnostics` (KOD-9) is on
  `AgentLoopResult` and logged to stderr per run, which is enough to eyeball disagreement rate
  manually; wiring it into `drift.ts`/the golden harness is still open.
- **Offline mode (KOD-13, added after the plan above shipped)**: the AI miner still never makes
  an HTTP call offline — `exportAgentJob` only calls `buildLabelTasks` (the CST leg). Leg 2 is
  the editor agent filling `ai-leg-writes.json` using embedded `job.minerPrompt` (exact online
  `AI_MINER_PROMPT`, same `{ writes: [...] }` shape). Then:
  - `translator/agent/offlineMiner.ts` citation-verifies writes → `ai-leg-candidates.json`
  - `translator/agent/reconcileOffline.ts` calls the same `reconcile()` / `verifyCitations()` and
    writes `label-plan.json` where **`aiOnly` → `demotedUnresolved`** (online demote parity —
    miner never asserts mapped alone; labeler uses `systemPrompt` / escalation)
  - Import gap-checks demoted fields via `label-plan.json`
  - `--no-cst` parity on export/auto-fallback unchanged
  - Driven by `.github/agents/kodiak-label.agent.md` / instructions / `.cursor/rules`
  - Tests: `translator/agent/reconcileOffline.test.ts` (pure — no filesystem, no network).
