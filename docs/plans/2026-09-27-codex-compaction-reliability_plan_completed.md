# Codex Compaction Reliability — Plan (completed)

**Status:** Completed 2026-09-27. All phases implemented and verified; rebuilt-app checks are deferred to
[2026-09-27-codex-compaction-reliability_livetest.md](2026-09-27-codex-compaction-reliability_livetest.md). Written 2026-09-27 from James's report "Codex appears not to
be working very well at handling compaction" (screenshots of instance `xqs4fg7sl`, "Run as many of these
livetests").

**Related:**

- [2026-09-24-codex-compaction-turn-visibility_plan_completed.md](2026-09-24-codex-compaction-turn-visibility_plan_completed.md)
  covered Codex's own *Compact* turns only (LT-652..LT-657). This plan covers the defects that remain.
- [2026-09-24-codex-compaction-turn-visibility_livetest.md](2026-09-24-codex-compaction-turn-visibility_livetest.md):
  the evidence below means **Check 2 (controlled recovery continues on the same thread) would fail today**
  (7 of 7 recoveries ended in `EmptyInput`). This plan does not edit that doc, because a live-test session
  may be working in it.

## 1. What James saw

1. `Codex error: failed to submit turn input: EmptyInput`, each followed by the misleading "The initial
   message could not be delivered and the session was kept open".
2. A long stack of "Codex is compacting…" / "Codex compacted its own context (awaiting updated usage)" /
   "Codex finished its provider compaction turn." rows with no agent output between them.
3. "Context 75%" and "Context at ~75% — compacting…" banners that never seem to go away.

## 2. Evidence (session `xqs4fg7sl`, 2026-09-27 04:00–10:00 BST)

Sources: `app.log`, `conversation-ledger.db` (`context_evidence_events`, `provider_event_captures`), all
read-only, and the Codex rollout
`~/.ai-orchestrator/codex/sessions/2026/09/27/rollout-2026-09-27T04-00-42-01a0e0ce-….jsonl`.

| Fact | Evidence |
| --- | --- |
| 27 compactions in 6 hours, and **every one was Harness-requested** (`trigger: "policy"`); Codex never compacted by itself | `app.log` "Codex compaction started" lines; rollout `compacted` entries |
| 04:02–04:36: seven `cumulative-4x → controlled-recovery` actions at **32–50% occupancy**, about every 4–6 minutes | `context_evidence_events` (`occupancy_used` 82k–131k of 258,400) |
| The epoch baseline *does* reset after each compaction, but the 16x "backstop" (16 × 258,400 = 4.13M gross tokens) is reached again in about 40 requests at ~100k context | e.g. epoch 1 baseline 7,713,314 → fired at 11,862,441 (+4.149M ≥ 4.134M) |
| Harness's cumulative counter was 4.18M when Codex's own parent-thread total was 1.07M at the same moment; the counter includes sub-agent threads (`spawn_agent` was called 3 times) | rollout `token_count` vs ledger; `usage-accounting.ts:212-218` adds `child` usage to `cumulativeTokens` |
| Each compaction takes 60–90 s and only brought context down to ~52k (≈20%), because Codex re-injects the full developer, AGENTS.md and skills context twice after each compaction | rollout ordinals 174–183 after the 03:04:22Z `compacted` entry |
| At 04:01:48 (one minute into the run) the model called Codex's `create_goal` tool. From then on, **Codex's goal extension starts its own continuation turn 10–35 ms after every Compact turn ends** | rollout `task_started` right after each `task_complete`; `<codex_internal_context source="goal">`; codex `ext/goal/src/runtime.rs:425-503` (`start_turn_if_idle`) |
| Harness's continuation is `thread/inject_items` (developer) then `turn/start` with `input: []`. `turn/start` is start-or-steer, so it landed on the goal turn as a steer, and Codex rejects an empty steer: **7 of 7 continuations failed with `EmptyInput`** | codex `core/src/session/turn_input.rs:303-366` + `:665-667`; ledger `error` rows at 04:04:22, 04:08:15, 04:12:32, 04:18:52, 04:24:39, 04:30:42, 04:36:31 |
| The injected developer text still reached the model (it was accepted into the goal turn), so the "error" was spurious, but Harness showed an error, set status `idle`, and reported it through `InitialPromptRecovery` | ledger capture 04:04:22.652–.662; `app.log` line "Initial prompt failed after successful spawn" |
| **From 04:36 to 10:00 Harness rendered no assistant or tool output at all**: only system rows. Over the same period the rollout has ~150 assistant messages and thousands of tool calls. Harness status toggled idle → busy (compaction) → idle while Codex worked non-stop | ledger `adapter-event:output` by hour (04: 2,295 assistant rows; 05–09: system only) vs rollout |
| Harness then treated the live goal turn as an idle boundary and sent `thread/compact/start` at 75%. **Codex aborted the running turn with `reason: "replaced"`** 13 times, discarding 10–15 minutes of in-flight work each time | rollout `turn_aborted {reason: "replaced", duration_ms: 628156–903252}` immediately before each policy compaction |
| Late in the session the policy also steered at 70% ("wrap up broad exploration") every cycle | `context_evidence_events` `known-occupancy-70 → steer-turn` |

## 3. Root causes

**RC1 — Spend is used as a compaction trigger.** `context-safety-policy.ts:359-421` turns
`cumulative-4x` into `controlled-recovery` (interrupt → compact → continue) when occupancy ≥ 50% *or*
spend since the epoch ≥ 16 × window. Gross spend is roughly requests × occupancy, so the backstop fires
every ~40 requests however small the context is. Compacting at 32% bought about 10 points of window
for an 80-second model call and an aborted turn. The counter also includes child-thread spend, which has
nothing to do with the parent thread's context. None of the surveyed projects (section 4) compacts on
spend.

**RC2 — The continuation uses start-or-steer with empty input.** `context-cost-controller.ts:343-420`
(`recoverAfterTurn` → `continueTurnWithRetry`) → `codex-app-server-turn-adapter.ts:115-162` sends a developer-only turn as
`thread/inject_items` + `turn/start {input: []}`. That works only if the thread is still idle when
`turn/start` arrives. Any provider-started turn (goal continuation, queued input, a future Codex automatic
turn) turns it into an empty steer → `EmptyInput`. The retry only recognises `ActiveTurnNotSteerable
{Compact}`. Because the recovery runs inside the original send's call stack
(`appServerSendMessageInner` → `recoverAfterTurn`), the error escapes to whichever caller awaited the
original send, which here was the initial prompt, so it was mislabelled "initial message could not be
delivered" (inferred from the stack in `app.log`; to confirm in Phase 0).

**RC3 — Harness only tracks turns it started.** `codex-app-server-adapter.ts:290-307`
(`handleIdleAppServerNotification`) keeps only usage and compaction signals when Harness has no active
turn; agent messages, tool items and `turn/completed` of a provider-started turn are dropped. The
2026-09-24 plan made Compact turns visible but not regular turns started by Codex. Consequences:

- The transcript is blank for hours while the agent works.
- Status reads `idle`, so hibernation, the memory governor and "at safe boundary" checks all see an idle
  session that is actually running.
- `getAtSafeProviderBoundary` (`compaction-runtime.ts:277-280`, `turnPhase === 'idle'`) is wrong, so
  "idle" native compaction replaces the live turn (RC4).

**RC4 — `thread/compact/start` is sent while a provider turn is running.** Codex treats it as replacing
the active turn (`turn_aborted reason: replaced`). Nothing in Harness checks for a provider-started turn
before compacting.

**RC5 — Harness pre-empts Codex's own compaction.** Codex auto-compacts **inline inside the running
turn** at 90% of the resolved window by default (`protocol/src/openai_models.rs:525-528`,
`core/src/session/turn.rs:598-637`). That path needs no interrupt, no continuation and no Harness RPC.
Harness's policy (steer at 70%, compact at 75% idle, interrupt+recover at 80%) always fires first, so
every compaction took the expensive interrupt-or-replace path.

**RC6 — Presentation.** Every compaction produces three separate system rows plus a "Recover context"
button. With RC3 hiding the work between them, the transcript becomes a wall of compaction notices.

## 4. How other projects handle it

| Project | Who triggers | Trigger measure | After compaction | Loop guard |
| --- | --- | --- | --- | --- |
| **Codex itself** (`codex-rs`) | Codex, inline mid-turn | active context tokens after each sampling request vs `model_auto_compact_token_limit` (default 90% of window) | continues the same turn (`continue;` at `turn.rs:637`); goal extension restarts idle work via `start_turn_if_idle` (never steers) | stops the active goal on a turn error, explicitly to stop compaction loops (`ext/goal/src/extension.rs:405-409`) |
| **t3code** (`apps/server/src/provider/Layers/CodexSessionRuntime.ts:2006-2036`) | leaves it entirely to Codex | none | n/a | n/a. Turn state comes from the thread's `turn/started`/`turn/completed` notifications **whoever started the turn**, so provider-started turns are always visible |
| **CodePilot** (`src/lib/context-compressor.ts`) | app, at 80% | fresh SDK usage snapshot (<60 s), else estimate | fresh session seeded with summary | 3 consecutive failures disables auto-compaction for the session |
| **opencode** (`packages/opencode/src/session/compaction.ts:232-241`) | app, pre-turn | estimate of the next request vs `window − max(output, buffer)` | synthetic compaction message; no continuation prompt | single pass per turn; context-overflow errors are non-retryable |
| **pi** (`packages/coding-agent/src/core/compaction/compaction.ts:248-292`) | app | tokens vs `window − reserve (16k)` | **invalidates cached usage at a compaction entry and re-estimates**, so a stale pre-compaction reading can never re-trigger | n/a |
| **openclaw** (`packages/agent-core/src/harness/compaction/compaction.ts:322-331`, `post-compaction-loop-guard.ts`) | app | tokens vs `window − reserve`, reserve capped at 25% | continues turn loop | `MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3`; post-compaction guard aborts if the agent repeats pre-compaction tool calls |
| **hermes-agent** desktop store | provider | n/a | reconciles the "compacting" flag only on proof the turn resumed or ended | n/a |

Principles taken from this:

1. Every surveyed harness triggers on **occupancy against the window minus a reserve**, never on spend.
2. When the provider compacts natively and inline (Codex), the best-behaved client (t3code) leaves it to
   the provider and only renders it.
3. Turn state must be **notification-driven for the whole thread**, not request-driven.
4. A post-compaction reading is stale until a fresh measurement arrives (pi).
5. Bound attempts, and stop when compaction stops helping (openclaw, CodePilot, Codex's own goal stop).
6. Never steer to start work. Start only if idle, and treat "someone else already started it" as success
   (Codex's goal extension uses `start_turn_if_idle`).

## 5. Decisions (agreed with James 2026-09-27)

Direction: follow the surveyed projects. Codex owns compaction; Harness renders it and stays out of
the way.

1. **Stop compacting on spend when occupancy is known.** `cumulative-2x` stays a ledger checkpoint.
   `cumulative-4x` recovery runs only when occupancy is unknown, where spend is the only signal. The
   `contextSpendRecovery*` settings are removed.
2. **Codex app-server compacts itself at its own 90% default.** Harness takes no occupancy-driven action
   for Codex (no 60/70/75/80% ladder, no 85% idle backstop, no 80% delegation-guidance message). Harness
   steps in only when Codex actually fails for size (the existing 1 MiB input-cap ladder) or when the user
   presses Compact. A threshold setting may come later, but nothing is passed to Codex by default.
   This reverses T62 (2026-09-03 backlog), which was a design preference with no recorded Codex failure.
3. **The 70% "wrap up" steer is gone for Codex** (falls out of 2).
4. **Track every turn on the root thread**, including goal continuations. Render its items, hold `busy`,
   and settle on its `turn/completed`.
5. **Continuations never use start-or-steer with empty input.** A manual compaction sends a continuation
   only if nothing else has started work; a provider turn that is already running counts as the
   continuation. No Harness continuation while a Codex goal is active.
6. **One boundary row per compaction** ("Codex compacted context 88% → 21%"), with "Recover context" in
   that row's menu.
7. **Stop pauses an active Codex goal** as well as interrupting the turn, so Codex does not restart work
   a moment later. The transcript says the goal was paused. "Stop" means every interrupt except a steer:
   the Stop button, mobile/channel/thin-client stops, orchestrator pause, tool-loop auto-stop and
   usage-overage stop. The pause is one-way; Harness never re-activates a goal, and the next user
   message simply starts a normal turn.

## 6. Implementation phases

### Phase 0 — Probes (done 2026-09-27)

Live probe against `codex app-server` 0.157.1 (`_scratch/probe-goal/probe.cjs`, default home):

- [x] Codex's own auto-compaction arrives as `item/started`/`item/completed` `contextCompaction` with the
      **running regular turn's** `turnId`, and a fresh `thread/tokenUsage/updated` (post-compaction
      occupancy) arrives with the completion. Only `thread/compact/start` produces a separate Compact
      turn, and it aborts the running turn first (`handlers.rs:243-250`, `TurnAbortReason::Replaced`).
- [x] An active goal starts a turn on the root thread with a normal `turn/started`, and the next one
      within milliseconds of the previous `turn/completed`. `thread/goal/updated` carries the status.
- [x] `thread/goal/set {status: paused}` during a goal turn lets that turn finish and starts no more
      (0 in 40 s). `thread/turns/list` (newest first) reports the running turn on non-ephemeral threads.
- [x] `turn/start` is start-or-steer; an empty steer is `EmptyInput` (`turn_input.rs:303-366`, `:665`).
- [x] The per-send recovery-ceiling question is moot: Codex no longer runs Harness recoveries.
- [x] Replay test of the xqs4fg7sl sequence: `codex-cli-adapter.provider-turns.spec.ts` (synthetic, no
      real transcript content).

### Phase 1 — Stop the spend storm (decision 1) — done

- [x] `decideCumulative`: `cumulative-4x` recovery only when occupancy is unknown; `cumulative-2x` stays a
      ledger checkpoint.
- [x] `contextSpendRecovery*` settings and the `CumulativeRecoveryLimits` plumbing removed.
- [x] Child-thread spend: moot once spend no longer acts on a known occupancy.
- [x] Tests (revert-checked): `context-safety-policy.spec.ts`, `context-policy-integration.spec.ts`,
      `context-evidence-incident-replay.spec.ts`.

### Phase 2 — Follow turns Codex starts by itself (decisions 4 and 7) — done

- [x] `CodexAppServerThreadRuntime.captureProviderTurn` follows a root-thread turn Harness did not
      request; `getActiveTurnOrigin()` reports `provider`. Harness and provider capture share one loop
      (`runCapture`), so items render through the same handlers.
- [x] `CodexAppServerTurnAdapter.followProviderTurn` (connection-level `turn/started`): status `busy`
      until the turn ends, then the final message, usage, cost and `complete` are published exactly as
      for a Harness turn (`emitCompletedTurn`), then `idle` unless a Harness send owns the status.
- [x] The runtime snapshot reports the provider turn, so `isTurnActive` / safe-boundary checks, manual
      compaction refusal, hibernation and idle monitors see the session as working.
- [x] A Harness send during a provider turn joins it: user text via `turn/steer` pinned to that turn id,
      developer text via `thread/inject_items`; the send resolves when the turn's output is published.
      If the turn ends mid-join, an already injected developer item is not sent again.
- [x] Stop pauses an active goal: `InstanceManager.interruptInstance` → `stopProviderAutoContinuation`
      (every origin except `steer`) → `thread/goal/set paused`, with a transcript note. The goal status
      is tracked from `thread/goal/updated`, so a known-active goal is paused in one request sent ahead
      of `turn/interrupt` on the same connection; only an unknown status (resumed thread) is read first.
      The tracked status is keyed to its thread id, so a reopened thread never inherits a stale status.
- [x] Tests (revert-checked): `app-server-thread-runtime.spec.ts`, `codex-cli-adapter.provider-turns.spec.ts`,
      `provider-auto-continuation.spec.ts`.

### Phase 3 — Safe continuation and safe compaction (decision 5) — done

- [x] Recovery skips its continuation when Codex will continue by itself (a followed provider turn, or
      an active goal per `thread/goal/get`).
- [x] A developer-only `turn/start` rejected as `EmptyInput` follows the turn that was already running
      (its `turn/started`, else `thread/turns/list`) instead of failing.
- [x] Transient continuation failures become a paused recovery (`continuation-failed`): the recovery
      posts its own notice and throws a surfaced `CodexContextRecoveryPausedError`, so the initial-prompt
      path adds no "could not be delivered" notice while orchestration callers still get the reason.
      Auth and usage-limit failures propagate unchanged.
- [x] `compactContext` refuses while any turn runs (Codex would replace it).
- [x] Tests: `context-cost-controller.spec.ts`, `codex-cli-adapter.app-server.spec.ts` (RPC order now
      includes the goal check).

### Phase 4 — Hand compaction to Codex (decisions 2 and 3) — done

- [x] `providerAutoCompaction: 'inline'` capability for Codex app-server; the policy takes no occupancy
      action for it (no 60/70/75/80% ladder, no steer). Codex keeps its own 90% default; no threshold is
      passed. `selfManagedAutoCompaction: true` also stops the 80% delegation message and the banner.
- [x] `compaction-signals.ts`: a compaction item inside the running regular turn is `inline-started` then
      `completed` (de-duplicated per item id): no send gate, no status flip, liveness heartbeat while it
      runs, and an `aborted` finish if the turn ends mid-compaction. A Harness request's Compact turn is
      recognised by `isCompactTurnExpected()` and is not followed as task work.
- [x] Post-compaction placeholder readings (`thread-compacted`, `post-compaction-reset`) never reach a
      policy decision (`context-policy-runtime.ts`), in addition to the existing forwarding skip.
- Intended ripple: `loop-context-survival.ts` now defers for a borrowed Codex app-server chat as it does
  for Claude (only the optional idle cache note is skipped; LF-1's reset still fires).
- Known gap, unchanged: remote-worker Codex (`remote-cli-adapter.ts`) exposes no context capabilities.

### Phase 5 — Presentation (decision 6) — done

- [x] Successful provider-compaction start/finish notices are hidden (`isQuietProviderCompactionMarker`);
      failures stay visible. The boundary row is the one row, labelled "Codex compacted its own context
      (was N%)" from the last measured reading (`instance-event-forwarding.ts`).
- Decision: "Recover context" stays inline on the boundary row. With compactions now rare it is not
  noise, and a menu would hide the only recovery affordance.
- [x] "initial message could not be delivered" misattribution removed (Phase 3).

### Phase 6 — Diagnostics — done

- [x] `Following a turn Codex started by itself` log with turn id; goal pause logged and noted in the
      transcript. Inline compactions log as `Codex compaction started` with `trigger: self-managed`.
- [x] Storm canary: `Codex compaction storm` warning above 6 compactions per instance per hour.

### Phase 7 — Verification — done

- [x] Canonical gates green: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
      `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, and `npm run test:quiet`
      (2,248 files, 26,849 tests). Every new test was revert-checked against its fix.
- [x] Live protocol probe against codex-cli 0.157.1 (Phase 0).
- [x] Fresh-eyes completion gate: first pass PASS with three should-fix findings (goal-pause ordering,
      duplicate developer injection, continuation-failure surfacing), all fixed; second pass PASS.
- Rebuilt-app checks are in [2026-09-27-codex-compaction-reliability_livetest.md](2026-09-27-codex-compaction-reliability_livetest.md).

## 7. Risks

- **Scope of Phase 2.** Rendering provider turns touches the same capture paths as Harness turns. One
  item pipeline is shared, and the existing Harness-turn specs pass unchanged apart from RPC order.
- **Goal pause on Stop** changes Codex-side state. Only a goal `thread/goal/get` reports as active is
  paused, and the transcript says so.
- **Codex's own compaction is now the only automatic path.** If a Codex build stops auto-compacting, the
  failure shows up as a context-window error on a turn; the input-cap ladder and manual Compact remain.
- **Other providers.** `ContextSafetyPolicy` is shared. Phase 1 changes spend handling for every provider
  with known occupancy; check Claude, Copilot and ACP capability declarations before merging.

## 8. Answered questions

1. Threshold: Codex's own 90% default (James, 2026-09-27).
2. Stop during an active Codex goal pauses the goal (James, 2026-09-27).
