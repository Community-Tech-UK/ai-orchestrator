# Loop Engine Overhaul — Implementation Spec

> **Status update 2026-07-02:** Phases 0–4 (incl. Phase 1.5 invoker-capture sweep) are ✅ IMPLEMENTED
> & verified against the tree: A0-A4, B0-B8, C1/C3-as-built, D1-D6, E1a/E1b/E2, F1/F2 all landed
> (D6 annotated below; Phase 1.5 added `declaredTimeoutMs` persistence + real per-provider
> `disableTools` — enforced on claude via `--disallowedTools` with bookkeeping tools kept available,
> prompt-only fallback documented for codex/gemini/copilot in `loop-tools-disable.ts`; coordinator
> emits `disableTools` on cap wrap-up turns). Phase 4 landed under James-approved conservative gates:
> G1 commit-ratchet is worktree-only/default-off, G2 uses the existing `fresh-child` path only when
> explicitly enabled, G3 contract utilities validate task packets and subagent result injection, and
> G4 adds default-off path-aware rw-locks to tool execution.
>
> **Status:** ✅ IMPLEMENTED (2026-06-26 spec, completed 2026-07-02 after fresh-eyes + Codex review).
> Coherent, joined-up implementation plan for all 30 borrows. Self-contained: the "how" is in §1–§11;
> the "what & why" (upstream provenance, corroboration, value/effort ranking) is **Appendix A**; the
> independent review's findings and how they were folded in are **§13**. Lives in the AI Orchestrator
> repo. This plan is now complete and should live under a `_completed` filename.
>
> **For agentic workers:** implement by **workstream and phase**, not by item number. Each workstream
> delivers a shared primitive that several borrows ride on — building per-item would duplicate
> infrastructure. Every "where" reference below was verified against the live tree on 2026-06-26;
> re-confirm before editing (the loop area churns). Anything tagged ⚠️HOT or ⚠️COLLIDES needs the
> guard in §9 honoured. Run the §8 verification gate before any `[x]`.
>
> **Two facts the review corrected — internalise before starting:** (1) the `loop:invoke-iteration`
> listener lives in `src/main/orchestration/default-invokers.ts` (registered from
> `src/main/app/initialization-steps.ts:361`), **not** `src/main/index.ts`; anything touching the live
> model stream, tool state, or invocation options lands there. (2) The loop's invocation **error path
> catches a plain string and runs its own circuit-breaker/degraded-retry** (`loop-coordinator.ts:1617`)
> — it does **not** call `RetryManager`/`ErrorRecoveryManager`, so error-handling borrows must insert
> classification at that seam and require the invoker to surface structured error info, not just a string.

---

## 0. Orienting facts (verified 2026-06-26)

The single most important finding: **we already own most of the machinery; the loop just doesn't call it.**

| Primitive we already ship | Where | Borrow it unlocks | Wired to loop today? |
|---|---|---|---|
| `TokenBudgetTracker.checkBudget` — diminishing-returns STOP (≥3 continuations & last delta <500) + "keep working, don't summarize" nudge | `context/token-budget-tracker.ts` | **#11** (verbatim — already built) | ❌ orphan |
| `buildCompactionPrompt` — 12-section anchored summary + `<prior_summary>` merge + `redactSecrets` | `context/context-compaction-prompt.ts` | **#2** (needs verbatim-user-msgs emphasis + wiring) | ❌ orphan |
| `Microcompact.compact` — deterministic tool-output → `[microcompacted]` placeholder swap | `context/microcompact.ts` | **#14**, **#3** (placeholder discipline) | ❌ orphan |
| `ErrorWithholder.handlePromptTooLong` — collapse→reactive-compact one-shot (413) | `context/error-withholder.ts` | overflow recovery (#4 routing) | ❌ orphan |
| `ContinuationInjector.createContinuation` — output-limit "resume immediately" turn | `context/continuation-injector.ts` | **#19**, **#9** | ❌ orphan |
| `OutputPersistenceManager.maybeExternalize` — spill big tool output to disk + marker | `context/output-persistence.ts` | **#26** (needs delegate hint) | ✅ via `loop-output-externalize.ts` |
| `CompactionCoordinator` — instance-keyed auto-compaction, `selfManagesAutoCompaction` opt-out, epochs | `context/compaction-coordinator.ts` | **#2/#13/#27** trigger path | ❌ orphan (wired at instance layer only) |
| `JITContextLoader` — registerable resource loader + cache | `context/jit-loader.ts` | **#13** rehydration | ❌ orphan |
| `provider-quota-service` — per-window `resetsAt`/`remaining`, `kind:'rate-limit'`, events | `core/system/provider-quota-service.ts` | **#17** breaker, **#5** | ⚠️ park-only via limit-handler |
| `FailoverError` + `ErrorRecoveryManager.classifyError` | `core/failover-error.ts`, `core/error-recovery.ts` | **#4/#5/#16** extend | ⚠️ single-axis |
| `loop-context-discipline.ts` (LF-1) — adapter-recycle-to-fresh-session on token-utilization | `orchestration/loop-context-discipline.ts` | the *coarse* survival tier Workstream B builds on | ✅ shipped (loop-local) |

> **Don't overstate the gap.** The loop is *not* a total island: LF-1 (above) already gives it one
> context-survival tier (full recycle), and the agent already drives REVIEW→PLAN back-edges via STAGE.md
> (`loop-stage-machine.ts:441,450`). The borrows below add **finer tiers and structured enforcement on top
> of** these, not from scratch. Each workstream calls out its specific delta vs the shipped LF-1..LF-8 work.

**The loop's extension idiom** (use these, don't invent new patterns): injectable setters on `LoopCoordinator`
(`setFreshEyesReviewer` L254, `setSemanticProgressReviewer` L291, `setCleanReviewClassifier` L303,
`setBranchSelector` L315, `setLoopMemoryStore` L327, `setResourceGovernor` L331, `setEvidenceStore` L381),
plus `registerIterationHook` (L521), `setIntentPersistHook` (L538), `setAdapterCleanupHook` (L548). New
behavior plugs in the same way. The provider invocation itself happens in the `loop:invoke-iteration`
listener in **`src/main/orchestration/default-invokers.ts`** (registered from
`src/main/app/initialization-steps.ts:361`; it calls `invokeCliTextResponse` and assembles
`LoopChildResult` ~`default-invokers.ts:1283`) — that's where anything touching the live model stream,
tool_use/tool_result state, invocation options (model, tool-disable), or structured error info lives.
Critically, the coordinator only ever sees a **sealed** `LoopChildResult` after the iteration returns;
any borrow that needs *mid-turn* state (pending tool calls, declared tool timeouts, read-file paths,
structured provider errors) must capture it in this listener and surface it on `LoopChildResult` (with a
matching field on `LoopToolCallRecord`/schema) — it is not derivable in the coordinator.

**Config is immutable after start** (no update channel). Every new knob is a field on `LoopConfig`
(`loop.types.ts:434`), a default in `defaultLoopConfig` (`loop.types.ts:553`), a Zod field in
`LoopConfigSchema` (`loop.schemas.ts:267`) + optional in `LoopConfigInputSchema` (L320), and is honoured
in `runLoop`. Renderer submits a partial; `prepareLoopStartConfig` (`loop-start-config.ts:52`) fills gaps.

---

## 1. Architecture of the change

Seven workstreams. Each is a shared layer; the 30 borrows map onto them. Build order respects the
dependency arrows.

```
A. Steering & Interrupt substrate ........ #1 #18 #29 #30        (independent)
B. Context Survival (wire into context/) . #2 #3 #11 #13 #14 #15 #26 #27   ← biggest value
C. Error Intelligence .................... #4 #5 #16 #17          (B unlocks overflow routing)
D. Stop / Completion hardening ........... #6 #7 #8 #9 #19 #28    (rides on B's token tracker)
E. Progress / anti-thrash ................ #10 #12               (independent, additive signals)
F. Stage control & re-anchoring .......... #22 #23               (#23 is foundational, do early)
G. Architectural opt-ins (gated) ......... #20 #21 #24 #25       (last; #20/#21 collide w/ refactor)
```

Three brand-new shared primitives are introduced (everything else extends an existing module):

1. **`LoopPendingInput`** — replaces `state.pendingInterventions: string[]` with a typed steer/queue queue (Workstream A).
2. **`LoopContextSurvivalManager`** — an injectable that owns per-loop compaction decisions by composing the `context/` primitives above (Workstream B).
3. **`LoopErrorClassification`** — a multi-axis decomposition layered over the existing `FailoverReason`/`ErrorCategory` (Workstream C).

---

## 2. Workstream A — Steering & Interrupt substrate

**Goal:** live human steering of a running loop without corrupting the in-flight iteration, plus
clean interrupt/resume. Borrows **#1, #18, #29, #30**.

**⚠️ Feasibility under our CLI-adapter delegation architecture (review correction).** Be precise about
three distinct things the upstream projects blur together — our architecture changes what's feasible:
- **(present)** *Iteration-boundary intervention* — we already have it: `intervene()` →
  `pendingInterventions`, drained into the next iteration's prompt. The gap is only *prioritization +
  drain timing*, not the capability.
- **(the feasible add — A1)** *Steer-vs-Queue prioritization at the boundary.* Because each loop iteration
  is a discrete CLI invocation (`loop:invoke-iteration` → a CLI subprocess via `default-invokers.ts`),
  "steer" can only mean **drain at the *next* iteration boundary** while "queue" means **drain after the
  run naturally stops**. That's a real, useful distinction but it is a **priority flag on the existing
  queue + drain-timing policy**, not opencode's in-stream step injection.
- **(infeasible here — explicitly out of scope)** *True mid-turn steer* — injecting into a CLI turn
  already in flight. We delegate the whole turn to a third-party CLI subprocess that owns its own
  tool loop; we cannot splice a message mid-turn without **aborting and re-invoking** the adapter (lossy,
  and most CLIs don't support resume-with-injection). So the `maxTurnsPerIteration` "step-budget reset"
  from opencode only applies to providers that expose a turn budget; for CLI adapters it's a no-op.
**Consequence:** #1's *feasible* slice is **easy-med and lower-value** than the upstream billing (it's a
boundary-priority queue, not mid-turn steer); the high-value mid-turn variant is **infeasible without
adapter abort/resume work** and is parked. The Appendix value/effort for #1 is corrected accordingly.

### A0. New type — typed pending input (replaces `string[]`)
`src/shared/types/loop-state.types.ts` — replace `pendingInterventions: string[]` (L~190) with:
```ts
export type LoopPendingInputKind = 'steer' | 'queue';
export interface LoopPendingInput {
  id: string;            // uuid, for dedup + ack
  kind: LoopPendingInputKind;
  message: string;
  enqueuedAt: number;
  source: 'human' | 'block-override' | 'plan-regen' | 'subagent-result' | 'wakeup';
}
```
Keep a back-compat read path: a migration helper `coercePendingInput(x: string | LoopPendingInput)` so
restored loops and the internal pushers (BLOCKED override `loop-coordinator.ts:1464`, plan-regen
`loop-coordinator-state-helpers.ts:159`) keep working. Those internal pushers default to `kind:'queue'`.

**⚠️ Surfaces checklist — `string[]`→object is wider than it looks. All must change together:**
- Type: `LoopPendingInput[]` on `LoopState` (`loop-state.types.ts:184`).
- **Persisted/broadcast Zod state schema** (`loop.schemas.ts:449` — `pendingInterventions` is validated;
  loosen with a union or migrate) + `cloneStateForBroadcast` (`loop-coordinator-state-helpers.ts:82`,
  deep-copies the array) so persistence/restore and main→renderer broadcast keep round-tripping.
- All push sites: `intervene` (`loop-coordinator.ts:1147`), BLOCKED override (`:1464`), plan-regen
  (`-state-helpers.ts:159`), and the new subagent-result/wakeup pushers.
- Prompt builders consume strings today (`loop-stage-machine.ts:359` `buildPrompt`, and
  `buildReviewDrivenPrompt`) — render `.message`.
- IPC/preload/renderer: `LOOP_INTERVENE` handler (`loop-handlers.ts:284`), preload
  (`loop.preload.ts:82`), renderer store (`loop.store.ts:430`), and the thin-client command executor
  if it issues interventions.
Land A0 as its own commit (pure type + migration + surface sync, behavior-neutral) before A1 adds the
steer/queue semantics — keeps the blast radius reviewable.

### A1 (#1). Steer-vs-Queue with safe-seam drain
**Where:** `loop-coordinator.ts` — `intervene()` (L1147) and `runLoop` prompt-build step (L1561–1594).
1. `intervene(loopRunId, message, mode: LoopPendingInputKind = 'queue')` — push a `LoopPendingInput`.
   Add `mode` to `LOOP_INTERVENE` payload: `LoopInterveneePayloadSchema` (`loop.schemas.ts:559`) gains
   `kind: z.enum(['steer','queue']).default('queue')`; thread through `loop-handlers.ts` `LOOP_INTERVENE`
   (L284) and the preload/renderer `loop.store.ts`.
2. **Drain policy** at the top of each iteration, before prompt build:
   - `queue` items: consumed into the prompt exactly as today (drain + flush at L1594).
   - `steer` items: consumed into the **next** iteration's prompt (the soonest safe boundary) and marked
     `steered: true`. *Step-budget reset is provider-dependent:* only where the adapter exposes
     `maxTurnsPerIteration` (not most CLI adapters) reset it + relieve `iterationsOnCurrentStage` pressure
     for the steer (mirrors opencode's step-reset-to-1); for plain CLI adapters this is a no-op and steer
     is purely a drain-priority distinction (see the feasibility note above).
   - **Safe seam:** never drain mid-`invokeChild`. The existing structure already drains only at
     prompt-build (between iterations), so the seam is correct by construction for the
     between-iteration case. True mid-stream injection is **out of scope** here (it's ⚠️HOT — needs the
     `loop:invoke-iteration` listener + adapter abort; see G/§9). Document that `steer` takes effect at
     the next iteration boundary, which is typically seconds away.
3. **First-iteration & post-compaction defer** (codex `can_drain_pending_input`): skip steer-drain on
   `state.totalIterations === 0` and on any iteration where `forceContextReset`/`pendingContextReset`
   fired, so a fresh prompt or a just-compacted context resumes before a steer reshapes it.
4. Suppress the synthetic interruption marker when a queued message already provides context (claude-code).

**Per-tool interrupt behavior** (claude-code `interruptBehavior`) is recorded in the steal-list as part
of #1 but belongs to the `loop:invoke-iteration` listener / adapter layer — track it as A1b, ⚠️HOT,
deferred to Workstream G alongside mid-stream cancel.

### A2 (#18). Verify-the-abort
**Where:** `cancelLoop()` (`loop-coordinator.ts:1169`). Today it sets the cancel flag, resolves the pause
gate, and immediately `terminate()`s. Add a post-terminate confirmation: a small poll loop (reuse
`awaitTerminalCleanup(id)` L558 + `setAdapterCleanupHook`) that confirms the child adapter actually
stopped; if a `loop:activity` event arrives after terminate (zombie turn), escalate via the
`adapterCleanupHook` to a hard kill. Bound the poll (e.g. 5s / `stableStoppedMs`). Emit
`loop:state-changed` only once stably stopped.

### A3 (#29). Sticky `waiting_input` exempt from idle-kill
**Where:** the resource-governor / no-progress path. `LoopStatus` already has `paused` and
`needs-human-arbitration` (`loop.types.ts:646`). Add the rule: when the loop is paused **because** it is
blocked on input (BLOCKED.md handshake L1448, or a terminal `block` intent), it is a *sticky* state that
the idle/crash-loop watchdog (Workstream E / `resourceGovernor`) must not count toward a stall kill.
Implement as a predicate `isStickyWaiting(state): boolean` consulted by the watchdog and by
`shouldRefuseToSpawnNext` callers. Termination on idle requires two independent facts (probe-dead AND
no-recent-activity), matching agent-orchestrator.

### A4 (#30). ScheduleWakeup — model-requested delayed re-entry
**Where:** extend the loop-control CLI intent channel (`loop-control.ts:387` `writeIntentFromCli`,
imported at boundaries `importLoopTerminalIntents` L147). Add a non-terminal intent kind `wakeup` with
`{ resumeAt: number }` (clamp [60,3600]s). On import, instead of terminating, the coordinator pauses and
schedules a resume using the **existing** `providerLimitResumeScheduler` plumbing
(`setProviderLimitResumeScheduler` L362, `scheduleInProcessResume` fallback in
`loop-provider-limit-handler.ts:184`) — that scheduler is already persistent/cross-process. Re-entry
pushes a `LoopPendingInput{kind:'queue', source:'wakeup'}` describing why it woke. Niche; lowest priority in A.

**A tests:** steer resets step budget & is marked; queue defers to next iteration; first-iter/post-compact
defer; cancel confirms stably-stopped + escalates on zombie activity; sticky-waiting not killed by
watchdog; wakeup schedules + re-enters. Extend `loop-coordinator.spec.ts` + `loop-control` specs.

---

## 3. Workstream B — Context Survival (finer tiers on top of LF-1)

**Goal:** give every iteration bounded, non-corrupting context. Borrows **#2, #3, #11, #13, #14, #15,
#26, #27**. Highest value in the spec.

**⚠️ Delta vs what already shipped (review correction — do not re-build LF-1).** The loop is **not** a
blank slate here. `loop-context-discipline.ts` (LF-1) already implements **one** survival tier: a pure
`ContextRecycleDecision` that recycles the loop's *persistent same-session adapter to a fresh session*
(re-anchoring from durable disk state) once cumulative-token utilization crosses a threshold of
`LOOP_CONTEXT_WINDOW_TOKENS` — the recycle itself lives in the invoker's adapter lifecycle. It
deliberately does **not** handle borrowed *instance* adapters (the instance owns its own compaction).
What LF-1 does **not** do — and what this workstream adds **on top of it**, not instead of it:
- **Summarization** (it throws the session away rather than summarizing) → B2 wires `buildCompactionPrompt`
  (which **already exists** with a 12-section anchored template — B2 is *sharpen + wire*, **not** a missing
  template).
- **Sub-recycle micro-compaction** (free tool-output pruning before a full recycle) → B4 (`Microcompact`).
- **Orphan tool-pair repair**, **rehydration**, **400-calibration**, **model-switch rebuild** → B3/B5/B6/B8.
- **Per-iteration token-budget / diminishing-returns** → B1 composes with (does not duplicate) LF-1's
  cumulative-token tracking.
So the framing is: **LF-1 = coarse "throw it away and re-anchor"; Workstream B = the cheaper, lossy-less
tiers below that (summarize, micro-prune, rehydrate) plus the correctness guards (orphan repair, canary).**
The `LoopContextSurvivalManager` (B0) should read LF-1's `loopContextUtilization` and treat full recycle
as its top `fresh-window` tier, choosing a cheaper tier when one suffices.

### B0. New injectable — `LoopContextSurvivalManager`
`src/main/orchestration/loop-context-survival.ts` (new). Follows the DI idiom: a default impl + a
`setContextSurvivalManager(mgr)` setter on `LoopCoordinator`, overridable in tests. It composes the
primitives we already own — it does **not** reimplement compaction.

```ts
export interface LoopContextSurvivalManager {
  // Called after each iteration is sealed (via registerIterationHook), BEFORE the next prompt build.
  onIterationSealed(ctx: {
    state: LoopState; iteration: LoopIteration; childResult: LoopChildResult;
  }): Promise<LoopContextSurvivalDecision>;
}
export interface LoopContextSurvivalDecision {
  action: 'none' | 'micro' | 'summarize' | 'fresh-window';
  forceContextReset: boolean;     // fed into next invokeChild(... forceContextReset)
  rehydrate?: string[];           // file paths to re-inject post-compaction
  nudge?: string;                 // soft-floor "keep working" message → pushed as steer-less prompt note
  reason: string;
}
```
Wire it via `registerIterationHook` (L521) so it runs in the existing post-iteration seam, and read its
`forceContextReset`/`nudge` at the next prompt-build (the coordinator already threads `forceContextReset`
into `invokeChild`, L1601/1617). **Gate on `contextStrategy`:** for `same-session` with an adapter that
returns `true` from `CompactionCoordinator.isSelfManagedAutoCompaction(instanceId)` (e.g. Claude CLI
self-compacts), the manager only does loop-level bookkeeping (token tracking, rehydration hints) and
defers actual compaction to the adapter. For `fresh-child`/`hybrid`, it drives compaction directly.

### B1 (#11). Diminishing-returns + soft-floor — *reuse `TokenBudgetTracker` verbatim*
`TokenBudgetTracker.checkBudget` already returns `{action: CONTINUE|STOP, ...}` with STOP on
(≥3 continuations && last delta <500) or (turnTokens ≥ 0.9·budget), and a "keep working, don't summarize"
nudge on CONTINUE. **Key the tracker by `state.id` (the loopRunId)** — there is no stable
`childInstanceId` (it is `null` in production, `default-invokers.ts:1514`; persistent same-session
adapters are themselves keyed by `loopRunId`). In `onIterationSealed`: get the tracker via
`getCompactionCoordinator().getBudgetTracker(state.id, state.config.caps.maxTokens ?? 1_000_000)`,
call `recordContinuation(iteration.tokens)` then `checkBudget({turnTokens: iteration.tokens})`.
- `STOP` while a completion signal is pending → allow stop (productivity is gone).
- `CONTINUE` while a completion signal fired *under budget* → emit the nudge as a prompt note next
  iteration (soft floor: "you have budget left, keep working").
This is the cheapest high-value win — it's wiring, not building. **Compose with LF-1, don't duplicate:**
LF-1 already tracks cumulative tokens vs the window for the *recycle* decision; B1's tracker is the
orthogonal *per-iteration productivity* axis (delta-based diminishing-returns), feeding stop/continue —
not context-occupancy. Keep them separate signals.

### B2 (#2). Handoff compaction prompt — *reuse `buildCompactionPrompt`, sharpen it*
`buildCompactionPrompt(conversationText, priorSummary)` already emits the 12-section anchored template
with `<prior_summary>` merge + secret redaction. Two sharpenings (the sections every home-grown
summarizer drops): ensure **`## Pending User Asks`** is filled **verbatim** from all user/intervention
messages, and **`## Remaining Work`** carries the **verbatim next step** (claude-code's anti-drift rule).
Add a STAGE/ledger injection: pass `LOOP_TASKS.md` (parsed via `parseTaskLedger`) + current `STAGE` into
the conversationText preamble so stage survives compaction. Frame the resume as a handoff. This is a
prompt edit in `context-compaction-prompt.ts` + the survival manager passing loop state in.

### B3 (#3). Orphaned tool_use/tool_result repair
Wherever the survival manager builds the compacted message list (when it drives `ContextCompactor` /
`Microcompact` directly), add an invariant pass: keep each `tool_use` with its `tool_result` in the same
retained chunk; walk the "keep last N" cut backward to a non-orphaning boundary; drop stranded results.
Add `assertNoOrphanedToolResults(messages)` as a pure helper with its own test. `Microcompact` already
preserves structure (placeholder swap, not deletion), so this matters most on the summarize path.

### B4 (#14). Free deterministic pre-compaction pass
Before any LLM summarization, run `Microcompact.compact(turns)` (placeholder-swaps old tool outputs,
skips if savings <500 tokens, protects last 3 turns). If that reclaims enough to drop under the
utilization target (`config.context.compaction.resetAtUtilization`, default 0.6), **skip the LLM call
entirely** (`action:'micro'`). Optionally upgrade the placeholder from `[microcompacted]` to a
type-aware one-liner (`[terminal] npm test → exit 0`) by reading `LoopChildResult.toolCalls` /
`filesChanged` — a small enhancement to `Microcompact` that keeps the signal needed to decide whether to
re-run a tool. Also adopt claude-code's **time trigger**: if idle > cache TTL (~60min since last
iteration), micro-compact regardless of token count (cheap, since the cache prefix is rewritten anyway).

### B5 (#13). Post-compaction health canary + rehydration
After any `summarize`/`fresh-window` action, set a `state` flag `justCompacted`. On the next iteration:
- **Canary:** the survival manager (or the invoke-iteration listener) runs one cheap throwaway check
  that the executor is still wired (claw-code does a guaranteed-empty glob); on failure, pause with a
  loud BLOCKED rather than producing a corrupt turn.
- **Rehydrate — split by what we actually capture:**
  - **B5a (now):** re-inject the **plan file**, the **active ledger** (`LOOP_TASKS.md`), and the files
    **edited** this run (`LoopChildResult.filesChanged` — these we *do* have) via `JITContextLoader`
    (`FileSystemLoader`, `loadBatch`), budget ~50K, under a "restored working set" note. Decision
    returns `rehydrate: string[]`; prompt-build appends them.
  - **B5b (needs new capture — schedule with E1/D1's invoker work):** re-injecting recently **read**
    files is **not implementable today** — the loop captures writes (`LoopFileChange` is write-diff
    shaped, `loop-state.types.ts:24`) and tool-call args are **hashed** (`argsHash`,
    `loop.schemas.ts:341`), so read paths can't be reconstructed. To do it, add a `filesRead: string[]`
    (or `resourcesRead`) to `LoopChildResult` + its Zod schema, capture it in the `default-invokers.ts`
    listener from tool activity, with retention + budget rules. Until then, B5a is the shipped behaviour.

### B6 (#15). Learn the real context limit from the 400
When the invoke path surfaces a context-overflow error carrying the provider's reported window size,
feed it into `resolveContextWindowSize(...)` (`context-window-guard.ts`) and retune the survival
manager's compaction threshold for that provider/model. Turns a fatal 400 into calibration. Ties to
Workstream C's overflow classification (the classifier tags `context_overflow` → routes here).

### B7 (#26). Tool-output spill + delegate hint
`OutputPersistenceManager.maybeExternalize` is **already wired** (`loop-output-externalize.ts`). Add the
delegate hint: when the loop config has sub-agents/branch-select available, the externalize marker text
should say "delegate a sub-agent to grep `<path>` — do not read it yourself." Small string change in
`output-persistence.ts` (gated by a flag the loop sets) + the loop passing that capability flag.

### B8 (#27). Model-switch forces context rebuild — *scope to the builder downshift, not fresh-eyes*
**Correction (review):** the fresh-eyes gate is a **separate headless side-call** that reviews the
diff/goal (`loop-fresh-eyes-reviewer.ts:114`) — it does **not** sit in the builder's forward context, so
"rebuilding context" there is meaningless. The real risk is the **quota downshift**: the
`downshiftModelByLoop` map is set (`loop-coordinator.ts:1395`) and threaded into `loop:invoke-iteration`
(L2703), **but** a persistent same-session adapter is **reused** and the new `model` only affects
*creation*, not an existing adapter (`default-invokers.ts:1378`). So a downshift silently keeps running
on the old model's session. Fix: when the resolved model for the next iteration differs from the adapter's
current model, **force an adapter recycle** (or `forceContextReset`) in the `default-invokers.ts` listener
so the new model gets a clean context rather than the old one's incompatible session. Drop the fresh-eyes
framing entirely.

**B tests:** budget STOP/CONTINUE wiring; compaction prompt fills Pending-Asks/Remaining-Work verbatim +
carries STAGE/ledger; orphan-repair invariant; micro-pass skips LLM when sufficient; canary fails loud;
rehydration re-injects ≤5 files under budget; overflow retunes threshold; model-switch forces reset.
New `loop-context-survival.spec.ts` and **new** `context-compaction-prompt.spec.ts` (does not exist yet);
extend existing `microcompact.spec.ts`, `token-budget-tracker.spec.ts`.

---

## 4. Workstream C — Error Intelligence

**Goal:** one multi-axis classifier that routes an error to retry / compact / failover / rotate, honours
server backoff, and breaks rate-limit storms across processes. Borrows **#4, #5, #16, #17**.

### C1 (#4). Multi-axis classification
Today: `FailoverReason` (single union → one `retryable` bool) and `ErrorCategory` (enum → one
`recoverable` bool) are **two unconnected single-axis systems**. Introduce a decomposition that layers
over both (don't rip them out):
```ts
// src/main/core/loop-error-classification.ts (new)
export interface LoopErrorClassification {
  reason: FailoverReason;              // reuse existing union
  category: ErrorCategory;             // reuse existing enum
  axes: {
    retryable: boolean;
    shouldCompress: boolean;           // context-overflow → Workstream B
    shouldFailover: boolean;           // switch provider/model
    rotateCredential: boolean;         // auth/quota on this credential
  };
  retryAfterMs: number | null;         // server-requested, UNCLAMPED for rate-limit
  serverWindowTokens?: number;         // for #15 calibration
}
export function classifyLoopError(err, ctx): LoopErrorClassification
```
Rules lifted from hermes: body content overrides status codes (400 "Unsupported parameter: max_tokens"
must NOT set `shouldCompress`; 402 "resets at…" IS retryable rate-limit; 5xx always retryable). The four
axes are **independent** — a safety refusal can be `{retryable:false, shouldFailover:true}`.
**context-overflow → `shouldCompress:true` and `retryable:false`** (routes to Workstream B, not retry).

**⚠️ The real seam (review correction):** the loop does **not** use `RetryManager`/`ErrorRecoveryManager`
today — its invocation error path **catches a plain string** and runs its own circuit-breaker +
degraded-iteration retry (`loop-coordinator.ts:1617`), then parks/terminates via
`loop-provider-limit-handler.ts`. So fixing `retry-manager`/`error-recovery` alone changes nothing for
the loop. Two-part requirement:
1. **Surface structured error info** from the invoker: the `default-invokers.ts` listener must return the
   provider `status`/headers/body (or a pre-built classification) on the error path instead of a bare
   string — without this the classifier has nothing to read.
2. **Insert `classifyLoopError` at `loop-coordinator.ts:1617`**, *before* the existing degraded-retry /
   terminate branches: route `shouldCompress`→Workstream B, rate-limit/quota with `retryAfterMs`→the
   existing park/resume-scheduler path, `shouldFailover`→provider switch, else fall through to today's
   degraded-retry. Consume the same classification in `loop-provider-limit-handler.ts`.
This makes C1 a coordinator-error-path change, not just a `core/` change — re-scope its effort to **med**
accordingly.

### C2 (#5). Honour server backoff, uncapped for rate-limit
`error-recovery.classifyError` already reads `retry-after` (seconds) but `retry-manager.calculateDelay`
**clamps to `maxDelayMs` (30s)** — wrong for a 15-minute rate-limit reset. Fix: when the classification
is a rate-limit/quota with a server `retryAfterMs`, **bypass the 30s clamp** and honour the server value
(the loop is long-running; a long park is fine and already supported via the resume scheduler). Also
parse `x-ratelimit-reset` / `Retry-After` HTTP-date forms (currently seconds-only). Keep jitter on
computed backoff; aborts/timeouts still propagate (never retried).

### C3 (#16). Named recovery recipes — one auto then escalate
`error-recovery.ts` already has `RecoveryActionType` (RETRY, SWITCH_PROVIDER, RESTORE_CHECKPOINT,
RESTART_SESSION, …) but the executor is a no-op placeholder. Add a small closed catalog of
loop-relevant recipes keyed by classification, each `{ steps, maxAttempts: 1, escalation: 'BLOCKED' }`:
e.g. mcp-handshake → retry once; context-overflow → compact (Workstream B). Enforce **exactly one
automatic recovery, then escalate to BLOCKED.md** (the loop's existing pause-for-human path,
`loop-coordinator.ts:1448`). Emit each attempt to the iteration log for audit. Prevents recovery loops.

**⚠️ No auto-destructive git (review correction).** Recovery steps must be classified
**`safe` (auto) vs `destructive` (operator-gated)**. Anything that can lose work — `git reset --hard`,
`git rebase`, `git clean`, branch deletion, force-checkout, discarding a dirty worktree — is **never
run automatically**; the recipe instead escalates to BLOCKED.md with the proposed command for operator
approval (respecting `allowDestructiveOps`, which defaults `false`, `loop.types.ts:627`). So
"stale-worktree" auto-recovery is limited to non-destructive moves (e.g. fetch, fast-forwardable rebase
detection → *report*); the actual reset/rebase is a gated step. The catalog must mark each step's class
and the executor must refuse to auto-run a `destructive` step.

### C4 (#17). Cross-process rate-limit breaker
We run multiple loop instances sharing one provider quota. `provider-quota-service` already models
per-window `resetsAt`/`remaining` but holds it **in-process**. Add a shared on-disk breaker (atomic
write under `userData`, self-cleaning) keyed by provider: the first real 429 (window `remaining===0`)
writes `{provider, resetAt}`; every other loop process consults it pre-flight (top of `runLoop`, near the
quota throttle L1388) and parks until reset instead of hammering. Reuse the existing park machinery
(`handleProviderLimit` → `parked`). Only trip on a genuine exhausted bucket, not on a single transient.

**⚠️ File-lock hygiene (review correction).** Concurrent Electron `main` processes racing one file needs
real discipline, not a naive write: (a) **atomic publish** via write-temp-then-`rename` (atomic on the
same filesystem) so a reader never sees a half-written record; (b) a short-held **advisory lock**
(`proper-lockfile` or `O_EXCL` sentinel) only around the read-modify-write, with **stale-lock reclaim**
(a crashed holder must not wedge every other loop — bound lock age and steal on expiry); (c) treat the
file as **best-effort/advisory** — a missing/corrupt/locked file must **fail open** (proceed, don't
deadlock the loop) since it's an optimization, not a correctness gate; (d) **same-machine only** — this
does nothing for remote nodes (they have separate quotas/filesystems). Record reset as epoch ms and
self-delete on expiry. Put the helper next to `loop-quota-throttle.ts` with its own concurrency test.

**C tests:** four axes independent; body-over-status overrides; context-overflow→compress-not-retry;
rate-limit honours uncapped server delay + HTTP-date; recipe runs once then escalates to BLOCKED;
breaker file parks sibling processes and clears on reset; **classifier inserted at the coordinator error
seam (`loop-coordinator.ts:1617`) routes before degraded-retry/terminate.** New
`loop-error-classification.spec.ts` and **new** `retry-manager.spec.ts` (does not exist yet); extend
existing `src/main/core/__tests__/error-recovery.spec.ts`.

---

## 5. Workstream D — Stop / Completion hardening

**Goal:** make "done" harder to fake and "keep going" cleaner. Borrows **#6, #7, #8, #9, #19, #28**.
All extend `loop-completion-detector.ts` (6+2 signals, evidence-precedence ladder) and the verify flow.

### D1 (#9). Stop-reason unreliable → pending-tool guard ⚠️HOT / NOT a coordinator-only change
**Correction (review):** this is **not representable at the coordinator** as written. `LoopChildResult`
exposes only **sealed** `toolCalls` records (`{toolName, argsHash, success, durationMs}`,
`loop-coordinator.types.ts:20`) — there is no pending/unsettled state, and the detector never receives
`finishReason`/`exitedCleanly` (`loop-completion-detector.ts:237`). By the time the coordinator sees a
result, all tool calls are already settled, so a "pending tool calls remain" guard is a no-op here.
**Where it actually belongs:** the `default-invokers.ts` invoke listener, which sees live
tool_use/tool_result pairing — have it (a) not seal an iteration as a clean stop while a tool_use lacks
its tool_result, and (b) surface `finishReason` + an `unresolvedToolCalls: boolean` onto `LoopChildResult`
so the detector can demote `sufficient` when set. **Reclassify ⚠️HOT; moves out of Phase 1** (needs
invoker + schema work). The *cheap, safe* half — our completion already keys off output text, not
`finishReason`, so we don't falsely trust stop reasons — is already true; this borrow only adds the
unresolved-tool guard.

### D2 (#6). Forced tools-disabled wrap-up on the last step ⚠️HOT / net-new adapter plumbing
**Where:** the cap path (`checkLoopHardCaps` consumer, `loop-coordinator.ts:1380`) and the iteration-seq
logic (~L2397). When the *next* iteration would exceed `maxIterations` (or any cap), run one final
iteration with tools disabled, instructing a structured hand-off (work done / remaining / next steps).
**Correction (review):** the `loop:invoke-iteration` payload (`loop-coordinator.ts:2703`) and the listener
(`default-invokers.ts:1221` payload type, options at `:1428`) carry **no** `disableTools`/`toolChoice`
today, and `invokeCliTextResponse` doesn't accept one — so this is **net-new, provider-specific adapter
work** (each CLI disables tools differently), not "easy/no-hot-path." Add the flag to the payload + listener
+ per-provider invocation options. Also adopt hermes's refund: iterations that did only programmatic/no-op
tool work don't count toward the cap. **Reclassify ⚠️HOT; moves out of Phase 1.** Guarantees a clean
summary instead of an abrupt mid-action cut. *(Cheaper interim alternative, Phase-1-safe: on cap-out, run
the final iteration with a strong prompt-only "summarize, do not start new work" directive — no adapter
change — and accept it's not API-enforced.)*

### D3 (#19). Announce-then-halt continuation nudge
In `observe()` / the completion path: detect a terminal no-tool response whose text *narrates intent*
("I'll now run the tests…", "next I will…") rather than finishing. Reuse `ContinuationInjector`-style
phrasing to push a `LoopPendingInput{kind:'queue'}` "Continue now. Execute the required tool calls."
(max 2×, tracked on `state`). Cheap catch for the classic announce-then-stop failure. **low, no risk.**

### D4 (#28). Self-correcting output-envelope re-wrap
When a terminal iteration's output is malformed for our parsers (e.g. a completion/stage marker the
detector can't parse, or a verify-claim with no parseable result), instead of failing the iteration push
a one-shot correction ("emit `<promise>DONE</promise>` / your verdict in the required form") and re-run
once. Guard to at most one re-wrap per stop attempt (reuse `completionAttempts`, capped by
`maxCompletionAttempts` default 3). **easy.**

### D5 (#8). Self-declared "more work remaining" bit
Add a structured field to the iteration result: the agent self-declares `moreWorkRemaining: boolean`
(via the loop-control CLI — a new lightweight `aio-loop-control status --more-work|--no-more-work`, or a
parsed sentinel). Feed it as a **high-priority completion signal**: `moreWorkRemaining===true` forces
continue (overrides toward continuing, never toward a false stop, per codex). Less spoofable than
re-deriving doneness. **med** (needs the CLI/sentinel channel — the loop-control infra at
`loop-control.ts` already exists).

### D6 (#7). Anti-self-grading verification ⚠️HOT
> **✅ LANDED 2026-07-02** (all three parts, behind `completion.antiSelfGrading`, default OFF per §9).
> 1 → `state.lastVerifiedWorkHash` + stale-verify rung in `evidence-resolver.ts`, wired at the
> coordinator gate. 2 → `loop-canonical-command.ts` (wrapper/env unwrap, `&&`/`;` subsequence,
> full/targeted/unrelated scope incl. `cd`-re-scoping) consumed via `findTargetedVerifyMasquerade`
> in `loop-anti-self-grading.ts`. 3 → caveat demotion of `declared-complete`
> (`findSelfAssignedCaveat`), prompt Verdict-Discipline block, and fresh-eyes instant ALLOW for
> non-edit turns (`state.freshEyesCleanForWorkState`, cleared on production change / blocked
> review / restore). ~100 new tests; full gate green.

Hardens the evidence ladder in `loop-completion-detector.ts`. Three additions:
1. **Edit-invalidates-proof:** track the work-hash / file-change set at the last passing verify; if any
   edit lands after it, the verify status is `stale` and cannot satisfy the gate until re-run. Store on
   `state` (e.g. `lastVerifiedWorkHash`).
2. **Canonical command matcher:** a pure helper that treats `pytest ≡ python -m pytest ≡ uv run pytest`,
   strips `env`/`VAR=`/`time` prefixes, subsequence-matches inside `&&`/`;`, and classifies
   targeted-vs-full scope so one test file can't masquerade as repo-green. Used when matching the agent's
   claimed verify command against `config.completion.verifyCommand`.
3. **"Only the verifier issues a verdict":** in the prompt (`buildPrompt`) and in the detector, forbid
   self-assigned PARTIAL/caveats from counting as completion — only the verify flow / fresh-eyes gate
   issues a verdict. Scope fresh-eyes to iterations that actually touched code (status/summary turns get
   an instant ALLOW — codex-plugin-cc), grounding claims in the diff (`diffSource:'git'`, already the
   reviewer's ground truth per `loop-fresh-eyes-reviewer.ts:29`).
⚠️HOT: touches completion gating — land behind tests + a config flag, conservative defaults.

**D tests:** pending-tool blocks stop; cap triggers tools-disabled wrap-up + refund; announce-then-halt
nudges ≤2×; malformed terminal re-wraps once; self-declared more-work forces continue; edit invalidates
proof; canonical matcher equivalences; non-edit turn skips fresh-eyes. Extend
`loop-completion-detector.spec.ts`.

---

## 6. Workstream E — Progress / anti-thrash

**Goal:** catch stalls the 8 structural signals miss. Borrows **#10, #12**. Additive signals in
`loop-progress-detector.ts` — no change to existing A–H semantics.

### E1 (#10). No-progress-on-*success* (doom-loop / identical-read)
**Delta vs existing `signalG_toolRepetition` (review correction).** We **already** have
`signalG_toolRepetition` (`loop-progress-detector.ts:483`): it flags `(toolName,argsHash)` repeats
*within an iteration* (WARN ≥5 / CRITICAL ≥8 per `toolRepeat*PerIteration`) and the same tool-set across 3
iterations. So E1a is **not net-new detection — it's an extension of signalG**, and E1b is the only
genuinely new axis. Implement accordingly:
- **E1a — extend `signalG`, don't add a parallel signal:** add a *consecutive byte-identical call* rung
  (same tool + identical `argsHash` 3× in a row → CRITICAL **immediately**, before the 4th fires), which
  signalG's count-based thresholds (5/8) don't catch early enough. This is an opencode `DOOM_LOOP_THRESHOLD`
  rung *inside* signalG, reusing the `argsHash` it already computes — no new signal id, no schema change.
- **E1b — Idempotent-read identity (needs new capture):** a read-only tool returning a byte-identical
  **result** hash N times (hermes third axis) — "re-reading, learning nothing." These *succeed*, so
  failure-based signals miss them. **Requires a new `resultHash` we do not capture today** — add
  `resultHash?: string` to `LoopToolCallRecord` (`loop-coordinator.types.ts:20`) **and** its Zod schema
  (`LoopToolCallRecordSchema`, `loop.schemas.ts:341`), captured in the `default-invokers.ts` listener.
  Schedule E1b with B5b/D1's shared invoker-capture work.
- **Schema work — E1b only** (E1a needs none, it lives inside signalG): add `'I'` to `ProgressSignalId`
  (`loop-state.types.ts:99`) **and** `ProgressSignalIdSchema` (`loop.schemas.ts:51`) — the
  persisted/broadcast enum — and add `'I'` to `SIGNAL_PRIORITY` (`loop-progress-detector.ts:581`).
Thresholds: E1a's consecutive-identical rung reuses `toolRepeat*PerIteration` (add a small
`identicalToolCallConsecutiveCritical: 3` to `LoopProgressThresholds` + its Zod schema); E1b adds
`idempotentReadRepeatWarn: 3`. Mark **I** (E1b) a strong signal (eligible for `shouldRefuseToSpawnNext`).
**E1a is the Phase-1 slice (extends signalG, no schema); E1b follows the Phase-1.5 capture work.**

### E2 (#12). Tool-timeout-aware watchdog
The stall/idle watchdog (the `resourceGovernor` seam + `streamIdleTimeoutMs` in `invokeChild` L2640)
should widen its kill threshold to `max(ceiling, declaredToolTimeout)` for the in-flight tool. Capture
the timeout the agent declared for a long Bash/tool call (via a PreToolUse-style record in the
`loop:invoke-iteration` listener, surfaced on `LoopChildResult` or a live `loop:activity` payload) so a
legit 20-min build doesn't trip the watchdog. **med** (needs the listener to report declared tool
timeouts). Pairs with A3 (sticky waiting).

**E tests:** doom-loop trips at 3 identical calls; idempotent-read identity warns; signal I priority +
kill-switch eligibility; watchdog widens to declared timeout, doesn't false-kill a long build. Extend
`loop-progress-detector.spec.ts`.

---

## 7. Workstream F — Stage control & re-anchoring

**Goal:** keep a long loop anchored to its stage/plan/caps every iteration, and let REVIEW send work
back. Borrows **#22, #23**. **#23 is foundational — do it first; it's the substrate the cadenced nudges
in A/D ride on.**

### F1 (#23). System-reminder re-anchoring substrate
**Where:** `loop-stage-machine.ts` `buildPrompt` (L359), inject at the Step-1 block chain (L513). Add a
`reanchorBlock` assembled each iteration that re-states, as a clearly-delimited reminder: current STAGE,
open BLOCKED.md status, caps remaining (iterations/tokens/cost from `LoopState` aggregates), the live
`LOOP_TASKS.md` ledger summary (via `parseTaskLedger` → `nextTodo` + counts), and "exactly one `doing`
item" discipline. Cadence-gate the *ledger* reminder (only re-surface the full list every ~10 iterations
without a ledger edit, to avoid noise — claude-code's `TURNS_SINCE_WRITE`). This single block is the
delivery vehicle for: the soft-floor budget nudge (B1), announce-then-halt (D3), and the verify reminder
(D6). Keep it terse; mark it non-binding context vs the binding `interventions` block (L466).

### F2 (#22). Coordinator-enforced REVIEW→PLAN back-edge + 3-field veto
**Correction (review):** the premise "the stage machine only advances" is **false** — stages are
file-driven and the prompt **already instructs** the agent to write `REVIEW` and loop back
(`loop-stage-machine.ts:441` "keep investigating", `:450` "loop back through review"). So a back-edge
*exists*, but it is **agent-discretionary**: the agent decides whether to write `REVIEW`, and nothing
caps how many times. **The actual delta** is making the back-edge **coordinator-enforced, verdict-gated,
and separately capped** — i.e. not relying on the agent volunteering:
- After a REVIEW iteration, the coordinator derives a structured 3-field veto from the fresh-eyes /
  clean-review output: `clean===false || recommendation!=='APPROVE' || architectural_status!=='CLEAR'`
  (recommendation/architectural_status mapped from finding severities vs `blockingSeverities`).
- On any veto, the coordinator **forces** STAGE back to PLAN (writes/overrides STAGE.md) rather than
  trusting the agent to do it, and increments a **dedicated** `reviewCycle` counter on `LoopState`,
  capped by a new `completion.maxReviewCycles` (default 10) **separate from global caps**, so review
  thrash converges. Reuses `consecutiveCleanReviewPasses` / `reviewDrivenStallIterations` already on
  `LoopState`. **Overlap to respect:** don't double-drive with the agent's own STAGE.md write — the
  coordinator override is authoritative; the prompt text at `:441/:450` should be reconciled so the two
  don't fight (agent *proposes*, coordinator *disposes*).

**F tests:** reanchor block contains stage/caps/ledger + cadence-gates the list; one-doing discipline
surfaced; REVIEW→PLAN rewinds on any veto field, capped at maxReviewCycles. Extend
`loop-stage-machine.spec.ts`, `loop-clean-review-classifier.spec.ts`.

---

## 8. Workstream G — Architectural opt-ins (gated, last) ✅ IMPLEMENTED

Borrows **#20, #21, #24, #25**. Higher risk / bigger surface; default **off**; some ⚠️COLLIDE with the
in-flight checkpoint/session refactor (§9). Implemented only behind explicit conservative gates.

### G1 (#20). Commit-ratchet — git as source of truth ✅
*(Upstream pattern: oh-my-codex `src/autoresearch/runtime.ts` — `last_kept_commit`/`candidate_commit`
manifest, `keep_policy: 'score_improvement'`, `reset --hard` to `last_kept_commit`. Not `team/runtime.ts`.)*
Implemented as `loop-commit-ratchet.ts` plus a post-iteration hook. Per-iteration: make exactly one candidate commit in the loop's worktree
(`loop-worktree-reconcile.ts`); score it via the existing evidence ladder / fresh-eyes; **keep only if
score improved, else `git reset --hard`** to baseline. Reject the iteration as a hallucination if the
worktree HEAD no longer matches the candidate commit or the worktree is still dirty after commit/reset
(cheap anti-overclaim guard at the git boundary). The IPC hook fails the loop closed if the ratchet
throws, so a commit/reset failure cannot silently continue. Config: `phase4.commitRatchet`, default off;
refuses the normal checkout and runs only against an isolated execution worktree.

### G2 (#21). Fresh-session-per-iteration mode ✅
An opt-in `contextStrategy` behavior (we already have `'fresh-child'` as a value, `loop.types.ts:53`):
the model never loops in-session; the harness re-launches a fresh session per iteration with a tiny
state snapshot (STAGE + ledger + last summary), and the agent returns a 4-value status
(`candidate|noop|abort|interrupted`) mapped to our terminal-intent channel. Zero-cost compaction; each
iteration replayable. James approved keeping `'same-session'` as the default; `phase4.freshSessionPerIteration.enabled`
normalizes the start config to the existing `'fresh-child'` path only when explicitly enabled.

### G3 (#24). Sub-agent contracts ✅
When branch-and-select (`loop-branch-select.ts`) or any fan-out graduates from gated/off: require a
validated **TaskPacket** to spawn (objective, scope, acceptance_criteria, verification_plan), a rigid
return schema (`Scope:/Result:/Key files:/Issues:`) so synthesis is deterministic, a **write-scope
non-overlap** gate + **depth limit** for parallel safety, background spawn with **result-injected-as-
fresh-`LoopPendingInput`** (reuses Workstream A's typed queue, `source:'subagent-result'`) and a "do NOT
poll/duplicate" instruction, and **cache-identical prompt prefix across forks** to make parallel cheap.
Implemented as `loop-subagent-contracts.ts`; branch-select consumes `phase4.subagentContracts.enabled`,
validates task packets before spawning any fan-out candidate, forwards the validated packets into fanout,
and injects the TaskPacket plus rigid return shape into each branch-candidate prompt.

### G4 (#25). Read/write-lock parallel tools ✅
Intra-iteration tool parallelism guarded by one shared `RwLock`: reads overlap (`.read()`), writes
serialize (`.write()`); refine with path-subtree reservation (parallelize writes only when paths don't
share a prefix). Lives in the `loop:invoke-iteration` listener / tool-dispatch layer, not the
coordinator. Implemented as `ToolRwLock` and optional `StreamingToolExecutor` lock metadata for host-owned
tool execution. Provider-owned CLI tools cannot be reordered after launch from the loop listener, so the
live invoker consumes `phase4.toolRwLocks.enabled`, detects overlapping write-tool streams, marks the child
result unclean, and the coordinator fails the loop closed on that structured safety error. Default off so
existing provider tool behavior is unchanged unless the flag is set.

### Bonus (prompt-only, fold into F1/buildPrompt, near-free)
Persistence framing ("keep going until fully resolved; don't stop at analysis/partial fixes");
approval-mode-conditional verification aggressiveness; 1–2 sentence preambles before tool groups (skip
for trivial reads). These are string additions to `buildPrompt`.

---

## 9. Collisions, risk flags & guards

- **Resolved 2026-07-02 — checkpoint/session refactor collision:** G1 (commit-ratchet) and G2 (fresh-session) touch
  worktree/commit/session state that James is actively refactoring (`conversation-ledger-*`,
  `history-manager`, `instance-context/lifecycle/manager`, `session-handlers`; memory:
  `project-claude1-todo-progress` — #15 deferred for exactly this). James approved conservative
  implementation: worktree-only commit ratchet, default-off fresh-session opt-in, no root-checkout writes.
- **⚠️HOT — streaming hot path / completion gating:** A1b (per-tool interrupt), D6 (anti-self-grading),
  G4 (rw-lock tools), and the *mid-stream* variant of #1 enter the hot path or the gate where prior work
  (A3 degraded-output, A4 evidence-resolver) was deliberately deferred for false-positive risk. Land
  these **behind a config flag with conservative defaults and a real test harness**, never via an
  autonomous loop landing.
- **Config compatibility:** every new field is optional with a safe default; `LoopConfigInputSchema`
  stays partial; restored loops use `coercePendingInput` and default new fields. No config-update channel
  is added (config stays immutable post-start) — new behavior is start-time only.
- **`selfManagesAutoCompaction`:** the survival manager must respect this opt-out (Claude CLI
  self-compacts) — drive compaction directly only for `fresh-child`/`hybrid` or adapters that don't
  self-manage; otherwise do bookkeeping + rehydration hints only.
- **Two `CompactionResult` shapes** exist (`compaction-coordinator` vs `context-compactor`) — the
  survival manager must name which it uses (recommend `ContextCompactor.compactLayered` for the
  loop-driven path, `CompactionCoordinator.compactInstance` for the adapter-managed path).

## 10. Verification gate (before any `[x]`)

Per `AGENTS.md`: `npx tsc --noEmit` + `npx tsc --noEmit -p tsconfig.spec.json` + `npm run lint` +
`npm run check:ts-max-loc` + targeted `vitest` for every touched spec, then `npm run verify` before
declaring a phase done. New Zod fields must round-trip (renderer partial → `prepareLoopStartConfig` →
defaults). Any new `@contracts/...` subpath must be added to all three alias sites (tsconfig.json,
tsconfig.electron.json, register-aliases.ts) per the packaging gotcha. Keep loop test count green
(currently ~289 loop specs).

---

## 11. Sequencing (recommended)

**Revised after review** — the items that secretly need invoker/adapter/schema work were pulled out of
Phase 1 into a new Phase 1.5 (hot-path/capture). Phase 1 is now genuinely no-hot-path.

| Phase | Items | Rationale | Risk |
|---|---|---|---|
| **0 — Foundations** | A0 typed pending-input (own commit, see surfaces checklist) · F1 re-anchor block · C1 classifier *type* · B0 survival-manager scaffold | shared primitives everything else rides on | low |
| **1 — Quick wins (truly no hot path)** | #2 #3 #5 #11 #19 #23 #28 · #10→**E1a only** (doom-loop, uses existing `argsHash`) | prompt/detector/`core` edits + wiring we own; no invoker/adapter/schema change | low |
| **1.5 — Invoker capture & adapter (the reclassified ones)** | #6 (tools-disable plumbing) · #9 (unresolved-tool + finishReason surfacing) · #10→**E1b** (`resultHash` capture) · #13→**B5b** (`filesRead` capture) | all need `default-invokers.ts` listener + `LoopChildResult`/schema additions; do as one capture sweep | med ⚠️HOT |
| **2 — Steering + Context core** | #1 #18 #29 #30 · #13→**B5a** #14 #15 #26 #27 | the two biggest capability gaps; wiring we own | med |
| **3 — Error + verify + signals** | #4 (coordinator error-seam, see C1 correction) #16 #17 · #7 #8 · #12 #22 | reliability + anti-self-grading + back-edge | med (#7 HOT) |
| **4 — Architectural opt-ins** | #20 #21 #24 #25 | gated, default-off; implemented conservatively | med / gated |

**First PR** = Phase 0 + Phase 1 (foundations make the quick wins clean): borrows
#2,#3,#5,#10(E1a),#11,#19,#23,#28 plus the typed pending-input (A0) + survival-manager (B0) scaffolds.
All genuinely low-risk, no invoker/adapter/schema change beyond A0's surface sync + E1a's `'I'` enum add,
~290 loop specs stay green. **#5 caveat:** fixing the `retry-manager` clamp is isolated and safe, but the
loop only *benefits* once the C1 error-seam (Phase 3) is in — land #5 as the `core/` fix now, wire the
loop later. **Phase 1.5 is the prerequisite** for #6/#9/#10b/#13b — schedule it as one "invoker capture"
sweep so `LoopChildResult` + its Zod schema change once, not four times.

## 12. Provenance & cross-refs

- Upstream provenance + corroboration + value/effort ranking for all 30 borrows: **Appendix A** (below).
- **Dedup baseline = the shipped LF-1…LF-8 work, NOT `loop-library-borrow_notes_completed.md`.** That
  earlier "borrowed" note covers **automation recipes** (scheduled one-pass prompts) — different content;
  it is not the right thing to dedup loop-*engine* borrows against. The correct baseline is
  `docs/plans/loopfixex_completed.md` (LF-1…LF-8) + the loop-intelligence "why"
  (`docs/plans/2026-05-29-loop-intelligence-improvements-plan_completed.md`). Per-workstream dedup against
  it:
  - **LF-1 context-discipline** (`loop-context-discipline.ts`) → Workstream B builds *finer tiers* on top
    (see §3 delta box); **do not re-implement the recycle.**
  - **LF-2 semantic-progress** (`loop-semantic-progress.ts`) → Workstream E's signal **I** must compose
    with it (semantic check is the "advanced?" modifier; E adds structural axes) — not overlap it.
  - **LF-4 ledger** (`loop-task-ledger.ts` + `LOOP_TASKS.md`) → F1 re-anchor *surfaces* the ledger; it
    doesn't add a second ledger.
  - **LF-5 branch-select** (`loop-branch-select.ts`) → G3 sub-agent contracts harden *that*, not a new
    fan-out engine.
  - **LF-6 cross-loop memory** → already feeds `buildPrompt` `priorObservations`; F1/B2 reuse it.
  - LF-3 cost-cap, LF-7 completion-attempt cap, LF-8 → unaffected. This spec is the *next* layer, additive.
- Open questions still needing James's call: fresh-vs-same-session default (gates G2), autonomy-vs-human
  on stuck (gates C3 escalation), cross-model rebuild scope (B8), canonical ledger/summary shape (B2/F1).
- Code surfaces in this spec verified against the live tree 2026-06-26; implementation completed 2026-07-02.

---

## 13. Fresh-eyes review record (2026-06-26)

This spec was reviewed twice the day it was written — a self-review and an independent Codex pass that
read the actual code. All findings were folded into §0–§12 above; this is the audit trail so a future
reader knows *why* certain items are flagged ⚠️HOT or split. **All 30 borrows were confirmed present and
mapped** (no item exists only in the appendix); the issues were feasibility, hidden surfaces, and
sequencing — now corrected.

| # | Finding | Severity | Where fixed |
|---|---------|----------|-------------|
| 1 | **D1 #9** pending-tool guard not representable at coordinator — `LoopChildResult.toolCalls` are sealed, no `finishReason`. | blocker | §5 D1 reclassified ⚠️HOT → `default-invokers.ts` capture; out of Phase 1 |
| 2 | **B5 #13** "rehydrate read files" unimplementable — only `filesChanged` (writes) captured; tool args hashed. | blocker | §3 B5 split B5a (edited files+plan+ledger, now) / B5b (needs `filesRead` capture) |
| 3 | **B1 #11** `loopInstanceId` nonexistent; `childInstanceId` is `null`. | blocker | §3 B1 keyed by `state.id` |
| 4 | **D2 #6** tools-disable is net-new adapter plumbing, not "easy". | blocker | §5 D2 reclassified ⚠️HOT; out of Phase 1; prompt-only interim noted |
| 5 | **B8 #27** fresh-eyes is a side-call; wrong model-switch trigger. | major | §3 B8 rescoped to quota-downshift adapter recycle |
| 6 | **C1/C2** loop catches a string + runs own retry; never uses `RetryManager`. | major | §4 C1 adds the real seam (`loop-coordinator.ts:1617` + invoker structured errors) |
| 7 | **A0/A1** `string[]`→object under-scoped (state schema, IPC, preload, store, broadcast/persist). | major | §2 A0 surfaces checklist added; A0 = own behavior-neutral commit |
| 8 | **E1 #10** missing schema work: `ProgressSignalId`/schema no `'I'`; no `resultHash`. | major | §6 E1 split E1a/E1b + enumerates schema edits |
| 9 | **Phase 1 "no hot path" false** (#6/#9/#10b touch invoker/adapter/schema). | major | §11 new Phase 1.5 (invoker-capture sweep); Phase 1 trimmed |
| 10 | Named test files don't exist (`context-compaction-prompt.spec.ts`, `retry-manager.spec.ts`). | major | §3/§4 tests marked "new"; error-recovery spec path corrected to `__tests__/` |
| 11 | Invoke listener is `default-invokers.ts` (via `initialization-steps.ts:361`), not `src/main/index.ts`. | minor | header + §0 corrected globally |

**Net effect on the plan:** the *shape* is unchanged (7 workstreams, 30 borrows), but four items
(#6, #9, #10b, #13b) that looked like Phase-1 quick wins actually depend on one shared piece of
infrastructure — **surfacing live tool/error/read state from the `default-invokers.ts` listener onto
`LoopChildResult` + its Zod schema**. That work is now consolidated into **Phase 1.5** so the schema
changes once. Phase 1 is correspondingly smaller but genuinely safe.

### 13b. Second review round (2026-06-26, cross-model) — folded in

A further cross-model pass caught premise/feasibility errors the first round missed. All corrected above:

| Finding | Severity | Where fixed |
|---|---|---|
| **#2** framed as trivial greenfield — `context-compaction-prompt.ts` already has the 12-section template | major | §3 B intro + B2 reframed "sharpen+wire"; Appendix `trivial*` asterisk |
| **#22** premise "stage machine only advances" **false** — file-driven REVIEW back-edges already at `loop-stage-machine.ts:441,450` | major | §7 F2 rewritten: delta = coordinator-enforced/capped, not agent-discretionary |
| **#10** omitted existing `signalG_toolRepetition` (`:483`) | major | §6 E1a reframed as an *extension of signalG*, not a new signal; only E1b adds signal `I` |
| oh-my-codex paths wrong (`team/runtime.ts:548`) — actual is `autoresearch/runtime.ts` + `pipeline/orchestrator.ts` | major | G1 inline + Appendix #20/#21/#22 corrected |
| **No delta vs shipped AIO subsystems** (LF-1 context-discipline, microcompact, error-recovery) | major | §0 LF-1 row + §3 B delta box + §12 per-LF dedup |
| Dedup scoped to the wrong note (automation recipes), not LF-1…LF-8 | major | §12 dedup baseline corrected |
| **#1** feasibility unanalyzed for CLI-adapter delegation; "med" inconsistent; mid-turn vs boundary conflated | major | §2 A feasibility box: boundary-priority (feasible, easy-med) vs mid-turn (infeasible, parked); Appendix #1 re-rated |
| **#16** recipes could run destructive git unattended | major | §4 C3 `safe`/`destructive` classes; destructive is operator-gated |
| **#17** shared file needs cross-process lock hygiene | major | §4 C4 atomic-rename + advisory lock + stale reclaim + fail-open + same-machine-only |
| Compaction gap conflated "no wiring/orphan-repair" with "no template" | major | §3 B intro: template EXISTS; gap = wiring + orphan-repair + section emphasis |
| Plan scoping to `loop-coordinator.ts` alone misses #1/#3/#4/#27 wiring | major | Touchpoints map below |

**Touchpoints map (where each "wiring" borrow actually lands — not `loop-coordinator.ts` alone):**

| Borrow | Primary touchpoint(s) beyond the coordinator |
|---|---|
| #1 steering | `default-invokers.ts` (invoke listener) + IPC/preload/renderer (`loop-handlers.ts:284`, `loop.preload.ts:82`, `loop.store.ts:430`) + state Zod schema (`loop.schemas.ts:449`) |
| #3 orphan repair | `src/main/context/` compactor (the message-list builder), **not** the coordinator |
| #4 error classification | `default-invokers.ts` (surface structured errors) **+** coordinator error seam `loop-coordinator.ts:1617`; `core/loop-error-classification.ts` (new) |
| #27 model-switch rebuild | `default-invokers.ts:1378` (adapter reuse/recycle), not the coordinator's `model` threading |
| #6/#9/#10b/#13b | `default-invokers.ts` listener + `LoopChildResult`/`LoopToolCallRecord` + Zod schema (Phase 1.5) |

A scaffold-only plan that edits `loop-coordinator.ts` would therefore **miss the load-bearing wiring** for
these — implementers must touch `default-invokers.ts`, `src/main/context/`, and the contracts/schemas.

---

## Appendix A — Borrow provenance, corroboration & ranking

The 30 borrows, with where each came from in the reference clones, how many independent projects
converged on it (corroboration — the strongest "worth stealing" signal), and value/effort. **Value** =
how much it fixes a real loop failure we hit; **Effort** = touch surface + hot-path risk. Upstream
`file:line` are into the sibling repos under `orchestrat0r/`, captured 2026-06-26. Items are grouped by
the workstream that implements them (§2–§8).

| # | Borrow | Workstream | Value | Effort | Corrob. | Upstream source(s) — file:line |
|---|--------|-----------|-------|--------|---------|--------------------------------|
| 1 | Steer-vs-Queue input — **boundary-priority slice** (mid-turn infeasible w/ CLI adapters) | A1 | ★★★☆☆ (feasible slice) | easy-med | **5** | codex `turn.rs:188`; opencode `runner/llm.ts:188`; claude-code `handlePromptSubmit.ts:313`; nanoclaw `poll-loop.ts:344`; copilot-sdk `session.go:1453` |
| 2 | Handoff compaction template (verbatim asks + next step) | B2 | ★★★★★ | trivial* | **5** | claude-code `services/compact/prompt.ts:61`; opencode `compaction.ts:182`; codex `compact/prompt.md`; openclaw `compaction.ts:49`; hermes `context_compressor.py:43` (*`context-compaction-prompt.ts` already has the 12-section template — sharpen+wire, not greenfield) |
| 3 | Orphaned tool_use/tool_result repair on prune | B3 | ★★★★☆ | easy | **3** | openclaw `compaction-planning.ts:382`; claw-code `compact.rs:129`; codex `compact.rs` |
| 4 | Multi-axis error classification → retry/compact/failover | C1 | ★★★★★ | med | **4** | hermes `error_classifier.py:69`; opencode `retry.ts:69`; openclaw `infra/retry.ts`; claw-code `recovery_recipes.rs` |
| 5 | Honor server Retry-After + jittered backoff | C2 | ★★★★☆ | easy | **3** | codex `responses_retry.rs:31`,`util.rs:85`; opencode `executor.ts:225`; openclaw `infra/retry.ts:25` |
| 6 | Forced tools-disabled wrap-up on last step | D2 | ★★★★☆ | med ⚠️HOT | **2** | opencode `max-steps.ts`; hermes `iteration_budget.py:37` |
| 7 | Anti-self-grading verification (edit-invalidates-proof, canonical cmd) | D6 | ★★★★★ | med ⚠️HOT | **4** | claude-code `TodoWriteTool.ts:76`; hermes `verification_evidence.py:495`,`:163`; codex-plugin-cc `stop-review-gate.md`; oh-my-codex `review-verdict.ts` |
| 8 | Self-declared "more work remaining" stop bit | D5 | ★★★☆☆ | med | 1 | codex `turn.rs:2206` |
| 9 | Stop-reason unreliable → pending-tool guard | D1 | ★★★★☆ | med ⚠️HOT | **2** | claude-code `query.ts:554`; opencode `prompt.ts:1103` |
| 10 | No-progress-on-*success* (doom-loop / identical-read) | E1 | ★★★★☆ | easy (E1a) / +capture (E1b) | **3** | opencode `processor.ts:354`; hermes `tool_guardrails.py:241`; nanoclaw `host-sweep.ts:83` |
| 11 | Diminishing-returns early-stop + soft-floor nudge | B1 | ★★★☆☆ | low* | 1 | claude-code `tokenBudget.ts:45` (*already built in `token-budget-tracker.ts` — wiring only) |
| 12 | Tool-timeout-aware watchdog | E2 | ★★★☆☆ | med | 1 | nanoclaw `host-sweep.ts:83` |
| 13 | Post-compaction health canary + rehydration | B5 | ★★★★☆ | med (B5a) / +capture (B5b) | **2** | claw-code `conversation.rs:307`; claude-code `compact.rs:531` |
| 14 | Free deterministic pre-compaction pass (no LLM) | B4 | ★★★★☆ | low* | **2** | hermes `context_compressor.py:990`; claude-code `microCompact.ts:446` (*`microcompact.ts` exists) |
| 15 | Learn real context limit from the 400 | B6 | ★★★☆☆ | easy | 1 | claw-code `conversation.rs:201` |
| 16 | Named recovery recipes — one auto then escalate | C3 | ★★★☆☆ | med | 1 | claw-code `recovery_recipes.rs:15` |
| 17 | Cross-session rate-limit breaker (shared file) | C4 | ★★★☆☆ | low | 1 | hermes `nous_rate_guard.py:71` |
| 18 | Verify-the-abort (poll until stably stopped) | A2 | ★★★☆☆ | low-med | **2** | oh-my-opencode `cancel-task.ts:236`; t3code `AcpSessionRuntime.ts:707` |
| 19 | Announce-then-halt continuation nudge | D3 | ★★★☆☆ | low | 1 | hermes `conversation_loop.py:4609` |
| 20 | Commit-ratchet: git as source of truth | G1 | ★★★★☆ | med ⚠️COLLIDES | 1 | oh-my-codex `src/autoresearch/runtime.ts` (`last_kept_commit`/`candidate_commit` ~L81/L46; `reset --hard` to `last_kept_commit`; keep-decision L549) |
| 21 | Fresh-session-per-iteration (opt-in mode) | G2 | ★★★★☆ | high ⚠️DECISION | 1 | oh-my-codex `src/autoresearch/runtime.ts:678` ("one candidate then exit") |
| 22 | Bounded REVIEW→PLAN back-edge + 3-field veto | F2 | ★★★★☆ | low | 1 | oh-my-codex `src/pipeline/orchestrator.ts:174` + `src/pipeline/review-verdict.ts` |
| 23 | System-reminder re-anchoring substrate | F1 | ★★★★☆ | low | **2** | claude-code `utils/api.ts:461`; opencode `reminders.ts:26` |
| 24 | Sub-agent contracts (TaskPacket / return-format / depth / scope) | G3 | ★★★☆☆ | med-hard | **5** | claw-code `task_packet.rs`; claude-code `forkSubagent.ts:54`; opencode `task.ts`; oh-my-opencode `council-manager.ts:83`; hermes `async_delegation.py` |
| 25 | Read/write-lock parallel tools | G4 | ★★☆☆☆ | med ⚠️HOT | **2** | codex `tools/parallel.rs:117`; hermes `tool_dispatch_helpers.py:104` |
| 26 | Tool-output spill-to-disk + delegate hint | B7 | ★★★☆☆ | easy* | 1 | opencode `truncate.ts:85` (*`output-persistence.ts` already wired — hint only) |
| 27 | Model-switch forces context rebuild | B8 | ★★★☆☆ | med | 1 | codex `turn.rs:825` (`comp_hash_changed`) |
| 28 | Self-correcting output-envelope re-wrap | D4 | ★★☆☆☆ | easy | 1 | nanoclaw `poll-loop.ts:603` |
| 29 | Sticky `waiting_input` state exempt from idle-kill | A3 | ★★★☆☆ | low | 1 | agent-orchestrator `runtime.go:10` |
| 30 | ScheduleWakeup — model-requested delayed re-entry | A4 | ★★☆☆☆ | low-med | 1 | jean `wakeup.rs:86` |

**Reading the corroboration column:** 4–5 = many independent codebases converged → lift with high
confidence (steering #1, handoff compaction #2, sub-agent contracts #24, error classification #4,
anti-self-grading #7). 1 = a single project's good idea — still worth it, but judge on merit.

**Reference projects mined (2026-06-26):** `codex` (OpenAI Codex CLI, Rust), `opencode` (SST, TS),
`Actual Claude` (unminified claude-code TS), `t3code`, `hermes-agent`, `nanoclaw`/`openclaw`/`claw-code`,
`copilot-sdk`, `jean`, `oh-my-codex`, `oh-my-opencode-slim`, `agent-orchestrator`, `codex-plugin-cc`.
Thin/skipped for loop ideas: `jean` (UI wrapper), `codex-plugin-cc` (prompt-only), `agent-orchestrator`
(signal/poller-driven, not a while-loop — only #29 lifted).
