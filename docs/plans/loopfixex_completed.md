# Loop Fixes — Executable Implementation Plan (`loopfixex_completed.md`)

> **Status:** ✅ IMPLEMENTED & VERIFIED (2026-05-30). LF-1…LF-8 all have code + specs in `src/main/orchestration/` (`loop-semantic-progress.ts`, `loop-branch-select.ts`, `loop-memory.ts`, `loop-output-externalize.ts`, ledger detector) and renderer (`loop-control.component.ts`, `loop-formatters.util.ts`); `acceptCompletion` / `completed-needs-review` / `maxCompletionAttempts` / `completionAttempts` are wired through coordinator → IPC → store; `maxCostCents` defaults to `1000`; `LoopConfig.context` reset block (`resetAtUtilization: 0.6`) present. The full loop suite is green: **29 spec files / 289 tests pass** (`npx vitest run src/main/orchestration/loop`, 2026-05-30). Renamed from `loopfixex.md` per AGENTS.md `_completed` convention. The checkbox `- [ ]` items below are retained as the historical task list; treat them as DONE.
> **Completion-authority architecture (resolved 2026-05-30):** completion is now governed by a single **evidence-precedence ladder** — (1) runtime truth, (2) external ground-truth (verify/SCM/empty review-thread fingerprint), (3) structured in-band intent (`declared-complete`, this plan's LF-7), (4) forensic markers (corroboration only). `completed-needs-review` is the human-escalation terminal used **only when no external authority exists** (not "the agent self-declared"). The remaining net-new work to fully realize tier 2 (an `evidence-resolver.ts` spine + convergent fix→verify→review cycle + review-quality + remote-node diversity) lives in `2026-05-28-first-class-remote-orchestration-plan.md` **Piece B**, which layers on top of — does not replace — the LF-7 model shipped here. See `claude2_todo.md` #1.
> **For agentic workers:** REQUIRED SUB-SKILL was `superpowers:executing-plans`. This file was loop-executable (the stage machine reads `- [ ]`/`- [x]` items). No further implementation work; future loop changes get a fresh plan.
> **Companion doc (the "why"):** `docs/plans/2026-05-29-loop-intelligence-improvements-plan.md` holds the full rationale/research — now marked SUPERSEDED by this implemented plan.

---

## 1. Goal

Fix the loop's capability gaps so a long-running loop (a) does not degrade from unbounded context growth, (b) can tell "done-idling" from "stuck-idling", (c) can escape dead-ends instead of only pausing for a human, (d) stops on a structured task ledger rather than forensic guesses, (e) learns across runs, and (f) is safe by default on spend. All changes reuse subsystems the app already ships; none rewrite the coordinator.

## 2. Diagnosis (one paragraph)

The loop's safety gates are excellent, but the loop is an **island**: `loop-coordinator.ts`, `loop-stage-machine.ts`, and `default-invokers.ts` import nothing from `src/main/context/` (compaction, token budget, window guard), nothing from `src/main/memory/`, and use the debate/multi-verify coordinators only at the completion gate. The default `contextStrategy: 'same-session'` (`src/shared/types/loop.types.ts:219`) accumulates the whole transcript across up to 50 iterations with no orchestrator-side compaction; progress sensing is purely syntactic (8 hash/Jaccard/count signals) and cannot disambiguate done vs. stuck (proven by `ITERATION_LOG.md` iter 2: `CRITICAL no-progress` + all completion signals in the same iteration); on `CRITICAL` the loop only pauses (`loop-coordinator.ts:1095`); completion is forensic (file rename / `DONE.txt`); `maxCostCents` defaults to `null` (`loop.types.ts:224`).

## 3. Scope

**In scope (this plan):**
- LF-1 Context discipline (wire loop adapters into `CompactionCoordinator` + budget guard) — **P0**
- LF-2 Semantic progress signal (model-based, escalation modifier) — **P0**
- LF-3 Cost-cap default + `NOTES.md` curation — **P0 hygiene, small**
- LF-4 Structured task ledger + RPI plan-first + disposable plan — **P1**
- LF-5 Branch-and-select on stuck (best-of-N) — **P1, gated, default off**
- LF-6 Cross-loop memory (reuse `src/main/memory/`) — **P2**

**Out of scope:** rewriting the coordinator/detectors; changing the IPC transport; remote-orchestration; renderer redesign beyond the few config toggles named below.

## 4. Decisions resolved (defaults — override before/at review)

These are the 4 open questions from the companion doc, resolved here so the plan is executable. Each is flagged `DECISION`; flip any and the affected task adjusts.

1. **`DECISION` Context default:** keep `same-session` as the default (users expect session continuity when a loop runs on a live chat), **but make orchestrator compaction mandatory for it** and correct the contradictory "fresh-context iterations" header in `loop-coordinator.ts:4`. `contextStrategy: 'fresh'` remains a documented, supported option for lowest context-rot. *(Override → flip default to `'fresh'`; then LF-1's reset path becomes the primary mechanism and same-session compaction is secondary.)*
2. **`DECISION` Stuck behavior:** branch-and-select (LF-5) is **opt-in, default off, and supplements** pause-on-CRITICAL (it runs *before* pausing only when `exploration.enabled`). *(Override → make it replace pause when enabled.)*
3. **`DECISION` Provider diversity:** LF-5 is **Claude-only first**; cross-model fan-out sits behind `exploration.crossModel` (default off). *(Override → enable cross-model in v1.)*
4. **`DECISION` Ledger format:** `LOOP_TASKS.md`, human-readable + agent-editable, parsed with the existing `parsePlanChecklist` regex (`^\s*[-*]\s*\[[xX ]\]`). *(Override → JSON sidecar.)*

## 5. Prerequisites & conventions

- Each task ships behind a `LoopConfig` flag; existing behavior is the fallback. Existing 91+ loop tests must stay green.
- New config fields go in **both** `src/shared/types/loop.types.ts` (`LoopConfig` + `defaultLoopConfig`) **and** the Zod schema `packages/contracts/src/schemas/loop.schemas.ts`; run `npm run check:contracts` + `npm run verify:exports`. (No new `@contracts/...` *subpath* is added, so the `register-aliases.ts` gotcha in AGENTS.md does not apply — extending an existing schema only.)
- Verification gate after **every** task: `npx tsc --noEmit` && `npx tsc --noEmit -p tsconfig.spec.json` && `npm run lint` && targeted `vitest` for the touched area.
- Singleton pattern: `getInstance()` + `_resetForTesting()` (see `CompactionCoordinator`). Logging: `getLogger('...')`.
- Observability is a loop strength — every new signal/decision must be recorded on `LoopIteration` and emitted as a `loop:*` event + appended to `ITERATION_LOG.md`. Do not add silent behavior.

---

## 6. Tasks

### LF-1 — Context discipline (P0)

**Why:** Same-session loops grow context unbounded with no orchestrator compaction → quality decay → thrash. The app already has `CompactionCoordinator` (singleton, dual-threshold 75/80/95% via `LIMITS`, `onContextUpdate`, `compactInstance`, `getBudgetTracker`, circuit breaker) — the loop just never calls it.

**Important nuance (verified):** `CompactionCoordinator.configure({ selfManagesAutoCompaction })` already lets adapters that self-compact (Claude CLI in stream-json mode) opt out of orchestrator-triggered compaction (`compaction-coordinator.ts:94-102,139-148`). So LF-1 must: (a) feed loop-adapter `ContextUsage` into the coordinator so **non-self-managing** adapters get compacted, and (b) for self-managing adapters, still track a budget for the loop's own reset/observability decisions rather than double-compacting.

**Files:**
- `src/main/orchestration/default-invokers.ts` (loop adapter lifecycle ~`:1322-1419`; this is where the borrowed/persistent adapter and its `instanceId`/usage are available)
- `src/main/orchestration/loop-coordinator.ts` (per-iteration boundary in `runLoop` ~`:757-806`; correct the header `:4`)
- `src/shared/types/loop.types.ts` + `packages/contracts/src/schemas/loop.schemas.ts` (new config block)
- `src/main/context/compaction-coordinator.ts` (reuse; no change expected)
- `src/renderer/app/features/loop/loop-config-panel.component.ts` (toggle + threshold)

**Changes:**
- [ ] Add `LoopConfig.context` = `{ compaction: { enabled: boolean; resetAtUtilization: number; clearToolResults: boolean } }`; default `{ enabled: true, resetAtUtilization: 0.6, clearToolResults: true }`. Mirror in Zod schema.
- [ ] In the invoker, after each iteration's adapter activity, derive the adapter's `ContextUsage` (the same shape the instance batch-update path emits, `src/shared/types/instance.types.ts`) and call `getCompactionCoordinator().onContextUpdate(instanceId, usage)`. Use the borrowed-instance id when borrowing; for a persistent loop adapter, register it with `configure({ selfManagesAutoCompaction })` correctly so Claude-CLI self-compaction isn't double-triggered.
- [ ] Add a loop-owned **reset rule**: when `getBudgetTracker(instanceId).utilization >= context.compaction.resetAtUtilization` AND the adapter does **not** self-manage, call `compactInstance(instanceId)`; if compaction is unavailable (fresh-child / no native), recycle the persistent adapter to a fresh session. Disk state (STAGE/NOTES/ITERATION_LOG/plan + persistent goal at `loop-stage-machine.ts:332`) re-anchors the next iteration.
- [ ] Enable tool-result clearing for the loop adapter when `clearToolResults` (reuse `context/output-persistence.ts` / `context/error-withholder.ts`).
- [ ] Correct the `loop-coordinator.ts:4` header to describe the *actual* default (same-session + mandatory compaction) and link this plan.
- [ ] Record a `loop:context-compacted` event + an `ITERATION_LOG` note (previous/new utilization).

**Acceptance:**
- A 30-iteration same-session loop keeps adapter utilization below `resetAtUtilization + dual-threshold headroom`; never exceeds 95% blocking unexpectedly.
- WARN/CRITICAL progress-verdict rate in the last third of a long run is **not worse** than the first third (no decay signature).
- After a reset/compaction, the next iteration still has the goal + plan (no goal loss) — assert via a fixture that drops a sentinel task and checks it's still pursued post-reset.
- Borrowed *instance* adapters are never terminated by loop compaction (respect borrowed-vs-owned at `default-invokers.ts:1400-1415`).

**Tests:** `loop-coordinator` + new `default-invokers` test: simulate rising `ContextUsage` → assert `onContextUpdate`/`compactInstance` called at threshold; assert self-managing adapter is NOT orchestrator-compacted; assert goal survives reset.

**Risk:** Over-aggressive compaction drops constraints → keep `resetAtUtilization` conservative (0.6) and preserve plan/NOTES on disk as durable record. **Effort: M.**

---

### LF-2 — Semantic progress signal (P0)

**Why:** Syntactic signals can't tell done-idling from stuck-idling. Add a cheap model-based "did we actually advance the goal?" check as an **escalation modifier** (never a sole stop/continue authority).

**Template:** Mirror `loop-fresh-eyes-reviewer.ts` exactly — a `FreshEyesReviewer`-style injectable function (`setFreshEyesReviewer` DI pattern at `loop-coordinator.ts:210`) backed by `cross-model-review-service`'s `runHeadlessReview`. Use a cheap/fast provider (Haiku).

**Files:**
- New `src/main/orchestration/loop-semantic-progress.ts` (+ `.spec.ts`)
- `src/main/orchestration/loop-coordinator.ts` (hook into progress-evaluation block ~`:880-892`; add `setSemanticProgressReviewer` DI like fresh-eyes)
- `src/main/orchestration/loop-progress-detector.ts` (accept an external verdict in aggregation/escalation)
- `src/shared/types/loop.types.ts` (`LoopSemanticProgressResult`; `progressThresholds.semanticCadence`, `semanticConfidenceFloor`) + Zod schema
- `LoopIteration` type (record the verdict)

**Changes:**
- [ ] Define `LoopSemanticProgressResult = { advanced: boolean; whatChanged: string; confidence: number }`.
- [ ] New reviewer: input = goal + task ledger (LF-4, or plan/NOTES until then) + diff since iteration `N-k` (reuse `loop-diff.ts` `collectWorkspaceDiff`). Prompt: "Compared to the prior checkpoint, did this iteration make measurable progress toward `<goal>`? Return advanced/whatChanged/confidence."
- [ ] **Cadence-gate** to bound cost: run only when (a) a structural signal is WARN, or (b) every `semanticCadence` iterations (default 5). Never every iteration.
- [ ] Wire into escalation: confirmed `advanced=false` (confidence ≥ floor) **upgrades** a structural WARN → CRITICAL; confirmed `advanced=true` **suppresses** a structural CRITICAL that is solely churn-based (A/B/H). Require confirmation across two consecutive checks before flipping a verdict (mirror weak-signal FU-4 at `loop-coordinator.ts` aggregation).
- [ ] Record verdict on `LoopIteration`; emit `loop:semantic-progress`; append to `ITERATION_LOG`.

**Acceptance:**
- Synthetic stuck loop (real edits, no goal progress) pauses **earlier** than structural-only.
- Synthetic converging-churn loop (A→B→A that is genuinely improving) does **not** false-pause.
- Per-loop cost attributable to this signal is bounded (cadence honored) and logged; default provider is the cheap tier.

**Tests:** stub the reviewer to return canned verdicts; assert upgrade/suppress logic + cadence gating + two-check confirmation.

**Risk:** model misjudgment → escalation-modifier only, never sole authority; confirmation required. **Effort: M.**

---

### LF-3 — Cost-cap default + `NOTES.md` curation (P0 hygiene)

**Why:** `maxCostCents: null` → no spend ceiling by default (`loop.types.ts:224`), though design intended $10. `NOTES.md` is agent-maintained, unbounded, and re-injected each iteration — it eats the context LF-1 conserves.

**Files:** `src/shared/types/loop.types.ts` (`defaultLoopConfig`), `loop-config-panel.component.ts`, `loop-stage-machine.ts` (NOTES read/inject), reuse `context/microcompact.ts` or `tools/tool-use-summarizer.ts`.

**Changes:**
- [ ] Default `maxCostCents` to `1000` ($10). Surface in config panel. Make a non-null cost cap a **precondition** for enabling LF-5.
- [ ] Add a `NOTES.md` size/token guard: when it exceeds a threshold, summarize older entries (reuse existing summarizer) while preserving the `## Completion Inventory` section **verbatim**.

**Acceptance:** a loop with no explicit cost config still has a ceiling; `NOTES.md` stays bounded on long runs; completion inventory survives curation byte-for-byte. **Tests:** cap default applied; NOTES curation preserves inventory. **Risk:** low. **Effort: S.**

---

### LF-4 — Structured task ledger + RPI plan-first + disposable plan (P1)

**Why:** Stages advance only when the agent rewrites `STAGE.md` (fragile); default skips planning (`initialStage: 'IMPLEMENT'`, `loop.types.ts:268`); completion is forensic with no per-item ledger (the deferred "Phase 3" gap). RPI: research/plan first, **context reset before implement**, **disposable plan**.

**Files:** `loop-stage-machine.ts` (stage progression, `buildPrompt`, artifact bootstrap, `parsePlanChecklist`), `loop-completion-detector.ts` (ledger state supersedes/augments plan-checklist), `loop-coordinator.ts` (PLAN→IMPLEMENT reset; stall→regenerate), types + schema.

**Changes:**
- [ ] Define `LOOP_TASKS.md` format + parser/serializer (extend `parsePlanChecklist`); item states `todo|doing|done|deferred(reason)`. Bootstrap it in the stage machine.
- [ ] Make the ledger the single source of truth for **scheduling** (next `todo`) and **stopping** (all items `done`/`deferred`); keep file-rename/`DONE.txt` as **corroborating** signals, not primary.
- [ ] Plan-first default for plan-less loops; **context reset at PLAN→IMPLEMENT** (calls LF-1 reset).
- [ ] Disposable plan: on repeated stage-stagnation/CRITICAL, regenerate the plan from goal/specs instead of grinding (config-gated `plan.regenerateOnStall`).
- [ ] Back-compat: existing plan-file loops keep working; derive ledger from an existing checklist when present.

**Acceptance:** a multi-item goal stops exactly when every ledger item is `done`/`deferred(reason)` **and** verify passes — not on a premature `DONE.txt`; the "items 6-9 deferred" case is explicit in the ledger. **Tests:** ledger drives stop; deferred-with-reason doesn't block; regenerate-on-stall fires; legacy plan-file path unchanged. **Risk:** changes completion semantics → flag-gated, forensic signals retained, extend the existing completion-detector tests. **Effort: M.**

---

### LF-5 — Branch-and-select on stuck (P1, gated, default off)

**Why:** On CRITICAL the loop only pauses. Best-of-N + verifier selection yields +7–15% (more cross-model). The app has `DebateCoordinator.startDebate`, `MultiVerifyCoordinator.clusterResponsesSemantically`, `ReviewCoordinator.startReview`, and `parallel-worktree-coordinator.ts` for isolation.

**Files:** new `src/main/orchestration/loop-branch-select.ts` (+spec); `loop-coordinator.ts` CRITICAL branch (~`:1095`); reuse debate/multi-verify/review + worktree coordinators; types + schema (`exploration { enabled, fanout, crossModel, selector }`, default `{ enabled:false, fanout:3, crossModel:false, selector:'verify+listwise' }`).

**Changes:**
- [ ] When CRITICAL would pause **and** `exploration.enabled` **and** a cost cap is set: snapshot workspace → fan-out `fanout` candidate iterations in isolated worktrees → run verify on each → list-wise LLM compare ("which diff best advances the goal?") via `DebateCoordinator`/`MultiVerifyCoordinator` → adopt winner, discard losers (cleanup), continue serially.
- [ ] Enforce fan-out spend against `caps.maxTokens`/`maxCostCents`; abort to normal pause if caps would be exceeded.
- [ ] Record `loop:branch-select` (candidates, scores, winner) + `ITERATION_LOG`.

**Acceptance:** on a seeded dead-end, branch-select yields ≥1 passing-verify candidate where serial retry did not, and the loop continues from it; losers cleaned up; caps respected; default-off path is a no-op. **Tests:** dead-end escape; worktree cleanup; cap enforcement; disabled = unchanged. **Risk:** expensive/complex → default off, requires cost cap (LF-3), robust worktree cleanup. **Effort: L.**

---

### LF-6 — Cross-loop memory (P2)

**Why:** Every loop starts cold. Anthropic's third pillar (agentic memory) + Huntley's "capture the why". The app has episodic/procedural stores, cross-project-learner, proactive-surfacer, project-memory-brief — unused by the loop.

**Files:** `loop-coordinator.ts` (terminal + CRITICAL paths → write); `loop-stage-machine.ts:buildPrompt` (read/inject, token-bounded); reuse `memory/{episodic-store,procedural-store,proactive-surfacer,project-memory-brief,project-memory-key}.ts`.

**Changes:**
- [ ] On loop terminal/CRITICAL, distill a learning record (failure modes, dead-ends, winning approach) keyed by workspace (`project-memory-key.ts`) into procedural/episodic store.
- [ ] In `buildPrompt`, inject top-K workspace-relevant learnings (via `proactive-surfacer`/`project-memory-brief`), token-bounded (respect LF-1) and labeled "prior observations (not binding)".

**Acceptance:** a dead-end recorded in run 1 is surfaced in run 2's prompt; injection respects the token bound. **Tests:** write→surface across two runs; bound honored. **Risk:** stale/wrong learnings → scope by workspace+recency, present as observations. **Effort: S–M (wiring).**

---

## 7. Sequencing & milestones

1. **Milestone A (safe long runs):** LF-1 + LF-3. Loop survives long runs without decay; spend is capped. *Ship-ready alone.*
2. **Milestone B (smart pausing):** LF-2 (depends on LF-1 for context headroom; reads LF-4 ledger if present, else plan/NOTES).
3. **Milestone C (reliable completion):** LF-4. Gives LF-2/LF-6 a structured ground truth.
4. **Milestone D (escape dead-ends):** LF-5 (requires LF-3 cap; benefits from LF-2 to trigger well).
5. **Milestone E (learning):** LF-6 (any time after LF-4).

## 8. Test matrix (deterministic fixtures)

| Fixture | LF-1 | LF-2 | LF-4 | LF-5 |
|---|---|---|---|---|
| Long run, rising context | ✅ no decay, compaction fires | — | — | — |
| Stuck (edits, no progress) | — | ✅ early pause | — | ✅ escapes |
| Converging churn A→B→A | — | ✅ no false pause | — | — |
| Multi-item goal, some deferred | — | — | ✅ stops correctly | — |
| Seeded dead-end | — | ✅ flags | — | ✅ candidate passes |
| Legacy plan-file loop | ✅ unchanged | off by cadence | ✅ back-compat | off |

## 9. Rollout, flags, back-compat

- All behavior behind `LoopConfig` flags; defaults chosen so a loop with no new config behaves like today **plus** mandatory same-session compaction (LF-1) and a $10 cost cap (LF-3) — the only two default-on changes (both pure safety).
- LF-2/LF-4/LF-5/LF-6 are additive and individually gateable.
- Renderer exposes toggles in `loop-config-panel.component.ts`; persisted via existing loop config IPC.

## 10. Definition of done

- All in-scope tasks' acceptance criteria met; test matrix green.
- `npm run verify` passes (lint, typecheck, spec-typecheck, ipc/exports/contracts, tests, architecture, native rebuild, electron smoke).
- New events/fields documented in `docs/runbooks/orchestration-hud-and-verdicts.md`.
- On completion, rename this file `loopfixex_completed.md` before committing (AGENTS.md).

## 11. References

- Companion rationale: `docs/plans/2026-05-29-loop-intelligence-improvements-plan.md`
- Prior loop plans: `docs/plans/2026-05-26-loop-mode-reliability_completed.md`, `docs/plans/2026-05-12-loop-terminal-control-spec_completed.md`, `docs/plans/completed/plan_loop_mode_Completed.md`
- Anthropic — Effective context engineering for AI agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Huntley — Ralph: https://ghuntley.com/ralph/ · https://github.com/ghuntley/how-to-ralph-wiggum
- Horthy — RPI vs Ralph: https://linearb.io/blog/dex-horthy-humanlayer-rpi-methodology-ralph-loop
- Test-time compute / multi-verifier: https://arxiv.org/html/2506.12928v1 · https://arxiv.org/pdf/2502.20379
- Reuse targets: `src/main/context/compaction-coordinator.ts` (`onContextUpdate`/`compactInstance`/`getBudgetTracker`/`configure({selfManagesAutoCompaction})`), `src/main/orchestration/{debate-coordinator,multi-verify-coordinator,loop-fresh-eyes-reviewer,parallel-worktree-coordinator}.ts`, `src/main/memory/*`


---

# Part II: Reviewer addendum: completion + UX (added 2026-05-29, second pass)

> Part I (LF-1..LF-6) is strong on context/memory wiring but (a) under-weights the most direct cause of "loops never finish completely", and (b) does not touch the visual design, which is half the reported problem. Part II adds three tasks (**LF-3a, LF-7, LF-8**), corrects two claims from the first draft, and amends the cross-cutting sections (§3/§4/§7/§8/§9/§10). Every citation re-verified against current `main`. Same conventions as §5 apply (config in both `loop.types.ts` and `loop.schemas.ts`; `npm run check:contracts` + `verify:exports`; verify gate after each task).

## 12. Diagnosis (corrected and ranked)

### 12.1 What the logs and code actually show

`ITERATION_LOG.md` is the tell. On a single iteration the loop fires *every* completion signal it has (`declared-complete` + `completed-rename` + `done-promise` + `done-sentinel` + `self-declared`, "6243/6243 tests pass") AND records a CRITICAL no-progress verdict (`A/CRITICAL` identical-work-hash) at the same time. See `ITERATION_LOG.md:181-193` and `:261-273`. The loop believes it is done and believes it is stuck at once, and it resolves the tie by pausing, never by completing.

Mechanically (`loop-coordinator.ts:896-1102`): completion is attempted first; if it succeeds the loop returns at `:1084` before any pause check. If the attempt is rejected, the CRITICAL check at `:1095-1102` sets `status='paused'` (it never stops). So a finished-looking run oscillates: declare done, gate rejects, spin, identical hash, CRITICAL, pause, wait for a human, resume, repeat.

### 12.2 The real termination failure modes (ranked)

1. **Manual-review pause with no resolution (the big one).** When a loop has no verify command and `allowOperatorReviewedCompletion` is on, every completion attempt is rejected as "unverifiable" and the run pauses for operator review (`loop-coordinator.ts:942-974`; `manualReviewOnly` set at `:379`, surfaced on state at `loop.types.ts:505` / `loop.schemas.ts:296`). But there is **no "accept completion" command anywhere**: the renderer only exposes start / pause / resume / intervene / cancel (`loop.store.ts:323-407`; handlers in `loop-handlers.ts`), and the paused UI offers only Resume (re-runs, re-pauses), Stop (becomes `cancelled`), Hint (`loop-control.component.ts:47-70,84-93`). A manual-review loop therefore **cannot reach `completed` from the UI at all**. This is the most literal version of "loops never finish".
2. **Done-vs-stuck conflation.** A converged run (work finished, tests stable, agent still touches `NOTES.md`/`STAGE.md`) trips D-prime/A as CRITICAL and pauses (`loop-coordinator.ts:1095-1102`), so a *successful* run ends as `paused`, then is reported as `no-progress`, never `completed`.
3. **No completion-attempt budget.** Hard caps cover iterations / wall-time / tokens / cost only (`checkHardCaps`, `loop-coordinator.ts:1581-1588`). A loop that keeps passing verify but keeps getting re-prompted (manual-review loop, or a secondary gate that keeps rejecting) has no "stop trying, we are done enough, escalate" path; it grinds to `cap-reached`.
4. **Verify never green.** Legitimate (the agent must fix it), not a bug. But the UI does not make "capped while still red" obvious, even though `describeCapReason` already computes exactly that distinction (`loop-coordinator.ts:1597-1616`).

### 12.3 Corrections to the first-pass draft (do not repeat these errors)

- **Empty verify does NOT silently run forever for user-started loops.** `prepareLoopStartConfig` (`loop-handlers.ts:264-294`) infers a verify command from the workspace and **throws at start** if it cannot, unless `allowOperatorReviewedCompletion` is set. So the trap is specifically the operator-reviewed path (12.2 #1) and programmatic callers, not "every default loop". Reframe the §2 emphasis accordingly.
- **Fresh-eyes does NOT pin the loop open.** On reviewer error it fails *toward* completion (returns "not blocked", so the loop stops) at `loop-coordinator.ts:1160-1174`; it only continues the loop on real blocking findings (`:1176-1230`). So it is not a "never finishes" cause. Its actual weakness is the opposite (it can let a misconfigured reviewer wave completion through with no independent check), which is a quality/observability gap folded into LF-7, not a termination bug.
- **§2's "null pass" evidence is stale.** `signalDPrime_testStagnationWithWrites` now only evaluates the latest contiguous NON-null suffix (`loop-progress-detector.ts:305-320`), so it no longer fires on all-null counts. It still fires CRITICAL on a *stable non-null* count plus incidental file writes (`:318-332`), which is the live converged-loop false positive (12.2 #2). Fix the live bug, not the patched one.

---

## 13. Tasks (Part II)

### LF-3a: Resolve the manual-review dead-end + verify-default polish (P0 hygiene)

**Why:** see 12.2 #1. Operator-reviewed loops are a half-built feature: they are designed to pause for human sign-off but there is no way to give it. We either give the operator a real "accept" action (LF-7 does the command) or stop creating unresolvable loops by default.

**Files:** `src/main/ipc/handlers/loop-handlers.ts` (`prepareLoopStartConfig` :264-294), `src/renderer/app/features/loop/loop-config-panel.component.ts` (verify field + `buildConfig`), `src/shared/types/loop.types.ts` + `packages/contracts/src/schemas/loop.schemas.ts` (no new field needed; copy edits only).

**Changes:**
- [ ] Keep verify inference + start-throw as the default safety (it already prevents most unverifiable loops). Surface the inferred command back to the renderer so the config panel can show "verify: <inferred>" instead of the bare "(auto-detected if blank)" hint, so the user knows what will gate completion.
- [ ] When `allowOperatorReviewedCompletion` is enabled, the config panel must warn inline that the loop will pause for manual sign-off and require the new Accept action (LF-7) to finish. No silent unresolvable loops.
- [ ] Make a non-null `maxCostCents` (LF-3) a precondition for `allowOperatorReviewedCompletion` too, not just for LF-5, since these loops are the ones most likely to sit paused and get resumed repeatedly.

**Acceptance:** starting an operator-reviewed loop shows the manual-sign-off warning; a normal loop shows its inferred verify command; no loop can start in a state that can neither auto-complete nor be accepted. **Tests:** extend `loop-handlers` start tests (inferred command surfaced; operator-reviewed requires cost cap). **Risk:** low. **Effort: S.**

### LF-7: Operator accept-completion + completion-attempt budget + trust the structured terminal intent (P0)

**Why:** see 12.1/12.2. This is the core "loops don't finish" fix. Three parts: (a) let an operator accept a paused-but-done run, (b) give the loop a way to *stop itself* when it is provably done but a secondary gate keeps it from a clean stop, (c) make the structured terminal intent we already built the primary completion path. We already have the right primitive: `LoopTerminalIntent` (`loop.types.ts:404-421`) surfaces as `declared-complete`, which is `sufficient: true` (`loop-completion-detector.ts:223-224`). This is our `stop_reason: end_turn` / "done tool" equivalent (see §16); today it is just one more forensic signal behind the same gates.

**New types (mirror in BOTH `loop.types.ts` and `loop.schemas.ts`):**
- [ ] `LoopStatus` / `LoopStatusSchema`: add `'completed-needs-review'` (a *successful* terminal state meaning "work is done and verified, but a human should glance at it"). Do NOT reuse `verify-failed`/`idle` (those are dead, see LF-8).
- [ ] `LoopHardCaps` / `LoopHardCapsSchema`: add `maxCompletionAttempts: number` (default 3). Mirror the default in `defaultLoopConfig` (`loop.types.ts:209-272`); `materializeConfig` (`loop-coordinator.ts:1283-1307`) already deep-merges `caps`, so no merge change is needed.
- [ ] `LoopState` / `LoopStateSchema`: add `completionAttempts: number` (init 0) and `lastCompletionOutcome?: 'accepted' | 'verify-failed' | 'unverifiable' | 'rename-gate' | 'review-blocked'` for observability + the UI gate stepper (LF-8).

**Coordinator changes (`src/main/orchestration/loop-coordinator.ts`):**
- [ ] **Accept command.** Add `async acceptCompletion(loopRunId)`: valid only when the loop is `paused` and (`manualReviewOnly` OR a `terminalIntentPending.kind === 'complete'`). If a verify command exists, run it once; on pass terminate `'completed'`, on fail reject as today. With no verify command, terminate `'completed-needs-review'`. Emit a new `loop:completed` (with an `acceptedByOperator: true` flag) or a dedicated `loop:completed-needs-review` event (decide in §15).
- [ ] **Completion-attempt budget.** Increment `state.completionAttempts` each time `hasSufficientSignal` is true (near `:907`). When verify PASSED but a *secondary* gate blocked (belt-and-braces rename at `:1013-1028`, or fresh-eyes unavailable), and `completionAttempts >= caps.maxCompletionAttempts`, terminate `'completed-needs-review'` instead of rejecting again. Record `lastCompletionOutcome`.
- [ ] **Do not re-pause a verified-done run.** When the same iteration both fired a sufficient signal that PASSED verify AND produced a CRITICAL verdict, prefer completion (already returns first at `:1084`); add a guard so a verified-done iteration can never fall through to the `:1095` no-progress pause.
- [ ] **Promote the structured intent.** In the candidate-selection at `:909-910`, prefer `declared-complete` over the forensic signals (`done-promise`/`done-sentinel`/`completed-rename`) when present; keep the forensic ones as corroboration only.
- [ ] **Fresh-eyes determinism/observability.** Keep failing toward completion (do not regress to blocking-forever), but when the reviewer errors or returns `infrastructureError`, set `lastCompletionOutcome` and emit a distinct note so the UI/runbook can show "completed without independent review" rather than silently passing (`:1160-1188`).
- [ ] **Terminal plumbing (gotcha).** Add `'completed-needs-review'` to `isTerminalStatus` in the coordinator (`:644-653`) AND in the store (`loop.store.ts:567-575`), and to `LoopFinalSummary['status']` (`loop.store.ts:57`). Missing either makes the store treat the run as still-active and the bar hangs; missing the coordinator one breaks `terminate()` idempotency.

**IPC plumbing for accept + new status (explicit, no generic forwarder):**
- [ ] `IPC_CHANNELS.LOOP_ACCEPT_COMPLETION` (+ any new `loop:completed-needs-review` channel) in the channels module; handler in `loop-handlers.ts` reusing `LoopByIdPayloadSchema`; forwarder in the `coordinator.on(...)` block (`loop-handlers.ts:101-117`); `sub(...)` in `loop.preload.ts:69-87`; `onX`/`acceptCompletion` in `loop-ipc.service.ts`; store command + subscription in `loop.store.ts`.

**Acceptance:**
- A paused manual-review loop can be accepted from the UI and lands on `completed-needs-review` (or `completed` if verify exists and passes), not stuck paused.
- The "done + CRITICAL same iteration" pattern from `ITERATION_LOG.md` terminates within `maxCompletionAttempts` instead of pausing indefinitely.
- A converged run with passing verify ends `completed`, never `no-progress`.
- `declared-complete` + passing verify stops on the first clean attempt.

**Tests:** `acceptCompletion` happy/invalid-state paths; budget exhaustion -> `completed-needs-review`; verified-done + CRITICAL does not pause; intent-primary candidate selection; fresh-eyes error sets outcome but still completes. Extend `loop-coordinator-completion-seed.spec.ts`, `loop-completion-detector.spec.ts`, `loop-coordinator-fresh-eyes.spec.ts`, `loop-handlers.spec.ts`. **Risk:** changes completion semantics; all behind the new status + cap, forensic signals retained. **Effort: M.**

### LF-8: Loop visual model (P0 for the reported UX bug)

**Why:** the first reported complaint ("the visual design is wrong, doesn't make sense") is not in Part I at all. It does not make sense because the UI shows the cosmetic axis (iteration counter, stage, tokens, cost) prominently while hiding the three things that actually decide whether the loop stops: lifecycle status, progress verdict, and completion-gate position. Good news: the data already exists, so this is renderer-only (no coordinator change beyond LF-7's status).

**Defects (verified):**
- The active-strip text never contains the word "paused"; pause is shown only by an icon swap (`loop-control.component.ts:75`) plus a separate banner (`:47-70`).
- "iter N complete" (`:77`) means "iteration N finished" but reads like "the loop completed".
- Stage and status share one run-on sentence (`:78`); stage keeps showing during a pause.
- The per-iteration verdict OK/WARN/CRITICAL is only in the inspector (`:136`), never in the always-on strip.
- No visual for the completion gate, so a user cannot see "done declared -> verify passed -> blocked on rename/review", which is exactly what explains a non-stopping run.
- Dead statuses: `LoopStatus` defines `verify-failed` and `idle` (`loop.types.ts:278-288`; schema `loop.schemas.ts:6-17`), but the coordinator never emits them (`isTerminalStatus` `:644-653` excludes them; `terminate()` is only called with completed/cancelled/failed/cap-reached/error), and the formatters have no case for them (`loop-formatters.util.ts:60-77,86-98`). They are dead enum values that imply states the system never reaches.

**Files:** `src/renderer/app/features/loop/loop-control.component.ts`, `loop-formatters.util.ts`, `src/renderer/app/core/state/loop.store.ts`, `loop-config-panel.component.ts`; new small presentational piece for the gate stepper.

**Changes:**
- [ ] Replace the run-on sentence with an explicit status pill driven by `LoopStatus`: RUNNING / PAUSED (with the reason: no-progress vs awaiting-review vs blocked) / DONE / NEEDS REVIEW / STOPPED (reason). Add an always-visible latest-verdict chip (OK/WARN/CRITICAL) sourced from `lastIteration.progressVerdict`.
- [ ] Rename "iter N complete" to "N iterations run" / "iteration N done" so it cannot be read as loop completion (`:77`).
- [ ] Add a compact **completion-gate stepper** (declared -> verify -> rename -> review -> stop) to the active strip and the summary, with the blocked step highlighted. Derive its position with no backend change from data the store already has: `lastIteration.verifyStatus` (`loop.store.ts:50`), `state.completedFileRenameObserved`, `state.manualReviewOnly`, `banner.kind`, the existing `loop:fresh-eyes-review-*` activity events (wired at `loop.store.ts:241-291`), and (after LF-7) `lastCompletionOutcome`.
- [ ] Differentiate the pauses with distinct copy + the one action each needs: awaiting-review (Accept / Configure verify / Stop, where Accept calls LF-7), no-progress (Hint / Resume / Stop), blocked-intent (address block). Today two of these render as the same orange banner.
- [ ] Add the **Accept as complete** button to the awaiting-review banner and the paused status strip, wired to the LF-7 store command.
- [ ] Reconcile statuses with labels: add `completed`/`completed-needs-review` styling + labels; either delete `verify-failed`/`idle` from the enums (preferred, they are dead) or wire them. Add a contract/unit test asserting every `LoopStatus` resolves to a non-empty label in `loopStatusLabel` and every terminal status in `terminalStatusLabel`.
- [ ] Surface the existing rich end reason: show `summary.reason` / `state.endReason` (built by `describeCapReason`, `loop-coordinator.ts:1597-1616`) prominently on the summary card so "capped while the last verify was FAILING" vs "last verify passed but no clean completion was accepted" is legible without the inspector.
- [ ] Keep the config visible (collapsed) while running so the user can see what spawned the active run.

**Acceptance:** from the strip alone, without opening the inspector, a user can answer "is it running, paused, done, or needs review; is it healthy; and what is it waiting on", and can accept a done-but-paused run in one click. Every `LoopStatus` has a label (asserted by test). **Tests:** `loop-formatters` label completeness; store gate-position selector unit tests; component render tests for each pause kind. **Risk:** low (renderer only). **Effort: M.**

---

## 14. Amendments to Part I sections

- **§3 Scope:** add **LF-3a (P0 hygiene)**, **LF-7 (P0)**, **LF-8 (P0)**. LF-7/LF-8/LF-3a are the actual fix for the reported bug; LF-1 stays P0 for long-run *quality* but is not the termination fix.
- **§4 Decisions:** add **Decision 5**: completion's primary authority is the structured terminal intent (`declared-complete`) plus verify; forensic signals (rename/sentinel/regex) are corroboration. Add **Decision 6**: manual-review loops are resolvable (operator Accept) by design; they may terminate as `completed-needs-review`.
- **§7 Sequencing:** insert **Milestone 0 (loops finish): LF-3a + LF-7 + LF-8**, before Milestone A. This is the smallest change that makes loops reach a clean terminal state and reads correctly in the UI. Milestone A (LF-1 + LF-3) then follows for long-run quality.
- **§8 Test matrix:** add rows: *Manual-review run, operator accepts* (LF-7/LF-8: lands `completed-needs-review`), *Converged run, tests stable* (LF-7: completes, no false pause), *Completion-attempt budget exhausted* (LF-7: stops, not infinite), *Every LoopStatus has a label* (LF-8). Add LF-7 and LF-8 columns.
- **§9 Rollout/flags:** LF-7 adds a terminal status, so include a back-compat note for persisted rows (treat unknown terminal status as terminal in the store reader); LF-8 is renderer-only and needs no migration. `maxCompletionAttempts` defaults to 3 for existing configs via `materializeConfig` merge.
- **§10 Definition of done:** document the new status, `acceptCompletion`, the completion-attempt budget, and the gate stepper in `docs/runbooks/orchestration-hud-and-verdicts.md`; add the LoopStatus-label contract test to the verify gate.

---

## 15. Open decision for this part

- **`DECISION` New-status event shape:** emit a dedicated `loop:completed-needs-review` event, OR reuse `loop:completed` with an `acceptedByOperator` / `needsReview` flag. Default here: **dedicated event** (cleaner for the store + analytics; the extra channel is cheap). Flip to the flag form to avoid adding a channel.

## 16. External patterns (fresh research) and how they map

- **Anthropic's agent loop** treats `stop_reason: end_turn` as the authoritative completion signal and warns against parsing "I'm done" natural language and against iteration caps as the *primary* stop. Our forensic stack (stdout regex + `DONE.txt` + file rename) is that anti-pattern; our `declared-complete` terminal intent is the in-band equivalent LF-7 promotes.
- **Vercel AI SDK** formalizes the same idea as a no-op `done` tool with `toolChoice: 'required'`: the agent stops only when it calls the structured done tool. Same conclusion.
- **Ralph (Huntley)** keeps progress in files + git, one task per iteration, test/build backpressure ("commit when tests pass"), agent exits after a successful commit. Ralph uses fresh context per iteration; our default is `same-session` (`loop.types.ts:219`), which is why LF-1 compaction matters, and reinforces that completion should be evidence-on-disk + verify, not transcript memory.
- **Clear terminal states matter.** Ambiguous "maybe done" states make agents retry; one writeup measured 14 tool calls collapsing to 2 once states were unambiguous. Our multi-signal "maybe done, maybe stuck" is that failure lifted to the loop level, which is what LF-7 (single primary signal) and LF-8 (single legible status) remove.

**References (new):**
- Anthropic agent loop / stop_reason: https://code.claude.com/docs/en/agent-sdk/agent-loop
- Vercel AI SDK loop control (done tool): https://ai-sdk.dev/docs/agents/loop-control
- Ralph: https://ghuntley.com/ralph/ and https://github.com/ghuntley/how-to-ralph-wiggum
- Clear terminal states / reasoning-loop token waste: https://dev.to/aws/how-to-prevent-ai-agent-reasoning-loops-from-wasting-tokens-2652
