# Bigchange: Conversational Ping-Pong Review Mode

Date: 2026-06-19
Status: DRAFT (untracked — do not commit until implemented, verified, and renamed `_completed`)
Owner: James

## 1. What we're building

A conversational "ping-pong till done" mode, triggered from the **main chat** while
talking to any model (e.g. Claude). When armed, the model does its work (a plan or an
implementation), then a **full agentic reviewer session running a different model**
(e.g. Codex) goes off, deep-dives the plan/code with real repo + tool access, and comes
back with concrete suggestions. The original model analyses the suggestions, pushes back
where they're wrong, fixes what's valid, and the cycle repeats — **until both models are
genuinely happy** (mutual convergence), or a hard cap (default 15, range 10–20 rounds) or
cost budget is hit.

### Design decisions (locked with James)
1. **It is a Loop mode**, not a new coordinator. We reuse the loop's iteration engine,
   caps, pause/resume, no-progress detector, evidence ladder, and existing chat UI.
2. **Reviewer is never the builder's own model.** Global setting "Ping-pong reviewer"
   = `Auto (different model)` (default) | `Codex` | `Gemini` | … Plus a per-run override
   in the loop control. Hard guard: reviewer provider != builder provider.
3. **Mutual convergence.** Done only when the reviewer returns *no blocking issues* AND
   the builder declares it has addressed/rebutted everything. Models must push each other
   but the prompts are calibrated to avoid pointless adversarial nitpicking. 10–20 rounds
   uninterrupted; hard cap + cost cap as backstops; no-progress detector kills nitpick
   spirals.
4. **Plan vs implementation is inferred from the prompt** (lightweight intent classifier),
   with a manual override if it guesses wrong.
5. **Fresh eyes every round** — a brand-new reviewer instance is spawned each round.

## 2. Why this maps cleanly onto the existing loop

The loop provides most of the cycle skeleton, but with an important correction from the
Codex review (§9): the existing fresh-eyes gate is a **finish-line second opinion**, not a
per-builder-step cycle. We build ping-pong by driving that completion path on **every
builder done-declaration** and injecting the full agentic reviewer.

- `FreshEyesReviewer` is an **injected seam** on the coordinator
  (`loop-coordinator.ts:237` field, `:240` setter). Today it's `defaultFreshEyesReviewer`
  (`loop-fresh-eyes-reviewer.ts:78`) which calls the **thin** `CrossModelReviewService`
  (one-shot diff opinion, no exploration — `cross-model-review-service.ts:317`).
- The completion gate runs the reviewer, filters findings by severity, and on blocking
  findings **converts them to an intervention** pushed onto `state.pendingInterventions`
  (`loop-coordinator-completion-gates.ts:289,304`), which is injected into the next builder
  prompt and cleared (`loop-coordinator.ts:1373,1395`); on clean it emits `…-passed`.
  **This intervention round-trip is the reusable ping-pong mechanism.**
- **Correction (Codex R1 #2 + R2 blocker #1):** the reviewer currently fires only *after*
  a builder completion signal + verify/belt checks (gated mode,
  `loop-coordinator.ts:1716,1782`) or after a **clean self-review with no production
  changes** reaches the clean-streak threshold (review-driven,
  `…completion-gates.ts:97,111`). Tuning `requiredCleanReviewPasses` does NOT produce a
  per-round cycle — as soon as the builder edits code, `noProductionChanges` is false and
  the reviewer is **skipped**. So ping-pong needs a **dedicated completion branch**, not a
  reused/retuned review-driven path (see §4.3a).

So the work is: **add an explicit ping-pong completion branch that runs the agentic
reviewer on every builder completion attempt, swap the reviewer for a full agentic one
spawned fresh per round, make convergence mutual AND fail-closed, and add an easy trigger +
settings + intent detection.**

## 3. Architecture

```
Main chat (talking to Claude)
   │  user: "ping-pong till done: <task>"  OR  /pingpong  OR toggle button
   ▼
Intent classifier  ── plan? impl? ──►  selects reviewer prompt template + verify policy
   ▼
Loop started review-driven (completion.crossModelReview.pingPong.enabled = true)
   │
   ├─ Builder iteration (existing loop builder = the model in the chat)
   │     produces/updates plan or implementation; declares done
   ▼
AgenticPingPongReviewer  (NEW — implements FreshEyesReviewer)
   │   spawns a FRESH full reviewer instance (different provider) via ReviewerSessionSpawner
   │   (wraps existing InstanceManager.createInstance); reviewer reads repo/plan with full
   │   tools; returns structured findings
   ▼
Gate: blocking findings? ──► inject as interventions ──► builder addresses/rebuts (next iter)
        no blocking + builder declares done ──► MUTUAL CONVERGENCE ──► complete
   │
   └─ Backstops: max rounds (15, cfg 10–20), cost cap, no-progress detector
```

## 4. Components

### 4.1 NEW: `ReviewerSessionSpawner` (wraps the EXISTING spawn API)
**Correction (Codex finding #3):** a programmatic spawn API already exists —
`InstanceManager.createInstance(config)` (`instance-manager.ts:1188`) with
`InstanceCreateConfig` supporting `parentId`, `workingDirectory`, `initialPrompt`,
`modelOverride`, `provider`, `yoloMode`, metadata (`instance.types.ts:417`). The
marker-parsing path (`instance-orchestration.ts:200`) is just one *caller* of it. So we do
NOT add a missing primitive — we add a wrapper that gives the reviewer an awaited,
disposable execution contract.

**The wrapper is required because `createInstance` is not "fire-and-await-result"
(Codex finding #4):** it returns after synchronous registration while adapter startup +
prompting continue in the background (`instance-lifecycle.ts:832,971`); the instance can
be marked idle *before* the initial prompt is sent (`:1538,1557`), and `readyPromise`
covers readiness, not "review complete" (`:1626`).

**Add** `src/main/orchestration/reviewer-session-spawner.ts` exposing
`runReviewSession(opts): Promise<ReviewSessionResult>` that:
- spawns via `InstanceManager.createInstance` with deliberate semantics (see R1 below).
- **correlates completion explicitly (Codex R2 #4):** the real awaitable primitive is
  `InstanceManager.waitForInstanceSettled` (`instance-manager.ts:1142`), backed by
  `InstanceSettledTracker.waitForSettled` (`instance-settled-tracker.ts:107`). Use that —
  raw `idle` is explicitly unsafe (instance can be idle before the prompt is even sent).
  Send the deep-dive prompt, await settled, enforce a **timeout**, support **cancellation**.
- reads the final output, returns `{ finalOutput, instanceId, tokensUsed, costUsd }`
  (cost/tokens needed for the loop budget — finding #6).
- **tears the instance down** every round (fresh-eyes ⇒ disposable; reliable termination,
  cf. MEMORY circuit-breaker cleanup leak).
- registers the spawned instance in the **agent tree** so James can watch the deep-dive
  live. Note: direct `createInstance` does NOT auto-apply the orchestration child
  limits/hooks (`orchestration.child.started`, `instance-orchestration.ts:327`); we either
  call that hook ourselves or accept the reviewer sits outside child-count limits.

### 4.2 NEW: `AgenticPingPongReviewer` (implements `FreshEyesReviewer`)
New file `src/main/orchestration/agentic-pingpong-reviewer.ts`.
- Signature matches the existing seam: `(input: FreshEyesReviewerInput) => Promise<FreshEyesReviewerResult>`
  (`loop-fresh-eyes-reviewer.ts:69`).
- Picks reviewer provider = setting, resolving `Auto` to "any installed provider !=
  builder provider"; hard guard rejects builder == reviewer.
- Builds a **deep-dive** task prompt (NOT a diff-scoring prompt):
  - plan mode: "Read the plan at <planFile> and the relevant code. Independently verify
    each load-bearing claim. Find gaps, wrong assumptions, missing edge cases, ordering
    problems. Return concrete, material issues with file:line. If nothing blocking, reply
    APPROVED. Do not invent nitpicks."
  - impl mode: "Deep-dive the implementation (git diff = starting point, but read whatever
    you need). Find correctness/security/edge/test-coverage issues. file:line. APPROVED if
    nothing material. No pointless nitpicks."
- Calls `ReviewerSessionSpawner.runReviewSession`, then parses the reviewer's structured
  output into `FreshEyesFinding[]` (reuse the existing severity schema; ask the reviewer
  to emit a small JSON block we can parse, with a tolerant fallback).
- Fresh instance per call (each gate invocation = new round = fresh eyes).
- On infra failure, returns `infrastructureError` — but in ping-pong mode this is treated
  as **fail-closed** (does NOT count as convergence — §4.4), not the existing degrade-safe
  "pass" behaviour.

**Per-loop injection, not a global setter (Codex R2 blocker #2).** `freshEyesReviewer` is a
single coordinator field with a global `setFreshEyesReviewer` (`loop-coordinator.ts:237,240`)
— overwriting it would corrupt *other concurrent loops* (AIO runs many). Change the
coordinator to resolve the reviewer **per loop run** (e.g. a reviewer factory keyed by
runId, or carry the ping-pong reviewer on the run's config/state), so a ping-pong loop and
a normal loop can run simultaneously.

**Extend `FreshEyesReviewerInput` (Codex R2 blocker #2).** It currently lacks the data the
ping-pong reviewer needs (`loop-fresh-eyes-reviewer.ts:22`). Add `builderProvider`
(to enforce reviewer != builder), `planFile` (for plan-mode deep-dive), and `subject`
('plan' | 'impl'). Also add the issue-ledger handle (§4.9).

### 4.3 CHANGED: Loop config / types — the ACTUAL seam
**Correction (Codex finding #1):** the coordinator branches on `completion.mode`
(`loop-coordinator.ts:1156`), NOT on `reviewStyle` — `reviewStyle` is UI/summary-level
only. So ping-pong is selected through the completion config, not a new `reviewStyle`.

`src/shared/types/loop.types.ts`:
- Drive ping-pong via `completion.mode: 'review-driven'` + a new
  `completion.crossModelReview.pingPong?: LoopPingPongConfig` block (reuse the existing
  `LoopCrossModelReviewConfig` for severity thresholds — already partly in the schema,
  `loop.schemas.ts:148`):
  `{ enabled: boolean; reviewerProvider?: 'auto' | CanonicalCliType;
     subject?: 'auto' | 'plan' | 'impl'; maxRounds?: number (default 15, clamp 1..20);
     freshReviewerEachRound: true; }`.
- Add `pingPongRoundCount` to `LoopState`. (Do NOT tune `requiredCleanReviewPasses` — that
  path is gated by `noProductionChanges`; ping-pong uses the dedicated branch in §4.3a.)
- Schema lives at `packages/contracts/src/schemas/loop.schemas.ts:148`; renderer-facing
  config at `src/preload/domains/loop.preload.ts`.
- (Optional, cosmetic only) add `'ping-pong'` to `LoopReviewStyle` for UI labelling — but
  it must NOT be the behavioural switch.

### 4.3a NEW: Dedicated ping-pong completion branch (Codex R2 blocker #1)
Do NOT reuse/retune `evaluateReviewDrivenCompletion`'s clean-streak path (it requires a
clean self-review with `noProductionChanges`, so it skips the reviewer right after the
builder edits — §2). Add an explicit branch (new `evaluatePingPongCompletion` in
`loop-coordinator-completion-gates.ts`, selected when `pingPong.enabled`) that, on **every
builder completion attempt** (builder declares done), runs the agentic reviewer regardless
of whether production files changed this iteration. Each invocation = one round.

### 4.4 CHANGED: Mutual + fail-closed convergence
- **Convergence requires an AUTHORITATIVE reviewer verdict (Codex R2 #3 + Copilot #1/#5),
  not merely `blocked:false`.** Today `runFreshEyesReviewGate` returns `blocked:false` on
  reviewer error / unavailable reviewer (`…completion-gates.ts:214,231`) — that would make
  a crashed or rate-limited reviewer *pass*. Ping-pong distinguishes three reviewer
  outcomes: `APPROVED` (verdict + completeness evidence), `CHANGES_REQUESTED` (findings),
  `UNRELIABLE/ERRORED` (timeout, infra fail, empty/unparseable, or failed the validity gate
  §4.9). Only `APPROVED` can converge; `UNRELIABLE` is **fail-closed** → retry/backoff or
  a terminal `reviewer-unreliable` state (§4.11), never a silent pass.
- Convergence = reviewer `APPROVED` AND builder self-review verdict clean/done. Both sides.
- Add `pingPongRoundCount` to `LoopState` (distinct from `reviewDrivenStallIterations`,
  which only counts no-file-change CRITICAL stalls — reviewer feedback IS progress).
- No-progress / anti-nitpick: if K consecutive rounds yield only low-severity churn with no
  new blocking issues and no builder changes → converged-or-arbitrate (§4.11), not infinite.
- Verify policy: impl mode runs the verify command if configured; plan mode skips verify
  (no code to run) and relies on mutual review convergence (R4).

**Cost + pause/cancel (Codex finding #6):**
- Extend `FreshEyesReviewerResult` (`loop-fresh-eyes-reviewer.ts:59`) with
  `tokensUsed?/costUsd?`, and fold reviewer spend into the loop's budget accounting
  (currently builder-only via `childResult`, `loop-coordinator.ts:1583`) so the cost cap
  actually bounds ping-pong.
- The loop pause check is only at the top of an iteration (`loop-coordinator.ts:1174`); a
  long reviewer session would otherwise run through a pause. The spawner must expose
  cancel + react to loop pause/cancel and terminate the in-flight reviewer instance
  (mirror `CrossModelReviewService`'s pause-cancel, `cross-model-review-service.ts:72`).

### 4.5 NEW: Intent classifier (plan vs impl)
New helper `src/main/orchestration/pingpong-intent-classifier.ts`:
- Small single-LLM classification of the kickoff prompt (precedent: loop's LF-2 semantic
  progress check). Returns `'plan' | 'impl'` + confidence.
- Heuristic fast-path first (keywords: "plan", "design", "spec" vs "implement", "fix",
  "build", "refactor"); LLM only on ambiguity.
- Overridable by explicit `/pingpong plan` / `/pingpong impl` or the `subject` config.

### 4.6 NEW: Settings (Codex finding #7 — scope is wider than first stated)
- `AppSettings` interface + `DEFAULT_SETTINGS` (`settings.types.ts:217,468`):
  - `pingPongReviewerProvider: 'auto' | 'codex' | 'gemini' | 'claude' | 'copilot' | 'cursor'`
    default `'auto'`.
  - `pingPongMaxRounds: number` default `15`.
- Add metadata/policy entries in `settings-control-policy.ts:171`.
- NOTE: `settings-validators.ts` currently validates **pause** settings specifically
  (`:110`) — don't assume a generic validator hook; add validation following that pattern
  if needed.
- Read in `AgenticPingPongReviewer` via `getSettingsManager().get(...)`
  (`settings-manager.ts:436`).

### 4.7 CHANGED: Trigger + UI
- **Easy button:** add a "Ping-pong" control next to the existing Loop toggle in
  `input-panel` (loop toggle lives at `input-panel.component.html:260`). Clicking arms a
  review-driven loop with `completion.crossModelReview.pingPong.enabled=true`, using the
  current chat's model as builder and the setting's reviewer.
- **Command:** recognise `/pingpong [plan|impl] <task>` in the chat input.
- **Natural language (optional, low-priority):** recognise "ping-pong till done" as an
  alias for the command (kept simple; the button/command are the reliable paths).
- Expose `pingPong` + `crossModelReview` in `LoopConfigInput` (`loop.preload.ts:5-44`)
  and `prepareLoopStartConfig` (currently `crossModelReview` is server-only).
- Loop control panel: per-run reviewer override + max-rounds slider (10–20).

### 4.8 CHANGED: Events / observability
- Reuse `loop:fresh-eyes-review-started/passed/blocked` events for round visibility.
- Add round counter + current reviewer provider to loop state broadcast so the UI can show
  "Ping-pong round 4/15 — Codex reviewing".

### 4.9 NEW: Issue ledger + review-validity gate + structured findings
(Reconciles "fresh eyes every round" with not re-litigating settled points — Copilot #2/#3/#5.)

- **Durable issue ledger** held in `LoopState` (persisted, §4.12), OUTSIDE model context:
  each issue = `{ id, title, severity, status: open|resolved|rebutted|regression, evidence,
  raisedRound, lastSeenRound, builderResponse }`. A fresh reviewer still reads the code
  cold, but is **handed the ledger** and must classify each prior issue as
  still-open/resolved/regression/new — so it doesn't blindly re-raise resolved items, and
  regressions are caught.
- **Structured findings, not prose (Copilot #2):** the reviewer must emit a schema'd block
  per finding — `severity` (rubric-defined), `file:line`, `evidence` citation, and a
  `novelty` flag vs the ledger. Findings without evidence are dropped. Cap new low-severity
  findings per round to throttle nitpick churn.
- **Review-validity / completeness gate (Codex R2 #3, Copilot #1/#5):** the reviewer must
  return completeness signals — scope covered, files/tools actually inspected, commands run.
  If those are absent or below a minimum-work threshold, the round is `UNRELIABLE` (§4.4),
  NOT a clean pass. This is how we distinguish "clean because good" from "clean because the
  reviewer didn't actually look."

### 4.10 CHANGED: Subject re-evaluation (Copilot #6)
Re-evaluate plan-vs-impl subject each round (cheap, reuse §4.5 classifier) rather than once
at start — a task can move from planning into implementation mid-run. Hybrid mode (plan +
impl checks together) is deferred (§8) but the ledger/verdict design doesn't preclude it.

### 4.11 NEW: Terminal states beyond converged/cap (Copilot #4)
Add ping-pong terminal states so deadlocks/unreliability surface instead of silently
passing or spinning: `converged`, `cap-reached`, `cost-exceeded`,
`needs-human-arbitration` (K contradictory rounds — reviewer keeps blocking, builder keeps
rebutting the same point), `reviewer-unreliable` (repeated UNRELIABLE rounds / provider
outage), `builder-unreliable` (builder declares done but never addresses findings). Each
maps onto / extends `LoopStatus` (`loop.types.ts:576-602`) and is shown in the UI with the
relevant context for James to arbitrate. **When adding `LoopStatus` values, update every
terminal/projection helper** (Codex R3 note): `workflow-lifecycle.types.ts`,
`loop-handlers.ts`, `default-invokers.ts`, campaign status mapping, and renderer formatters
— a missed projection silently mis-renders the new states.

### 4.12 NEW: Persistence, resilience & UX controls (Codex R2 #3 tail, Copilot #7)
- **Persist ping-pong state** (round count, issue ledger, current subject, in-flight
  reviewer metadata) via the existing loop store so a mid-ping-pong app restart resumes
  rather than loses the thread. **Normalize crash-restored checkpoint state on resume**
  (Codex R3 note): interrupted in-flight reviewer metadata must be explicitly reconciled —
  a reviewer instance that was mid-run at crash = mark that round UNRELIABLE and re-run;
  never resume pointing at a dead instance id.
- **Reviewer outage/rate-limit:** retry/backoff; then provider fallback (next eligible
  non-builder provider); then `reviewer-unreliable` terminal — never a fake pass.
- **User controls** during a run: pause, resume, **skip this reviewer round**, **force human
  decision** (jump to `needs-human-arbitration`), and a live cost/round readout. Wire to the
  loop's existing pause/intervene plumbing (`debate:intervene` analogue exists for loops).

## 5. Convergence & anti-adversarial calibration

Prompt wording is necessary but NOT sufficient (Copilot #2) — the structural safeguards in
§4.9 (evidence-required findings, validity gate, ledger classification, churn cap) are the
real defense. Prompts on top:
- Reviewer prompt: "Report only **material** issues that would block a competent engineer
  from approving. Cite evidence (file:line, what you inspected) for each. You MAY and SHOULD
  reply APPROVED when the work is sound. Do not manufacture nitpicks to look thorough."
- Builder prompt (on injected findings): "Evaluate each finding on its merits. Fix valid
  ones. For ones you disagree with, briefly justify and push back — do not capitulate to
  be agreeable. Then declare done only when you genuinely believe the work is complete."
- Backstops: max rounds, cost cap, no-progress/anti-nitpick detector (§4.4), and the
  terminal arbitration states (§4.11).

## 6. Phasing

- **P1 — Infra:** `ReviewerSessionSpawner` (wraps `createInstance` + `waitForInstanceSettled`)
  with timeout/cancel/teardown/cost; agent-tree registration. Unit-test with a mock
  InstanceManager. Decide root-vs-child + permission mode (R1).
- **P2 — Per-loop reviewer plumbing:** make the coordinator resolve the reviewer per run
  (remove reliance on the global setter); extend `FreshEyesReviewerInput`
  (builderProvider/planFile/subject/ledger).
- **P3 — Reviewer:** `AgenticPingPongReviewer` + deep-dive prompts + **structured finding
  parser** + completeness/validity gate (§4.9).
- **P4 — Completion branch:** `evaluatePingPongCompletion` (§4.3a) + fail-closed
  authoritative verdict + mutual convergence + round counter + anti-nitpick (§4.4).
- **P5 — Issue ledger** (§4.9) + persistence/restart-resume (§4.12) + terminal states (§4.11).
- **P6 — Intent classifier** (§4.5) + per-round subject re-eval (§4.10) + plan-mode verify-skip.
- **P7 — Settings** (§4.6) + preload/config plumbing + reviewer outage fallback/backoff.
- **P8 — UI:** button, command, control-panel overrides (skip-round, force-arbitration),
  round/cost display, arbitration surfacing.
- **P9 — Tests + manual run** of a real ping-pong on a small task (both plan and impl).

## 7. Risks / open questions

- **R1 Reviewer truly agentic? (sharpened by Codex finding #5)** `createInstance` *can*
  spawn a full CLI (it passes cwd, MCP config, permission hooks —
  `instance-lifecycle.ts:1369,1382,1390`) but NOT "full-fat by default": `yoloMode`
  defaults false (`settings.types.ts:400`), and instances spawned **with `parentId` skip
  root-only prompt hierarchy / memory / repo-map loading** (`instance-lifecycle.ts:994`).
  Decision required: spawn the reviewer as a **root-level instance (no `parentId`)** so it
  gets repo-map/memory for a genuine deep-dive, and set an explicit read/explore permission
  mode. Resolve before P2.
- **R2 Cost.** Fresh full instance every round × 10–20 rounds × 2 models is expensive.
  Cost cap is mandatory; surface a live spend readout.
- **R3 Finding-parse robustness.** Reviewer is a free-form agent; need a tolerant parser
  (JSON block preferred, regex/sentinel fallback). Per §4.4, an unparseable result is
  `UNRELIABLE` (fail-closed), never a silent clean pass.
- **R7 Concurrency.** Multiple loops run at once; the reviewer must be resolved per-run, not
  via the global `setFreshEyesReviewer` (§4.2). Verify no shared mutable reviewer state.
- **R8 Ledger drift.** The issue ledger must stay consistent across fresh reviewers and app
  restarts; a fresh reviewer mis-classifying a resolved item as open should be cheap to
  correct (builder rebuts → ledger updates), not a convergence-blocker forever.
- **R4 Plan-mode verify.** No code to run; ensure the completion path doesn't require a
  verify command in plan mode.
- **R5 Teardown leaks.** Disposable reviewer instances must be reliably torn down each
  round (counter/circuit-breaker cleanup precedent in MEMORY: terminate cleanup).
- **R6 Intent misclassification.** Always allow explicit override; default to impl on low
  confidence (safer — runs verify).

## 8. Out of scope (for now)
- Reviewer-of-reviewer (>2 models) — design allows a reviewers[] list later.
- Persisting full reviewer transcripts beyond the agent-tree/output buffer.

## 9. Review log (ping-pong on the plan itself)

### Round 1 — Codex (gpt-5.5), read-only deep-dive against the real source
Material findings, all accepted and folded in above:
1. `reviewStyle` is not the behavioural seam — coordinator branches on `completion.mode`
   (`loop-coordinator.ts:1156`). → §4.3 rewritten.
2. Existing gate is a finish-line second opinion, not a per-round cycle — reviewer fires
   only after completion signal/verify or clean-streak. → §2 corrected; ping-pong drives
   review-driven mode per done-declaration.
3. "No programmatic spawn API" was FALSE — `InstanceManager.createInstance`
   (`instance-manager.ts:1188`) exists. → §4.1 reframed as a wrapper.
4. `createInstance` returns before the review completes (idle before prompt sent;
   readyPromise ≠ done). → §4.1 explicit completion-correlation + timeout + cancel.
5. R1 sharpened: `parentId` children skip repo-map/memory; `yoloMode` false by default →
   spawn reviewer as root-level with explicit permissions. → §7 R1.
6. Cost/pause untracked: `FreshEyesReviewerResult` has no cost fields; pause only checked
   at iteration top. → §4.4 cost+pause additions.
7. Settings scope wider (AppSettings/defaults/control-policy; validators are pause-specific;
   crossModelReview already partly in schema). → §4.6.
APPROVED by Codex: FreshEyesReviewer injection seam exists; default reviewer is thin;
intervention-injection mechanism is real and reusable.

### Round 1 — Gemini (fresh eyes): NOT RUN
`gemini-cli` failed with `IneligibleTierError` (free tier deprecated → "migrate to
Antigravity"). Third-perspective fresh-eyes pass on the plan is still outstanding —
substitute Copilot or a separate Claude reviewer subagent before build.

### Round 2 — Codex (gpt-5.5), re-review against source
Verified R1 fixes: #1,#3,#5,#6,#7 RESOLVED; #4 PARTIAL (named the real awaitable
`waitForInstanceSettled`/`InstanceSettledTracker.waitForSettled` — folded into §4.1).
**#2 NOT RESOLVED** + 3 new blockers, all accepted and folded in:
- B1: clean-streak tuning can't produce per-round review → §4.3a dedicated
  `evaluatePingPongCompletion` branch.
- B2: global `setFreshEyesReviewer` unsafe for concurrent loops + `FreshEyesReviewerInput`
  missing builderProvider/planFile/subject → §4.2 per-loop reviewer + extended input.
- B3: reviewer error returns `blocked:false` (fake pass) → §4.4 fail-closed authoritative
  verdict (APPROVED / CHANGES_REQUESTED / UNRELIABLE).

### Round 2 — Copilot (gpt-5.3-codex), fresh eyes (Gemini still down this round)
7 ranked issues; #1/#5 independently matched Codex B3 (false convergence). Accepted:
- Validity/completeness gate + structured evidence-bearing findings → §4.9.
- Durable issue ledger reconciling "fresh eyes every round" with no re-litigation → §4.9.
- Deadlock/unreliable terminal states → §4.11. Per-round subject re-eval → §4.10.
- Persistence/restart/interrupt + reviewer-outage fallback + user controls → §4.12.
Copilot called the core architecture (loop reuse + provider separation + awaited reviewer
semantics) "genuinely strong."

### Round 3 — Codex (gpt-5.5): APPROVED — implementation-ready
B1/B2/B3 confirmed materially addressed and consistent with the real code (clean-streak
gate is genuinely blocked by `noProductionChanges`; coordinator has a clean branch point in
the review-driven completion path; reviewer seam/input shape matches the per-loop proposal).
4 minor notes, all folded in: stale §4.3 `requiredCleanReviewPasses` line removed; schema/
preload paths pinned (§4.3); update all `LoopStatus` projection helpers (§4.11); normalize
crash-restored checkpoint / in-flight reviewer metadata on resume (§4.12).

### Convergence status
**Plan CONVERGED** per the deep-dive reviewer (Codex: NOT-APPROVED → revised → APPROVED
across 3 rounds) plus one Copilot fresh-eyes pass. Two independent models reviewed.
STILL OUTSTANDING (optional): a third-model fresh-eyes pass via Antigravity
(`mcp__antigravity-cli__ask_antigravity`) — server not yet loaded this session (needs a
Claude Code restart per [[gemini-cli-tier-deprecated]]). Recommend running it before P1 as a
final independent check, but not a blocker.
