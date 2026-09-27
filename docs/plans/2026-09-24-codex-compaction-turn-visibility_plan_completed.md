# Codex "keeps dying": make the provider Compact turn visible — Implementation Plan

**Date:** 2026-09-24
**Status:** COMPLETED 2026-09-24 (implementation, canonical verification, independent review and
local package verification complete; rebuilt-app/provider checks deferred to the linked live test)
**Owner:** hand-off implementer (any model). Written by a Claude session that did the
investigation only; no code was changed by the investigator.
**Related register items:** LT-652 and LT-653 (preserved regressions), plus LT-654, LT-655 and
LT-656 (implemented and regression-tested here; rebuilt-app checks remain in the linked live-test
document). LT-657 was not needed because the sender/hibernation audit is part of LT-654.

---

## 0. Rules for the implementer (read before touching anything)

1. **The working tree is dirty on purpose.** It holds the uncommitted LT-652/LT-653 fixes
   (`src/renderer/app/core/state/instance/*messaging*`, `src/main/cli/adapters/codex/app-server-thread-runtime.ts`)
   plus an unrelated loop fix (`src/main/orchestration/loop-child-invoker.ts`) and register/runbook
   edits. Build on top of them. Never `git stash`, `git checkout --`, reset, or overwrite them.
   Their focused tests pass today (`68 tests passed` across the four spec files listed in §3).
2. No feature branch, no worktree, no commits, no pushes unless James asks. Work in this checkout.
3. Read every file you edit in full, plus its callers and spec. The file:line references below were
   correct on 2026-09-24 at commit `98ad8ede` + the dirty tree; re-verify them.
4. Reproduce with a unit test that fails on the current code before writing the fix.
5. James runs the **packaged** app (`/Applications/Harness.app`, `app.asar` built 2026-09-24 12:21,
   running since 12:26). Nothing you change reaches him until a DMG is rebuilt. **Never restart
   Harness yourself while he has live sessions**; build the DMG, verify it, and tell him.
6. Finish with the canonical gate list (§7), a fresh-eyes review pass by a separate agent using the
   `task-completion-gate` skill, register entries, and a `_livetest.md` for anything that genuinely
   needs the rebuilt app.

---

## 1. What James sees, and what is actually happening

James's report: "codex keeps dying". Screenshot (2026-09-24 18:20, session
`Fix Performance Issues Using n8n`, instance `xqhsuju06`, Codex `gpt-6-astra`, profile
`CodexComTech`, cwd `~/work/communitytech`): the agent's last message says it **stopped** work and
saved a handoff; James's reply produced a collapsed **"3 errors"** card; a **"Context compacted
[self-managed]"** divider with a **"Recover context"** button appeared; the header meter reads
**"Context 0%"**; the composer still holds his unsent text.

Three distinct things went wrong in that one screen, and a fourth mode killed two sessions
yesterday. All four share one root cause (§2).

### Incident A — the screenshot session (2026-09-24, times local/BST)

Evidence: `~/Library/Application Support/Harness/logs/app.log`, `lifecycle.ndjson`, and
`~/Library/Application Support/Harness/conversation-ledger/conversation-ledger.db`
(`provider_event_captures`, `instance_id='xqhsuju06'`).

| Time | Event |
|---|---|
| 17:48:47 | Spawned (pid 7180), status idle → busy on the initial prompt |
| 18:11:23 | `DoomLoopDetector` runaway warning: `Edit` ×200 |
| 18:19:52 | Adapter context event: 195,365 / 258,400 tokens = **75.6 %** |
| 18:20:20 | Assistant streams "Stopped exploration and saved the [durable handoff]…" — the LT-653 steer-turn paraphrase, so a policy `steer-turn` almost certainly fired (nothing logs it; see §2.4) |
| 18:20:25.606 | `complete` → status **idle** |
| 18:20:25.755 | James's send arrives (154 chars + `pasted-image-12.png`) |
| 18:20:26.2 → 18:20:27.2 | **Six** `INSTANCE_SEND_INPUT` / `sendInput` attempts, each answered by `Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }`; status flips busy→idle six times; `InstanceCommunication` logs `Suppressing repeated error` counts 4, 5, 6 |
| 18:22:06 | `CodexCliAdapter: Thread compacted by Codex app-server` (thread `01a0d451-d413-…`) — **100 s after the sends were rejected**, the compaction was still running the whole time |
| 18:31:25 | James's next send succeeds |

So the session did not die. Codex was running its own compaction turn; AIO reported the instance
idle, tried to send into it, was rejected, retried in a sub-second storm, and gave up. The "3
errors" card, the "Context 0%" meter and the "Recover context" button are all AIO's rendering of a
normal provider compaction, and none of them tell James "Codex is compacting, wait".

### Incident B — two sessions actually killed (2026-09-23, before the 21:09 "Fixing codex" commit)

Instances `xfbaestxb` and `xm9076fqy` (Codex `gpt-6-sol`). Same capture table, same log.

| Time | `xfbaestxb` |
|---|---|
| 16:39:41 | James sends (36 chars); status busy |
| 16:40:35.724 | `Thread compacted by Codex app-server`; system message "Codex reached a shared context-policy boundary, so Harness interrupted it, observed compaction, and is continuing on the same thread" (`controlled-recovery`) |
| 16:40:35.728 | `Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }` — the same-thread continuation was submitted while the Compact turn was still open |
| 16:40:35.729 | adapter emits **status `error`** |
| 16:41:08 | `IdleMonitor: Found zombie process, force killing {status:'error'}` → adapter cleaned up |
| 16:41:38 | `StuckProcessDetector: Process stuck — provider process is not running`; `InterruptRespawn: Skipping respawn … no longer recoverable {status:'error'}` |
| 17:05:20 | terminated |

`xm9076fqy` followed the identical sequence 41 s later (16:41:16 → 16:42:08 zombie kill). Those are
the only two `busy → error` transitions for Codex in the last two days, and both are this cascade.
Commit `9efc4871` (2026-09-23 21:09, in the installed build) changed the classification so this
rejection now yields `idle` instead of `error`, and added **one** retry after 750 ms. That stops the
zombie kill but not the underlying failure: the continuation still fails whenever the Compact turn
outlives 750 ms, which it always does (measured 14 s to 565 s; see memory note
`codex-compaction-signal-is-context-item.md`). 14 `Same-thread continuation raced the provider
compaction turn closing; retrying once` warnings are logged between 2026-09-23 17:09 and
2026-09-24 17:52.

### Incident C — recovery paused on "compaction could not be confirmed"

Five `Context compaction was acknowledged but not observed` events (outcomes `timed-out`,
`stalled`, `cancelled`), each followed by `InitialPromptRecovery: Initial prompt failed after
successful spawn … Codex context recovery paused because compaction could not be confirmed`
(instances `xyq4o1e41`, `xax7edfzq`, `xryeh9vtb`, `xs5yte46m`). The 900 s running window and the
`aborted` signal (uncommitted on 2026-09-23, now in `compaction-signals.ts`) address the first two
outcomes; this plan only requires that the new gate (§4) reuses that window rather than adding a
second timeout.

### Scale

`Thread compacted by Codex app-server` appears **113 times** between 2026-09-23 15:58 and
2026-09-24 18:22 (one thread compacted 19 times). Every one of those is a window in which the
defects above can fire. Codex CLI is `codex-cli 0.156.1`
(`~/.nvm/versions/node/v24.15.0/bin/codex`).

---

## 2. Verified root cause

### 2.1 The Compact turn is invisible to AIO's turn tracking, so a compacting instance is "idle"

- Codex app-server runs compaction as an internal turn (`turn_kind: Compact`) and rejects any
  `turn/start` or `turn/steer` for its whole duration with `ActiveTurnNotSteerable`.
- `CodexAppServerThreadRuntime.captureTurn` (`src/main/cli/adapters/codex/app-server-thread-runtime.ts:240-266`)
  only knows about turns **it** started (`this.activeTurn`). Its `turn/started` subscription
  (`:291-303`) runs only while one of its own turns is open. A provider-initiated Compact turn never
  sets `activeTurn`, so `hasActiveTurn()` is false.
- The adapter does see the compaction start: `handleAppServerNotification` calls
  `contextCostController.acceptCompactionSignal(...)`
  (`src/main/cli/adapters/codex-app-server-adapter.ts:275-277`) and
  `CodexCompactionSignalTracker.accept` (`src/main/cli/adapters/codex/compaction-signals.ts:32-65`)
  returns `'started'` on `item/started {type: contextCompaction}`. But the adapter acts **only on
  `'completed'`**; `'started'` just marks the compaction gate running and starts a heartbeat
  (`context-cost-controller.ts:158-195`). **No status is emitted, no output message, no renderer
  event.** The instance stays `idle` for the whole compaction.
- Consequences, in order:
  1. `InstanceCommunication.sendInput` sees `status: 'idle'` and forwards James's message
     (`sendInput state check … status: 'idle'` in the log). `sendInputImpl`
     (`codex-app-server-adapter.ts:570-605`) emits `busy`, the submit is rejected, the catch emits
     the error output and `idle` again. That is the busy/idle flapping and the "3 errors" card.
  2. The renderer drains the queue on every ready-status edge
     (`src/renderer/app/core/state/instance/instance.store.ts:395` and `:517`), so each `idle`
     re-sent immediately. That is the six-sends-in-a-second storm (LT-652; renderer backoff already
     in the tree).
  3. The controlled-recovery continuation (`continueTurnWithRetry`,
     `src/main/cli/adapters/codex/context-cost-controller.ts:348-366`) is submitted right after the
     `contextCompaction` item completes, races the Compact turn closing, and retries **once after
     750 ms** (`CONTINUE_TURN_RETRY_DELAY_MS`, `:21`). If that also fails the whole `sendInput`
     throws; before `9efc4871` the classifier returned `unknown` → `restart-runtime` →
     `keepInstanceUsable: false` → status `error` → `IdleMonitor` zombie kill
     (`src/main/instance/lifecycle/idle-monitor.ts:426-436`). After `9efc4871` the classifier
     returns `request-rejected`/`retry-thread` (`app-server-runtime-errors.ts:98-106`,
     `app-server-recovery-policy.ts:47-49`) so the instance goes `idle`, but the recovery's
     "continue on the same thread" step is silently abandoned and the user's turn ends with an
     error bubble.
  4. Because the instance is `idle`, the idle-hibernation sweep and the resource governor treat a
     compacting session as free to hibernate/cull (see memory notes
     `codex-async-question-ends-turn.md`, `memory-pressure-culled-live-sessions.md`).

### 2.2 The "Context 0%" meter

`buildObservedCompactionEvents` (`src/main/cli/adapters/codex/compaction-presentation.ts:17-25`)
emits a context event with `used: 0, percentage: 0, isEstimated: true` on every observed
compaction. The header meter renders that literally as 0 %, and the real post-compaction occupancy
only arrives with the next `thread/tokenUsage/updated`. James reads "0 %" as "the session lost
everything".

### 2.3 The "Recover context" button and "self-managed" divider

The compaction boundary marker is attached in `src/main/app/instance-event-forwarding.ts:205-229`
with `method: 'self-managed'`, and `output-stream.component.html:127-138` renders the divider plus a
`Recover context` button (`compaction-recovery-copy.ts`). The renderer's own "compacting" indicator
(`instance.store.ts:223-241`, `_compactingInstances`) is fed only by the AIO `CompactionCoordinator`
(`src/main/app/compaction-runtime.ts:478-483`, `:538-542`), never by a Codex self-managed
compaction. So for Codex the UI shows a *recovery* affordance after the fact, and no *progress*
affordance during it. What "Recover context" does for a self-managed marker must be checked against
`docs/plans/2026-06-28-compaction-recovery-marker-spec_completed.md` before deciding whether to keep,
relabel or hide it (§5, Phase 3).

### 2.4 Policy actions are unlogged

`src/main/context/context-policy-runtime.ts` and
`src/main/context-evidence/provider-context-action-executor.ts` contain no `logger.*` calls. The
ladder in `src/main/context-evidence/context-safety-policy.ts:19-22, 205-300` fires `steer-turn` at
70/75 % mid-turn and `native-compaction`/`controlled-interrupt` at 75/80 %, yet the only trace of
the 18:20 steer is the model's wording. Every incident above required inference where a log line
should have existed.

### 2.5 Already fixed, and where each fix currently lives

| Item | State | Where |
|---|---|---|
| Rejection classified as retryable (no more `error` status → zombie kill) | in installed build | `9efc4871`, `app-server-runtime-errors.ts:98-106` |
| One 750 ms continuation retry | in installed build | `context-cost-controller.ts:21, 348-366` |
| Compaction signals from `contextCompaction` items, 900 s running window, `aborted` signal | working tree (some committed 09-23) | `compaction-signals.ts`, `compaction-gate.ts` |
| LT-652 renderer backoff (15 s × 12, `retryAfterAt` gate, coalesced drains) | **uncommitted** | `messaging-retry-disposition.ts`, `instance-messaging.store.ts`, `instance-queue-retry-timers.ts`, `instance.types.ts` |
| LT-653 system-framed steer text | **uncommitted** | `app-server-thread-runtime.ts` `CONTEXT_POLICY_STEER_TEXT` |

The LT-652 backoff is a renderer-side symptom fix (it stops the storm and the drop). It cannot fix
2.1.3, 2.1.4, 2.2, 2.3 or 2.4, and it still lets the first send hit Codex and produce an error
bubble. Keep it as defence in depth for the race window before `item/started` arrives.

---

## 3. Decision

Fix the root cause in the main process: **an observed or inferred Codex Compact turn must make the
instance non-idle and must gate every submit path until the compaction completes**, and the UI must
say "compacting" instead of "errors". The renderer backoff stays. Concretely:

1. On compaction `'started'` with no AIO-owned turn active → emit `status: 'busy'`, a system output
   message, and the existing `instance:compact-status {status:'started'}` renderer event. On
   `'completed'`/`'aborted'` with no AIO-owned turn → emit `'idle'` and `compact-status
   completed`. When an AIO turn is active (controlled recovery) the status is already `busy`; emit
   only the message/event.
2. Every submit into the thread (`appServerSendMessage`, `steerActiveTurn`, the controlled-recovery
   continuation, orchestration inject) first **awaits the compaction gate** (bounded by the existing
   running window, `compactionRunningTimeoutMs`, 900 s in the live log, with the existing
   heartbeat) instead of submitting and hoping.
3. If a submit is nevertheless rejected with `turn_kind: Compact` (the `item/started` notification
   had not arrived yet), mark the tracker as running from the rejection, apply rule 1, and **wait for
   the completion signal, then submit once** — not a fixed-delay retry.
4. Post-compaction context event carries the last known occupancy marked estimated (or the value
   from the first `thread/tokenUsage/updated` after the compaction) instead of 0.
5. Policy decisions and executed actions are logged with instance id, trigger, action and proof.

Why not just make the renderer smarter: main-process senders (automations, loops, mobile/Discord
routers, orchestration `inject-response`, the recovery continuation) all bypass the renderer queue
and hit the same rejection.

---

## 4. Phases

Each phase: reproduce with a failing unit test → implement → run the focused specs → move on.
Keep every file under the `check:ts-max-loc` ceiling (split helpers into new files as the
existing code does, e.g. `compaction-signals.ts`, `compaction-presentation.ts`).

### Phase 1 — Compaction-aware status and gate in the Codex adapter (LT-654)

Files: `src/main/cli/adapters/codex-app-server-adapter.ts`,
`src/main/cli/adapters/codex/context-cost-controller.ts`,
`src/main/cli/adapters/codex/compaction-signals.ts`,
`src/main/cli/adapters/codex/compaction-gate.ts`,
`src/main/cli/adapters/codex/app-server-thread-runtime.ts` (only if the gate has to live near
`captureTurn`), their `.spec.ts` files, and `codex-cli-adapter.app-server.spec.ts`.

Tasks:

1. `CodexContextCostController`: expose `isCompactionRunning(): boolean` and
   `awaitCompactionSettled(): Promise<CompactionGateOutcome>` built on the existing
   `CompactionGate` running window and heartbeat (do not add a new timer or constant; reuse the
   `compactionRunningTimeoutMs` dependency, `context-cost-controller.ts:281` /
   `compaction-gate.ts:33`, which the live log reports as `runningTimeoutMs: 900000`).
2. `CodexCompactionSignalTracker`: add `markRunningFromRejection(turnId: string | null)` so a
   `turn_kind: Compact` rejection can start the running state when `item/started` was not seen.
   `'completed'`/`'aborted'` clear it as today.
3. Adapter: in `handleAppServerNotification`, act on `'started'` and `'aborted'` as well as
   `'completed'`:
   - `'started'`, no `appServerRuntime.hasActiveTurn()` → `emit('status','busy')`, `emit('output',
     {type:'system', content:'Codex is compacting its context…', metadata:{providerCompaction:'started'}})`,
     and forward `instance:compact-status started` through whatever path
     `compaction-runtime.ts:478` uses (route it via the instance manager/event forwarding so the
     Zod schema `InstanceCompactStatusEventSchema` still validates).
   - `'completed'`/`'aborted'`, no active turn → `emit('status','idle')` after the existing
     `handleObservedThreadCompaction`, plus `compact-status completed`.
   - Check the lifecycle state machine accepts `idle → busy → idle` from this path and that
     `hibernating`/`hibernated`/`superseded` instances are not moved (guard on current status the
     same way `sendInputImpl` does).
4. Adapter submit gate: in `appServerSendMessage` (and `steerActiveTurn`, and the orchestration
   inject path in `codex/orchestration-response-send.ts`), before calling into the runtime:
   `if (controller.isCompactionRunning()) await controller.awaitCompactionSettled()`. On a
   `'failed'`/timeout outcome throw the existing `recovery-paused` style error so the caller's
   handling stays unchanged.
5. Rejection handling: replace `continueTurnWithRetry`'s fixed 750 ms retry with: classify → if the
   message matches `turn_kind: Compact` (add `isCompactTurnRejection()` beside
   `classifyMessage` in `app-server-runtime-errors.ts`; keep the current broad regex for the
   `kind`), `markRunningFromRejection`, apply task 3's status/message, `await
   awaitCompactionSettled()`, submit exactly once more. Apply the same wrapper to the user send path
   in `sendInputImpl` so the **first** user send during an unseen compaction is held, not surfaced
   as an error bubble. Any non-Compact rejection keeps today's behaviour.
6. Tests (all must fail on current code first):
   - `item/started contextCompaction` with no active turn → status busy + system message +
     compact-status started; `item/completed` → idle + completed. With an active turn → no status
     change, message/event still emitted.
   - `sendInput` during a running compaction resolves only after the completion signal and results
     in exactly one `turn/start`.
   - `turn/start` rejected with `ActiveTurnNotSteerable { turn_kind: Compact }` before any
     `item/started` → tracker running, status busy, one resubmit after `item/completed`, no `error`
     status, no error output bubble.
   - Controlled-recovery continuation against a Compact turn that stays open for 20 s (fake timers)
     → continuation succeeds after the completion signal; the old 750 ms path would have thrown.
   - Regression for Incident B: the `xfbaestxb` sequence (turn active → compacted → continuation
     rejected) never emits `status: 'error'`.
   - Gate timeout (running window elapsed, no signal) → the existing paused-recovery error,
     status back to idle, no zombie state.

Acceptance: a user or automation send that lands anywhere inside a Codex compaction is delivered
after it, with no `Codex error:` bubble, no busy/idle flapping, and no `Failed to send message after
N retries` notice; a controlled recovery's continuation lands on the same thread after the compaction
regardless of its duration; the instance is never `idle` while Codex is compacting (so hibernation
and the governor leave it alone).

### Phase 2 — Main-process send paths honour the compacting state (LT-654, part 2)

Files: `src/main/instance/instance-communication.ts` (the `sendInput state check` path around the
`status: 'idle'` log and `:2303-2318` error suppression), `src/main/instance/instance-manager.ts`
`sendInput`, the senders that already wake hibernated instances before sending
(`src/main/channels/channel-message-router.ts`, `src/main/doc-review/doc-review-delivery-coordinator.ts`,
`src/main/event-bus/thin-client-instance-commands.ts`; grep `wakeInstance` for the full list),
`src/main/orchestration/*` inject paths, `src/main/process/idle-hibernation-sweep.ts`,
`src/main/runtime/long-run-resource-governor.ts`.

Tasks:

1. Trace what each main-process sender does when the instance is `busy` (queue, steer, interrupt,
   or reject) and make sure a compaction-busy instance is **queued**, never interrupted. Where the
   busy handling currently interrupts (renderer-owned send-while-busy is fine; main-side steer paths
   are the risk), add an explicit "provider compacting" check via the adapter's
   `isCompactionRunning()` (expose it through the adapter interface, defaulting to `false` for other
   providers).
2. Ensure `IdleHibernationSweep` and `ResourceGovernor` idle selection exclude a compacting
   instance (they should already, once status is `busy`; add a test that proves it through the
   status, not by re-implementing a check).
3. Tests: send from the instance-manager path during compaction → queued/held, delivered after;
   hibernation sweep skips a compacting instance.

Acceptance: `sendInput state check` in `app.log` never reports `status: 'idle'` for a Codex
instance between `item/started contextCompaction` and its completion.

### Phase 3 — Honest UI during and after a self-managed compaction (LT-655)

Files: `src/main/cli/adapters/codex/compaction-presentation.ts`,
`src/renderer/app/features/instance-detail/output-stream.component.{ts,html}`,
`compaction-recovery-copy.ts`, `message-format.service.ts:127-138`, the header context meter
component (find via `contextUsage`/`percentage` bindings in `instance-detail`), `instance.store.ts`
`_compactingInstances`.

Tasks:

1. Context meter: `buildObservedCompactionEvents` must not emit `used: 0`. Emit the last observed
   occupancy with `isEstimated: true` and a `source: 'thread-compacted'` marker, and let the first
   `thread/tokenUsage/updated` after the compaction replace it. If the meter must show something
   distinct, show "compacted, awaiting usage" rather than 0 %. Test the adapter event and the
   meter rendering.
2. Compacting indicator: because Phase 1 now emits `compact-status started/completed`, the existing
   `_compactingInstances` set lights up for Codex. Verify the header/row indicator actually renders
   for it (seed the renderer store per memory note `renderer-ui-verify-via-ng-store-seeding.md`) and
   that the composer shows "Codex is compacting… your message will send afterwards" instead of the
   generic busy state when a queued message exists.
3. Error card: the three surfaced `Codex error: … turn_kind: Compact` bubbles must not appear at all
   after Phase 1. Add a renderer test that a message with that content is never rendered as an
   error card even if an older main process sends it (defence in depth), rendering it as the
   compacting notice instead.
4. "Recover context" on a self-managed boundary: read
   `docs/plans/2026-06-28-compaction-recovery-marker-spec_completed.md`, trace
   `recoverCompactionContext` from `output-stream.component.ts:992` through IPC to main, and decide:
   keep the button only if it restores something real for a Codex-compacted thread; otherwise hide
   it for `method: 'self-managed'` and change the divider copy to "Codex compacted its own context
   (N % → M %)". Record the decision and the evidence in this plan's as-built notes.

Acceptance: while Codex compacts, the session shows a compacting state and a queued-message hint;
after it, the meter shows a real (or explicitly estimated) percentage and no error card; the
divider copy and any button are truthful for a self-managed compaction.

### Phase 4 — Policy and compaction observability (LT-656)

Files: `src/main/context/context-policy-runtime.ts`,
`src/main/context-evidence/provider-context-action-executor.ts`,
`src/main/cli/adapters/codex-app-server-adapter.ts`, lifecycle logging
(`src/main/instance/lifecycle/*` where `status-transition` records are written).

Tasks:

1. Log every policy decision (`trigger`, `action`, `reasonCode`, occupancy %, instance id) and every
   executed action with its proof (`requested` / `acknowledged` / `observed` / `none` / `skipped`)
   at `info`, using `getLogger('ContextSafetyPolicy')` and `getLogger('ProviderContextAction')`.
2. Log `Codex compaction started` / `completed` / `aborted` with instance id, thread id, turn id,
   duration, trigger (`self-managed` vs `policy`), and emit a `lifecycle.ndjson` event
   (`eventType: 'provider-compaction'`, `phase`) so the campaign runbook queries can find them
   without joining the capture DB.
3. The `Suppressing repeated error` path (`instance-communication.ts:2303-2318`) should log at
   `warn` with the instance status and, when the message matches a Compact rejection, name the
   compaction state, so a future storm is diagnosable from one grep.

Acceptance: re-running the §1 timeline queries on a rebuilt app shows the steer, the compaction
start, and the completion as first-class log lines.

### Phase 5 — Keep LT-652 and LT-653 intact (no new work unless a gate finding demands it)

The uncommitted renderer backoff and the framed steer text stay as they are. After Phase 1 the
backoff should almost never fire (the send is held in main), so add one integration-style test that
the renderer receives no rejection for a send during a compaction, and leave the LT-652 tests in
place as regression cover for the pre-`item/started` race. Do not weaken the 15 s × 12 budget.

### As built — 2026-09-24

1. **Provider lifecycle and gates (Phase 1).** `contextCompaction` item/turn signals and strict
   Compact rejections now drive one bounded lifecycle with heartbeat, outcome-preserving cleanup,
   schema-valid compact-status events and first-class transcript metadata. User/orchestration sends
   serialize behind compaction; steering and controlled recovery wait for the owning turn and retry
   once. Busy ownership survives successful/recoverable outer-send completion and controlled
   continuation. Stalls, aborts, cancellation and runtime exit clear without fatal/zombie state.
2. **Main-process safety (Phase 2).** `isProviderCompacting()` is exposed through the adapter path;
   queue/steer/orchestration handling respects it. Idle hibernation excludes the compaction-busy
   instance, and the preserved `thread-compacted` usage snapshot is display-only at forwarding,
   busy-warning and after-turn policy ingress.
3. **Truthful presentation (Phase 3).** The renderer shows a dedicated compaction banner and
   queued-message explanation, suppresses the generic interrupt hint, and renders legacy Compact
   rejection output as a compaction notice. Unknown occupancy no longer becomes 0%; a last-known
   reading is marked estimated until real usage arrives. `Recover context` remains because its
   wired IPC path restores real bounded wake/verbatim context.
4. **Observability (Phase 4).** Policy decisions, provider action proof, provider-compaction
   lifecycle/outcomes/duration, and repeated-error suppression now emit structured identifiers and
   state. Lifecycle forwarding uses validated compact-status payloads and retains terminal outcomes.
5. **Existing fixes (Phase 5).** LT-652's 15-second × 12 renderer fallback and LT-653's explicitly
   system-framed steer remain intact and covered. No new LT-657 item was necessary.
6. **Architecture and review.** Task additions were extracted into focused helpers. The original
   LOC ceilings remain 704 (+50 repository tolerance) for `codex-app-server-adapter.ts` and 2496
   (+50) for `instance-communication.ts`; current counts are 754 and 2545. Six fresh completion-gate
   rounds were run; every finding was remediated, and round six returned `VERDICT: PASS`.
7. **Verification.** Focused suites, application/spec typechecks, lint, the restored LOC ratchet,
   main and renderer production builds, and `git diff --check` pass. The final pinned-Node full suite
   passed 2,226 files / 26,526 tests (`_scratch/test-run.pid-61166.log`). Checks requiring the rebuilt
   app, real provider behaviour, or the 35-minute hibernation window were moved to
   `2026-09-24-codex-compaction-turn-visibility_livetest.md`.
8. **Packaging.** `npm run localbuild` completed under pinned Node 24.15.0, including native ABI
   rebuild/verification, all production bundles, signed arm64 packaging and DMG blockmap generation.
   `release/Harness-0.1.0-mac-arm64.dmg` was mounted, its signed app copied out, verified with
   `codesign --verify --deep --strict`, and passed the repository packaged-startup smoke from an
   isolated profile. James's installed/running Harness was not restarted.

---

## 5. Deferred live checks

The rebuilt-app, real-provider and 35-minute checks were moved to
[`2026-09-24-codex-compaction-turn-visibility_livetest.md`](2026-09-24-codex-compaction-turn-visibility_livetest.md).

---

## 6. Register and documentation lifecycle

- Add LT-654 (compaction turn invisible → idle → rejected sends / abandoned continuation / zombie
  cascade), LT-655 (UI shows errors, 0 %, and a recovery button for a normal compaction), LT-656
  (policy and compaction actions unlogged) to `docs/plans/livetest-remediation-register.md` in the
  existing format: index row, Observed behaviour (copy the §1 timelines), Root cause (§2), Required
  behaviour / acceptance, and a "Fix and acceptance evidence" section once done. If a fourth item
  is needed for the main-process sender audit (Phase 2), use LT-657.
- Keep this file `_plan.md` and untracked while working. When every phase is implemented and
  verified, add as-built notes per phase, rename to `_plan_completed.md`, and move any genuinely
  deferred checks into the `_livetest.md` first. Only then may it be staged.
- Update memory note `codex-compaction-signal-is-context-item.md` (in the Claude memory directory)
  with the outcome, or leave a pointer in the register.

---

## 7. Verification gates (all required before claiming completion)

```bash
npm run test:quiet -- src/main/cli/adapters/codex/compaction-signals.spec.ts src/main/cli/adapters/codex/context-cost-controller.spec.ts src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts src/main/cli/adapters/codex/app-server-thread-runtime.spec.ts src/renderer/app/core/state/instance/instance-messaging.store.spec.ts src/renderer/app/core/state/instance/messaging-retry-disposition.spec.ts
npx tsc --noEmit
npm run typecheck:spec
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run build:renderer
npm run test:quiet
```

Then: spawn a fresh agent with the `task-completion-gate` skill to review the merge-base-to-HEAD
diff plus the dirty tree against this plan; fix every actionable finding; repeat until
`VERDICT: PASS`. Then build the DMG (`npm run build` / the packaging runbook in
`docs/packaging-native-modules.md`), verify it launches, and tell James it is ready. Do not restart
his running Harness.

---

## 8. Appendix — evidence queries (re-runnable)

```bash
LOGS="$HOME/Library/Application Support/Harness/logs"
LEDGER="$HOME/Library/Application Support/Harness/conversation-ledger/conversation-ledger.db"

# Compact-turn rejections and the sends that caused them
grep -c 'ActiveTurnNotSteerable' "$LOGS/app.log"
grep -n 'xqhsuju06' "$LOGS/app.log" | grep -e SEND_INPUT -e 'Suppressing repeated error'

# Compaction frequency
grep -c 'Thread compacted by Codex app-server' "$LOGS/app.log"

# Adapter status/error/system events for an instance (read-only)
sqlite3 -readonly "$LEDGER" "select created_at, raw_source, substr(raw_json,1,300) from provider_event_captures where instance_id='xfbaestxb' and raw_source in ('adapter-event:status','adapter-event:complete') or (instance_id='xfbaestxb' and raw_json like '%\"type\":\"error\"%') order by created_at;"

# Codex status transitions (python one-liner over lifecycle.ndjson filtering provider=codex, eventType=status-transition)
```

Incident A capture rows: `provider_event_captures`, `instance_id='xqhsuju06'`, `created_at`
1790270425606 (complete) → 1790270427209 (sixth idle). Incident B: `instance_id='xfbaestxb'`,
`created_at` 1790178035724–1790178035729; `instance_id='xm9076fqy'`, 1790178076746–1790178076751.
