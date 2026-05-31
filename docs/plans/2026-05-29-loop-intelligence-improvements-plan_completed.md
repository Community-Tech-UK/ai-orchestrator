# Loop Mode Intelligence & Subsystem-Reuse Plan

> **Status:** ⛔ SUPERSEDED / IMPLEMENTED (2026-05-30). This is the **rationale ("why") companion**; the executable plan it spawned — `docs/plans/loopfixex_completed.md` (LF-1…LF-8) — is **implemented and verified** (29 spec files / 289 loop tests green). The workstreams below (P0-A context discipline, P0-B semantic progress, P1-A branch-and-select, P1-B RPI/ledger, P2-A cross-loop memory, P2-B cost cap) all shipped as the corresponding LF tasks. **Do not work this document** — it is kept only as the research/trade-off record. The four "Open questions for review" at the bottom were all resolved in loopfixex §4 (Decisions). The completion-authority question is now resolved by the evidence-precedence ladder documented in `loopfixex_completed.md`'s header and `first-class-remote-orchestration-plan.md` Piece B.
> **For agentic workers:** no action — superseded. New loop work gets a fresh dated plan.

**Goal:** Make the loop *smarter*, not just safer. The loop's safety gates are already excellent (verify-before-stop, structural no-progress detection, terminal-intent CLI, fresh-eyes review, crash-loop protection). What's thin is its *intelligence*: it is a single-agent, strictly-serial loop with purely syntactic progress sensing, unbounded context growth, agent-self-driven stages, no parallel exploration, no structured task ledger, and no cross-run memory.

**Central finding:** The loop is an **island**. The app already ships best-in-class subsystems for exactly the gaps below — `src/main/context/` (compaction, token budget, context-window guard), `src/main/memory/` (episodic/procedural stores, cross-project learner, proactive surfacer), and the debate / multi-verify / review coordinators — but `loop-coordinator.ts`, `loop-stage-machine.ts`, and `default-invokers.ts` import **none** of them. So most of this plan is **integration**, not greenfield: lower risk, lower effort, and consistent with subsystems already tested in production paths.

**Architecture:** Keep the existing coordinator/detector/invoker boundaries and the `loop:invoke-iteration` extensibility seam. Add capability by wiring the loop into existing subsystems and by adding two new, well-scoped detectors (semantic-progress, branch-select). No rewrite.

**Tech Stack:** Electron main process, TypeScript 5.9, Angular 21 renderer, Vitest, Zod IPC schemas.

---

## Background: how the loop works today

`LoopCoordinator.runLoop()` (`src/main/orchestration/loop-coordinator.ts:684`) is a `while(true)`:

1. Pre-flight: pause/cancel/cap checks; import terminal intents; honor `BLOCKED.md`; pre-iteration "kill switch" (`progressDetector.shouldRefuseToSpawnNext`).
2. Read `STAGE.md` (`PLAN`/`REVIEW`/`IMPLEMENT`); build a fixed prompt via `LoopStageMachine.buildPrompt()` (`loop-stage-machine.ts:341`).
3. Invoke one child via `invokeChild()` → `loop:invoke-iteration` → `default-invokers.ts` (borrows the live instance adapter or a persistent same-session adapter; fresh-child is only a fallback).
4. Diff files, parse test counts, compute work-hash; run **8 structural progress signals** (`loop-progress-detector.ts`) and **6 completion signals** (`loop-completion-detector.ts`).
5. **Verify-before-stop**: on a sufficient completion signal → quick-verify → verify → optional anti-flake re-verify → optional fresh-eyes cross-model review gate → stop.
6. On `CRITICAL` no-progress → **pause and wait for a human** (`loop-coordinator.ts:1095`). Sleep 1500ms; repeat.

Defaults (`src/shared/types/loop.types.ts:209`): `contextStrategy: 'same-session'` (line 219), `initialStage: 'IMPLEMENT'` (line 268), caps `50 iters / 8h / 1M tokens / maxCostCents: null / 200 tools-per-iter` (lines 220-225).

### Evidence the intelligence is the bottleneck

Real run from this workspace's `ITERATION_LOG.md` (iteration 2):

```
## Iteration 2 — IMPLEMENT — CRITICAL
- files changed: 18
- progress signals:
  - [A/CRITICAL] Identical work hash repeated (3 consecutive, 3 of last 3)
  - [D-prime/WARN] Tests unchanged at null pass for 3 iterations despite file writes
- completion signals fired:
  - [declared-complete] ... items 1-5,10-12,15 implemented; items 6-9,13-14,16-18 deferred ...
  - [completed-rename] / [done-promise] / [done-sentinel] / [self-declared]
```

`CRITICAL no-progress` and **all** completion signals fired in the *same* iteration. The structural detector cannot tell "done and idling" from "stuck and idling" — both look like an identical work-hash on the same 18 files. This is the syntactic-sensing ceiling, and it is exactly what the workstreams below address.

### The loop is an island (verified)

| Capability the loop needs | Already exists in app | Loop uses it today? |
|---|---|---|
| Context compaction / summarize-and-reinitialize | `src/main/context/compaction-coordinator.ts` (`onContextUpdate`, `compactInstance`, `getBudgetTracker`, auto-compact, epoch tracking), `context-compactor.ts`, `microcompact.ts` | ❌ No |
| Token-budget / context-window guard | `context/token-budget-tracker.ts`, `context/context-window-guard.ts` | ❌ No |
| Tool-result clearing / JIT load | `context/error-withholder.ts`, `context/jit-loader.ts`, `context/output-persistence.ts` | ❌ No |
| Parallel multi-agent / debate / verifier | `orchestration/debate-coordinator.ts` (`startDebate`), `orchestration/multi-verify-coordinator.ts` (`clusterResponsesSemantically`), `agents/review-coordinator.ts` (`startReview`) | ⚠️ Only fresh-eyes at completion |
| Cross-run memory / learnings | `memory/episodic-store.ts`, `memory/procedural-store.ts`, `memory/cross-project-learner.ts`, `memory/proactive-surfacer.ts`, `memory/project-memory-brief.ts` | ❌ No |

---

## Research basis (web)

- **Anthropic — Effective context engineering for AI agents.** Long-horizon work needs three pillars: **compaction** (summarize + reinitialize, preserving "architectural decisions, unresolved bugs, implementation details"), **structured note-taking / agentic memory**, and **multi-agent architectures**. "Context rot": recall degrades as token count grows; treat context as a finite resource. Tool-result clearing is the "safest lightest-touch compaction."
- **Huntley — the Ralph technique (canonical).** Fresh context per iteration + persistent disk state; "the more you use the context window, the worse the outcomes" (quality drops past ~150k tokens); one task per loop; "search before assuming"; capture the *why*; plan file is the scheduler.
- **Horthy — RPI (Research → Plan → Implement).** A separate research/plan phase with a **context reset before implementation**; **disposable plans** ("if it's wrong, throw it out; regeneration is one planning loop, cheap vs. going in circles"); intermediate markdown artifacts as alignment/handoff points.
- **Test-time compute / best-of-N literature.** Sampling N candidates + verifier selection yields +7–15% pass rate; **mixing different SOTA models** for parallel rollouts pushes Pass@K substantially higher; list-wise (direct comparison) verification beats independent scoring.

(Full links in References.)

---

## Workstreams

Two **P0** items (independent, highest leverage), two **P1**, two **P2**. Each can ship behind a config flag with `same-session`/legacy behavior preserved as the fallback.

---

### P0-A — Context discipline: stop unbounded same-session growth

**Problem.** The header advertises "fresh-context iterations" (`loop-coordinator.ts:4`) but the real default is `same-session` (`loop.types.ts:219`), and the invoker borrows the live/persistent adapter (`default-invokers.ts:1322-1358`). On a long loop this accumulates the full transcript across up to 50 iterations with **no compaction, no tool-result clearing, no budget guard**. This is the root cause behind the `ITERATION_LOG` thrash and directly contradicts every external source.

**Design.** Wire the loop into the existing `CompactionCoordinator` and add a per-iteration **context-budget checkpoint** for same-session loops:

- Before each iteration, read the borrowed/persistent adapter's context usage and call `compactionCoordinator.onContextUpdate(instanceId, usage)`; honor its background/blocking compaction decision (`compaction-coordinator.ts:167,261,448`).
- Add a hard reset rule: when usage crosses a configurable threshold (default ~50–60% of window — tunable via `getBudgetTracker`), force `compactInstance()` *or* recycle the persistent adapter to a fresh session, relying on disk state (STAGE/NOTES/ITERATION_LOG/plan) to re-anchor. The prompt already persists the goal every iteration (`loop-stage-machine.ts:332`) and instructs disk-first state (`:337-339`), so a reset is safe.
- Enable tool-result clearing / output-persistence for the loop adapter (`context/output-persistence.ts`, `error-withholder.ts`).
- **Decision to make (see Open Questions):** flip the default to `contextStrategy: 'fresh'` (true Ralph) vs. keep `same-session` + compaction. Recommendation: keep same-session as default *but* make compaction mandatory for it, and document fresh as the low-context-rot option.

**Integration points.** `loop-coordinator.ts` (`invokeChild`/`runLoop` boundary), `default-invokers.ts` (adapter lifecycle ~`:1322-1419`, `enableAdapterResume`), `context/compaction-coordinator.ts`, `context/token-budget-tracker.ts`, `context/context-window-guard.ts`. New config on `LoopConfig`: `context.compaction { enabled, resetAtUtilization, clearToolResults }`.

**Tasks.**
- [ ] Add `context` block to `LoopConfig` + `defaultLoopConfig` (Zod schema in `packages/contracts/src/schemas/loop.schemas.ts`, types in `loop.types.ts`).
- [ ] In the invoker, surface adapter context usage to `CompactionCoordinator.onContextUpdate` each iteration; gate on `isCompacting`.
- [ ] Implement the utilization-threshold reset (compact or fresh-session recycle) for same-session loops; verify disk-state re-anchor works (no goal loss).
- [ ] Enable tool-result clearing for the loop adapter.
- [ ] Renderer: expose compaction toggle + threshold in the loop config panel (`src/renderer/app/features/loop/loop-config-panel.component.ts`).

**Acceptance.** A 30+ iteration same-session loop keeps adapter context utilization below the configured ceiling; output quality / progress-verdict distribution does not degrade across iterations (compare WARN/CRITICAL rate in first vs. last third of a long run); goal is never lost after a reset. `npx tsc --noEmit`, spec tsc, lint, and loop tests green.

**Risks.** Over-aggressive compaction can drop subtle constraints (Anthropic's caveat) — keep the reset threshold conservative and preserve the plan/NOTES on disk as the durable record. Recycling a borrowed *instance* adapter must NOT terminate the user's live session (the invoker already distinguishes borrowed vs. owned at `:1400-1415` — respect that).

**Effort.** M.

---

### P0-B — Semantic progress signal (resolve done-vs-stuck)

**Problem.** All 8 progress signals are syntactic (work-hash, Jaccard text similarity, tool-repeat, test-count deltas — `loop-progress-detector.ts`). They are blind to "edits that don't advance the goal" and cannot disambiguate done-idling from stuck-idling (the `ITERATION_LOG` collision). Jaccard on output text is a crude proxy.

**Design.** Add a **new, cheap, model-based progress signal** that runs *only* when it's worth it (e.g., when structural signals reach WARN, or every N iterations), not every iteration:

- Reuse the fresh-eyes infrastructure (`loop-fresh-eyes-reviewer.ts`) but with a lightweight "delta" prompt: given the goal, the task ledger (P1-B), and the diff since iteration `N-k`, return `{ advanced: bool, whatChanged: string, confidence }`.
- Feed the verdict into the existing WARN→CRITICAL escalation (`loop-progress-detector.ts` aggregation + `loop-coordinator.ts:884`): a confirmed "no semantic advance" upgrades the structural WARN to CRITICAL; a confirmed "advanced" *suppresses* a false-positive structural CRITICAL (e.g., legitimate A→B→A churn that is actually converging).
- This is additive — it never replaces verify-before-stop; it only sharpens the pause decision.

**Integration points.** New `loop-semantic-progress.ts` (mirrors `loop-fresh-eyes-reviewer.ts` provider plumbing). Hook in `loop-coordinator.ts` progress-evaluation block (~`:880-892`). New thresholds in `progressThresholds` (cadence, confidence floor). Prefer a cheap/fast provider (Haiku) to keep cost negligible.

**Tasks.**
- [ ] New `loop-semantic-progress.ts` reviewer + `LoopSemanticProgressResult` type + Zod schema.
- [ ] Wire into coordinator escalation (upgrade/suppress) with cadence gating to bound cost.
- [ ] Record the semantic verdict on `LoopIteration` for observability + iteration log.
- [ ] Tests: WARN→CRITICAL on confirmed no-advance; CRITICAL suppression on confirmed converging churn; cost stays bounded (cadence honored).

**Acceptance.** On a synthetic stuck loop, semantic signal escalates to pause faster than structural-only. On a synthetic converging-churn loop (A→B→A that's actually improving), it prevents the false pause. Cost per loop attributable to this signal is bounded and logged.

**Risks.** Model-based judgment can be wrong → keep it as an *escalation modifier*, never a sole stop/continue authority; require confirmation across two checks before flipping a structural verdict (mirrors the existing weak-signal FU-4 pattern).

**Effort.** M.

---

### P1-A — Branch-and-select on stuck (best-of-N, cross-model)

**Problem.** On `CRITICAL` the loop only **pauses for a human** (`loop-coordinator.ts:1095-1102`). The literature's highest-leverage move is the opposite: at a hard point, **sample N candidates in parallel and select via a verifier** (+7–15%; cross-model even more). The app already has `DebateCoordinator`, `MultiVerifyCoordinator` (semantic clustering), and `ReviewCoordinator` — and multi-provider adapters — but the loop doesn't use them for exploration.

**Design.** Add an opt-in "explore-on-stuck" mode:

- When a CRITICAL would otherwise pause (and human-in-the-loop is off), snapshot the workspace, then run 2–3 candidate iterations in parallel from that snapshot — ideally across providers (Claude/Codex) for diversity.
- Score candidates with the existing verifier path (run the verify command on each) + a list-wise LLM comparison ("which diff best advances the goal?") via `DebateCoordinator`/`MultiVerifyCoordinator`. List-wise selection beats independent scoring per the literature.
- Adopt the winner's changes, discard the rest, continue the serial loop from there. Strict serialization on commit (Ralph's "many readers, one writer").

**Integration points.** `loop-coordinator.ts` CRITICAL branch; new `loop-branch-select.ts`. Reuse `orchestration/debate-coordinator.ts`, `orchestration/multi-verify-coordinator.ts`, `agents/review-coordinator.ts`. Workspace isolation via per-candidate worktrees (there is precedent in `orchestration/parallel-worktree-coordinator.ts`). New `LoopConfig.exploration { enabled, fanout, crossModel, selector }`.

**Tasks.**
- [ ] New `loop-branch-select.ts`: snapshot → fan-out candidates (worktree-isolated) → verify each → list-wise select → adopt winner.
- [ ] Wire into the CRITICAL path as an alternative to pause (config-gated; default off).
- [ ] Reuse worktree coordinator for isolation; ensure cleanup of losing candidates.
- [ ] Cost accounting: fan-out multiplies token spend — enforce against `caps.maxTokens`/`maxCostCents` and log.
- [ ] Tests: stuck loop escapes via the better candidate; losers cleaned up; caps respected.

**Acceptance.** On a seeded dead-end, branch-select produces at least one passing-verify candidate where serial retry did not, and the loop continues from it. Token/cost is bounded by caps and attributed in observability.

**Risks.** Expensive (N× tokens) and complex (parallel worktrees). Keep default off; require a cost cap to be set before enabling (ties to P2-B). Worktree cleanup must be robust to avoid disk leaks.

**Effort.** L.

---

### P1-B — RPI-style plan-first + disposable plan + structured task ledger

**Problem.** Stages advance only when the agent rewrites `STAGE.md` (fragile — the stage-stagnation signals exist *because* of this), and the default `initialStage: 'IMPLEMENT'` (`loop.types.ts:268`) **skips planning entirely**. RPI says the opposite: research/plan first, with a **context reset before implement**, and a **disposable plan**. Completion is also forensic (file rename / DONE.txt) with no per-item ledger — the deferred "Phase 3 per-spec workflow state machine" is exactly this gap.

**Design.**
- Default new loops to **plan-first** when no plan file is configured: a PLAN/RESEARCH phase produces a disposable plan artifact, then a **context reset at the PLAN→IMPLEMENT boundary** (ties to P0-A) before implementation.
- Introduce a **structured task ledger** (`LOOP_TASKS.md` or a JSON sidecar) with explicit item states: `todo | doing | done | deferred(reason)`. The ledger becomes the single source of truth for **both** scheduling (which item next) and **stopping** (stop only when every item is done-or-explicitly-deferred). This supersedes the boolean `uncompletedPlanFilesAtStart` gate (`loop-stage-machine.ts:304`, `loop-completion-detector.ts` plan-checklist).
- Make the plan **disposable**: when progress stalls (CRITICAL or repeated stage-stagnation), regenerate the plan from specs/goal instead of grinding (RPI: "regeneration is one planning loop").

**Integration points.** `loop-stage-machine.ts` (stage progression, `buildPrompt`, artifact bootstrap), `loop-completion-detector.ts` (replace/augment plan-checklist with ledger state), `loop-coordinator.ts` (PLAN→IMPLEMENT context reset; stall→regenerate-plan). New ledger parser/serializer (extend the existing `parsePlanChecklist` regex used in stage machine + completion detector). The P0-B semantic check reads the ledger as ground truth.

**Tasks.**
- [ ] Define ledger format + parser/serializer; bootstrap in stage machine.
- [ ] Switch scheduling + completion to ledger state; keep file-rename/DONE.txt as corroborating, not primary.
- [ ] Plan-first default for plan-less loops; context reset at PLAN→IMPLEMENT.
- [ ] Stall→regenerate-plan path (config-gated).
- [ ] Migration/back-compat: existing plan-file loops keep working; ledger derived from checklist if present.
- [ ] Tests: ledger drives stop only when all-done-or-deferred; deferred-with-reason doesn't block; regenerate-on-stall fires.

**Acceptance.** A multi-item goal stops exactly when every ledger item is `done`/`deferred(reason)` and verify passes — not on a premature DONE.txt. The `ITERATION_LOG`-style "items 6-9 deferred" case is represented explicitly in the ledger, not buried in free text.

**Risks.** Changes completion semantics — must preserve existing forensic signals as corroboration and ship behind a flag with thorough tests (this subsystem already has 91+ loop tests; extend them).

**Effort.** M.

---

### P2-A — Cross-loop memory (reuse `src/main/memory/`)

**Problem.** Every loop starts cold and re-discovers the same dead-ends. The loop writes `NOTES.md` (good, per-loop) but doesn't curate or retrieve learnings across runs. Anthropic's third pillar (agentic memory) and Huntley's "capture the why" both call for persistent, retrievable learnings. The app has a full memory subsystem the loop ignores.

**Design.** At loop end (and on CRITICAL), distill what failed / worked / was deferred into the existing `procedural-store`/`episodic-store` keyed by workspace (`memory/project-memory-key.ts`). At loop start and on each iteration prompt build, inject top-K relevant learnings via `proactive-surfacer.ts` / `project-memory-brief.ts` / `cross-project-learner.ts`.

**Integration points.** `loop-coordinator.ts` terminal + CRITICAL paths (write); `loop-stage-machine.ts:buildPrompt` (read/inject, bounded to a few hundred tokens to respect P0-A). Reuse `memory/proactive-surfacer.ts`, `memory/project-memory-brief.ts`, `memory/episodic-store.ts`, `memory/procedural-store.ts`.

**Tasks.**
- [ ] On loop terminal/CRITICAL, write a distilled learning record (failure modes, dead-ends, successful approach) to procedural/episodic store.
- [ ] In `buildPrompt`, inject top-K workspace-relevant learnings (token-bounded).
- [ ] Tests: a seeded dead-end recorded in run 1 is surfaced in run 2's prompt; injection respects token bound.

**Acceptance.** Run 2 on the same workspace receives prior-run learnings in its prompt; injected context stays within a configured token budget.

**Risks.** Stale/wrong learnings could mislead — scope by workspace + recency, and present as "prior observations," not binding instructions.

**Effort.** S–M (mostly wiring).

---

### P2-B — Operational hygiene: cost cap, NOTES.md curation

**Problem.** `maxCostCents: null` (`loop.types.ts:224`) — no spend guard by default, though the design docs intended $10; "hard caps on spend are non-negotiable." `NOTES.md` is agent-maintained and unbounded — re-injecting it on long runs eats the very context P0-A conserves.

**Design.** Set a sane default cost cap (e.g., $10 → `maxCostCents: 1000`); **require** a cost cap before P1-A exploration can be enabled. Add NOTES.md curation: when it exceeds a size/token threshold, summarize older entries (reuse `context/microcompact.ts` or `tools/tool-use-summarizer.ts`) while preserving the completion inventory.

**Tasks.**
- [ ] Default `maxCostCents` to a non-null value; surface in config panel; enforce as a gate for P1-A.
- [ ] NOTES.md size/token guard + summarize-older-entries (reuse existing summarizer).
- [ ] Tests: cap default applied; NOTES.md stays bounded; completion inventory preserved through curation.

**Acceptance.** A loop with no explicit cost config still has a spend ceiling; NOTES.md stops growing without bound on long runs.

**Risks.** Low. Don't summarize away the active completion inventory — preserve it verbatim.

**Effort.** S.

---

## Suggested sequencing

1. **P0-A (context discipline)** and **P0-B (semantic progress)** first — independent, highest leverage, address the documented failure directly. P0-A unlocks meaningful long runs; P0-B sharpens the pause decision.
2. **P1-B (RPI + task ledger)** next — gives P0-B and P2-A a structured ground truth (the ledger) to reason against.
3. **P2-B (cost cap)** alongside, since it gates **P1-A**.
4. **P1-A (branch-and-select)** — biggest capability jump, but most expensive/complex; do it once caps + ledger + semantic signal exist to drive and bound it.
5. **P2-A (memory)** — wiring; can land any time after P1-B.

## Cross-cutting concerns

- **Back-compat:** every workstream ships behind a `LoopConfig` flag; current `same-session` + forensic-completion behavior remains the fallback. Existing 91+ loop tests must stay green.
- **Observability:** record new signals (semantic verdict, compaction events, branch-select outcomes, injected memory) on `LoopIteration` and in `ITERATION_LOG.md` so runs remain auditable (the loop's observability is already a strength — extend it, don't bypass it).
- **Testing:** follow the existing `_resetForTesting()` singleton pattern; add deterministic fixtures for stuck/converging/dead-end loops. Verify with `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, and the loop test suite.
- **Cost:** P0-B and P1-A add LLM calls — gate by cadence (P0-B) and caps (P1-A); always attribute spend.

## Open questions for review

1. **Context default:** flip the default to `contextStrategy: 'fresh'` (true Ralph, lowest context rot, leans fully on disk state) — or keep `same-session` as default but make compaction mandatory for it? (Plan assumes the latter; the former is simpler and more in line with canonical Ralph.)
2. **Human-in-the-loop vs. autonomy:** should branch-and-select (P1-A) replace the pause-on-CRITICAL behavior, or be an opt-in alternative? (Plan assumes opt-in, default off.)
3. **Provider diversity:** is cross-model exploration (Claude + Codex) in scope, or Claude-only first? (Affects P1-A cost and adapter wiring.)
4. **Ledger location:** `LOOP_TASKS.md` (human-readable, agent-editable) vs. JSON sidecar (robust parsing)? (Plan leans `LOOP_TASKS.md` to match the existing on-disk, agent-editable convention.)

## References

**Web**
- Anthropic — Effective context engineering for AI agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Huntley — Ralph Wiggum as a software engineer: https://ghuntley.com/ralph/
- Huntley — how-to-ralph-wiggum: https://github.com/ghuntley/how-to-ralph-wiggum
- LinearB — Dex Horthy RPI methodology vs. Ralph loop: https://linearb.io/blog/dex-horthy-humanlayer-rpi-methodology-ralph-loop
- Scaling Test-time Compute for LLM Agents: https://arxiv.org/html/2506.12928v1
- Multi-Agent Verification (multiple verifiers): https://arxiv.org/pdf/2502.20379

**Internal**
- Loop core: `src/main/orchestration/loop-coordinator.ts`, `loop-stage-machine.ts`, `loop-progress-detector.ts`, `loop-completion-detector.ts`, `loop-fresh-eyes-reviewer.ts`, `default-invokers.ts`
- Context subsystem (to reuse): `src/main/context/compaction-coordinator.ts`, `context-compactor.ts`, `token-budget-tracker.ts`, `context-window-guard.ts`, `microcompact.ts`, `output-persistence.ts`
- Multi-agent (to reuse): `src/main/orchestration/debate-coordinator.ts`, `multi-verify-coordinator.ts`, `agents/review-coordinator.ts`, `parallel-worktree-coordinator.ts`
- Memory (to reuse): `src/main/memory/{episodic-store,procedural-store,cross-project-learner,proactive-surfacer,project-memory-brief,project-memory-key}.ts`
- Prior loop plans: `docs/plans/2026-05-26-loop-mode-reliability_completed.md`, `docs/plans/2026-05-12-loop-terminal-control-spec_completed.md`, `docs/plans/completed/plan_loop_mode_Completed.md`
