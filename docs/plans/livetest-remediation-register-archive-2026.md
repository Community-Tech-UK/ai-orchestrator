Agents do not read this archive unless a register index row points here.

# Live-Test Remediation Register Archive 2026

**Type: standing archive — historical detail, no plan/spec lifecycle.**

Current defect status belongs to the [register index](livetest-remediation-register.md#remediation-index).
Detail blocks below were moved verbatim from the register for closed entries only. An entry whose index row
still says a live check or acceptance is outstanding stays in the register with its full detail. The register
keeps each archived heading as a link stub pointing here, so existing links to it still resolve.

<a id="lt-010-archived-detail"></a>


## LT-010: Sync Handler Validates Against the Wrong Allowlist

**Priority P1. Found 2026-07-26 (confirms and root-causes the 2026-07-24 report).**

### Observed behavior

Against the live `windows-pc` worker, in the same minute:

- `sync_to_node → C:\Users\shutu\.orchestrator\_scratch\aio-transfers\aio-lt-sync` fails with
  `RPC error -32603: Path outside allowed roots`.
- `upload_to_node` writes to **that same path** successfully.

The node advertises that root as
`{id: "scratch", path: "C:\\Users\\shutu\\.orchestrator\\_scratch\\aio-transfers", read: true, write: true}`.

### Root cause

`src/worker-agent/worker-agent.ts:929` constructs the handler from the wrong list:

```ts
this.syncHandler = new SyncHandler(this.config.workingDirectories ?? []);
```

`SyncHandler.assertAllowed()` (`src/worker-agent/sync-handler.ts:29-33`) therefore validates against
`workingDirectories`, a different allowlist from the file-transfer roots that
`upload_to_node`/`download_from_node` use. `isPathAllowed()` itself
(`src/worker-agent/path-sandbox.ts`) is correct — it is handed the wrong roots. Proof: the identical
sync into a *working directory* path succeeds (`added: 2, totalBytesTransferred: 48`).

### Required behavior

Construct `SyncHandler` from the node's writable file-transfer roots so the sync and upload tools
share one allowlist, and read-only roots are refused **as read-only** rather than as
"outside allowed roots".

### Acceptance

Worker file-movement check 5 passes against the `aio-transfers` scratch root exactly as its recipe
is written, including the read-only-root refusal assertion.

<a id="lt-014-archived-detail"></a>


## LT-014: Restore Ladder Contract Conflict for an Alive-but-Unresumed Session

**Priority P2 — a decision, not yet a defect. Found 2026-07-27 (session 2).**

### Observed behavior

History-restore check 2 says a restore whose provider session no longer exists must show the
"could not be restored natively" notice, land on `restoreMode: replay-fallback`, and record
`nativeResumeFailedAt` so a second restore skips straight to fallback.

Driven live (transcript deleted, then restored) the app instead reports `resume-unconfirmed`, emits
no notice, and leaves `nativeResumeFailedAt: null`.

That is **deliberate**, not broken. When Claude finds no transcript it starts a fresh session under
the same id (the documented B7 behaviour) — so the process is alive, and
`history-restore-coordinator.ts` only demotes to `replay-fallback` when the instance is *dead*. Two
tests lock this on purpose, with the rationale in their own comments:

> `resume-unconfirmed` (not `replay-fallback`), because the instance is up and usable even without
> native resume confirmation … `markNativeResumeFailed` is NOT called — the instance is alive, just
> unconfirmed.

The migration plan likewise records "no change to ladder semantics".

So for Claude, `replay-fallback` is unreachable via a dead session, and **check 2 cannot pass as
written**. Reversing it was attempted during this session and correctly abandoned: it would have
silently overturned a documented design lock to satisfy a check's wording.

### Cost of the current semantics

`nativeResumeFailedAt` is never recorded for this case, so every later restore of that conversation
re-attempts the same doomed native resume. Before this session's change that cost the full
post-spawn window (5 s) on each restore; the probe now exits as soon as the adapter reports its
definitive answer, so the stall is gone, but the repeated attempt and the missing user-facing notice
remain.

### Required behavior

James's call, one of:

1. **Keep the semantics, rewrite check 2** to assert `resume-unconfirmed` + a queued continuity
   preamble, and note that `replay-fallback` is reachable only via a dead process or
   `forceFallback`.
2. **Change the semantics** so a definitively disproven resume demotes to the replay rung (notice +
   `nativeResumeFailedAt`), and update the B1/B2 locks and the migration plan's "no change to ladder
   semantics" statement to match.

### Decision — 2026-07-27 (James) — option 1's rung, option 2's bookkeeping

Neither as written. **The rung stays `resume-unconfirmed`; the notice and `nativeResumeFailedAt`
are emitted whenever the adapter *disproves* the resume.** A merely-unproven resume
(`proof === null`) stays silent and unblacklisted — absence of proof is not proof of absence.

Why not plain option 1: the user is never told the provider lost its native memory of the
conversation, when only the injected preamble carries it forward.

Why not plain option 2: demoting the rung runs `cleanupFailedNativeResume` → `terminateInstance`
and then a second `createInstance`, i.e. it kills a healthy process to respawn an identical one.
The live session already holds the archived transcript in its buffer and has the continuity
preamble queued, so the extra spawn buys nothing the user can observe.

Why acting on `disproven` is safe: for Claude it comes from `shouldUseNativeResume()`
(`claude-cli-adapter.ts:223-229`) → `nativeTranscriptExists()`, a filesystem check that tries both
the raw and `realpath`-resolved cwd encodings and **fails open**, returning `true` on any error
(`claude-transcript-registry.ts:44-51`). A `false` is therefore a deliberate high-confidence
negative, categorically unlike the cold-start stall that used to blacklist handles wrongly — that
path is already separated out as `infrastructure` and still does not blacklist. The respawn path
already treats `fresh-fallback` as a definite non-resume (`instance-lifecycle.ts:1055-1064`), so
this also removes a disagreement between two paths reading the same signal.

Accepted cost: `nativeResumeFailedAt` is permanent for the entry — once set,
`getNativeResumeSessionId` returns `undefined` for good (`history-restore-helpers.ts:53-58`), so an
entry later restored from a cwd where the transcript *does* exist stays downgraded. Judged
acceptable because the transcript is cwd-keyed anyway, and the guard is that only adapter proof
(`proof === false`), never the context-usage heuristic, can set it.

### Acceptance

Check 2 and the coordinator's tests assert the same contract, whichever is chosen, and the choice is
recorded in the migration plan rather than only in test comments.

**Status: implemented 2026-07-27.** `history-restore-coordinator.ts` emits the notice and calls
`recordNativeResumeFailure` on `ResumeWaitState.disproven`; the B1/B2 locks now assert the new
bookkeeping alongside the unchanged rung, plus a new lock that a merely-unproven resume stays
silent (17 tests green, history suite 92 green). Check 2 in the livetest doc is rewritten to match
and carries the decision rationale.

Deviation from the acceptance wording: the decision is recorded **here and in the livetest doc, not
in the migration plan**, because `2026-07-17-history-restore-reconciler-migration-plan_completed.md`
is `_completed` and committed — adding new scope to a `_completed` file is forbidden. Its stale "no
change to ladder semantics" line is superseded by this entry.

Still open: a live re-run of check 2 against a rebuilt app.

<a id="lt-015-archived-detail"></a>

## LT-015: Runtime-Change System Notices Are Model-Only, Never Rendered

**Priority P2. Found 2026-07-27 (session 2).**

### Observed behavior

YOLO checks 1, 2 and 4 all assert the transcript *shows*
`[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]` (and, for
check 4, the model-change notice too). It never appears.

Measured on the real renderer, not the main-process buffer: after a yolo toggle applied on settle,
`app-output-stream`'s own `messages()` held 5 messages and **none** contained the notice, and
`el.textContent` did not contain `tool permissions are now pre-configured`.

The notice *is* delivered — asked "did you receive a message containing the words 'YOLO mode
enabled'?", the session answered **YES** — and after the combined change of check 4 the model
volunteered "model switched to Sonnet and YOLO mode is off, so tool calls will need your approval".
So both notices arrive at the CLI and neither reaches the user.

Beware a false positive here: a naive `textContent` search for "YOLO mode enabled" matches, because
the *probe question* contains that phrase. Match the full notice text.

### Root cause

`runtime-reconciler.ts` emits these notices with `adapter.sendInput(...)`, which writes straight to
the CLI. Only `InstanceCommunication.sendInput` records a visible message into `outputBuffer`, so
nothing is ever queued for display.

### Required behavior

James's call:

1. **Render them** — surface the notices as system messages in the transcript, which is what all
   three checks describe and what makes a permission-posture change visible after the fact; or
2. **Keep them model-only** and rewrite checks 1, 2 and 4 to assert the observable state instead
   (the header's YOLO indicator, `yoloPending()`, `desiredRuntimeLabel()`), recording that the
   notices are deliberately model-directed control messages.

### Acceptance

The yolo live test and the runtime-reconciler agree on where these notices are observable, and
checks 1, 2 and 4 can be judged without inspecting CLI-side state.

### Knock-on

The 2026-07-27 session-1 PASS for check 1 did not evidence its notice sub-assertion. Check 1 is
therefore **partial**, not clean, until this is settled — its session-continuity substance
(native-resume fork, context survival) genuinely does pass.

<a id="lt-016-archived-detail"></a>


## LT-016: Unpinned cross-provider swap reports a false "model no longer available"

**Found:** 2026-07-29, driving the provider/model-swap live checks in the dev app.

### Observed behavior

Swapping an existing session to another provider **without pinning a model** — the picker's
"click the provider tab row" path, and the documented `changeModel(id, undefined, …, provider)`
call — puts a notice like this in the transcript:

```
system  Model "opus[1m]" is no longer available for codex. Using "gpt-5.6-sol" instead.
        The saved selection was left unchanged.
system  Model "opus[1m]" is no longer available for antigravity. Using the provider default
        instead. The saved selection was left unchanged.
```

Reproduced on two different target providers in one session, with `defaultModelByProvider` empty.

### Root cause

`resolveSwapModel` (`src/main/instance/lifecycle/model-change-provider-swap.ts:112-125`) delegates
to `resolveInitialModel` (`src/main/instance/lifecycle/resolve-initial-model.ts:30-36`), whose
precedence is:

```
configModelOverride || agentModelOverride || perProvider || defaultModel || undefined
```

`defaultModel` is the **legacy global** default — here `opus[1m]`, a Claude model. When
`defaultModelByProvider[target]` is unset, that Claude model id is handed to Codex/Antigravity as
the requested model. Downstream provider validation correctly rejects it and degrades to the
provider default, and the degradation path then reports the rejection to the user.

So the mechanism is working exactly as designed and the *outcome* is right — the session lands on
a sensible model. Only the message is wrong.

### Required behavior

An unpinned swap must not surface a degradation notice attributable to a model the user never
chose for that provider. Either skip the global `defaultModel` rung when it belongs to a different
provider, or suppress the notice when the rejected id came from the global fallback rather than
from an explicit request or a remembered per-provider value.

The genuine case must keep working: a *pinned* model, or a stale remembered
`defaultModelByProvider[target]`, that the provider no longer knows should still produce the
existing notice — that is check 5's subject and it passes today.

### Required regression coverage

- Unpinned swap with `defaultModelByProvider` empty and a foreign-provider global `defaultModel`
  emits **no** degradation notice, and still lands on the target provider's default.
- Unpinned swap with a stale `defaultModelByProvider[target]` **does** emit the notice.
- Explicitly pinned unknown model still emits the notice (unchanged).

### Priority rationale

P2, not higher: no session is lost, no context is lost, and the landed model is correct. It is a
trust problem — the app reports a failure that did not happen, on a routine action.

<a id="lt-017-archived-detail"></a>


## LT-017: Manual Codex compaction stalls 30 s, then silently restarts the thread

**Found:** 2026-07-29, running context-cost-governor check 1. **Reproduced twice.**

### Observed behavior

Pressing compact on a live Codex instance:

```
compaction-rpc  stage:"requested"
compaction-rpc  stage:"accepted"          ← 1–4 ms later
        … 30 000 ms of nothing …
"Context compaction was acknowledged but not observed" {timeoutMs:30000, outcome:"timed-out"}
"restart-with-summary compaction completed" {reductionRatio:0}
```

`compaction-observed` never arrives from the installed Codex app-server build. The IPC then answers
`{success: true, method: "restart-with-summary"}` after **36.8 s** and **40.1 s** on two runs, the
provider session id changes each time (`019fae5f` → `019fae60` → `019fae62`, `adapterGeneration`
1 → 2 → 3), and the original prompt is replayed inside a `[Context Compaction Continuity Package]`.

The user-visible transcript says `— Context compacted —`, and the context indicator drops to 0 %
with `source: "post-compaction-reset", isEstimated: true` while `cumulativeTokens` is unchanged.

### Root cause

Two separate things, and they should be judged separately:

1. **The 30 s dead wait** is unconditional. `compactContext()`
   (`src/main/cli/adapters/codex/context-cost-controller.ts:92-105`) waits the full
   `compactionTimeoutMs` before conceding. Since this Codex build never emits `thread/compacted`,
   *every* manual compaction pays 30 s of nothing before any work starts.
2. **The silent fallback** is deliberate:
   `src/main/context/compaction-coordinator.ts:440-452` tries native, and on failure runs
   `restartCompactStrategy` and reports the combined outcome as `success: true`. The caller cannot
   tell that the native path failed.

Note the automatic governor path already behaves the way the live test specifies —
`recoverAfterTurn` (`context-cost-controller.ts:125-129`) pauses with `compaction-unobserved` and
preserves the conversation. Only the manual path diverges.

### Required behavior

Split by concern:

- **The stall must go.** Either detect that the connected app-server does not support/emit
  `thread/compacted` and skip the native attempt, or cut the timeout to something proportionate and
  cache the negative result for the session. 30 s per press with a `reductionRatio: 0` outcome is
  not acceptable regardless of which fallback policy wins.
- **The fallback needs a decision.** Either (a) honour the documented contract — report failure,
  keep the thread, no restart, no prompt replay; or (b) keep restart-with-summary but report it
  honestly (`method` surfaced to the user, the native failure not hidden behind `success: true`) and
  update check 1 and check 3's wording to match. Option (b) is defensible — the user did ask to free
  context and it was freed — but it must not keep claiming the native contract.
- `reductionRatio: 0` reported alongside `success: true` should be investigated as part of either
  option; a compaction that reduced nothing is not obviously a success.
- The post-compaction `0 %` indicator is an estimate, not a measurement, and should not be presented
  as a real reading while the new thread carries a replayed continuity package.

### Required regression coverage

- Native compaction times out → the manual IPC result distinguishes "native failed, restarted"
  from "native succeeded".
- A build that does emit `thread/compacted` still takes the native path and does **not** restart the
  thread or change the session id.
- The 30 s wait is not paid twice in one session once the provider is known not to support it.

### Priority rationale

P1, not P0: no conversation is lost — the continuity package carries the objective across, and
context genuinely is freed. But it is slow enough to look broken, it changes the provider session id
behind the user's back on a routine action, and it reports a success the code knows is a fallback.

<a id="lt-020-archived-detail"></a>


## LT-020: A queued provider/model swap kills the loop iteration it lands on

**Priority P1. Found 2026-07-31 while running provider/model-swap live check 4 ("swap during a
loop") in the dev app over CDP against a real Claude loop.**

### Observed behavior

Requesting a provider swap on an instance that is running a loop queues correctly and does not
interrupt anything immediately — and then, when it applies, it **SIGTERMs the CLI the loop is
mid-iteration on**, and the loop dies.

Reproduced 2 of 2 attempts (loop runs `loop-1785524137007-fa601033` seq 0 and
`loop-1785524685187-2979a0e1` seq 1). The exact sequence from the second run:

```
19:07:27.811 RuntimeReconciler  Applying runtime change
                                { instanceId: 'csu9nxitx', oldProvider: 'claude',
                                  targetProvider: 'codex', adapterExists: true }
19:07:28.182 DefaultInvokers    Loop iteration invocation failed (classified)
                                { reason: 'process_exit', retryable: false }
19:07:28.182 DefaultInvokers    Loop iteration invocation failed
                                Error: Claude CLI exited with code 143      ← 128 + SIGTERM
19:07:28.183 LoopCoordinator    Iteration invocation failed { seq: 1, attempt: 0 }
19:07:28.186 LoopCoordinator    Loop terminated { status: 'completed-needs-review',
     reason: 'Iteration 1 paused for review instead of an automatic replay: Degraded iteration
     (invocation-error) with UNPROVABLE workspace state — Git observation failed … Automatic
     replay is unsafe without proof of no side effects; paused for review.' }
```

371 ms from the reconciler applying the change to the iteration dying. A control run with no swap
(`loop-1785523468791-aa48d25c`) iterated cleanly to `capReached` over 7 iterations, so the loop
itself is healthy — the swap is what kills it.

Two further observations from the same runs:

- The instance ends up on the new provider (`codex`, `adapterGeneration` 1 → 2), but the loop's own
  `config.provider` stays `claude`. So even a surviving loop would not "continue on the new
  provider" as the check expects; the next iteration would fail
  `canBorrowParentLoopAdapter('claude', 'codex')` and silently spawn its own separate Claude adapter.
- The invoker's error record carries `instanceId: undefined`, so the failure is not attributed back
  to the instance whose swap caused it.

### Root cause

`registerDefaultLoopInvoker` (`default-invokers.ts:1226-1239`) **borrows the instance's live
adapter** for `contextStrategy: 'same-session'` loops (`borrowedFromInstance = true`,
`instanceId: p.chatId` at `:1327`). The instance is therefore the loop's execution runtime, not just
its owner.

The desired-runtime queue applies a queued change as soon as the *instance* looks settled. It has no
knowledge of the borrow, so "settled" can be true in the gap between the CLI turn ending and the
loop coordinator starting the next iteration — or, as here, while the borrowed adapter is still
mid-iteration. `RuntimeReconciler` then tears that adapter down and respawns it, which the loop sees
as an unexplained `process_exit`.

The `retryable: false` classification is correct in isolation (a SIGTERM'd child with unknown
workspace effects must not be auto-replayed), which is why the loop terminates rather than retrying.

### Required behavior

- A runtime change queued against an instance whose adapter is currently borrowed by a live loop
  iteration must not apply until that iteration has genuinely completed. "Instance status is idle"
  is not sufficient evidence of an iteration boundary.
- When the change does apply, the loop's own `config.provider`/model must move with it, or the swap
  must be refused with a clear reason — silently leaving the loop configured for the old provider is
  not acceptable, because it makes the next iteration spawn a second, invisible CLI.
- A loop iteration that dies because Harness itself tore the adapter down must be attributed
  (`instanceId` populated) and must not be reported to the user as an unexplained degraded
  iteration.

### Required regression coverage

- A queued runtime change is deferred while a borrowed adapter has an in-flight loop iteration, and
  applies at the real iteration boundary.
- Applying a provider swap to a loop-bearing instance updates the loop's configured provider (or
  refuses), asserted on `LoopState.config.provider`.
- An adapter teardown caused by a runtime change is classified distinctly from a provider crash.

### Acceptance

Re-run provider/model-swap live check 4: start a multi-iteration loop on an instance, request a
cross-provider swap mid-iteration, and observe the running iteration complete normally, the swap
apply at the boundary, and the loop continue on the new provider.

<a id="lt-021-archived-detail"></a>


## LT-021: Loop tool activity never reaches the renderer — 8 of 11 activity kinds are dropped

**Priority P2. Found 2026-07-31 while running provider/model-swap live check 4; visible as 110
blocked renderer events in a single campaign session.**

### Observed behavior

Every loop iteration floods the main process log with:

```
[WARN] [RendererEventValidation] Blocked invalid renderer event payload {
  channel: 'loop:activity',
  issues: [ { path: 'kind',
              message: 'Invalid option: expected one of "status"|"error"|"input_required"' } ] }
```

110 occurrences during this session's loop runs. The events are dropped at the IPC boundary, so the
loop activity feed the user watches while a loop runs receives no tool calls, no tool results, no
assistant chunks and no completion signal — only the occasional `status` line.

### Root cause

`LoopInvocationActivityKind` (`loop-invocation-activity.ts:14-25`) has eleven members:
`spawned`, `status`, `tool_use`, `tool_result`, `assistant`, `system`, `input_required`, `error`,
`stream-idle`, `complete`, `heartbeat`.

`emitActivity` in `default-invokers.ts:1183-1195` spreads the whole activity (`...activity`) onto the
`loop:activity` event, so all eleven kinds go out. `loop-handlers.ts:226` forwards them verbatim.

But the renderer-boundary schema `LoopActivityEventSchema`
(`packages/contracts/src/schemas/loop-events.schemas.ts:48`) declares
`kind: z.enum(['status', 'error', 'input_required'])`. The eight other kinds fail validation and are
blocked. `loop.store.ts:180` → `addActivity` therefore never sees them.

The schema is the stale side: it was written for the three kinds the coordinator emits directly and
never extended when the invoker began forwarding its adapter-level activity vocabulary.

### Required behavior

- The renderer-boundary schema accepts every kind the main process actually emits, so the loop
  activity feed shows tool calls and results while a loop runs.
- Any kind added to `LoopInvocationActivityKind` in future fails a test rather than being silently
  dropped at runtime.

### Required regression coverage

- A test asserting the schema's accepted `kind` set equals `LoopInvocationActivityKind`, so the two
  cannot drift again.
- `LoopActivityEventSchema` parses a representative `tool_use` and `tool_result` payload.

### Acceptance

Run a loop and observe tool activity in the renderer's loop activity feed, with zero
`Blocked invalid renderer event payload` warnings for `loop:activity` in the log.

<a id="lt-023-archived-detail"></a>


## LT-023: Two rapid CLI crashes leave the session dead, silently

**Priority P2. Found 2026-07-26, reproduced 2026-07-31 on the current build while running
unexpected-exit check 4.**

### Observed behavior

Conversation-bearing Claude instance `cg4ds8wvy`. Two `kill -9`s 1.1 s apart:

```
01:17:11.376 InterruptRespawn      Auto-respawn successful { pid: 56023, resumed: true }
01:17:12.501 InstanceCommunication Adapter exit event { signal: 'SIGKILL' }
01:17:12.501 InstanceCommunication Suppressing auto-respawn: another respawn completed very
                                   recently { msSinceLastRespawn: 1124 }
```

Instance state, sampled every 300 ms throughout:

```
0s idle|wr=-|g2|rc1
0s respawning|wr=-|g3|rc2      ← first kill recovers cleanly
1s idle|wr=-|g3|rc2
2s error|wr=-|g3|rc2           ← second kill: suppressed, and that is the end
```

- The anti-storm suppression works and is right to exist.
- But **nothing retries afterwards.** The session sits in `error` indefinitely; the user must
  restart it manually.
- **`waitReason` is never set** (`wr=-` at every sample). The check expects a backoff chip
  explaining the wait; there is no chip and no explanation of any kind.
- The circuit breaker's backoff never engages here — suppression fires first, so the
  `BACKOFF_SCHEDULE_MS` ladder (`respawn-circuit-breaker.ts:24`) is bypassed entirely on this path.

### Required behavior

A suppressed respawn must not be a terminal outcome. Either schedule a retry after the suppression
window (routing through the circuit breaker's backoff, which is what the ladder is for), or set a
`waitReason` the UI can render so the user knows why the session stopped and what to do. Silently
terminal is the one option that should be off the table.

### Required regression coverage

- A second unexpected exit inside the suppression window leaves the instance with a retry scheduled
  or a `waitReason` set — never `error` with neither.
- The backoff ladder is exercised on the rapid-crash path, not only on the slower one.

### Acceptance

Re-run unexpected-exit check 4: three kills in quick succession, and observe a backoff indication in
the UI plus eventual recovery.

### Related observation (not filed separately)

A **fresh instance that has never received a message** (`cwjg2v6uh`) went straight to `error` on its
first kill with **no auto-respawn attempt logged at all** — unlike conversation-bearing instances,
which always respawned. Plausibly deliberate (nothing to recover), but it means "kill a brand-new
session" and "kill a working session" behave completely differently, which is worth confirming is
intended.

### Fix — 2026-08-12 — deferred and retried instead of left terminal, verified live

**Root cause confirmed by reading the executing path**, not the filed hypothesis alone (the filed
diagnosis above turned out to be accurate on inspection): `instance-communication.ts`'s `exit`
handler computed `withinRecentRespawnWindow` and folded it directly into `canAutoRespawn`
(`!withinRecentRespawnWindow && …`). When a second crash landed inside the 5s window,
`canAutoRespawn` was `false`, so the code fell straight to the terminal branch (`newStatus = 'error'`)
**without ever calling `deps.onUnexpectedExit`** — meaning `respawnAfterUnexpectedExit` and the
circuit breaker inside it (`respawn-circuit-breaker.ts`) were never invoked at all for that exit.
`waitReason` is a renderer-only concept (never written onto the main-process `Instance` object;
only carried through the `queueUpdate` → `instance:batch-update` IPC stream), so with no call into
the respawn path there was nothing to carry it and no further attempt was ever scheduled.

**Fix.** A second eligibility check (`wouldAutoRespawnIfNotRecent`, the same conditions as
`canAutoRespawn` minus the recent-window term) now gates a new deferred-retry branch: when a crash
is suppressed only because it landed inside the recent-respawn window, the instance transitions to
`respawning`, restartCount increments, a `{ kind: 'backoff', attempt, retryAt }` waitReason is
queued immediately, and a `setTimeout` for the remaining window retries through the exact same
`deps.onUnexpectedExit` path once it elapses — so the crash is deferred rather than abandoned, and
the circuit breaker's own ladder is always reached (never bypassed) on repeated crashes. Aborts
quietly (no retry fired) if the instance moved on — terminated, manually restarted, or already
recovering another way — before the timer fires. Extracted into
`src/main/instance/instance-communication-recent-respawn-retry.ts` (`scheduleSuppressedAutoRespawnRetry`)
to keep `instance-communication.ts` inside its LOC ceiling (raised 2622 → 2696 in
`scripts/check-ts-max-loc.ts` to account for this plus other concurrent same-cycle work already in
that file).

**Regression tests** (`src/main/instance/instance-communication.spec.ts`, describe block
`LT-023: a suppressed respawn defers and retries instead of dying silently`, 3 tests): a suppressed
exit defers into `respawning` + a `backoff` waitReason instead of `error`, and the deferred
`onUnexpectedExit` call actually fires once the window elapses; the deferred retry does **not** fire
if the instance moved on (e.g. terminated) before the timer; the restart-count cap (5) is still
respected and still terminates immediately even inside the suppression window (unchanged safety
behavior). Mutation-verified: reverted the fix, watched the first two tests fail with the exact
expected assertion (`'error'` instead of `'respawning'`), restored, watched all 3 pass again.

**Live verification** — dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-lt023`, CDP :9467, renderer
reused from :4567), a real conversation-bearing Claude instance, kills gated on pid-absent-from-
pre-run-snapshot + `ppid` matching this dev app's Electron main + command-line match:

- **Deferred retry, not terminal.** A second `kill -9` landing 3.3s after the first respawn (well
  inside the 5s window) produced, in the main log: `Suppressing auto-respawn: another respawn
  completed very recently { msSinceLastRespawn: 3301 }` → `Deferring auto-respawn until the
  recent-respawn suppression window elapses { remainingSuppressMs: 1699 }` → `Retrying auto-respawn
  after recent-respawn suppression window elapsed` → `Recovery respawn complete { pid: 80222 }`.
  Before the fix this exact sequence stopped after the "Suppressing" line and the instance stayed in
  `error` forever.
- **`backoff` waitReason chip data reaches the renderer.** Captured the real
  `instance:batch-update` IPC stream (`electronAPI.onBatchUpdate`) across a second within-window
  double-kill: `{"status":"respawning","waitReason":{"kind":"backoff","attempt":2,"retryAt":...}}`
  arrived ~46ms after the suppressed kill, followed by the deferred retry's own `respawning`
  waitReason, then `idle`/`null` on recovery. The renderer already has display code for this exact
  shape (`input-panel-formatters.ts:61` — `"Held — backing off (attempt N)"`;
  `instance-header.component.ts:111,143`), so the chip data now actually reaches it on this path
  where it never did before.
- **The circuit breaker's own ladder, once always-reached, produces the expected increasing
  delays.** A run of 4 cumulative crashes on one instance (spaced tens of seconds apart, each still
  within the breaker's 1-hour reset window) showed `RespawnCircuitBreaker: Circuit breaker backing
  off before respawn { attempt: 3, delayMs: 10000 }` then `{ attempt: 4, delayMs: 30000 }` — both
  recovered successfully after their full wait (confirmed live, not inferred).
- **Recovery still eventually succeeds** in every case observed, including after a 10s
  circuit-breaker wait. **No unbounded respawn storm** — the anti-storm suppression continues to
  work exactly as before; it now defers instead of dead-ending.

Gates: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
`npm run check:ts-max-loc`, `npm run build:main`, targeted
`npm run test:quiet -- src/main/instance/instance-communication.spec.ts` (95/95) — all green.

<a id="lt-024-archived-detail"></a>


## LT-024: Zod's `$schema` key made every Claude-reviewer review fail

**Priority P1. Found 2026-07-31 running WS14 check 10. FIXED and verified the same session.**

### Observed behavior

Every cross-model review with Claude as the reviewer died immediately:

```
[CrossModelReviewService] Cross-model review reviewers selected { selected: ['claude'] }
Error: --json-schema is not a valid JSON Schema: no schema with key or ref
       "https://json-schema.org/draft/2020-12/schema"
[CrossModelReviewService] Review failed { cliType: 'claude', error: 'Claude CLI exited with code 1' }
```

### Root cause

`serializeReviewResultJsonSchema` (`src/shared/validation/cross-model-review-schemas.ts:73`)
returned `JSON.stringify(z.toJSONSchema(schema))`. Zod 4 includes a top-level
`"$schema": "https://json-schema.org/draft/2020-12/schema"`, and the installed Claude CLI's
validator cannot resolve that dialect ref and rejects the **entire** document.

Confirmed by direct A/B against the CLI, not by inference:

```
$ claude --print --json-schema '<schema WITH $schema>'    → Error: not a valid JSON Schema
$ claude --print --json-schema '<same schema, $schema removed>'  → {"verdict":"OK"}
```

### Fix

Strip the dialect key before serializing. It describes which JSON-Schema dialect the document is
written in; it is not part of the contract being expressed, so the reviewer loses nothing.
Regression test asserts its absence for both review depths — the absence *is* the wire contract.

### Verified

Rebuilt and re-ran check 10 live: the `not a valid JSON Schema` error and the exit-1 failure are
both gone, and the reviewer now runs. A direct CLI run with the **real** 1,596-byte review schema
returns a complete, schema-conformant verdict object.

<a id="lt-025-archived-detail"></a>


## LT-025: The in-app Claude reviewer returns an empty response

**Priority P1. Found 2026-07-31 immediately after LT-024 was fixed.**

### Observed behavior

With the schema now accepted, the reviewer still produces nothing:

```
01:26:33.780 Cross-model review reviewers selected { selected: ['claude'], configured: ['claude'] }
01:26:45.835 WARN Failed to extract JSON from review response
                  { reviewerId: 'claude', responseLength: 0, responsePreview: '' }
01:26:45.835 INFO Reviewer response failed validation — attempting one format-repair retry
01:26:56.641 WARN Failed to extract JSON from review response  { responseLength: 0 }
01:26:56.641 WARN Reviewer format-repair response also failed validation
```

Both attempts return **zero bytes**, in ~12 s and ~11 s. That is not a timeout: the review budget
was deliberately raised from 30 s to 120 s for this run and the empty responses came back just as
fast. (At the default 30 s the run *also* trips `Review exceeded its operation deadline`, but that
is a consequence of burning the budget on two empty attempts, not the cause.)

### The control that makes this app-side

The same schema and an equivalent prompt, run **directly** against the same CLI binary, return a
full valid verdict — every section populated, `overall_verdict: "CONCERNS"`, schema-conformant:

```
$ claude --print --json-schema "$(cat /tmp/real-schema.json)" \
    'Review this code and return the verdict object: function divide(a,b){return a/b}'
{"correctness":{"reasoning":"…","score":2,"issues":[…]},…,"overall_verdict":"CONCERNS","summary":"…"}
```

So the CLI, the schema and the model are all fine. Something in the app's reviewer dispatch is
losing the response.

### Where to look first

The reviewer one-shot goes through the normal Claude adapter, which parses
`--output-format stream-json` events. With `--json-schema` the CLI emits the structured object, and
the suspicion is that the adapter's stream parser never surfaces it as `content` — hence
`responseLength: 0` rather than an error. Two nearby log lines from the same window are worth
checking as part of this: `Skipping --session-id: id already in use by an unreachable transcript`
and `Falling back to SIGINT interrupt (process not resident)` on the reviewer spawn.

### Required behavior

A reviewer one-shot that the CLI answers must reach the parser with its content intact. If the
response genuinely cannot be read, that must be reported as a dispatch failure — not as an empty
response that silently burns the format-repair retry and the review budget.

### Acceptance

Re-run WS14 check 10: a Claude-reviewed cross-model review parses **first try**, with no
`format-repair retry` line.

### Root cause and fix (2026-07-31)

Reproduced the adapter's exact spawn against the CLI —
`--print --output-format stream-json --input-format stream-json --verbose --json-schema <schema>` —
and the answer is unambiguous. In stream-json mode the verdict is **not** assistant text; it arrives
as a tool call:

```json
{"type":"assistant","message":{"content":[
  {"type":"tool_use","name":"StructuredOutput","input":{ …the full verdict object… }}]}}
```

`ClaudeCliAdapter.parseOutput` routes `text` blocks to `content` and `tool_use` blocks to
`toolCalls`. A reply that is *only* a structured answer — precisely what `--json-schema` requests —
therefore yielded `content: ''`, which the reviewer saw as `responseLength: 0`.

Fixed by preferring the `StructuredOutput` payload as the response content
(`structured-output-content.ts`, applied at `claude-cli-adapter.ts` `parseOutput`), falling back to
text when no structured payload is present.

**Verified live:** WS14 check 10 re-run after rebuild →
`Review completed { cliType: 'claude', durationMs: 20470, repaired: false }`, with **0**
format-repair retries, **0** empty responses and **0** schema rejections in the whole run, and a
real review result delivered to the renderer.

### Follow-up found while gating the fix (2026-07-31)

Two things the review surfaced that the first fix got wrong, both now corrected and covered:

- **Take the LAST `StructuredOutput` call, not the first.** The CLI validates each call and, on a
  schema mismatch, returns an error tool_result and lets the model retry — so one turn can contain a
  **rejected** payload followed by the accepted one. This is reachable, not theoretical: the CLI's
  strict-conversion allowlist has no `minimum`/`maxLength`/`maxItems`, so these schemas fall back to
  non-strict and the model is not prevented from emitting an invalid first attempt. Returning the
  first payload hands back the one the CLI already refused, which then fails the reviewer's Zod parse
  — the same symptom class as the original defect.
- **Ignore subagent payloads.** Subagent assistant messages are streamed into the same top-level
  NDJSON tagged with `parent_tool_use_id`. Without filtering, a subagent's structured output could
  replace the parent turn's real answer — reproduced against the real `parseOutput`.

**Separately, worth its own decision (not fixed here):** `ProviderRuntimeService.shouldUseSpawnWorker`
routes Claude one-shots through `CliAdapterWorkerProxy` when `enableSpawnWorkerOffload` is on
(default `false`). That path never passes `--json-schema`, and its `parseWorkerOutput` drops
`tool_use` blocks entirely — so with the offload enabled, cross-model reviews silently degrade to
prompt-steered JSON and neither LT-024 nor LT-025 applies. It is off by default, so nothing is broken
today, but the two paths should not diverge silently.

### LT-016 create-path fix — a deliberate trade, recorded

One case is now quieter than before and it should be a conscious choice, not an accident: if the
global `defaultModel` is rejected by the provider it was actually chosen for — e.g. a Claude id that
later leaves the catalog, on a Claude session — the user gets a different model with no transcript
notice. The "you never chose it for this provider" rationale does not hold there. It is consistent
with the swap-path contract shipped on 2026-07-30, and the model badge still shows the real model,
so it is left as-is. Flagging it so it is not rediscovered as a bug.

Also note `modelSource` describes the model as *resolved*, before tier expansion: if a tier was
expanded, `degradation.requestedModel` is the expanded provider-native id while `modelSource` still
names where the tier came from. A tier cannot become the global default through the settings UI
(its options are concrete ids), so this only matters for a hand-set `defaultModel`.

<a id="lt-026-archived-detail"></a>


## LT-026: Hardened mode killed every session it was enabled on

**Priority P1. Found 2026-07-31 running WS13 check 2. FIXED and verified live the same session.**

### Observed behavior

Creating an instance with `hardened: true` spawned under Seatbelt and then died immediately:

```
[BaseCliAdapter]        Spawning CLI under Seatbelt hardened mode { writableRootCount: 8 }
[InstanceLifecycle]     CLI spawned successfully { pid: 25139 }
   … 0.5 s later …
[InstanceCommunication] Adapter exit event { code: 1, signal: null }
[InstanceCommunication] Instance exited unexpectedly { newStatus: 'error' }
```

The instance never reached idle. Hardened mode — the entire WS13 feature — was unusable.

### Root cause

Reproduced outside the app by building the exact same `sandbox-exec` invocation and running the real
Claude CLI under it:

```
$ sandbox-exec -p <base policy> -D WRITABLE_ROOT_0=… /Users/suas/.local/bin/claude --print …
Not logged in · Please run /login          ← exit 1
```

The CLI's credentials are in the **login keychain** (`security find-generic-password -s "Claude
Code-credentials"` resolves), and reading the keychain is a **mach-lookup to securityd**, not a file
read. `resources/sandbox/aio-seatbelt-base.sbpl` granted `mach-lookup` for opendirectoryd,
PowerManagement and cfprefsd — but not securityd. So the jailed CLI could not reach its own
credentials.

This was an oversight rather than a design choice: the policy's own composition contract says read
access is broad in Phase A precisely because *"CLIs need configs, keychains"*.

### Fix

Added the securityd/SecurityServer mach-lookup allowance to the base policy. Proven decisive before
and after, by A/B on the identical jailed invocation:

| Policy | Result |
| --- | --- |
| as shipped | `Not logged in · Please run /login`, **exit 1** |
| + securityd mach-lookup | `OK`, **exit 0** |

And in the app after a rebuild: a hardened Claude instance now spawns to **`status: idle`** with a
live pid, where it previously went straight to `error`.

Guarded by a test asserting the shipped policy carries the allowance.

<a id="lt-027-archived-detail"></a>


## LT-027: Seatbelt writable roots granted nothing (symlinked prefixes)

**Priority P1. Found 2026-07-31 running WS13 check 2, immediately after LT-026. FIXED and verified
live the same session.**

### Observed behavior

With the keychain fix in place, a hardened instance still died at spawn:

```
EPERM: operation not permitted, mkdir '/var/folders/…/T/aio-claude-tmp/…'
```

…even though the system temp dir is one of the eight roots `defaultHardenedWritableRoots` declares.

### Root cause

Seatbelt matches `(subpath (param "WRITABLE_ROOT_n"))` against the **real** path. On macOS the two
most important roots are symlinks:

```
/tmp                  → /private/tmp
os.tmpdir()           → /private/var/folders/…/T
```

`buildSeatbeltCommand` used `path.resolve()`, which normalises but does **not** follow symlinks — so
the granted subpath never matched the path the process actually touched. Measured with a jailed
`mkdir`, changing only the root:

| Writable root | Result |
| --- | --- |
| `os.tmpdir()` (unresolved) | `Operation not permitted` |
| `fs.realpathSync(os.tmpdir())` | exit 0 |

Practical blast radius: the temp root never worked for anyone, and **any workspace under `/tmp`**
never worked either — which is most disposable test workspaces.

### Fix

`realpathForSandbox()` resolves each root through symlinks before it becomes a `-D` parameter, and
passes a non-existent root through unchanged (it may be created inside the jail; dropping it would
fail closed for the wrong reason). Two regression tests pin both behaviours.

### Verified

After the fix a hardened Claude instance reaches `idle` and completes write / read / shell in one
turn, while a write outside the roots still fails `EPERM` and the file never appears.

<a id="lt-030-archived-detail"></a>


## LT-030: A swap on a looping session cannot deliver its own notices

**Priority P1. Found 2026-08-01 while implementing the LT-020 provider-divergence decision.
Partially mitigated; the root cause needs an ownership handshake and is NOT fixed.**

### Observed behavior

Swapping a loop-bearing session claude → codex, with the loop still running:

```
10:30:23  RuntimeReconciler       Runtime change applied { provider: 'codex', continuity: 'replay' }
   … 10 s of nothing …
10:30:34  RuntimeChangeNotices    CLI did not accept a post-change message in time; continuing
                                  { what: 'replay-continuity', timeoutMs: 10000 }
10:30:34  RuntimeReconciler       Failed to apply runtime change
                                  CodexAppServerRuntimeError: Codex app-server runtime already has
                                  an active turn
```

Consequences, all observed:

- **No provider-change notice reaches the user at all** on this path — LT-015's guarantee is silently
  void whenever a loop is running.
- The reconciler's catch **reverts** the swap (`instance.provider = oldProvider`) after it had
  already been applied and logged, leaving instance state and adapter state disagreeing.
- Before the timeout mitigation below, `applyRuntimeChange` never resolved at all — a dangling
  promise per swap, with no error surfaced anywhere.

### Root cause

`applyRuntimeChange` finishes the respawn and *then* talks to the adapter — first the
replay-continuity message, then each runtime-change notice. But LT-020's loan is released at the end
of an iteration, and the loop starts its **next** iteration during the swap. By the time the
reconciler tries to send, the loop owns an active turn on that adapter, so every send either hangs or
is refused.

The loan solved "don't tear down an adapter mid-iteration". It does not solve "don't let the loop
take the adapter back while the swap is still finishing".

### Fix (2026-08-01) — three parts, because there were three causes

1. **Render before deliver.** `announceRuntimeChangeSet` writes every transcript entry *first*, then
   delivers. The user-visible half no longer depends on a send that may never complete.
2. **A reciprocal interlock.** The LT-020 loan stopped the reconciler tearing down an adapter
   mid-iteration; `beginRuntimeChange` / `waitForRuntimeChange` stop a loop *taking it back* while
   the reconciler is still delivering. The claim is held across the whole post-change sequence and
   released before the session mutex, so a waiting loop wakes into a settled instance. Bounded
   (30 s): a stuck reconciler degrades to the old behaviour rather than stalling the loop.
3. **One delivery, not several — this was the real root cause.** Even with the loop waiting, the
   sends still collided *with each other*: on Codex, `sendInput` starts a real model turn, so the
   replay-continuity message put the runtime into an active turn and the notices that followed were
   refused with `already has an active turn`. The replay preamble and every notice now ride in a
   single message.

### Verified live

Real Claude loop, mid-iteration swap to Codex:

| | Before | After |
| --- | --- | --- |
| `provider-changed` notice in transcript | absent | **present** |
| `loop-provider-divergence` notice | absent | **present** |
| `already has an active turn` refusals | 1 | **0** |
| `Failed to apply runtime change` (revert) | 1 | **0** |
| loop CLI SIGTERM kills | 0 | **0** |
| loop waited for the change | n/a | **1** (interlock working) |

The one remaining bounded timeout is expected and harmless: the combined message starts a genuine
model turn, which takes longer than the 10 s acceptance budget. Nothing reverts and nothing collides.

### Knock-on — resolved

**LT-020's second-half decision now takes effect.** The live transcript carries:

> *[System: This session is now on codex, but the loop running on it stays on claude — a loop keeps
> the provider it was started with. New messages you send go to codex; the loop's own iterations
> continue on claude. Stop and restart the loop if you want it moved.]*

<a id="lt-031-archived-detail"></a>

## LT-031: A long automation description silently never reaches the UI

**Found:** 2026-08-01, by grepping the packaged app's own `app.log` for
`Blocked invalid renderer event payload` — not by running a check. Worth noting how it was found:
this class of bug is invisible from the UI and invisible from tests; the only trace is that one warn
line.

### Observed behaviour

```
Blocked invalid renderer event payload
{ channel: "automation:changed",
  issues: [{ path: "automation.description",
             message: "Too big: expected string to have <=1000 characters" }] }
```

One occurrence, 2026-08-01. The automation ("Weekday research and morning outreach desk") had an
operational note appended by an agent earlier the same day. The write **succeeded** — the long
description is present and live, confirmed via `list_automations`. Only the renderer notification
was dropped, so the Automations page kept rendering the previous version, with no error surfaced
anywhere a user could see.

### Root cause

An inconsistency between two validation points that nobody had reason to compare:

- **The write path allowed 2000.** `CreateAutomationArgsSchema` / `UpdateAutomationArgsSchema`
  (`src/main/mcp/orchestrator-automation-tools.ts`) cap `description` at 2000 — and, unlike the IPC
  path (`automation-handlers.ts`, which validates against `AutomationCreatePayloadSchema` before
  writing), the MCP path writes **without** validating against the payload schema at all.
- **The event path capped at 1000.** `AutomationSchema.description`
  (`packages/contracts/src/schemas/automation.schemas.ts`) was `z.string().max(1000)`, and
  `automation:changed` is validated against it before `webContents.send`.

So the system happily accepted a value it could then never tell the renderer about. And 1000 was
below *real* usage regardless — James's automations routinely carry multi-paragraph operational
notes ("PAUSED 2026-08-01 because …, original description: …"), several already close to the cap.

### Required behaviour and fix

Raised to a single shared `AUTOMATION_DESCRIPTION_MAX = 8_000` used by all three sites (create
payload, update payload, entity), so the write path and the event path cannot disagree.
**Deliberately raised rather than truncated on write** — clipping would silently destroy the note,
which is the same class of harm as dropping the event. Still bounded, so a runaway payload is
rejected.

### Acceptance

Three tests in `automation.schemas.spec.ts`: a realistic ~1600-char note parses on create and on
update, and an 8001-char one is rejected. Verified the first two fail when the cap is put back to
1000.

### Correction, and the sibling defect it hid

My first write-up of this item stated **"the write path caps nothing"**. That was **wrong**:
`description` has been capped at 2000 in the MCP args schema since 2026-06-09 (commit `06f4a500`).
I asserted the negative from a `grep` that returned no matches, without opening
`orchestrator-automation-tools.ts` to read the schema I was blaming. The real shape is an asymmetry
between two *bounded* caps, not an unbounded write.

That matters beyond pedantry, because the same unverified assumption hid a **second, live instance of
the identical bug** — caught by the completion gate, not by me:

**`workingDirectory`: 10 000 at the MCP write path vs 1 000 at the entity bound.**
`WorkingDirectorySchema` (`common.schemas.ts`) is `max(1000)` and reaches
`AutomationChangedEventSchema` via `AutomationSchema.action`. Both MCP tools allowed
`max(10_000)`. Because the MCP path does not validate against the payload schema, any
`workingDirectory` of 1001–10 000 chars would write successfully and then have its
`automation:changed` event silently dropped — the exact LT-031 mechanism on a different field.
Not observed in `app.log` (no such automation exists), but unambiguous in code.

Fixed by pointing both MCP sites at the shared `WorkingDirectorySchema`, so the write and event
bounds are now literally the same object. A path over 1000 chars exceeds `PATH_MAX` on every
supported platform, so tightening rather than raising is the correct direction here — the opposite
call to `description`, and for a concrete reason rather than symmetry.

**Checked and clear:** `name` (200 everywhere) and `prompt` (MCP 100 000 is *tighter* than the
entity's 500 000, so it can only reject early, never drop an event). `workspaceId` is not an MCP arg.

### The class is now closed, not just the two instances

Checking fields by hand does not scale — a third looser bound added tomorrow reopens this. So the
MCP write path now validates before writing, which is what the IPC path always did:
`assertWritablePayload()` in `automation-tool-impl.ts` runs the payload schema immediately before
`createWithScheduling(input)` and before `store.update(...)`, and throws naming the offending field.

**It validates the MAPPED object, not the raw args** — deliberately. The MCP arg shape is flat
(`cron` / `runAt` / `workingDirectory` / `prompt`) while the payload shape is nested
(`schedule` / `action`), and the mapping does real work first (cron validation, `Date.parse`,
defaulting the working directory from the calling chat). Only after that is there a payload-shaped
object to check. Validating raw args would fail on shape for every legitimate call.

**Why this is safe against false rejection**, checked before writing it rather than assumed: neither
`AutomationCreatePayloadSchema` nor `AutomationUpdatePayloadSchema.shape.updates` is `.strict()` —
the only two `.strict()` schemas in the file are the *event* schemas — so extra keys are stripped,
not rejected. `AutomationActionSchema` requires just `prompt` and `workingDirectory`, both always
supplied by the mapping, and `destination` carries a `.default()`. The guard can therefore only fire
on a genuine bound or enum violation, which is exactly its purpose. All 148 `src/main/automations`
tests pass unchanged.

**All three MCP write sites are covered**, not two. A gate pass pointed out that my first pass said
"closing the class" while leaving `postponeAutomation` — which also writes via `store.update` —
outside the guard. It was not exploitable today (its `runAt` is a derived number and its timezone is
copied from an already-valid schedule), but "not exploitable today" is precisely the reasoning that
let this class exist in the first place, so it is now covered too.

The two hand-fixed bounds (`description`, `workingDirectory`) are kept rather than reverted: they
are the correct bounds on their own merits, and this guard is defence in depth behind them, not a
replacement.

**Note on live status:** this is working-tree code. Until the app is rebuilt, the packaged app still
runs the unvalidated path, so this cannot be exercised live yet.

### The generalisable lesson

`validateRendererEventPayload` **does** log every drop, and that log is the only evidence this
failure mode leaves. It is worth grepping `Blocked invalid renderer event payload` periodically —
doing so on 2026-08-01 also surfaced 110 dropped `loop:activity` events from 2026-07-31, which
independently confirms LT-021 was a genuine live defect rather than a theoretical one.

<a id="lt-032-archived-detail"></a>

## LT-032: A hidden window permanently freezes transcript scroll tracking

**Found:** 2026-08-01, while verifying the scroll-edge-loading fix for the audit plan's item 2. Found
by *driving* the check rather than reasoning about it — the fix under test worked, and the check
still failed, which is what exposed the second cause.

### Observed behaviour

With an instance open and a populated transcript, the viewport was genuinely scrollable and scrolled
(`scrollTop` 886 → 0, held), the listener was bound (`boundViewport: true`,
`viewportCleanup: true`), and yet **no scroll state moved**: `showScrollToBottom` stayed `false`
with 886 px of distance from the bottom.

The gate was `isRestoringRef.value === true`, stuck.

### Root cause

Measured directly in the running renderer:

```
{ rafFires: false, hidden: true, visibilityState: "hidden", hasFocus: false }
```

`requestAnimationFrame` does not fire **at all** in a hidden window — not late, not throttled.
Both restore paths (`output-stream.component.ts`, the instance-switch restore and the
deferred-restore watcher) set `isRestoringRef.value = true` **synchronously** and clear it **only
inside the rAF callback**. No frame, no clear. `OutputScrollService`'s listener short-circuits on
that guard (`output-scroll.service.ts:52`), so every scroll event is then discarded for the life of
that session.

### Why it matters beyond the test harness

This is not a CDP artefact. Any user who opens an instance and switches to another app — or whose
window is fully occluded — before the frame lands gets a session whose scroll tracking is dead:
no scroll-to-bottom button, no position saving, and no scroll-edge loading of older messages. There
is no error and nothing in the log.

It also means the 2026-07-25 audit's conclusion was only half right. It attributed the frozen
listener state entirely to the one-shot `afterNextRender` binding. That binding bug was real and is
fixed, but fixing it alone does not make the check pass, because the guard still sticks.

### Fix

`runRestoreFrame()` (`restore-frame.ts`) runs the step on the next frame **or** after a bounded
timeout, whichever comes first, exactly once. Frame-aligned when visible — which is what the restore
wants, to avoid a visible jump — and guaranteed to run when not. All five restore/scroll frame call
sites in `output-stream.component.ts` use it.

### Acceptance

4 tests in `restore-frame.spec.ts`: runs on the frame; **still runs when the frame never arrives**;
runs exactly once when a late frame lands after the fallback; no double-run when the frame is
prompt. Verified that removing the fallback fails 2 of the 4.

<a id="lt-033-archived-detail"></a>

## LT-033: The stuck-frame-guard shape in three more components

**Found:** 2026-08-01, by the LT-032 completion gate. I asked the reviewer to sweep the whole
renderer for the *shape* rather than re-check my fix, and it came back with three more. That request
was worth more than the review itself.

### The shape

A boolean guard (or an awaited promise) is raised **synchronously**, gates re-entry, and is lowered
**only inside a `requestAnimationFrame` callback**. Since rAF never fires while the document is
hidden (measured under LT-032), one occurrence while backgrounded sticks the guard for the life of
the component — silently, with no error.

### The three instances

| Site | Guard | Trigger frequency | User-visible effect when stuck |
| --- | --- | --- | --- |
| `input-panel.component.ts` `scheduleTextareaResize()` | `resizeScheduled` | **every keystroke** (plus 5 other call sites) | the composer textarea stops auto-growing for the session |
| `transcript-jump-rail.component.ts` `scheduleMeasure()` | `measureScheduled` | items/viewport/prompt change, visibility toggle, transcript scroll, `ResizeObserver` | jump-rail tick highlighting and hover previews freeze |
| `transcript-find-controller.ts` `waitForRender()` | an awaited rAF promise | a find with zero visible matches and older messages available | the promise never settles, so the enclosing `finally` never runs, `loadingOlder` stays `true`, and the find bar's next/prev buttons stay disabled |

The first is the worst: it fires on **every keystroke**, so the window only has to be backgrounded
for a single character for the composer to stop resizing until the session ends.

The third is the subtlest — the guard is not a boolean at all. A never-settling `await` inside a
`try` means the `finally` that clears `loadingOlder` never runs. Same root cause, different disguise.

### Fix

All three now use `runRestoreFrame()` (`restore-frame.ts`), which races the frame against a bounded
timeout and cancels the loser.

### Why this was worth chasing beyond LT-032

LT-032 was filed against the transcript's scroll-restore paths. Fixing only those would have left the
same defect on the composer's keystroke path — more frequently hit than anything LT-032 touched.
**When a completion gate confirms a defect, the useful next question is not "is my fix right?" but
"where else does this shape appear?"** Asking that produced three more real defects; asking only the
first would have produced none.

### One related hazard deliberately left alone

`workspace-bench.service.ts:162-168` (`waitForPaint`) awaits a double-rAF promise that also never
settles while hidden. It is the same *underlying* hazard but **not** the LT-033 shape — there is no
persistent flag left wrongly set, so nothing is bricked for the session; the await simply stalls
until the window is visible again. It is also a manual benchmarking harness reachable only from the
bench UI.

Not fixed, for a concrete reason: `restore-frame.ts` lives in `features/instance-detail/`, and
`workspace-bench.service.ts` is in `core/services/`. Importing it there would make a core service
depend on a feature module — a layering inversion that two gates explicitly checked for and found
clean. Fixing this properly means promoting the helper to a shared location, which is a wider change
than the hazard justifies. Recorded so it is a decision, not an oversight.

### Ruled out in the same sweep

Checked and cleared as *not* this shape (no persistent re-entry guard tied to the frame):
`instance-list.component.ts:715`, `output-stream-inline-edit-controller.ts:98`,
`streaming-text.component.ts` (recursive loop, id used only for cancellation),
`voice-audio-capture.ts` (`stopped` gates only its own tick), `workspace-bench.service.ts`
(dev-only), and the one-shot drag-image/focus cleanups in `source-control.component.ts`,
`file-explorer.component.ts`, and `recent-directories-dropdown.component.ts`.

<a id="lt-034-archived-detail"></a>


## LT-034: The context ring renders aggregate token spend as context-window occupancy

**Found:** 2026-08-11, running WS14 check 2's outstanding live re-check.
**Source evidence:** [WS14 check 2](./2026-07-13-fable-ws14_livetest_completed.md)

### Observed behaviour

A Copilot instance (`p5abkxd11`, `copilot-acp`) was given **three one-word turns**
(`Reply with exactly one word: TURN1/2/3`). The rendered context ring read, from the live DOM:

```
title / aria-label = "Context window: 52% used (103,222 / 200,000 tokens)"
```

Underlying `contextUsage` across the three turns:

| After | used | total | percentage | occupancyReported | cumulativeTokens |
| --- | --- | --- | --- | --- | --- |
| create | 0 | 200 000 | 0 | *(absent)* | — |
| turn 1 | 17 153 | 200 000 | 8.58 | **true** | 17 153 |
| turn 2 | 51 535 | 200 000 | 25.77 | **true** | 51 535 |
| turn 3 | 103 222 | 200 000 | 51.61 | **true** | 103 222 |

The real context occupancy after three one-word exchanges is a few thousand tokens. The UI claims
the context window is **52 % full**.

### Root cause

`AcpCliAdapter.publishContextUsageFromTurn` (`src/main/cli/adapters/acp-cli-adapter.ts:2004-2028`)
accumulates per-turn spend and publishes the running total *as* occupancy:

```ts
this.cumulativeTokens += turnTokens;
const total = ACP_CAPABILITIES.contextWindow;   // 200_000
const used = this.cumulativeTokens;             // monotonically increasing
this.emit('context', { used, total, percentage: Math.min((used / total) * 100, 100), … });
```

This is **documented and deliberate** at `:1998-2002` — "`used` is the aggregate, not a true
context-window occupancy, because ACP does not report one and fabricating it would be worse". The
adapter also declares the fact honestly: `getContextCapabilities()` returns
`occupancyReporting: 'aggregate-only'` (`:357`).

**The defect is that nothing on the rendering path consumes that declaration.** The only consumer of
`occupancyReporting` anywhere in the tree is `context-safety-policy.ts:116`, which uses it for
context-evidence safety decisions. The ring instead keys on `ContextUsage.occupancyReported`, and
that boolean is set for *any* provider-reported usage at
`instance-communication.ts:1631` — so it means "the provider sent a number", not "this number is
occupancy". LT-018 introduced the flag to separate *unknown* from *zero*; it does not separate
*measured occupancy* from *cumulative spend*.

Because `percentage` is clamped with `Math.min(…, 100)`, a long Copilot session ends up pinned at a
confident **100 %** with a nearly-empty context.

### Scope — this is not Copilot-only

Every adapter declaring `aggregate-only` feeds the same ring:

| Adapter | Declaration site |
| --- | --- |
| `acp-cli-adapter.ts` (`copilot-acp`) | `:357` |
| `copilot-cli-adapter.ts` | `:149` |
| `gemini-cli-adapter.ts` | `:164` |
| `claude-cli-adapter.ts` — **non-resident only** (`resident ? 'current' : 'aggregate-only'`) | `:305` |
| `codex-app-server-adapter.ts` — non-app-server path | `:627` |

Providers reporting `'current'` (resident Claude, Codex app-server) are correct and must stay that
way — verified live in the same run: a resident Claude instance read
`{used: 56 902, total: 1 000 000, percentage: 5.69, occupancyReported: true}`, i.e. genuine
occupancy, and preserved the flag across a compaction.

### Required behaviour

The ring must not state occupancy it does not have. Either:

1. **Propagate the capability to the renderer** — carry `occupancyReporting` (or a derived
   `isAggregate` boolean) on `ContextUsage`, and have `composer-toolbar.component.ts`
   `ringTitle`/`ringPct` render aggregate-only providers as spend rather than occupancy
   (e.g. *"Tokens used this session: 103,222"* with no percentage ring); or
2. **Stop emitting a percentage for aggregate-only providers** — publish `cumulativeTokens` only and
   leave `used`/`percentage` unset, so the existing LT-018 "no data" path renders.

Option 1 is preferred: the aggregate is genuinely useful information, it is just mislabelled. Option
2 discards it.

Whichever is chosen, `occupancyReported` should stop being the single signal for two different
questions.

### Acceptance

- A `copilot-acp` instance given three short turns does **not** display a context-window percentage
  derived from cumulative spend.
- The cumulative figure remains visible to the user in some honest form.
- A resident Claude instance still shows real occupancy, still shows it across a compaction, and a
  never-reported instance still reads *"Context window: no data"* (LT-018 must not regress).
- A regression test pins the aggregate-only rendering decision so a future adapter declaring
  `aggregate-only` cannot silently reacquire a fake percentage.

### Note on LT-018's relationship to this

LT-018 is **fixed and verified live** in the same run (see the WS14 evidence section). This is not a
reopening of it — it is the adjacent case LT-018's flag design did not cover. LT-018 asked "is this
number known?"; LT-034 asks "is this number the thing we are labelling it as?".

### Fix — landed 2026-08-11 (option 1: label the aggregate honestly)

James chose option 1 ("go with your recommendations"), so the aggregate is kept and named rather
than discarded.

`ContextUsage` gains `occupancyIsAggregate?: boolean`, derived **centrally** in
`instance-communication.ts` from the adapter's own declaration via `isAggregateOnlyOccupancy()`
(`instance-communication-adapter-helpers.ts`) — not per adapter, so a new provider cannot reacquire
a fake percentage by forgetting a flag.

Three decisions worth recording, because each was a trap:

1. **Gated on `!== 'current'`, not `=== 'aggregate-only'`.** The conservative default is `'none'`,
   and Cursor over ACP inherits it while sharing Copilot's `publishContextUsageFromTurn`. Gating on
   `'aggregate-only'` alone would have left Cursor mislabelled. Pinned by a test.
2. **Duck-typed, not `instanceof BaseCliAdapter`.** `RemoteCliAdapter` has no
   `getContextCapabilities`, so both forms agree — but `instanceof` also fails silently whenever the
   base class is reached through a second module instance (this repo resolves adapters through path
   aliases), and that silent `false` is indistinguishable from "this provider reports occupancy".
3. **Remote adapters are deliberately NOT flagged.** They forward whatever the worker's CLI reports,
   so a remote resident-Claude session carries real occupancy; defaulting them to aggregate would
   hide a working ring for every remote instance. The cost — a remote aggregate-only provider keeps
   the mislabelling until the capability is forwarded over the worker protocol — is recorded rather
   than assumed away.

**The warning path mattered more than the ring.** `checkContextWarningThreshold` fires at
`percentage >= 80` and injects *"Your context is at N% capacity … delegate to children"* **into the
conversation**. On an aggregate-only provider that threshold tracks total tokens billed, so it would
fire over a nearly-empty context and actively degrade the run. It now returns early on an aggregate
reading. Fixing this required passing `instance.contextUsage` rather than the raw `usage` — the
clone-vs-raw trap that broke LT-018's fix at `queueUpdate`; a mutation test pins it.

Renderer: `composer-toolbar` and `context-bar` both treat an aggregate as *unknown occupancy* and
render the spend instead, with the compact view falling back to an en dash plus an explanatory
tooltip. `buildPostCompactionUsage` carries the flag through compaction for the same reason it
carries `occupancyReported`.

### Verified live — 2026-08-11 (dev app, CDP)

Same scenario that produced the defect: a Copilot instance, three one-word turns.

| | Before | After |
| --- | --- | --- |
| rendered ring | `Context window: 52% used (103,222 / 200,000 tokens)` | `Tokens used this session: 103,264 (this provider does not report context-window occupancy)` |
| `ringPct` | 51.6 | **0** |
| `occupancyKnown` | true | **false** |

Control — a resident Claude instance in the same run is **unchanged**:
`Context window: 6% used (57,074 / 1,000,000 tokens)`, `ringPct 5.7`, `occupancyKnown true`.

Compaction preserves the flag, confirmed live rather than only by unit assertion:
`newUsage` → `{used: 0, cumulativeTokens: 103264, occupancyReported: true, occupancyIsAggregate: true,
source: 'post-compaction-reset'}`.

**Tests: 20 added across 4 specs, every one mutation-verified** (reverting the fix makes it fail,
restoring makes it pass) — including the naive `=== 'aggregate-only'` gate and the clone-vs-raw
call-site trap, which are the two ways this fix could have looked right and been wrong.

<a id="lt-040-archived-detail"></a>


## LT-040: Claude CLI never connects to the `computer-use` MCP server for any instance

**Found:** 2026-08-12, batch A, attempting Check 1 of the Computer Use consent/targeting live test.
**Source evidence:** [Computer Use consent/targeting evidence](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md#evidence-run--2026-08-12-batch-a--computer-use-mcp-never-connects-for-any-claude-instance-lt-040)

### Observed behaviour

Created a fresh Claude instance in an isolated dev app (`c3004l84l`) with `computerUseEnabled: true`
and `desktopGetHealth()` reporting `screenCapture/accessibility/input: "available"`. Asked the
instance to call `computer.request_app_grant`; it reported (correctly, not fabricated): "No
`computer.*` tools ... are actually available in this session" and listed its actual top-level tool
set plus the full `ToolSearch`-deferred index — no `computer.*` tool anywhere in either.

Verified this is not specific to my instance or to a dev app. `ps` shows exactly which of the four
Harness-injected MCP servers (`codemem`, `browser-gateway`, `computer-use`, `orchestrator-tools`)
actually became a live child process of the spawned `claude` CLI, for three independent instances:

| Instance | codemem | browser-gateway | computer-use | orchestrator-tools |
| --- | --- | --- | --- | --- |
| `c3004l84l` (my dev-app instance) | live | live | **absent** | live |
| `ctudhhy3l` (live packaged-app session) | live | live | **absent** | live |
| `c17u6i9vq` (live packaged-app session — the orchestrating agent's own session) | live | live | **absent** | live |

All three ran the identical `claude --print ... --mcp-config <file> <codemem-json> <browser-gateway-json>
<computer-use-json> <orchestrator-json>` invocation pattern; `computer-use` is the only one of the
four dynamic blobs that never spawns a child, in every sample.

Ruled out before concluding this is real:
- **Not a health/settings gate.** `desktopGetHealth()` reports fully healthy; `computerUseEnabled` was
  confirmed `true` before spawn; `getComputerUseMcpOptions` (`src/main/instance/lifecycle/spawn-config-builder.ts:383-414`)
  did run and inject the config — the `computer-use` JSON blob is present, well-formed, and identical
  in shape to the other three (`python3 -c 'json.loads(...)'` on the extracted blob from each of the
  four positions: all four parse as valid JSON).
- **Not a broken `aio-mcp computer-use` binary.** Drove it directly with a raw MCP stdio handshake
  (`initialize` → `notifications/initialized` → `tools/list`, bypassing Claude CLI entirely) using
  the exact socket/instance/provider env from the live spawn: it answered `initialize` correctly and
  `tools/list` returned the full `computer.*` tool set (`computer.request_app_grant`,
  `computer.list_grants`, `computer.revoke_grant`, `computer.get_audit_log`,
  `computer.raise_escalation`, ...). The server side is fully functional.
- **Not the static `config/mcp-servers.json` shadowing it.** That file only defines `lsp` and `imap`;
  no `computer-use` key to collide with.
- **Not a positional/count limit on `--mcp-config` values.** The 4th and last dynamic blob
  (`orchestrator-tools`) connects fine, so Claude CLI is not simply dropping tail arguments.

### Root cause (as first filed, 2026-08-12 batch A)

Not fully pinned down. The failure is specifically in how the real `claude` CLI process treats the
`computer-use`-named inline `--mcp-config` blob — the server itself, the config JSON, and the spawn
wiring are all provably correct. A reproduction attempt by invoking `claude` directly from this
session's own shell was inconclusive (it returned `"mcp_servers":[]` for *every* server including
ones known to work elsewhere, because this session's own Claude CLI environment appears to suppress
MCP loading for nested/recursive invocations — a confound, not evidence either way). The leading
hypothesis, untested: Claude CLI may special-case or reject a user-supplied MCP server literally
named `computer-use` because it collides with Anthropic's own built-in "computer use" tool concept.
Whoever picks this up should test that hypothesis first (rename the injected server key, e.g. to
`aio-computer-use`, and see if it then appears as a live child) before looking elsewhere.

### Root cause — confirmed 2026-08-12, LT-040 pickup

The naming-collision hypothesis above is **confirmed**, with the exact mechanism pinned by reading
the real Claude CLI bundle (`strings -a` on `~/.local/share/claude/versions/2.1.227`, the Bun
single-executable binary run for every AIO Claude spawn):

- The CLI hardcodes `var wpe="computer-use"` — a literal constant for its **own** reserved/built-in
  desktop-automation server name — and `function gRe(e){return uc(e)===wpe}` matches any server
  (including a caller-supplied one) whose name equals that constant.
- Every server connection attempt is gated by `function My(e){let t=pp();if(XNs(e))return
  !PHo(t.enabledMcpServers).includes(e);return PHo(t.disabledMcpServers).includes(e)}`, where
  `XNs(e)=e===wpe`. For every *other* server name, `My()` is **opt-out**: disabled only if the name
  appears in that project's `disabledMcpServers` (empty by default → connect proceeds). For the one
  literal name `computer-use`, `My()` is **opt-in only**: disabled unless the name already appears in
  `enabledMcpServers` for the current project entry in `~/.claude.json`. A fresh/never-approved
  project (the case for every AIO-spawned working directory, since AIO never performs the interactive
  "trust this MCP server" approval flow) has no such entry, so `My('computer-use')` is always `true`
  → the connection loop (`N1d`'s per-server `T` closure) classifies it `{type:"disabled"}` and
  **returns immediately, before ever attempting to spawn a child process** — which is exactly why no
  `aio-mcp computer-use` process, and no MCP-level error, was ever observed on our side.
- A separate code path — `setupComputerUseMCP()`, which injects Anthropic's *own* built-in
  `computer-use` server via `{...lr, ...Do}` when `Yt()==="macos"&&!Pn()&&IFo()` — was investigated
  and **ruled out** as the mechanism for AIO's spawns specifically: `Pn()` returns `!isInteractive()`,
  which is `true` for every AIO spawn (`claude --print` is always non-interactive), so `!Pn()` is
  `false` and that branch never runs for us. The `My()`/`XNs()` allowlist gate above is unconditional
  and independent of interactive/print mode, and is the actual mechanism blocking AIO.
- **Decisive test:** renamed the injected server key from `computer-use` to a scratch test name and
  rebuilt. `ps` on the resulting `claude --print` child immediately showed a live
  `aio-mcp <test-name>` process (previously always **absent**), and the agent both listed and
  successfully called a renamed tool end-to-end. Reverting the name reproduced the original absence.
  This is the requested naming-collision test from the LT-040 filing, run and confirmed rather than
  left untested.

### Required behaviour

Every Claude-provider instance with Computer Use enabled and healthy must actually receive the
`computer.*` tools it is documented to have, so an agent can call `computer.request_app_grant` and
the rest of the desktop-gateway tool surface end to end.

### Fix — 2026-08-12, LT-040 pickup

Renamed the MCP server *registration name* (not the `aio-mcp` CLI subcommand, which stays
`computer-use`) from the reserved literal `computer-use` to `harness-computer-use`, via a single
exported constant `COMPUTER_USE_MCP_SERVER_NAME` in `src/main/desktop-gateway/desktop-mcp-config.ts`,
used by all four provider config emitters (`buildComputerUseMcpConfigJson` for Claude/Codex-app-server
inline JSON, `buildComputerUseCodexConfigToml` for Codex TOML, `buildComputerUseGeminiSettingsJson`
for Gemini settings, `buildComputerUseAcpMcpServers` for ACP/Copilot/Cursor/Grok) and by the three
call sites in `src/main/cli/adapters/adapter-spawn-helpers.ts` that detect/merge that same server
(`hasComputerUseBridge`, `mergeComputerUseGeminiSettings`). Audited every other `'computer-use'`
string literal in the codebase (RPC error messages, the `aio-mcp` subcommand dispatcher, the lock-file
purpose string, renderer settings-tab/component ids, a skill script filename) and confirmed none of
them are the MCP *registration* name Claude CLI reserves — they are independent identifiers and were
deliberately left unchanged.

Added a permanent regression guard,
`desktop-mcp-config.spec.ts › 'never registers the MCP server under the literal name "computer-use"
(LT-040)'`, asserting the Claude/Gemini JSON keys, the Codex TOML table name, and the ACP `name` field
are never the literal string `computer-use`. Mutation-verified: reverted
`COMPUTER_USE_MCP_SERVER_NAME` to `'computer-use'`, watched the new test fail
(`expected [ 'computer-use' ] to not include 'computer-use' `), restored the fix, watched it and the
other 5 tests in the file pass.

Gates: `npx tsc --noEmit` clean, `npx tsc --noEmit -p tsconfig.spec.json` clean, `npm run lint`
("All files pass linting"), `npm run check:ts-max-loc` passed (exit 0; touched files are not on the
oversize list), `npm run build:main` succeeded, targeted `npm run test:quiet` across
`desktop-mcp-config.spec.ts`, `adapter-spawn-helpers.chrome-devtools.spec.ts`, and
`instance-lifecycle-browser-mcp.spec.ts` — 3 files / 32 tests passed.

### Verification

**Fixed and verified live 2026-08-12.** After rebuilding `dist/main` with the fix and spawning a
fresh Claude instance in an isolated dev app (`AIO_DEV_USER_DATA_PATH`, CDP port 9466,
`computerUseEnabled: true`, `yoloMode: true`):

- `ps` on the spawned `claude --print` child (pid 71769) now shows a live
  `dist/aio-mcp-cli-sea/aio-mcp computer-use` process (pid 71934) — previously **absent** in every
  sample across three independent instances (one dev, two live packaged-app sessions).
- Asked the agent to list every tool from a desktop/computer-use MCP server: it reported the full
  18-tool `harness-computer-use` set as deferred (`mcp__harness-computer-use__computer_*`) — previously
  it reported none.
- Asked the agent to call `computer_health`: it ran `ToolSearch` to load the tool, called
  `mcp__harness-computer-use__computer_health`, and got back real driver-health JSON
  (`{"decision":"allowed","outcome":"ok","data":{"platform":"darwin","supported":true,
  "screenCapture":"available","accessibility":"available","input":"available","enabled":true,
  "lockAvailable":true,"injectable":true}}`) — a genuine round trip through the real MCP connection,
  not just tool-list presence.
- The agent also correctly declined to actually drive local UI (`list_apps`/`request_app_grant`/
  clicks) per the operator's own standing "explicit local-control approval" instruction — confirming
  the fix only restores MCP *connectivity*, not any change to AIO's own consent gating.

### Impact on this batch

This blocked Check 1 (and effectively Check 4, which also needs a real `computer.*`-driven grant flow)
of [`2026-08-09-computer-use-consent-and-targeting_livetest.md`](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md)
regardless of local Mac control being approved — the blocker was that no spawned agent could reach the
tool at all, not a policy/UI boundary. It likely also explains why Checks 2/3 in that same doc's prior
evidence run were driven with raw probe scripts rather than a real agent MCP call. With LT-040 fixed,
that livetest doc's own checks should be re-run by whichever batch owns it — this pickup did not
re-run or rename that doc, since it is outside this task's assigned batch.

<a id="lt-045-archived-detail"></a>


## LT-045: Manual Codex compaction re-pays the 30s confirmation timeout on every call, not just the first

**Found:** 2026-08-12, batch B, re-running Context-Cost-Governor check 1 against a rebuilt dev app to
verify the 2026-07-30 LT-017 partial fix ("the 30s stall is paid at most once per session").
**Source evidence:** [Context-cost-governor evidence](../superpowers/plans/2026-07-14-context-cost-governor-plan_livetest_completed.md#evidence-run--2026-08-12-batch-b--lt-017-decision--lt-045-found-and-fixed)

### Observed behaviour

Created a fresh Codex instance (`x8cjlnal4`, then `x1y99stdy` after a rebuild), sent a small prompt to
establish the native thread, then called `compactInstance` twice in a row on the same AIO instance
with `AIO_CODEX_CONTEXT_DIAGNOSTICS=1` set:

| Call | Elapsed | `method` | `nativeAttemptFailed` |
| --- | --- | --- | --- |
| 1st | 48.0s / 34.6s (two separate runs) | `restart-with-summary` | `true` |
| 2nd (same AIO instance, no restart between calls) | 38.3s | `restart-with-summary` | `true` |

The 2026-07-30 note explicitly predicted the 2nd call would be "near-instant, no 30 s wait, no second
RPC". It was not — it paid the full stall again.

### Root cause

LT-017's sticky flag (`CodexContextCostController.nativeCompactionUnobserved`) lives on the per-adapter
controller instance, constructed once in `CodexAppServerAdapter`'s constructor
(`codex-app-server-adapter.ts:104`). Manual compaction's only fallback when native fails is
restart-with-summary (`compaction-coordinator.ts` `executeCompaction`), and that fallback replaces the
**entire adapter object** — `instance-lifecycle.ts` calls `this.deps.setAdapter(instanceId, adapter)`
with a freshly constructed adapter (confirmed live: `adapterGeneration` incremented 1→2, provider
session id changed) as part of every restart-with-summary. The brand-new adapter gets a brand-new
`CodexContextCostController` with `nativeCompactionUnobserved = false`, so the very next manual
compaction call re-attempts the native RPC and re-pays the full 30s timeout — on the *only* path the
2026-07-30 fix was written for (manual compaction is what falls back to restart-with-summary
immediately on every failure; the automatic 4x-governor path never restarts the thread, so its own
copy of the same sticky flag genuinely does persist across the multiple `compactContext()` calls it
can make on one controller instance — that path already worked as documented).

### Required behaviour

Once a given AIO instance has proven, this session, that its connected provider build never confirms
native compaction, every later manual compaction for that same instance should skip the native RPC
attempt entirely and go straight to restart-with-summary — regardless of how many adapter respawns
happened in between — reporting `nativeAttemptFailed: true` honestly as before.

### Fix

Added `CompactionCoordinator.nativeCompactionProvenUnsupported` (`compaction-coordinator.ts`), a
`Set<instanceId>` that survives an adapter respawn because the coordinator singleton itself is never
replaced. `compaction-runtime.ts`'s `nativeCompact` strategy closure checks
`coordinator.isNativeCompactionProvenUnsupported(instanceId)` before calling the adapter at all, and
records the verdict via `coordinator.recordNativeCompactionProvenUnsupported(instanceId)` immediately
after a failed `compactContext()` call **only** when the adapter confirms (via a new passthrough,
`CodexAppServerAdapter.nativeCompactionKnownUnsupported()`) that the failure was a genuine timeout, not
an ordinary transient failure — preserving LT-017's original selectivity. Cleared in
`CompactionCoordinator.cleanupInstance()` on instance teardown. Deliberately does **not** attempt a
self-heal retry after a respawn (e.g. for a mid-session CLI upgrade) — that would reintroduce the exact
cost this fix removes; a genuinely upgraded CLI needs the app or instance to be restarted, which already
clears the record.

### Verification

Regression tests added and watched fail with the fix reverted, then pass with it restored:
`src/main/app/compaction-runtime.spec.ts` ("skips the native RPC on a later compaction once the
coordinator has proven it unsupported, even for a new adapter object (respawn)" — simulates the
respawn by swapping the mocked adapter object between calls, asserts the 2nd adapter's
`compactContext` is never invoked; "clears the proven-unsupported record on instance cleanup").
`npx tsc --noEmit` (both configs), `npx oxlint --config .oxlintrc.json` on the touched files, and
`npm run build:main` all pass. Verified live against a rebuilt dev app on a real Codex instance: 1st
manual compaction 34.6s (`nativeAttemptFailed: true`), 2nd **4.3s**, 3rd **7.1s** — both skipped the
RPC (confirmed the 2nd/3rd calls' `previousUsage` shows the post-1st-compaction reset state, and
elapsed time is consistent with adapter-respawn + `ContextCompactor` overhead only, not a 30s wait).

### Completion gate round 2 — **FAIL again**, and it found the worst one yet

A second, differently-briefed reviewer confirmed all five round-1 remediations were correctly wired,
then found four more. One is materially worse than anything above, because it has **no visible
symptom at all**.

**`calculateContextBudget` silently disables memory injection for the rest of the session.**
`instance-context.ts` and its worker-thread duplicate `context-worker-client.ts` both read
`contextUsage.percentage` with *no* gate — not even `occupancyReported`. Past 90 % (95 for children)
they return `{totalTokens: 0, rlmMaxTokens: 0, unifiedMaxTokens: 0, rlmTopK: 0}`, and this runs on
**every `sendInput`** via `buildInputContexts` → `getContextEngine().assemble()`. So on any
aggregate-only provider, once cumulative spend crosses the threshold — which is inevitable, since
spend is monotonic and clamped — **RLM and unified-memory context stop being injected into every
subsequent prompt**, with nothing in the UI to say so. The UI findings were embarrassing; this one
quietly degrades answer quality for the majority of non-Claude-resident providers.

**The self-correction claim in the round-1 remediation was wrong.** `restoreContextUsage`'s comment
asserted a legacy record "self-corrects on the first context event". It cannot: a woken pre-fix
aggregate session restores a pinned ~100 % with no flag, `resolveContextWarningLevel` reads that as
`'emergency'`, and `'emergency'` **disables the composer** — but sending is the only thing that
produces a context event. The bug blocked its own fix. (Not a permanent lockout — Compact Now is a
separate control — but the user gets a false "context nearly full" banner and a dead input box with
no automatic recovery.)

Plus two low-severity ones: a stale comment claiming four providers still receive the delegation
guidance they can no longer reach, and `provider-runtime-trace-sink.ts` writing `context.used` /
`context.percentage` to the NDJSON trace **without** either flag — dormant today (no reader exists)
but baking "spend labelled as occupancy" into every trace file, which is precisely what the schema's
own comment warns against.

### Round-2 remediation

- **The duplicated rule is now one function.** `isOccupancyPressureReading()`
  (`src/shared/utils/context-occupancy.ts`) answers "is `percentage` usable as context *pressure*?"
  and is called by both budget paths. This condition had been written out **four** times across the
  codebase — two thresholds and two budget copies — and every round of this defect has been another
  copy nobody found. New consumers of `percentage` should call it rather than re-derive it.
- **A restored reading can no longer lock the composer.** `restoreContextUsage` now stamps
  `source: RESTORED_CONTEXT_USAGE_SOURCE`, and `resolveContextWarningLevel` caps a restored reading
  at `'critical'` — banner still shows, input stays usable, and the next real context event promotes
  it to `'emergency'` if still true. This fixes the legacy-record case *and* any future
  restore/live mismatch, rather than patching the one that was reported.
- Stale comment corrected; both flags added to the trace record.

**11 further tests, mutation-verified.** Gates green: `tsc` ×2, `lint`, `check:ts-max-loc`,
`build:main`.

### What two failed gates cost, and what they bought

Round 1 found 5 surfaces; round 2 found 4 more including the only silent one. **Nine consumers of a
single number, across two gate rounds, for a defect whose first fix looked complete and passed every
gate.** The pattern is now unambiguous enough to state as a rule:

> When a number reaches the UI with the wrong meaning, do not fix the surface that showed it.
> Enumerate every consumer of that number — renderers, thresholds, budgets, serializers, persistence
> and traces — and fix them together, or extract the rule so there is only one consumer to fix.

Both reviewers were briefed to hunt "remaining instances of the same shape", and both found some.
A single review pass would have shipped the silent budget defect.

<a id="lt-046-archived-detail"></a>


## LT-046: The rolling handoff document never accumulates state on a turn without billable usage

**Found:** 2026-08-12, batch B, running the rolling-handoff-state livetest checks with new
rung-choice observability (see the doc's own "what would make this doc runnable" note).
**Source evidence:** [Rolling-handoff-state evidence](../superpowers/plans/2026-07-17-rolling-handoff-state-plan_livetest_completed.md#evidence-run--2026-08-12-batch-b--observability-added-checks-1-4-re-run-with-direct-proof-lt-046-and-lt-047-found)

### Observed behaviour

With `sessionHandoffStateEnabled: true`, a Claude instance completed 14 real turns (a decision turn
plus 13 short filler turns), and `contextUsage`/`totalTokensUsed` correctly grew across all of them
(confirmed via `listInstances`). A subsequent provider swap logged, via the new
`RestartPolicyHelpers` debug instrumentation:

```
rung: "replay-preamble", documentChars: 1804, ...
"Recent transcript:\n- 7 earlier turns omitted for brevity...
```

That "N earlier turns omitted for brevity" phrasing belongs to the **replay-preamble** builder, not
`HandoffStateService.renderDocument` — direct, unambiguous proof the maintained-handoff document was
never used, and (since `buildHandoffDocument` only returns non-null when `ring.length > 0 ||
rollingSummary`) that `noteTurnCompleted` had never successfully recorded a single one of the 14
turns.

### Root cause

`getHandoffStateService().noteTurnCompleted(instance)` (spec item 5's only write path) lived nested
inside `recordCompletionCost` (`instance-communication.ts`), gated behind that method's own early
returns: `if (!usage) return;` and `if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite
=== 0 && reasoning === 0) return;`. Zero cost-tracker entries were recorded for the test session
(confirmed: `getEntries()` empty, no `recordCompletionCost failed` catch logged either — a clean
early-return, not an exception), even though a *separate* event path correctly updated
`contextUsage`/`totalTokensUsed`. The handoff feature's turn-completion hook has no reason to depend
on cost-tracker eligibility — coupling them meant any session whose `response.usage` on the
`'complete'` event carried no billable tokens silently never populated handoff state at all,
regardless of the setting.

### Required behaviour

`noteTurnCompleted` must fire on every genuinely completed conversational turn, independent of
whether `response.usage` was present or billable.

### Fix

Moved the `noteTurnCompleted` call out of `recordCompletionCost` to the shared `if (completedInstance)`
call site in the adapter `'complete'` handler, guarded only by `sessionHandoffStateEnabled`
(`instance-communication.ts`).

### Verification

Regression tests added to `instance-communication.spec.ts` (`LT-046: rolling handoff state is
maintained even when the turn carried no billable usage` — three cases: zero-usage turn ON,
no-usage-object-at-all turn ON, OFF stays null) — the full file (92 tests) passes. `npx tsc --noEmit`
(both configs), `npx oxlint`, `npm run build:main` all pass. **Verified live**: rebuilt the dev app,
ran the identical 14-turn Codex-origin sequence (Codex proven to reach the `'complete'` handler — see
LT-047), swapped provider, and the debug log now shows `rung: "maintained-handoff"` with a `Rolling
summary (8 earlier turns folded)` section containing the early decision text verbatim — see the
rolling-handoff-state doc's evidence run for the full logged document.

<a id="lt-047-archived-detail"></a>


## LT-047: A resident Claude CLI session never fires the adapter `'complete'` event

**Found:** 2026-08-12, batch B, while live-verifying the LT-046 fix.
**Source evidence:** [Rolling-handoff-state evidence](../superpowers/plans/2026-07-17-rolling-handoff-state-plan_livetest_completed.md#evidence-run--2026-08-12-batch-b--observability-added-checks-1-4-re-run-with-direct-proof-lt-046-and-lt-047-found)

### Observed behaviour

A temporary, unconditional `logger.info` placed directly inside the `if (completedInstance)` block of
the adapter `'complete'` handler (`instance-communication.ts`, right where LT-046's fix lives) **never
fired once** across 14 completed turns on a resident Claude instance — confirmed by grepping every log
line for that instance id (14 total lines, none of them the diagnostic) even well after the turns
settled. The identical diagnostic, same code, same session type, fired **on the very next turn** for a
Codex instance in the same test run. `contextUsage`/`totalTokensUsed` still grow correctly for the
Claude instance (proving *some* other event path works), but `costEstimate` stayed `0` after the first
turn where a sibling Claude instance from an earlier part of the same session did show a non-zero
`costEstimate` — inconsistent, and not fully explained; worth re-checking whether it depends on turn
count or session state.

### Root cause

Not pinned down. `completeResponse()` — the documented single seam (`base-cli-adapter.ts:948-970`)
every adapter should emit `'complete'` through instead of calling `this.emit('complete', ...)`
directly — **is** called from `ClaudeCliAdapter.sendMessage()` at `claude-cli-adapter.ts:614`. That
rules out "the seam doesn't exist" but does not confirm `sendMessage()` is the method actually invoked
for a resident-session turn; `ClaudeCliAdapter` is a single class handling both resident and
non-resident modes (no separate resident subclass), so the divergence, if real, is inside that shared
class rather than a different code path entirely. Whoever picks this up should instrument
`sendMessage()`/`completeResponse()` entry directly (not just the downstream consumer) to confirm
whether it's reached at all for a resident turn, or reached with a `response.usage` shape that later
logic silently drops.

### Required behaviour

Every completed turn, for every provider and session mode, must emit `'complete'` (via
`completeResponse()`) so cost tracking, calibration telemetry, the `cost-recorded` circuit-breaker
signal, and the rolling handoff-state feature all work correctly for Claude, not just non-Claude
providers.

### Impact beyond the handoff feature

This is broader than LT-046: if confirmed, resident Claude CLI sessions (the default per
`residentClaudeSession: true`) may be silently under-recording cost/usage telemetry through this path
for their entire session history. Not fully characterized this session — flagging the blast radius
rather than asserting it, since `contextUsage` tracking clearly works through some other path and this
was not chased to a definitive scope.

### Verification

Not fixed this session — time-boxed given the blast radius (touches cost tracking broadly, not just
the doc this was found under) warrants a dedicated investigation rather than a rushed fix. Evidence
above is real log greps against a live dev-app session, not inference from source alone.

### Root-caused + fixed 2026-08-12 (LT-047 dedicated pass)

**Confirmed the observation, independently.** In an isolated dev app (`AIO_DEV_USER_DATA_PATH`,
CDP-driven), a resident Claude instance sent 5 real turns via `sendInput` → 0/5 `onProviderRuntimeEvent`
`kind: 'complete'` events; `costGetEntries`/`costGetSummary` for that instance returned 0 entries
throughout. A resident Codex control in the same session: 3/3 turns fired `'complete'`. This matches
the filed observation exactly — the earlier diagnosis was correct, not one of this campaign's subtly-wrong
filings.

**Root cause, pinned down.** `ClaudeCliAdapter` has two structurally separate turn-completion paths:
1. The one-shot `sendMessage()` (`claude-cli-adapter.ts` — used for non-resident/legacy request-response
   calls) sets up its own `process.stdout` listener and, on `process.on('close', …)`, calls
   `this.completeResponse(this.parseOutput(this.outputBuffer))` — the only call site that previously
   reached `completeResponse()`/emitted `'complete'`.
2. The resident/streaming path (`spawn()` → `handleStdout()` → `processCliMessage()`'s `case 'result':`)
   handles the CLI's per-turn `result` NDJSON message by emitting `'context'`, sometimes `'cost'`, and
   `'status': 'idle'` — but never called `completeResponse()`.

`residentClaudeSession: true` is the default, and every renderer-driven send for a live instance flows
through `sendInputImpl()` → the resident process's stdin — **never** through `sendMessage()`. So for the
default configuration, `sendMessage()`'s `completeResponse()` call site was simply unreachable: a resident
process never exits between turns, so its `process.on('close', …)` handler — the only place completion
was wired — never fires per-turn. This resolves the register's earlier open question ("does not confirm
`sendMessage()` is the method actually invoked for a resident-session turn"): confirmed, it is not.

**Consumer map — every listener gated on the adapter's `'complete'` event**
(`instance-communication.ts`'s `adapter.on('complete', …)` handler, all previously dead for resident
Claude turns):
- `drainContextEvidence(instanceId)` — flushes the per-turn context-evidence write queue before the rest
  of the handler reads instance state (ordering primitive; evidence itself is captured elsewhere and also
  drained at termination, so impact here is a possible read-after-write lag mid-session, not lost data).
- `detectCompletionProviderLimit()` — regular-session provider-limit auto-resume detection (a throttled
  CLI's limit notice arriving as ordinary assistant content).
- Degraded-output warning log (only active when `detectDegradedAdapterOutput` is on; default off).
- `emitProviderRuntimeEvent(toProviderCompleteEvent(response))` — the `kind: 'complete'` diagnostics/trace
  event (tokensUsed/costUsd/durationMs/degradedReason) that renderer/coordinator trace consumers see.
- `recordCompletionCost()` → `getCostTracker().recordUsage()`, `recordInstanceTurnAttribution()` (cost
  attribution fan-out), `getCacheAnalyticsService().recordTurn()` (cache-hit analytics) — **all** silently
  skipped for every resident Claude turn; confirmed live (0 cost-tracker entries across 5 real turns).
- `recordEstimationTelemetry()` → the token-estimator calibration sample/telemetry (`getTokenCounter()`).
- `getHandoffStateService().noteTurnCompleted()` — LT-046's rolling-handoff-state write path. LT-046's own
  fix moved this out of `recordCompletionCost`, but it is still gated on `'complete'` firing at all, so it
  remained broken for resident Claude sessions until this fix (LT-046's "verified live" evidence used a
  provider swap to Codex specifically because Claude could not reach this handler yet).
- `dispatchInstanceLifecycleHook('PostSampling', …)` and `dispatchInstanceLifecycleHook('Stop', …)` — both
  hook types are dispatched **only** from this handler (confirmed: no other call site in the codebase), so
  agent hooks configured on `PostSampling`/`Stop` never fired for the default provider.
- `this.deps.onToolStateChange?.(instanceId, 'idle')` and `this.deps.onProviderLimitTurn` — **not**
  actually broken: the adapter's separate `'status'` event (which resident turns also emit, via
  `emit('status', 'idle')` in the same `result` case) independently drives `onToolStateChange`, diff-stat
  computation, and `notifyChildTurnCompleted` (turn-completion notifications to parents) through its own
  handler in `instance-communication.ts`. Turn-completion notifications to parents were never broken.
- `this.deps.clearProviderLimitAfterSuccessfulTurn` — checked and found **lower-impact than it looks**:
  `ProviderLimitLedger.clearAfterSuccessfulTurn()` only deletes rows where `resume_at <= now` (already-
  expired rows); `getActive()` already filters `resume_at > now`, so an expired-but-undeleted row could
  never gate a dispatch decision anyway. Missing this call for Claude was table-janitorial dead weight, not
  a live gating bug.

**Fix.** `claude-cli-adapter.ts`: accumulate each resident turn's raw NDJSON in a new
`residentTurnRawOutput` field (appended in `handleStdout()`, reset at the start of each new turn in
`sendInputImpl()`/`sendRaw()` and on a fresh `spawn()`); at the `result` case, feed it to the existing
`parseOutput()` (byte-for-byte the same conversion the one-shot path already trusts for content/toolCalls/
usage) and call `this.completeResponse(response)`. Guarded by a new `awaitingOneShotCompletion` flag (true
only while `sendMessage()`'s own promise is in flight) so this can never double-fire alongside
`sendMessage()`'s own close-handler completion for the same turn — checked for an existing compensating
workaround first; none exists (`getCostTracker().recordUsage()` has exactly one call site,
`recordCompletionCost`, gated only on `'complete'`).

**Verification.** Unit: `src/main/cli/adapters/__tests__/claude-cli-adapter.spec.ts` — 4 new tests
(`'complete'` fires with real content+usage at `result`; no cross-turn content bleed between two resident
turns; no `'complete'` on a `tool_deferred` result, since the turn is paused, not finished; no double-fire
while `awaitingOneShotCompletion` is true) — all 4 watched to FAIL with the fix reverted (a
`false &&` mutation on the guard), then pass restored; full file 64/64 passing. `npx tsc --noEmit` (both
configs), `npm run lint`, `npm run build:main` all clean. `npm run check:ts-max-loc` required raising this
file's ratchet ceiling 2346 → 2430 (documented in `scripts/check-ts-max-loc.ts`) to cover this fix plus a
concurrent same-cycle LT-062 change already in the file.

**Live-verified**, rebuilt dev app, fresh resident Claude instance, 3 real turns: 3/3 `'complete'` events
fired with populated `content` ("pong") and `usage` (`inputTokens`/`outputTokens`/`cacheReadTokens`/
`cacheWriteTokens`/`cost`), and `costGetEntries`/`costGetSummary` for that instance now show exactly 3 cost
entries / `requestCount: 3` (was 0 before, for an identical 5-turn sequence). No double-firing observed.

**Separate finding, not part of this fix:** cost tracking also fails for resident **Codex** turns, via an
unrelated mechanism (`'complete'` fires but `response.usage` is undefined) — filed as LT-090, not fixed.

### Completion gate round 3 — **FAIL**, including a self-inflicted regression

Three HIGH findings. The first two are process failures, not just code ones, and are worth recording
as such.

**1. Round 2 broke an existing test and reported gates green anyway.**
`context-worker-client.spec.ts` — `'calculateContextBudget returns zero budget when context usage is
critical'` — uses a fixture of `{used: 90, total: 100, percentage: 91}` with **no
`occupancyReported`**. Round 2's new gate correctly refuses to treat an unreported reading as
pressure, so the function returned a real budget and the test failed, deterministically, 4/4.

The round-2 entry above lists `tsc ×2, lint, check:ts-max-loc, build:main` — **`test:quiet` is
absent, and that is exactly why this was missed.** Targeted tests were run on the files where tests
were *added*, not on the files that were *changed*. Those are different sets, and the difference is
where this hid.

The fixture was under-specified, not the fix: under LT-018 an unreported reading is the create-time
placeholder, so asserting a skip off `percentage: 91` was asserting off a number meaning "unknown".
Fixture corrected to state a real reading, plus two new cases.

**2. The fix for round 2's worst finding had no coverage at its call site.** Round 2 unit-tested the
extracted `isOccupancyPressureReading()` predicate but never the *wiring* inside
`calculateContextBudget`. Reverting the guard at the call site failed **nothing** — 11/11 still
passed. The silent-memory-injection fix was therefore unverified. Now covered in both copies
(`context-worker-client.spec.ts`, `instance-context-port.spec.ts`), including the in-process one that
had no spec file at all.

**3. A tenth consumer: `evaluateContextWindowGuard`.**
`instance-event-forwarding.ts:294-303` computes `remaining = total - used` and warns below 32k /
hard-blocks below 16k, with no occupancy check. Crucially, `used` is **not clamped** for
aggregate-only providers — only `percentage` is (`acp-cli-adapter.ts:2017-2019`) — so `used` grows
past `total`, drives `remaining` negative, and fires a false "context window is low" warning plus a
false hard-block classification over a nearly-empty context. The pre-existing `isStatelessExecProvider`
skip excludes 2 of the 5 aggregate-only adapters, but for an unrelated exec-per-message reason;
Copilot, Cursor and non-resident Claude were not filtered. Now gated.

### Round-3 remediation — and the duplication is finally gone

Finding 4 of the review was that **only 2 of 6** sites called the shared predicate; the other four
still hand-rolled it. That is the same duplication that produced every previous round, so all six now
call `isOccupancyPressureReading()`:

| Site | Was |
| --- | --- |
| `instance-context.ts` `calculateContextBudget` | shared predicate (round 2) |
| `context-worker-client.ts` `calculateContextBudget` | shared predicate (round 2) |
| `instance-communication.ts` `checkContextWarningThreshold` | checked only `occupancyIsAggregate` — safe by accident, not design |
| `context-warning-level.ts` `resolveContextWarningLevel` | two hand-rolled checks |
| `mobile-gateway-serializers.ts` | two hand-rolled checks |
| `instance.queries.ts` `totalContextUsage` | two hand-rolled checks |

The predicate is now a type guard (`usage is ContextUsage`), so callers narrow correctly instead of
re-testing for `undefined`.

**The consolidation is what makes this testable.** A single mutation of the predicate now fails
**22 tests across 6 call sites**. Before consolidation the equivalent mutation failed 3.

### Deliberately not changed

Review finding 5: `resolveContextWarningLevel` caps **any** restored reading at `'critical'`, not
just aggregate ones, so a genuinely 99 %-full resident-Claude session shows `'critical'` rather than
`'emergency'` between wake and adapter reattach. Kept universal on purpose — scoping the cap to
`occupancyIsAggregate` would exclude exactly the **legacy records that have no flag**, which is the
case it was introduced to fix. The exposure is one banner level for a few seconds on a provider that
self-manages compaction anyway; the alternative reintroduces a composer lockout.

Gates: `tsc` ×2, `lint`, `check:ts-max-loc`, `build:main`, and — this time — the touched specs,
219 passing across 14 files.

<a id="lt-055-archived-detail"></a>

## LT-055: RLM's general context stores never populate the vector store, so `semantic_search` silently degrades to keyword

**Found:** 2026-08-01, WS16 livetest check 5 (recall traces for the `rlm` surface). Filed as an
`LT-NNN` item on 2026-08-12 — it was reproduced with evidence but had not previously been added to
this register.
**Source evidence:** [WS16 check 5](./2026-07-13-fable-ws16_livetest_completed.md#check-5--root-caused-2026-08-01-the-rlm-surface-cannot-emit-a-trace-today)

### Observed behaviour

Driven live against a real RLM context store: `rlmCreateStore` → `rlmAddSection` (a real note) →
`rlmStartSession` → `rlmExecuteQuery {type: 'semantic_search'}`. The query **succeeded** and
returned a plausible-looking result (`[Match 1] backoff-notes (external): …`), with no error and no
indication anything was degraded — but the match came from the **keyword fallback**, not vector
search. `VectorStore residency changed { totalVectors: 0 }` was logged for that store the whole
time. A caller who explicitly asks for `semantic_search` has no way to know it silently ran as a
keyword search instead.

### Root cause

`RLMContextManager.indexStoreForSemanticSearch()` (`src/main/rlm/context-manager.ts:519-532`) is
the **only** method that ever writes vectors for a general-purpose context store (the kind created
by `rlmCreateStore`/`rlmAddSection`), and it has **zero production callers** anywhere in `src/`
(confirmed by grep, and it is not exposed over any IPC channel). So every context store created
through the normal API starts and stays vector-empty, and `context-search.ts`'s semantic-search path
(`:236-262`) only emits a recall trace and returns vector hits `if (searchResults.length > 0)` —
with zero vectors that branch never fires, and the code falls through to the keyword path with no
signal to the caller.

This is a different code path from RLM's **episodic** memory store, which is not affected:
`episodic-rlm-store.ts` calls `vectorStore.addSection()` directly on every write (`:204, :355,
:392`), so episodic semantic recall genuinely works. The gap is specific to session/context stores
made via the `rlmCreateStore` family — the surface WS16 check 5 happened to exercise.

Embeddings themselves are not the blocker (ruled out, not assumed): `EmbeddingService` in `auto`
mode falls Ollama → OpenAI → Voyage → local TF-IDF (`embedding-service.ts:231-262, :422`), so it
would embed with no external provider configured at all. Nothing ever calls it for this store kind.

### Required behaviour (decision needed, not implemented)

`semantic_search` against an RLM context store should either genuinely search vectors, or the
response should say plainly that it fell back to keyword matching — not silently substitute one for
the other. Three viable wiring points, in increasing cost/complexity:

1. **Lazy, on first semantic query** — call `indexStoreForSemanticSearch` inside
   `context-search.ts`'s semantic-search branch when `totalVectors === 0`, before falling through to
   keyword. Cheapest to add; pays the embedding cost only for stores that actually get queried
   semantically, but adds latency to that first query.
2. **Eager, on every `addSection`** — index synchronously (or via a debounced batch) whenever a
   section is added. Keeps queries fast but pays an embedding pass on every write, including
   sections that are never searched semantically — a real, ongoing cost for high-churn stores.
3. **Explicit, caller-driven** — expose `indexStoreForSemanticSearch` over IPC/MCP and require the
   caller to opt in before relying on `semantic_search`. No hidden cost, but pushes the decision onto
   every caller and does nothing for the ones (like this check) that assume `semantic_search` just
   works today.

### Why this is not implemented in this session

Per this campaign's fixing guidance, this is a genuine product/UX and cost tradeoff (which
call-time or write-time cost model to accept), not a bug with one obviously-correct fix — so it is
recorded here rather than decided unilaterally. It is deliberately **not** treated as one of this
repo's known-by-design orphan primitives (`fuseHybrid`, `policy-engine`, `lease-dispatch`,
`lesson-store`): those were built ahead of a feature that does not exist yet, whereas
`semantic_search` is a shipped, already-used RLM query type that silently behaves differently from
its name for this one store kind. Recommendation, if asked: option 1 (lazy, on first semantic
query) — it is the smallest change, adds no cost to write-heavy stores that are never searched
semantically, and only pays the embedding cost exactly when a caller has already asked for semantic
search specifically.

### Completion gate round 1 — **FAIL**, and it was right: the fix covered 2 surfaces of 7

The first independent fresh-eyes review rejected the fix above. It was correct, and the shape of the
miss is the same one recorded for LT-018 in this register: **a confident-wrong-number bug is never
one call site.** The original fix guarded the two surfaces the live check happened to exercise (the
composer ring and the injected context warning) and left five more rendering the same fabricated
figure.

| # | Surface | What it did with cumulative spend | Severity |
| --- | --- | --- | --- |
| 1 | `instance-detail.component.ts` `contextWarningLevel` | drove `[disabled]` on the composer at ≥ 95 % | **Critical** |
| 2 | hibernate/wake (`context-usage-restore.ts`, `session-continuity.ts`) | dropped the flag entirely on every round trip | High |
| 3 | `instance.queries.ts` `totalContextUsage` | summed it into the always-visible sidebar "% ctx" | High |
| 4 | `mobile-gateway-serializers.ts` | shipped it to phone clients as `contextPercentage` | High |
| 5 | `provider-diagnostics-panel.component.ts` | rendered it as "N %" with a `warning` tone ≥ 90 | Medium |

**Finding 1 is worse than the original defect.** `percentage` for an aggregate provider is
monotonically non-decreasing and clamped at 100, so *every* sufficiently long Copilot / Gemini /
non-resident-Claude / Codex-exec session eventually crosses 95 % and **disables its own composer** —
locking the user out of a session whose real context may be nearly empty. Suppressing the main
process's `checkContextWarningThreshold` did nothing for it, because the renderer keeps an entirely
independent copy of the same threshold. Two copies of a rule, one fixed.

**Finding 2 is the LT-018 trap for the third time.** `restoreContextUsage` and `instanceToState`
both rebuild `ContextUsage` field by field, and `session-continuity.types.ts` narrows the persisted
shape — so the flag was dropped with no compiler error, exactly as the LT-018 write-up warned.

### Remediation

- Finding 1: the rule is extracted to `context-warning-level.ts` as a pure
  `resolveContextWarningLevel()` with its own spec — the same treatment `context-usage-restore.ts`
  got, and for the same reason: it was an unreviewable computed inside a component with no spec and
  a large dependency graph. It now also suppresses on unreported occupancy (LT-018), which the
  original never did.
- Finding 2: flag added to `PersistedContextUsage`, `restoreContextUsage`, `instanceToState` and the
  `session-continuity.types.ts` shape. Deliberately **no** inference from the numbers for legacy
  records — spend and occupancy are indistinguishable by value, so a pre-field record is treated as
  occupancy (today's behaviour) and self-corrects on its first context event, which carries the
  adapter's real declaration.
- Findings 3-5: guarded at each surface; cost is still counted for aggregate instances, because
  billing is independent of occupancy reporting.

**23 further tests added across 6 specs, each mutation-verified** (revert the guard → the test
fails; restore → it passes). Gates green: `tsc` ×2, `lint`, `check:ts-max-loc`, `build:main`.

**The lesson, restated because it has now cost three rounds across two defects:** when a wrong number
reaches the UI, the fix is not "guard the surface that showed it" — it is "enumerate every consumer
of that number and guard all of them", and a completion gate is what catches the difference.

<a id="lt-060-archived-detail"></a>


## LT-060: Concurrent dev-app livetest runners silently collide on one shared profile

### Observed behavior

Following the campaign runbook's own recipe (`nohup npx electron . --user-data-dir=/tmp/aio-lt-batchE
--remote-debugging-port=9455 …`) while another batch's dev app (`--user-data-dir=/tmp/aio-lt-batchA`)
was already running produced an immediate self-quit:

```
[WARN] [App] Shutdown trigger observed { source: 'single-instance-lock-failed', argv: [... '--user-data-dir=/tmp/aio-lt-batchE' ...] }
```

Inspecting the already-running "batchA" process with `ps aux` showed its actual Electron Helper
(Renderer) processes launched with `--user-data-dir=/Users/suas/Library/Application Support/harness-dev`
— **not** `/tmp/aio-lt-batchA` — confirming the CLI flag never took effect for that instance either.
A CDP probe into that shared instance found three live Claude instances under
`/tmp/aio-lt-batchC-rt` (two `waiting_for_permission`), i.e. a *third* batch's work was also landed on
the same shared profile. All concurrently-launched unpackaged dev apps collapse onto one profile and
fight over the single-instance lock; only the first one to start actually runs.

### Root cause

`src/main/index.ts:57` calls `app.setPath('userData', resolveHarnessUserDataPath(...))` **before**
`app.requestSingleInstanceLock()` (line 335). `resolveHarnessUserDataPath`
(`src/main/app/user-data-path.ts`) unconditionally returns `join(appDataPath, isPackaged ? 'harness' :
'harness-dev')` for any non-smoke-test launch — it never reads Electron's own `--user-data-dir` switch
or any other override for a normal unpackaged run. Passing `--user-data-dir` on the command line has no
effect because this call overwrites whatever Electron's native bootstrap had already set.

### Required behavior

An unpackaged (dev) launch must be able to opt into a genuinely isolated user-data profile so that
multiple dev-app instances (e.g. parallel livetest runners, or a developer running two checkouts) do
not silently collapse onto the same profile and single-instance lock. Packaged/production behavior
must be unchanged.

### Fix

Added an opt-in `AIO_DEV_USER_DATA_PATH` environment override in `resolveHarnessUserDataPath`,
applied only when `!isPackaged` (mirrors the existing packaged-only `AIO_STARTUP_SMOKE_USER_DATA_PATH`
pattern) and validated absolute, same as the smoke-test override
(`src/main/app/user-data-path.ts`). Usage: `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchE npx electron .`
— no `--user-data-dir` flag needed or honored (that switch remains inert by design; the app owns its
userData path resolution deliberately, per the comment at `index.ts:48-56`).

### Verification

- 3 new tests in `src/main/app/user-data-path.spec.ts` (honors the override, ignores it when packaged,
  rejects a relative path) — reverted the fix and watched the 2 override-dependent tests fail
  (`toThrow` got `undefined` instead of the error; "5 passed, 2 failed"), then restored and watched all
  7 pass.
- `npx tsc --noEmit -p tsconfig.electron.json`, `npx tsc --noEmit -p tsconfig.spec.json`, `npx eslint
  src/main/app/user-data-path.ts src/main/app/user-data-path.spec.ts`, `npm run build:main` — all
  clean.
- Live: `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchE npx electron . --remote-debugging-port=9455` started
  cleanly (no lock failure) and `/tmp/aio-lt-batchE/` now holds a real, separate Electron profile
  (Cache, Cookies, etc.) rather than being empty. The shared `harness-dev` dev app used by other
  concurrent batches (port 9451) was left untouched throughout.

### Residual note

`npm run check:ts-max-loc` reported one pre-existing ratchet failure
(`src/renderer/app/features/instance-detail/instance-detail.component.ts`, 1634 vs 1582+50 ceiling) —
unrelated to this fix, part of the concurrently-dirty tree per the campaign brief; not touched.

<a id="lt-061-archived-detail"></a>

## LT-061: Tool-loop detector under-detects realistic Bash-tool doom loops (incidental metadata pollutes argsHash)

### Observed behavior

Sibling-audit-round2 check A2 asks: craft a prompt that makes the CLI poll an unchanging file
repeatedly; expect a warning toast after ~3 identical call/result pairs. Driven live (Batch E
isolated dev app, instance `c5ogymnv8`, Claude, yolo): asked the agent to run
`cat /tmp/aio-lt-batchE-c10/watch.txt` (an unchanging file) 8 times in a row via the Bash tool, no
other commentary. It complied — 7 `Bash` tool_use calls, each with the identical `command` field —
but the renderer's `instance:doom-loop` listener (hooked directly via
`ipcService.on('instance:doom-loop', …)` *before* the send, to rule out a toast-timing artifact)
captured **zero** events. No toast fired.

### Root cause

`toProviderToolUseObservedEvent` (`src/main/providers/adapter-runtime-event-bridge.ts:533-534`)
computes `argsHash = hashStable(stableStringify(toolCall.arguments))` over the **entire** raw
arguments object the CLI reports, unfiltered — and `instance-tool-loop-wiring.ts:49-57`
(`toToolUseObservation`) feeds it `event.input` verbatim, with no field allow/deny-list. This is
live, wired code (not the dormant WS-B10 seam the module doc discusses — `observeToolLoopEvent` is
called from `InstanceManager.emitProviderRuntimeEvent()`).

For Claude's Bash tool, the raw input is `{command, description}`, where `description` is
documented as a short human-readable annotation shown during permission prompts — cosmetic, not
part of what the command does. Claude naturally varies that text per call even when the `command`
itself is byte-identical and the file being polled never changes — in this run it produced
`"Read watch.txt (1/8)"`, `"(2/8)"`, … `"(7/8)"`. Because `argsHash` is computed over `{command,
description}` together, each call gets a **different** hash, so `checkRepeatNoProgress`
(`doom-loop-detector.ts:311-340`) never sees the same `lastSignature` twice — `repeatChainLength`
resets to 1 on every call — and the 3-in-a-row threshold is never reached. `ping-pong` has the same
exposure since it also keys on `signatureOf(toolName, argsHash)`.

### Required behavior

A realistic Bash-tool polling loop, where the command is identical and produces an unchanging
result, must trigger `repeat-no-progress` regardless of incidental per-call annotation text the CLI
includes alongside the command (Claude's `description` field being the concrete case observed;
other CLIs/tools may have analogous cosmetic fields).

### Acceptance

- A regression test on `doom-loop-detector.ts` (or the bridge/wiring layer) proves 3 Bash tool_use
  events with identical `command` but distinct `description` (e.g. `"(1/3)"`, `"(2/3)"`, `"(3/3)"`)
  and identical results now trigger `repeat-no-progress`, and that it still does **not** falsely
  trigger when the `command` itself genuinely changes between calls.
- Sibling-audit-round2 check A2's first half (toast after ~3 identical calls) passes live with a
  prompt worded like a natural doom loop, not one that artificially forces identical `description`
  text too.

### Scope note (why this was not fixed in the original session)

The narrow, defensible fix — excluding the Bash tool's `description` field from the hash — is
mechanical. Generalizing it (which fields are "cosmetic" for which other tools/providers) is a
product-judgment call that session did not make unilaterally; recorded as reproduced, not fixed.
Not fixed in that session for the same reason plus time budget; the register/plan status sections
were updated accordingly, and the finding was written up for a decision rather than acted on alone.

### Decision and fix (2026-08-12)

Went with the general fix, not the Bash-only one, per the steer in the follow-up task: a per-tool/
per-provider denylist (e.g. `toolName === 'Bash'`) rots the moment a *different* tool or CLI adds
its own annotation field under a different name — the exact scenario this task exists to prevent a
repeat of.

`toProviderToolUseObservedEvent` (`src/main/providers/adapter-runtime-event-bridge.ts`) now strips a
fixed set of top-level field names — `description`, `reason`, `rationale`, `explanation`,
`justification`, `summary`, `note`, `thought` — from the arguments object before hashing
(`stripAnnotationFieldsForHash` / `ARGS_HASH_IGNORED_ANNOTATION_FIELDS`), for **every** tool and
provider, not just Bash. `argsSummary` (the human-readable value shown in diagnostics) is
unaffected — only the loop-detection hash changes.

This is scoped by **field name**, not by tool identity, which is deliberately narrower than "detect
any cosmetic field automatically" (not achievable without per-tool schema awareness at the
observation site) but broader than "Bash's `description` only". It still needs a new entry for a
genuinely novel field-name convention, but no longer needs a change per tool or per provider.

Safety against masking a genuinely operative field that happens to share one of these names (e.g. a
hypothetical tool whose real payload lives in a field called `summary`): both `repeat-no-progress`
and `ping-pong` additionally require the tool's **result** to match/stay stable across the repeated
calls. A call whose real effect lives in one of the stripped fields will almost always produce a
different result each time, so it will not falsely collapse into "no progress" — verified by a test
that a genuinely different operative argument (with the annotation field held constant) still
produces a different `argsHash`.

**Regression tests** (all in `adapter-runtime-event-bridge.spec.ts` and `doom-loop-detector.spec.ts`,
mutation-verified — reverted the fix, watched the exact 3 tests fail, restored, watched them pass):
- Bash `command` identical / `description` varying → identical `argsHash`.
- Bash `command` genuinely different / `description` identical → different `argsHash`.
- A non-Bash, hypothetical MCP tool with a differently-named annotation field (`reason`) → identical
  `argsHash` when only `reason` varies, proving the exclusion is not gated on `toolName === 'Bash'`.
- The same hypothetical tool with a genuinely different operative argument → different `argsHash`.
- `argsSummary` still shows the full arguments including the annotation field.
- A pipeline-level test drives 3 realistic Bash `tool_use`/`tool_result` pairs (identical `command`,
  `description` `"(1/3)"`…`"(3/3)"`, identical result) through the real `toProviderToolUseObservedEvent`
  → `DoomLoopDetector.recordToolUse`/`recordToolResult`, and asserts `repeat-no-progress` fires; a
  second test with 3 genuinely different commands and formulaic step-numbered descriptions asserts it
  does **not** fire.

Gates on the touched files: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run
lint`, `npm run check:ts-max-loc`, `npm run build:main` all clean; targeted
`npm run test:quiet -- src/main/providers/adapter-runtime-event-bridge.spec.ts
src/main/orchestration/doom-loop-detector.spec.ts` — 46/46 passing.

### Live verification and scope-narrowing discovery (2026-08-12)

Drove this live in an isolated dev app (`AIO_DEV_USER_DATA_PATH`, port 9461, rebuilt `dist/main`
with the fix). First re-ran the **exact original repro shape** against **Claude** (matching the
original filer's provider choice): working dir `/tmp/aio-lt-lt061-work/watch.txt`, yolo, prompt
asking for 8 sequential `cat watch.txt` Bash calls with no other commentary. Confirmed via the raw
`outputBuffer` that Claude produced 8 calls with byte-identical `command: "cat watch.txt"` and
varying `description: "Check watch.txt contents (N/8)"` — the textbook LT-061 shape. With the fix
live, `instance:doom-loop` (hooked via `electronAPI.onInstanceDoomLoop` before the send) still
captured **zero** events.

Traced why: `bindRawAdapterProviderEvents` (`instance-communication-provider-events.ts`) — the only
production call site that emits `kind: 'tool_use'`/`'tool_result'` events into
`emitProviderRuntimeEvent` (and therefore into the tool-loop detector) — is driven purely by an
adapter's own `tool_use`/`tool_result` `EventEmitter` events. Grepping every adapter under
`src/main/cli/adapters/` for `.emit('tool_use', …)` finds exactly one hit outside test fixtures:
`acp-cli-adapter.ts`. Claude's NDJSON streaming adapter (`claude-cli-adapter.ts`) collects tool calls
into a `toolCalls` array attached to the response/`output` messages instead, and the same is true of
Codex, Gemini, Antigravity and Ollama's adapters — none of them ever call `.emit('tool_use', …)`. So
for every provider except the three that use `AcpCliAdapter` (Copilot, Cursor, Grok), the entire
WS-A2 detector is unreachable, independent of `argsHash` correctness.

Confirmed the pipeline works end-to-end where it *is* reachable: the identical prompt shape against a
**Cursor** (ACP) instance produced a live `repeat-no-progress` **warn** at count 3
(`toolName: "\`rtk cat watch.txt\`"`) and **critical** at count 6, captured by the same
`electronAPI.onInstanceDoomLoop` listener. This is separate from the LT-061 fix under test (Cursor's
ACP `execute` tool didn't happen to vary an annotation field in this run) but it proves the compiled
fix, the wiring, and the renderer IPC channel are all live and correct for a real running session —
isolating the Claude-null-result to the adapter-emission gap, not to anything in this fix.

Filed the adapter-emission gap separately as **LT-062** (below) rather than folding it into this
item, since it is a different code location and a materially different (and larger) fix, and this
item's own acceptance criteria — the `argsHash` behavior — are met and mutation-verified regardless.
LT-061's own acceptance criterion "Sibling-audit-round2 check A2's first half … passes live" is
**not yet fully satisfiable for a Claude session** because of LT-062; it does pass live for an
ACP-based provider today. A2 should be re-run once LT-062 is resolved (or explicitly re-run against
an ACP provider in the interim) to see the toast for the provider the check actually exercises.

<a id="lt-062-archived-detail"></a>


## LT-062: The WS-A2 tool-loop detector never receives an observation for Claude/Codex/Gemini/Antigravity/Ollama sessions

**Status: FIXED 2026-08-12, verified live.** Found 2026-08-12 while live-verifying the LT-061 fix;
fixed in a follow-up session the same day. See "Fix (2026-08-12)" below for the fix, a correction to
this section's original root cause for Claude specifically, and live verification.

### Observed behavior

Reproduced LT-061's exact original scenario against **Claude** in an isolated dev app: an 8-call
`cat watch.txt` Bash polling loop with identical `command` and only `description` varying (the
textbook shape). Confirmed via `outputBuffer` that the calls were byte-identical on `command`. With
the LT-061 `argsHash` fix live and compiled into `dist/main`, `instance:doom-loop` (hooked via
`electronAPI.onInstanceDoomLoop` before the send) still captured **zero** events.

The same prompt shape, same working directory, against a **Cursor** instance (also isolated dev app,
same build) produced a real `repeat-no-progress` **warn** (count 3) then **critical** (count 6)
through the same listener — so the detector, the renderer IPC channel, and the LT-061 fix are all
confirmed live and correct; only Claude (and, by the same code-path argument below, Codex, Gemini,
Antigravity and Ollama) never reach it.

### Root cause

`bindRawAdapterProviderEvents()` (`src/main/instance/instance-communication-provider-events.ts:30-56`)
is the only production call site that emits `kind: 'tool_use'`/`kind: 'tool_result'`
`ProviderRuntimeEvent`s into `emitProviderRuntimeEvent()` — the funnel `InstanceManager` uses to
reach `observeToolLoopEvent()` (`instance-manager.ts:1229`). That function is driven entirely by an
adapter's own `EventEmitter` events: `adapter.on('tool_use', …)` / `adapter.on('tool_result', …)`.

Grepping every file under `src/main/cli/adapters/` for `.emit('tool_use', …)` (outside test-only
fixtures — `scripted-cli-adapter.ts`, `out-of-process-fixture-adapter.ts`) finds exactly one
production hit: `acp-cli-adapter.ts:1346` (and `:1418` for `tool_result`). `AcpCliAdapter` backs only
three of AIO's providers — `createCopilotAdapter`, `createCursorAdapter`, `createGrokAdapter`
(`adapter-factory.ts`).

Every other provider surfaces tool activity a different way and never calls `.emit('tool_use', …)`:
- Claude (`claude-cli-adapter.ts`): NDJSON `tool_use` blocks are pushed into a `toolCalls` array
  (`claude-cli-adapter.ts:921-925`) and separately turned into `output` messages of
  `type: 'tool_use'`/`'tool_result'`.
- Codex (`codex-cli-adapter.ts` → `CodexAppServerTurnAdapter`): `buildToolCallsFromTurnState()`
  (`codex-app-server-turn-adapter.ts:345-375`) does the same from turn-state command executions.
- Gemini, Antigravity, Ollama: same shape — no `.emit('tool_use', …)`/`.emit('tool_result', …)`
  anywhere in their adapter files.

`InstanceCommunicationManager`'s `adapter.on('output', …)` handler (`instance-communication.ts:1152-`)
does see these `type: 'tool_use'`/`'tool_result'` output messages (it uses them for circuit-breaker
resets and `toolResultProcessor.processToolLifecycle`), but never forwards them into
`emitProviderRuntimeEvent()` with a `tool_use`/`tool_result` **kind** — that only happens for the
separate ACP-only `EventEmitter` events. So for non-ACP providers, `observeToolLoopEvent()` is never
called with a `tool_use`/`tool_result` event at all, and `recordToolUse`/`recordToolResult` are never
invoked — independent of, and unfixable by, anything in `argsHash` computation (LT-061).

The `instance-tool-loop-wiring.ts` module doc's claim that wiring the detector in
`emitProviderRuntimeEvent()` "covers ordinary sessions" is true only for ACP-based sessions; it does
not hold for the default/most-used provider (Claude) or for Codex, Gemini, Antigravity or Ollama.

### Required behavior

A realistic tool-call polling loop must be observable by the tool-loop detector for **every**
provider AIO supports launching a session with — not only the three that happen to route through
`AcpCliAdapter`. At minimum, Claude (the default provider) must reach the detector.

### Acceptance

- A regression test proves that a Claude (or Codex/Gemini/Antigravity/Ollama) `tool_use`/`tool_result`
  pair — via whatever event path that provider actually surfaces it on (today: `output` messages of
  `type: 'tool_use'`/`'tool_result'`) — reaches `DoomLoopDetector.recordToolUse`/`recordToolResult`.
- Sibling-audit-round2 check A2 passes live against a **Claude** instance (the check's original and
  default provider), not only against an ACP-based one.
- Existing ACP-provider behavior (Copilot/Cursor/Grok) is unchanged — no regression on the path
  proven live in the LT-061 verification run.

### Scope note (why this was not fixed in this session)

This session's task was scoped to LT-061 (the `argsHash` computation). This is a different code
location — bridging `output`-message tool events into `emitProviderRuntimeEvent()` for every
non-ACP adapter, most likely inside `InstanceCommunicationManager`'s `output` handler
(`instance-communication.ts`) alongside the existing `toolResultProcessor.processToolLifecycle` call
— and a materially larger change than a session scoped to a single hash-computation fix should make
unilaterally, particularly given how many call sites already branch on `message.type ===
'tool_use' || message.type === 'tool_result'` in that handler and would need to be checked for
double-emission or ordering conflicts with the ACP path. Recorded as reproduced with a live
repro, root cause, and acceptance criteria; not fixed.

### Fix (2026-08-12)

**Correction to the root cause above.** Re-verifying live (dev app, `AIO_DEV_USER_DATA_PATH`, port
9468) before building on the filed diagnosis found one claim in it was subtly wrong: "Claude
… separately turned into `output` messages of `type: 'tool_use'`/`'tool_result'`" is only true for
the `tool_use` half. Dumping a live Claude session's `outputBuffer` for the exact 8-call polling
repro showed 8 `tool_use` output messages and **zero** `tool_result` output messages — reading
`claude-cli-adapter.ts`'s `case 'user':` handler confirms why: a `tool_result` content block only
ever becomes a visible `'output'` message on the permission-denial branch; an ordinary
success/failure (the common case, including this repro) is never surfaced as any kind of event at
all in the modern streaming path — not as `'output'`, and (per the original diagnosis) not as a raw
`EventEmitter` event either. A pure message-layer bridge therefore cannot pair Claude's calls; it
can only ever see the `tool_use` half.

**Two-part fix, both additive and non-UI:**

1. **General `output`-message bridge** (`instance-tool-loop-wiring.ts`, `resolveToolLoopObservation`)
   — `observeToolLoopEvent()` now also accepts a `ProviderRuntimeEvent` of `kind: 'output'` whose
   `messageType` is `'tool_use'`/`'tool_result'`, extracting `toolName`/`callId`/args or result from
   the `OutputMessage.metadata` (checking `id`/`toolCallId`/`tool_use_id`/`toolUseId` in priority
   order — different adapters use different keys) and routing it through the same
   `toProviderToolUseObservedEvent`/`toProviderToolResultObservedEvent` normalizers (so LT-061's
   annotation-field stripping applies uniformly). Gated on `metadata.transport !== 'acp'`, because
   `AcpCliAdapter` already emits a raw `tool_use`/`tool_result` `EventEmitter` event for the same
   call *and* an `'output'` echo of it (`acp-cli-adapter.ts:1346-1367`, `:1391-1420`) — without the
   gate, an ACP call would be recorded twice per turn. This covers Claude's `tool_use` half and
   whatever `output` tool activity Codex/Gemini/Antigravity/Ollama already surface.
2. **Claude-specific raw `tool_result` emit** (`claude-cli-adapter.ts`, inside the `case 'user':`
   content-block loop) — for every `tool_result` block with string content, regardless of
   success/failure/permission-denial, the adapter now also does
   `this.emit('tool_result', { id: tool_use_id, name, arguments, result })` — the exact raw
   `EventEmitter` event `AcpCliAdapter` already emits, consumed only by
   `bindRawAdapterProviderEvents()` (→ the loop detector) and context-evidence capture, **never**
   the rendered chat transcript (which is driven by `'output'` events only). This closes Claude's
   `tool_result` gap without changing what the user sees. Whether Claude's transcript should also
   *render* `tool_result` content the way ACP/Codex/Gemini adapters already do for their users is a
   separate product decision, not decided here.

Together, one path in per half: Claude's `tool_use` reaches the detector via bridge (1); its
`tool_result` reaches it via raw-emit (2) — two different halves of the same pair, not duplicate
coverage of the same event, so there is no double-count risk between them.

**Known residual, not fixed this session.** Codex's real-time command-execution `tool_use`/
`tool_result` `output` items (`codex-app-server-notification-adapter.ts`) and Gemini's tool events
carry **no correlation id at all** in their metadata — bridge (1) cannot invent one, so those calls
still only increment `runaway`'s total-call counter; `repeat-no-progress`/`ping-pong` still cannot
pair them. Fixing that would need an adapter-level change analogous to fix (2), scoped per adapter,
and was out of this session's budget once Claude (the acceptance bar's minimum, and the provider the
original repro used) was solid.

**Tests, mutation-verified** (reverted the fix, watched the listed tests fail, restored, watched
them pass):
- `src/main/instance/instance-tool-loop-wiring.spec.ts` (new) — Claude-shaped `tool_use` output
  paired with a raw `tool_result` fires `repeat-no-progress`; genuinely different commands do not;
  an ACP `output` echo alongside its own raw `tool_use`/`tool_result` is not double-counted; a
  Codex-shaped `tool_use` output with no id still counts toward `runaway`.
- `src/main/cli/adapters/claude-cli-adapter.spec.ts` — a normal successful `tool_result` block emits
  the raw `tool_result` event with no matching `'output'` message; repeated identical calls each
  emit one; structured (non-string) content is skipped.
- `src/main/instance/__tests__/instance-manager.normalized-event.spec.ts` — the same two proof cases
  through the real `InstanceManager.emitProviderRuntimeEvent()` entry point, not just the wiring
  module in isolation.

Gates on the touched files: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`,
`npm run lint`, `npm run build:main` all clean; targeted
`npm run test:quiet -- src/main/instance/instance-tool-loop-wiring.spec.ts
src/main/cli/adapters/claude-cli-adapter.spec.ts
src/main/instance/__tests__/instance-manager.normalized-event.spec.ts
src/main/orchestration/doom-loop-detector.spec.ts` — 80/80 passing.
`npm run check:ts-max-loc` reports `claude-cli-adapter.ts` over its ratchet ceiling, but this file
was being edited concurrently by another uncommitted fix (LT-047, `residentTurnRawOutput`) in the
same shared working tree throughout this session; this fix's own net contribution to the file is 13
lines, and the file was already ~27 lines over its tolerance-adjusted ceiling from HEAD alone before
any of today's session's uncommitted work landed. Not something this fix can resolve unilaterally in
a shared tree — flagged for whoever consolidates/commits this session's work.

### Live verification (2026-08-12)

Rebuilt `dist/main` (`npm run build:main`) and restarted the isolated dev app (`AIO_DEV_USER_DATA_PATH`,
port 9468) to pick it up. Created a fresh Claude yolo instance, hooked `electronAPI.onInstanceDoomLoop`
before sending, then re-ran the **exact original LT-062 repro shape**: 8 sequential `cat watch.txt`
Bash calls with no other commentary. Where the original repro captured zero events, this run captured:

```json
[
  { "detector": "repeat-no-progress", "severity": "warn",     "toolName": "Bash", "count": 3 },
  { "detector": "repeat-no-progress", "severity": "critical", "toolName": "Bash", "count": 6 }
]
```

Confirms the fix reaches a live, real, unmocked Claude session end to end — not just the unit/pipeline
tests. Instance terminated and dev app stopped after capture.

<a id="lt-065-archived-detail"></a>


## LT-065: The WS5 workspace-write observer silently drops every change on a symlinked workspace path

**Found:** 2026-08-12, running loop-convergence-and-cost-safety check 5 (degraded invocation with a
workspace write parks visibly).

### Observed behavior

A dev-app loop (Claude, `same-session`, `review-driven` completion, workspace `/tmp/aio-lt-degraded`)
was asked to create `write1.txt`, run a long Bash command, then create `write2.txt`. Once
`write1.txt` existed on disk (confirmed with `ls`/`stat`), the parent Claude CLI process was killed
with `kill -9` after the standard PID-gating checks (new since this session, `ppid` matched the dev
app's Electron main pid, command line matched `claude --print …`).

The killed iteration (`seq 0`) did **not** pause for review. It logged `Orchestration invocation
completed` (43 tokens, cost 0 — a truncated turn) followed immediately by `Loop workspace observation
completed … coverage: "complete" … changedPathCount: 0`, and the coordinator auto-retried on a fresh
iteration 4 seconds later. The retry (`seq 1`) ran a full, un-killed 129-second turn that created
`write2.txt` as well — and **also** logged `changedPathCount: 0`. `ITERATION_LOG.md` recorded "files
changed: 0" for both iterations despite two real, verified-on-disk file writes. `git status
--porcelain` in the workspace confirmed both files were genuinely untracked/new the whole time.

A differential test isolated the cause: the identical single-file-write scenario run against a
workspace **outside** `/tmp` (`_scratch/lt-2026-08-11/repro-nosymlink`, not a symlink) correctly
logged "files changed: 1" on the very first iteration.

### Root cause

`createAttemptDeltaObserver` (`src/main/orchestration/loop-attempt-observation.ts:49`, pre-fix) set
`const workspace = path.resolve(workspaceDir)` — a plain absolute-path normalization that does **not**
resolve symlinks. It then called `discoverWorkspaceRepositories(workspace)`
(`src/main/orchestration/loop-workspace-repositories.ts:27-33`), whose `containingGitRoot` runs `git
rev-parse --show-toplevel` — a command that **always** returns the REAL (symlink-resolved) path. On
macOS, `/tmp` is a symlink to `/private/tmp`, so for a workspace like `/tmp/aio-lt-degraded` the
observer's own `workspace` stayed `/tmp/aio-lt-degraded` while the discovered authoritative git root
came back as `/private/tmp/aio-lt-degraded`.

`toWorkspaceFileChange(workspace, repoRoot, repoPath)`
(`src/main/orchestration/loop-attempt-observation.ts:155-162`) then computed
`path.relative(workspace, absolutePath)` with those two divergent roots. Node's `path.relative` does
not resolve symlinks either — it string/segment-compares the two absolute paths — so the result for
every single file was `../private/tmp/aio-lt-degraded/<file>`, which starts with `../` and hits the
existing "outside the workspace" guard (`if (!workspacePath || workspacePath === '..' ||
workspacePath.startsWith('../')) return null;`), silently discarding every real change. `coverage`
still reported `'complete'` (the underlying `git` commands all ran successfully) so this was never
visible as a degraded-observation warning — it looked exactly like a clean, no-op turn.

The five pre-existing tests in `loop-attempt-observation.spec.ts` all construct nested-repository
fixtures where the workspace root itself is **not** a git repo (`containingGitRoot` fails, discovery
falls back to a BFS scan that starts from — and stays consistent with — the un-resolved `workspace`),
so none of them exercised the "workspace root IS the sole git repo, reached through a symlink" shape
that this defect needs.

### Required behavior

A real workspace write made during an attempt (killed, degraded, or a normal successful turn) must be
detected regardless of whether the configured `workspaceCwd` is reached through a symlink. A degraded
or killed attempt with real writes must report `workspaceEffect: 'writes-observed'` and the changed
path list, so the coordinator pauses for review with sealed evidence instead of auto-retrying.

### Fix

Added `resolveWorkspaceRoot()` in `loop-attempt-observation.ts`, which resolves `workspaceDir` through
`fs.realpathSync` (matching what `git rev-parse --show-toplevel` will independently return) and falls
back to the previous plain `path.resolve` when the target doesn't exist yet (preserving the existing
"workspace root could not be read" `coverage: 'failed'` behavior, which needs `realpathSync` to throw,
not succeed). `createAttemptDeltaObserver` now calls this instead of `path.resolve` directly. Because
`discoverWorkspaceRepositories` receives the already-realpath'd `workspace` as its own `workspaceDir`
argument, its internal `path.resolve` on an already-real absolute path is a no-op, so both the
authoritative-root and nested-BFS-discovery paths stay consistent with the observer's own `workspace`.

### Verification

- New regression test `loop-attempt-observation.spec.ts` → "still observes a new file when
  workspaceDir is reached through a symlink" — builds a real git repo, symlinks to it (portable, does
  not rely on macOS's own `/tmp` behavior), writes a new file through the symlink path, and asserts
  `observation.changes` and `workspaceEffect: 'writes-observed'`. **Watched it fail against the
  pre-fix source** (`expected [] to deeply equal ['write1.txt']`), then pass after the fix.
- `npm run test:quiet -- src/main/orchestration/loop-attempt-observation.spec.ts` — 6/6 passing (5
  pre-existing + the new one).
- `npm run test:quiet -- src/main/orchestration/loop-workspace-repositories.spec.ts
  src/main/orchestration/loop-repo-state.spec.ts src/main/orchestration/loop-invocation-attempt.spec.ts`
  — 21/21 passing, no regressions in the adjacent modules that share this code path.
- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run
  check:ts-max-loc`, `npm run build:main` — all clean (the file was not already on the LOC-ratchet
  allowlist and stayed under its ceiling).

<a id="lt-090-archived-detail"></a>


## LT-090: Codex resident turns also never record cost — `response.usage` is undefined on `'complete'`

**Found:** 2026-08-12, investigating LT-047's cost-tracking claim.

### Observed behaviour

While verifying LT-047 (cost tracking broken for resident Claude turns because `'complete'` never
fired), the Codex control used to prove the contrast turned up a second, independent gap. `'complete'`
fires reliably for resident Codex turns (3/3 across the whole investigation), but on every sampled turn
the `onProviderRuntimeEvent` payload's `response.usage` was `undefined` — reproduced on: a trivial
one-word reply, a substantive ~200-word prose answer, and a tool-using turn (a real `Bash`/shell
`command_execution` call with a captured result). `costGetEntries`/`costGetSummary` for that Codex
instance returned 0 entries across all of it, identical in symptom to the pre-fix Claude behaviour but
via a completely different mechanism (the handler runs; the data it needs is just never attached).

### Root cause

Not pinned down — flagged, not fully chased (small sample, would need a wider repro before committing to
a fix). `codex-app-server-turn-adapter.ts:235` builds the `'complete'` response's `usage` field only from
`turnState.finalTurn?.usage` — i.e. the `usage` property of the `turn` object delivered on the
`turn/completed` notification (`codex-app-server-notification-adapter.ts:347-363` →
`completeTurn(state, turn)`). In all three sampled turns that field was empty. Real per-turn token/cost
numbers *do* arrive in the same session, but via a structurally separate notification —
`thread/tokenUsage/updated` (`codex-app-server-notification-adapter.ts:367+`), which the adapter maps to
its own `'context'` event (observed firing, with real numbers, in the same test run) and which
`codex-app-server-turn-adapter.ts` does not consult when building the `'complete'` response. Two
candidate explanations, neither confirmed: (a) this app-server/CLI version simply never attaches `usage`
to `turn/completed` and always relies on the decoupled token-usage channel, making
`turnState.finalTurn?.usage` effectively dead code; (b) `usage` is populated only under conditions not
sampled here (e.g. specific turn shapes, an app-server capability flag). The `'context'` event fires
*after* `'complete'` in the observed ordering, which is at least consistent with (a) — usage becomes
known too late for the response object already handed to `completeResponse()`.

### Required behaviour

`recordCompletionCost` should record a real cost/usage entry for a resident Codex turn whenever real
usage numbers are available for that turn, whether they arrive on `turn/completed` or
`thread/tokenUsage/updated` — a `'complete'` event firing should not by itself be treated as evidence
that cost was recorded for Codex, since it can fire with `usage: undefined` (silently, no error).

### Impact

Same class of impact as LT-047 (cost tracking, calibration telemetry both gated on `response.usage`),
but for Codex — and via a mechanism that would have been invisible to the fix that resolved LT-047, since
that fix only changed *when* Claude calls `completeResponse()`, not how `usage` is sourced. Not
characterized how often this occurs for Codex outside this small sample (3 turns, 1 session, 1 test
account) — do not read "0/3" as a confirmed 100% failure rate without a larger repro.

### Verification

Not fixed this session — time-boxed; flagging the finding with exact reproduction steps rather than
guessing at a fix for an under-characterized root cause. Evidence is real `onProviderRuntimeEvent`
payloads and `costGetEntries`/`costGetSummary` reads against a live, rebuilt dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-lt047`, isolated profile), not inference from source alone.

### Fix and live re-verification — 2026-08-12, cost-tracking follow-up batch

**Re-verified the filed claim first, independently, before touching code.** Rebuilt the app, launched an
isolated dev profile (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-cost`), created a fresh resident Codex instance,
and drove one real tool-using turn (`ls`-equivalent shell command). Confirmed: `'complete'` fired with
`tokensUsed`/`costUsd` **absent** from the envelope, and `costGetEntries`/`costGetSummary` showed **0**
entries for the instance — the filed symptom reproduced exactly, on the first attempt, with fresh evidence.

**Root cause pinned down** (was previously "not established" — now confirmed candidate (a) from the
original write-up): `thread/tokenUsage/updated`'s `last` sample already carries a full per-call breakdown
— `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningOutputTokens` — not just the `totalTokens`
figure the adapter was already using for the context-occupancy bar
(`codex-app-server-notification-adapter.ts`, `case 'thread/tokenUsage/updated'`). `turn/completed`'s own
`usage` field was empty on every sampled turn in this app-server build; the breakdown data was real and
available, just never captured or consulted when `codex-app-server-turn-adapter.ts` built the `'complete'`
response.

**Fix**: `codex-base-adapter.ts` gained a `lastTurnUsageBreakdown` field (reset to `null` at the top of
every turn, alongside the existing `hasTokenUsageNotification` reset, so a turn that receives no
notification at all never reuses a stale sample from the previous turn). The notification handler
populates it whenever `thread/tokenUsage/updated` reports real per-call occupancy (extraction moved to a
new `codex/token-usage-breakdown.ts` to keep the notification-adapter file under its LOC ceiling).
`codex-app-server-turn-adapter.ts`'s response-building step now has an `else if (this.lastTurnUsageBreakdown)`
branch, mutually exclusive with the existing `turnState.finalTurn?.usage` branch, so a turn's cost is never
counted twice: when `turn.usage` is present, behaviour is byte-for-byte unchanged; when it is absent but a
same-turn token-usage notification arrived, the response's `usage` (and the cost added to
`cumulativeCostUsd`) is built from the captured breakdown instead of being silently dropped.
`cumulativeTokensUsed` is deliberately left untouched in the new branch — the notification handler already
applied it in real time when the notification arrived, so touching it again would double-count.

**Live re-verification post-fix**, same rebuilt/relaunched isolated profile: created a fresh Codex resident
instance and drove two more real turns (a tool-using `ls`-style command, then a one-word `"ok"` reply).
Both fired `'complete'` with real `tokensUsed`/`costUsd` (e.g. `{tokensUsed: 27474, costUsd: 0.152151924}`),
and `costGetEntries` showed exactly 2 entries afterward (was 0/2 before the fix) — `requestCount` in
`costGetSummary` incremented by exactly 1 per turn, confirming no double-count against the
`turnState.finalTurn?.usage` path. Also re-verified LT-047's resident-Claude fix remained intact after this
session's unrelated `buildArgs` extraction from `claude-cli-adapter.ts` (Task 1, LOC ratchet): one real
Claude turn recorded one correct cost entry (`cost: 0.421777`, real cache/input/output split).

**Regression tests**: three new tests in `codex-cli-adapter.app-server.spec.ts` ("LT-090: cost tracking
when turn/completed has no usage") — records real cost from the fallback when `turn.usage` is absent;
leaves `usage` undefined (no fabricated zero-cost entry) when neither source has data; and confirms a
second turn with no notification does **not** reuse the first turn's stale breakdown. All three
mutation-verified: disabling the fallback branch failed the first and third tests; removing only the
per-turn reset line failed the third test in isolation. Gates: `npx tsc --noEmit`, `npx tsc --noEmit -p
tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, and the targeted
Claude/Codex adapter spec files (249 tests) all pass.

**New finding surfaced by the same investigation, filed separately**: Cursor and Grok (both routed through
the shared `AcpCliAdapter`, not the legacy `cursor-cli-adapter.ts`/similar per-provider files) also recorded
**zero** cost entries for real turns in the same session — filed as **LT-100**, a different-shaped gap (the
ACP server itself never reports `usage` on `session/prompt`, and the adapter correctly declines to fabricate
one), not fixed this session — see LT-100 for the product decision this needs.

<a id="lt-095-archived-detail"></a>


## LT-095: No UI exists to approve or deny a `computer.request_app_grant` request

**Found:** 2026-08-12, batch CU, running Computer Use consent/targeting checks 1 and 4 (now
unblocked from LT-040, which was fixed earlier the same day).
**Source evidence:** [Computer Use consent/targeting evidence](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md#evidence-run--2026-08-12-batch-cu--checks-1-and-4-blocked-by-a-new-defect-lt-095)

### Observed behaviour

With LT-040 fixed and rebuilt, a real Claude yolo instance (`c8q1l2i8y`, isolated dev app
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-cu`, port 9470) called
`mcp__harness-computer-use__computer_request_app_grant` for `com.apple.calculator` /
`observeAndInput` / `boundedMinutes` / 1 minute. The call returned a real pending request
(`requestId: grant_znv2sv82b2`, `status: pending`, `expiresAt` 60s out). No approval UI of any kind
appeared in the renderer during the pending window — checked by reading `document.body.innerText`
and querying for any `[class*="modal"]`/`[class*="dialog"]`/`[class*="approval"]`/
`[class*="permission"]` element over CDP immediately after the request was created: zero matches, no
text mentioning the grant or the app anywhere in the DOM.

After the 60-second window, `computer_get_approval_status` returned `status: "expired"`, and
`computer_get_audit_log` (unfiltered) showed the real internal sequence: `computer.request_app_grant`
→ `allowed`/`ok` at `t+0`, then `computer.resolve_app_grant` → `denied`/`not_run`/
`computer_use_grant_expired` at `t+60005ms` (a real audit entry, not a client-side artifact — see Root
cause for why this is not itself a bug), then `computer.get_approval_status` → `allowed`/`ok` (a
status-read entry) when polled later. **No entry anywhere had `decidedBy: 'auto_approve'`** — the
ACP-YOLO auto-approval restriction from the plan's Task 1 is holding correctly. But no entry had
`decidedBy: 'user'` either, because nothing in the app can ever produce that decision.

Separately, Step 7 of check 1 (ACP-transport YOLO auto-approval must still work) was verified
**working correctly**: a real Cursor (`cursor`, ACP transport) yolo instance (`uphw6ahee`) was asked
to write and read back a file; the `Edit File`/`Read File` ACP tool calls completed in under 3
seconds with no pause, and `probe.txt` was confirmed on disk with the exact expected content. ACP
YOLO auto-approval is unaffected by the Task 1 restriction to `details.transport === 'acp'`.

### Root cause

Traced the full call graph for `computer.request_app_grant`:
`desktop-grant-approval-controller.ts`'s `requestPermissionRegistryApproval()` (line 222) calls
`PermissionRegistry.requestPermission()` (`src/main/orchestration/permission-registry.ts:42`), which
returns a Promise that resolves only via `PermissionRegistry.resolve()` (line 51) — called from
exactly three places in the whole codebase: (1) `registerAcpYoloAutoApproval`'s YOLO listener, gated
to `details.transport === 'acp'` (correctly excludes desktop grants, by design, per the very fix this
plan shipped); (2) the registry's own internal `setTimeout(..., request.timeoutMs)` auto-deny; (3)
`PermissionRegistry.clearForInstance()` on instance removal. **There is no fourth call site.** No IPC
channel, preload export, or renderer component anywhere in `src/main/ipc/`, `src/preload/`, or
`src/renderer/` calls `PermissionRegistry.resolve()`, subscribes to its `'permission:requested'`
event for display, or exposes any "approve/deny this pending request" action to a human. Confirmed
by exhaustive grep across all three trees for `PermissionRegistry`, `permission:requested`,
`desktop_computer_use_grant`, `requestAppGrant`, and `DesktopGrantRequestStatus` — the only renderer
files that reference Computer Use grants at all
(`computer-use-permission.store.ts`/`-banner.component.ts`) are about macOS **Screen
Recording/Accessibility system-permission** health, an unrelated concern.

This is a structural gap, not a narrow bug: the *same* `PermissionRegistry` primitive is also used,
with the identical no-UI shape, by `orchestrator-tools-step.ts`'s App Store/Google Play release-gate
approval and its Microsoft-calendar-mutation approval (`decision.decidedBy === 'user'` is checked at
both call sites, but nothing can ever produce that value either). ACP tool-permission requests are
the **only** consumer of `PermissionRegistry` with a real UI, because `acp-cli-adapter.ts` separately
emits an `input_required` chat message with approve/deny buttons (`buildPermissionPrompt`) alongside
its `PermissionRegistry` call — `desktop-grant-approval-controller.ts` has no equivalent emission.

**Consequence for the livetest doc:** Check 1's steps 3–6 (deny in the UI, confirm denial reason,
approve in the UI, confirm the resulting grant's fields) cannot be run — there is no UI to click.
Check 4 requires "the approved test window", i.e. a real, humanly-approved grant as its precondition;
since no grant can ever be approved through any human-reachable path, check 4 is blocked by the same
root cause, one step further downstream.

### Required behaviour

An operator needs some real, discoverable way to approve or deny a pending `computer.request_app_grant`
request before the 60-second window lapses — a UI surface of some kind (a chat-style approval message
like ACP's, a modal, a toast, a dedicated Settings-tab list) needs to actually call
`getPermissionRegistry().resolve(requestId, granted, 'user')` (or an equivalent new IPC path) from a
real user action. Which surface, and whether the fix should share plumbing with the also-broken
App Store/Play/calendar-mutation approvals on the same primitive, is a product/UX decision — not
picked unilaterally here per this campaign's fixing rules.

### Fix — 2026-08-12 (audit-appId sub-defect only; the "no UI" finding itself is NOT fixed)

A smaller, mechanical, non-product-decision defect was found and fixed on the same code path while
investigating: `desktop-grant-approval-controller.ts`'s `audit()` calls in `requestAppGrant` (line
109), `getApprovalStatus` (line 128), and both branches of `resolveAppGrant` (lines 159 and 166)
omitted the dedicated `appId` positional argument (7th parameter of
`DesktopGrantApprovalControllerDeps.audit`), passing the app id only inside the free-form
`redactedMetadata` blob instead. `DesktopGatewayService.getAuditLog()` filters by the dedicated
top-level `appId` DB column (`desktop-gateway-service.ts:346-350`), so `computer.get_audit_log`
filtered by `appId` silently returned zero rows for the entire request/poll/deny-or-expire grant
lifecycle even when real, correctly-ordered audit entries for that exact app existed — reproduced
live (see Observed behaviour) and by a new regression test. Fixed by threading `appId` through to
all four `audit()` call sites in that file.

**Regression test:** `src/main/desktop-gateway/desktop-gateway-service.spec.ts` — "records the appId
on every audit entry in a request/deny grant lifecycle so an appId-filtered log finds it". Mutation-
verified: reverted the fix, watched the new test fail (`expected [] to have a length of 2 but got
+0`), restored, watched all 37 tests in the file pass.

**Gates (files touched only):** `npx tsc --noEmit` clean, `npx tsc --noEmit -p tsconfig.spec.json`
clean, `npm run lint` clean, `npm run check:ts-max-loc` clean (neither touched file listed),
`npm run build:main` clean, `npm run test:quiet -- src/main/desktop-gateway/desktop-gateway-service.spec.ts`
37/37 passing. Verified via the mutation-tested unit test, not re-verified live in a running app after
the rebuild (the running dev app used for the live finding above predates this fix; this is a
narrow audit-completeness fix with no behavioural effect on grant approval/denial itself, so it was
judged not worth another live cycle within this session's time budget).

**Files touched:**
- `src/main/desktop-gateway/desktop-grant-approval-controller.ts`
- `src/main/desktop-gateway/desktop-gateway-service.spec.ts`

### Fix — 2026-08-12 (the "no UI" finding itself, now FIXED and live-verified)

Per James's instruction ("whatever you recommend, but be generous"), built a generic approval
surface for `PermissionRegistry` rather than a Computer-Use-only affordance, after confirming the
sibling-gap claim above by tracing `orchestrator-tools-step.ts`'s `authorizeReleaseMutation` (line
282) and `authorizeCalendarMutation` (line 307): both call the exact same
`getPermissionRegistry().requestPermission()` → `decision.granted && decision.decidedBy === 'user'`
pattern as the desktop grant, with a longer 5-minute `timeoutMs` (vs. the desktop grant's 60s). One
surface now serves all three.

**Backend:**
- `PermissionRegistry.extend(requestId, extraMs)` (`src/main/orchestration/permission-registry.ts`) —
  new. Replaces a pending request's timer, extending its effective `timeoutMs` from "now" rather than
  from `createdAt`, so a human reviewing the 60-second Computer Use window isn't racing the clock.
  Also added `getPending(requestId)` for existence checks. `PermissionRegistry.resolve()` itself was
  unchanged — it was always safe to call, just unreachable.
- New IPC surface: `permission-registry:list-pending` / `:resolve` / `:extend`
  (`packages/contracts/src/channels/permission-registry.channels.ts`,
  `src/main/ipc/handlers/permission-registry-handlers.ts`, registered in `ipc-main-handler.ts` next
  to the desktop-gateway handlers). Zod schemas in
  `src/shared/validation/permission-registry-schemas.ts`. `list-pending` enriches each item with the
  requesting instance's `displayName`/`provider` and a precomputed `expiresAt`, and **excludes**
  `details.transport === 'acp'` requests — ACP tool-permission requests already have a working
  approval path via `acp-cli-adapter.ts`'s `input_required` chat flow (confirmed by tracing
  `resolvePermissionDecision`); surfacing them here too would create a second, racing resolver for
  the same pending CLI RPC call, which was out of scope to also touch.
- Preload: `src/preload/domains/permission-registry.preload.ts`, wired into `preload.ts`.

**Renderer:** `PendingApprovalsBannerComponent`
(`src/renderer/app/core/state/pending-approvals-banner.component.ts`, standalone/OnPush/`inject()`,
polls every 2.5s) mounted at app root in `app.component.html` next to
`BrowserApprovalsBannerComponent` — the closest existing precedent for "surface every pending
cross-instance approval at the app root and poll" (`browser-approval-request.component.ts` is the
equivalent instance-scoped precedent the task brief named). Shows every pending request (not just the
oldest) with: a risk badge (`pending-approvals-banner.rules.ts` — `store_release_mutation` is
`critical`; the desktop grant and calendar flows are `warning`), the request's own human-readable
`description` (already fully formed by the request's source — e.g. "Allow Computer Use
observeAndInput for com.apple.calculator" — so no per-action copy was hand-rolled), which
instance/provider is asking, `toolName`, a live countdown, and a compact `details` summary.
Approve/Deny/**+2 min** buttons per item.

**Extend vs. pause-on-visibility:** the brief asked to consider extend/defer or pausing the timeout
while visible. Chose extend (a registry method + a button) over an auto-pause-while-rendered
heuristic — pausing would need a signal that a human is actually looking at the specific item (not
just that the banner mounted), and Computer Use's fail-closed short window is a deliberate security
property elsewhere in the same plan family; a bounded, explicit, human-initiated extension keeps
that property while giving a real 2-minute reprieve.

**Regression tests, each mutation-verified (reverted the fix, watched the new/renamed test fail;
restored, watched it pass again):**
- `src/main/orchestration/__tests__/permission-registry.spec.ts` — `extend()` pushes the deadline out
  and survives past the original deadline; `extend()` on an unknown/resolved request is a no-op;
  `getPending()` returns the live request or `undefined`.
- `src/main/ipc/handlers/__tests__/permission-registry-handlers.spec.ts` — lists a real pending
  request end-to-end with instance enrichment (**this is the reachability test**: it drives the exact
  `requestPermission()` → IPC → response path the defect made impossible); excludes ACP-transport
  requests; filters by `instanceId`; resolve(granted) approves and unblocks the awaited
  `requestPermission()` promise; resolve(denied) denies it; resolve() on an unknown id returns
  `PERMISSION_REGISTRY_NOT_PENDING` instead of silently no-op-succeeding; extend() returns the updated
  item; a malformed payload is rejected by the Zod schema before touching the registry.
- `src/renderer/app/core/state/pending-approvals-banner.rules.spec.ts` — risk classification per
  action, countdown formatting, details formatting.
- `src/renderer/app/core/state/pending-approvals-banner.component.spec.ts` — renders full context for
  a pending item (instance, description, tool, details, risk badge); marks a store-release request
  critical; Approve calls `resolve(id, true)`; Deny calls `resolve(id, false)`; Extend calls
  `extend(id, 120_000)`.

**Live verification (isolated dev app, `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-095`, CDP port 9475,
`computerUseEnabled` set true for that profile, deleted afterward with the profile):** spawned a real
yolo Claude instance and asked it to call
`mcp__harness-computer-use__computer_request_app_grant` for `com.apple.calculator` /
`observeAndInput` / 1 minute. The request appeared in `permission-registry:list-pending` and, with
focus/visibility emulation enabled over CDP, in the live DOM banner within its 60s window. Clicked
the real **Approve** button in the DOM — `desktopListGrants` then showed a real grant
(`desktop_grant_oin2gpftu_…`, `decidedBy: "user"`), the first ever produced through a human action
via this path. A second request (`com.apple.textedit` / `observe`) was extended via the real
**+2 min** button (DOM countdown went from "36s left" to "1m 59s left", confirming
`PermissionRegistry.extend()` is wired), then denied via the real **Deny** button;
`desktopListGrants` confirmed no grant was created for it, and `computer.get_audit_log` showed a
`computer.resolve_app_grant` / `denied` entry with `decidedBy: "user"` in `redactedMetadata`. The
App Store/Play and calendar mutation flows were **not** live-triggered — both have real, largely
irreversible external side effects (a real store release, a real calendar write/invite) with no safe
way to fabricate a livetest run — but they run through the exact same generic handler code (no
per-action branching exists in `permission-registry-handlers.ts`) and are covered by the
mutation-tested unit test using their real `action` values (`store_release_mutation`,
`calendar_mutation`).

**Gates:** `npx tsc --noEmit` clean, `npx tsc --noEmit -p tsconfig.spec.json` clean (one pre-existing,
unrelated failure in `cost-page.component.spec.ts` from concurrent work, confirmed via `git status`
to predate this change), `npm run lint` clean, `npm run check:ts-max-loc` clean for every file this
fix touched (one pre-existing violation in `acp-cli-adapter.ts`, confirmed via `git diff --stat` to
be another session's concurrent, uncommitted edit, not this fix's), `npm run build:main` clean,
targeted `npm run test:quiet` green across all four new/changed spec files plus
`browser-approvals-banner.component.spec.ts`, `browser-gateway-handlers.spec.ts`,
`app.component.spec.ts`, `ipc-channels-identity.spec.ts`, and `ipc-channel-contract.spec.ts` (touched
shared aggregator files — all still green).

**Not built (left out of this session's scope, reported rather than silently dropped):** a dedicated
full-page approval list (the banner shows every pending item already, so a second surface felt
redundant within one session); wiring into the Workboard "Needs You" lane (that lane is
instance-status-driven and the release-gate/calendar approvals aren't always tied to a live Workboard
card — judged a separate, smaller follow-up rather than something to force in); a main→renderer push
event for pending/resolved/extended (the banner polls every 2.5s instead, matching the existing
Browser Gateway approvals banner's pattern exactly, which was judged sufficient for a 60s-minimum
window).

**Files touched:**
- `src/main/orchestration/permission-registry.ts`, `src/main/orchestration/__tests__/permission-registry.spec.ts`
- `packages/contracts/src/channels/permission-registry.channels.ts`, `packages/contracts/src/channels/index.ts`
- `src/shared/validation/permission-registry-schemas.ts`
- `src/shared/types/permission-registry.types.ts`
- `src/main/ipc/handlers/permission-registry-handlers.ts`, `src/main/ipc/handlers/__tests__/permission-registry-handlers.spec.ts`
- `src/main/ipc/handlers/index.ts`, `src/main/ipc/ipc-main-handler.ts`
- `src/preload/domains/permission-registry.preload.ts`, `src/preload/preload.ts`, `src/preload/generated/channels.ts` (generated)
- `src/renderer/app/core/services/ipc/permission-registry-ipc.service.ts`
- `src/renderer/app/core/state/pending-approvals-banner.component.ts`, `.component.spec.ts`, `.rules.ts`, `.rules.spec.ts`
- `src/renderer/app/app.component.ts`, `src/renderer/app/app.component.html`

<a id="lt-100-archived-detail"></a>


## LT-100: ACP-transport providers (Cursor and Grok confirmed) record zero cost when the ACP server omits `usage`

**Found:** 2026-08-12, running the LT-090 cost-tracking blast-radius survey ("which providers actually
record cost today, and which do not?").
**Source evidence:** this session's live dev-app run (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-cost`, isolated
profile), `_scratch/lt-2026-08-11/devapp-cost2.log`.

### Observed behaviour

While confirming LT-090's fix and surveying other providers for the same class of gap, two ACP-transport
providers turned up a genuinely zero-cost result on a real turn:

- **Cursor**: created a `provider: 'cursor'` instance (routes through `AcpCliAdapter`, `adapterName:
  'cursor-acp'`, **not** the separate, unused `cursor-cli-adapter.ts` file — confirmed by
  `createCursorAdapter()` in `adapter-factory.ts` and by the `transport: 'acp'` tag on the instance's own
  `output` events). Sent "Say hello in one short sentence." — got a real streamed reply
  ("Hello — I'm here and ready to help..."). The `'complete'` envelope carried only `durationMs` and
  `stopReason`; no `tokensUsed`/`costUsd`. `costGetEntries` showed 0 rows for the instance.
- **Grok**: same test, `provider: 'grok'` (also `AcpCliAdapter`, `createGrokAdapter()`). Real reply
  received, real turn completed. Same result: 0 cost entries.
- The app log recorded, for both providers, exactly the line the adapter's own LT-018-era design already
  anticipates: `"ACP turn reported no token usage; context bar stays empty for this session" { profile:
  'none', usageKeys: null }` — `usageKeys: null` means the ACP server's `session/prompt` response carried
  **no `usage` object at all**, not an empty or malformed one.

Initially misread this from a static read of `cursor-cli-adapter.ts` (which has its own, separately broken
usage construction — `inputTokens` is hardcoded to `0` or omitted entirely, `outputTokens` is an
`estimateTokens()` heuristic, never a real provider count). That file is **dead code** for the current
`provider: 'cursor'` create path — the live check (the `transport: 'acp'` tag on the instance's own output
events, plus `createCursorAdapter()`'s source) corrected the misread before it was written up as a finding.
Both live-tested providers actually took the ACP path exclusively.

### Root cause

`AcpCliAdapter.toCliUsage()` (`acp-cli-adapter.ts:2030`):

```ts
private toCliUsage(usage: AcpPromptUsage | undefined, duration: number) {
  if (!usage) {
    return duration > 0 ? { duration } : undefined;
  }
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, cost: usage.costUsd, duration };
}
```

When `result.usage` (the ACP `session/prompt` response's own `usage` field) is `undefined`, this
deliberately returns `{ duration }` only — no token fields — rather than fabricating a number.
`publishContextUsageFromTurn()` makes the same choice for the context bar, with an explicit comment: "No
usage ⇒ no event (a missing bar beats a confident zero)". `recordCompletionCost` then normalizes
`{ duration }` via `normalizeUsage()`, which does not recognize `duration` as a token field, resolves
nothing, and returns `undefined` — so `recordCompletionCost` early-returns with no entry. This is the
adapter working exactly as designed; the actual gap is that **the ACP server (cursor-agent's and Grok's own
CLI, not this codebase) never populated `usage` on `session/prompt`** in either live sample. Not established
whether this is universal for these providers/versions or only occurs under the flags/models exercised here
(both samples used `yoloMode: true`, a fresh instance, a single short turn).

This is a different shape of defect from LT-047/LT-090: those had real usage numbers available *somewhere*
in the adapter and simply never routed them to `'complete'`. Here, on the two providers sampled, the data
does not appear to exist anywhere in the adapter at all for this call.

### Required behaviour

Undetermined — this is a product/UX decision, not a clear bug fix, and is being written up rather than
decided unilaterally per this campaign's rules. Two live options, both with real costs:

1. **Accept the gap.** Cost/spend UI silently shows nothing for Cursor and Grok turns (and likely Copilot,
   same code path, not independently live-tested this session). Honest, but leaves James unable to see
   real spend for three providers.
2. **Add a heuristic-estimate fallback** (character-count-based, mirroring what the now-dead
   `cursor-cli-adapter.ts` attempted) when the ACP server reports no `usage`. Restores a non-zero cost
   signal, but the existing LT-018 design comment in this exact file argues explicitly against this
   ("a missing bar beats a confident zero") — reversing that call needs sign-off, not a quiet re-add.

### Impact

Cost tracking is confirmed silently broken (0 entries) for Cursor and Grok on a real turn each. Copilot
shares the identical `AcpCliAdapter` code path (`createCopilotAdapter()`) but was not independently
live-tested this session (an EBRD-only work-pilot seat per prior campaign notes) — flag, not confirmed. Not
characterized across a wider sample (different models, longer turns, tool use) — do not read "0/1 for each
of 2 providers" as a confirmed 100% failure rate without a larger repro.

### Verification

Not fixed — flagging with live evidence and exact reproduction steps rather than deciding the product
question unilaterally. Evidence is real `onProviderRuntimeEvent` payloads, `costGetEntries` reads, and the
app log's own "ACP turn reported no token usage" line, against a live, rebuilt dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-cost`, isolated profile) — not inference from source alone.

### Acceptance

- A documented decision (from James) on accept-the-gap vs. heuristic-fallback for ACP-transport providers
  when the ACP server itself reports no `usage`.
- If a fallback is chosen: implemented behind the same no-fabrication philosophy check the LT-018 comment
  already establishes, with regression tests, and live-verified on Cursor and Grok (and ideally Copilot).
- Either way: Copilot gets an independent live check to confirm or rule out the same gap.

<a id="lt-136-archived-detail"></a>


## LT-136: checkpoint timeline mislabels every checkpoint "Auto" and drops its name

**Fixed + verified live 2026-08-18 — Batch S.**

### Symptom

Live-tested WS-B7 (manual compaction preview/apply) check A2 opened the checkpoint timeline after
using both the "Preview compaction → Confirm" and plain "Compact Now" flows. Both flows are
supposed to create a labeled pre-compaction checkpoint (`applyCompaction()` in
`compaction-runtime.ts`, label `"Before manual compaction"` or `"Before manual compaction (keep
latest N exchanges)"`). Every entry in the checkpoint timeline rendered as an unnamed
`Checkpoint {id}` tagged **Auto**, with no way to tell the deliberate pre-compaction checkpoint
apart from a routine per-turn safety checkpoint.

### Root cause

`SnapshotManager.listSnapshots()` (`src/main/session/snapshot-manager.ts`) is the only source the
checkpoint timeline UI (`checkpoint-timeline.component.ts`) and its badge count
(`instance-detail.component.ts`'s `checkpointCount`) read from. It builds each listing entry from
the in-memory `SnapshotIndex`, which only ever tracked `id, instanceId, sessionId,
historyThreadId, timestamp, messageCount, schemaVersion` — never `name`, `description`, or
`trigger`. The listing therefore hardcoded `trigger: 'auto' as const` and left `name`/`description`
undefined for every entry, regardless of what was actually written to the full snapshot JSON on
disk (`session-continuity/snapshots/<id>.json`), which does correctly persist all three fields.

Confirmed directly on disk for a real manual-compaction run: the JSON file for the pre-compaction
checkpoint carried `"name":"Before manual compaction (keep latest 1 exchange)"` and
`"metadata":{"trigger":"checkpoint", ...}` — fully correct — while the same instant, the running
renderer's `listSessionSnapshots` IPC response (and the DOM) showed `trigger: "auto"` and no name
for that exact entry.

### Impact

Every checkpoint the checkpoint-timeline UI has ever shown a user was mislabeled "Auto" with no
name, including manual pre-compaction checkpoints. This defeats the purpose of the label: a user
restoring "to right before I compacted" cannot distinguish it from any other checkpoint in the
list. It also turned out the app's routine per-turn safety checkpoints are themselves labeled
`"Before: <message>"` with `trigger: 'checkpoint'` on disk (not `'auto'` as the UI implied) —
meaning essentially no checkpoint in normal usage was ever correctly labeled in this view.

### Fix

- `src/main/session/snapshot-index.ts`: added optional `name`, `description`, `trigger` fields to
  `SnapshotMeta`.
- `src/main/session/snapshot-manager.ts`: `createSnapshot()` now passes `name`/`description`/
  `trigger` into `snapshotIndex.add()`; `listSnapshots()` reads them back (`trigger` falls back to
  `'auto'` only for an index entry created before this fix, in-process only).
- `src/main/session/session-continuity.ts`: the startup disk-rebuild path (`buildSnapshotIndex()`)
  and the session-import path both now populate the same three fields from the full snapshot data
  they already read, so the fix applies after a restart and to imported sessions too.

### Verification

- `src/main/session/__tests__/snapshot-manager.spec.ts`: extended the existing "creates snapshots,
  indexes them" test to assert `name: 'Checkpoint'` and `metadata.trigger: 'checkpoint'` on the
  listed entry. Reverted the three source files to their pre-fix `HEAD` versions and re-ran — the
  test failed with the pre-fix hardcoded `trigger: 'auto'`/missing `name`, confirming the assertion
  is load-bearing. Restored the fix; the full `src/main/session/` suite (32 files, 308 tests) and
  `npx tsc --noEmit` / `-p tsconfig.spec.json` / `npx eslint` on the touched files / `npm run
  build:main` all pass.
- Live-verified post-fix in a rebuilt, restarted isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchS`,
  port 9452): created a fresh Claude instance, sent one turn, ran the plain `compactInstance` IPC
  (Compact Now), selected the instance in the real UI, and opened the checkpoint timeline. It now
  shows three correctly labeled entries — `"Before: [Context Compaction Continuity
  Package]\nCompaction"`, `"Before manual compaction"`, `"Before: Say the single word \"hello\" and
  nothing else."` — all tagged **Checkpoint**, none "Auto".

### Acceptance

- A checkpoint's `name` and real `trigger` (not a hardcoded `'auto'`) reach the checkpoint timeline
  UI, both immediately after creation and after an app restart rebuilds the index from disk.
- A manual pre-compaction checkpoint is visually distinguishable from a routine per-turn checkpoint
  in the timeline.

<a id="lt-146-archived-detail"></a>


## LT-146: Antigravity instances silently ignore their configured working directory

**Found:** 2026-08-18, running check 4 ("Antigravity stateless check") of the provider-agnostic
context-evidence live test.
**Source evidence:** isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchC`, port 9453), instance
`ihhmab46q`, workspace `/tmp/aio-lt-evidence-batchC` (containing only `package.json` and `notes.txt`);
corroborated by a direct, harness-independent shell invocation of the installed `agy` binary.

### Observed behaviour

A fresh `provider: 'antigravity'` instance was created with `workingDirectory:
'/tmp/aio-lt-evidence-batchC'` and sent "List the files in this directory, then read notes.txt.". The
instance's own record correctly showed `workingDirectory: "/tmp/aio-lt-evidence-batchC"`. Its reply:

> "The current directory (`/Users/suas/.gemini/antigravity-cli/scratch`) contains 621 files
> (consisting primarily of diagnostic Python scripts, text match logs, and markdown documents), but no
> `notes.txt` file exists here."

The model was operating against a completely different, shared, persistent directory
(`~/.gemini/antigravity-cli/scratch`, 621 files — clearly a long-lived scratch area accumulated across
unrelated past sessions) rather than the disposable one-file workspace it was actually scoped to.

Two hypotheses were live: (a) the harness passes the wrong `cwd` at spawn time, or (b) the reply was
fabricated by the harness's known degraded replay-fallback path (this instance also hit two
`process_exited_unexpected` spawn stalls with `SessionRecovery`/`replay-fallback` in its log, per
existing team knowledge that replay fallback can return synthetic content). Both were ruled out:

- **Not a harness `cwd` bug.** `createAntigravityAdapter()` (`adapter-factory.ts:293-308`) correctly
  passes `workingDir: options.workingDirectory` into `AntigravityCliConfig`, and the adapter constructor
  (`antigravity-cli-adapter.ts:82-91`) correctly passes `cwd: config.workingDir` to the underlying
  `CliAdapterConfig`/spawn call. Node's `child_process.spawn` `cwd` option is honored.
- **Not a replay-fallback artifact.** Running `agy --print "List the files in this directory using a
  tool, then report what you found."` directly from a shell with `cwd` explicitly set to
  `/tmp/aio-lt-evidence-batchC` — no AIO harness involved at all — reproduced the identical answer,
  reporting the same `~/.gemini/antigravity-cli/scratch` directory and the same 621-file listing.

**Root cause:** `agy` has its own workspace/project concept, independent of the OS-level process `cwd`.
`agy --help` lists `--add-dir <path>` ("Add a directory to the workspace (repeatable)") and
`--project`/`--new-project` flags specifically for this. AIO's `buildArgs()`
(`antigravity-cli-adapter.ts:270-311`) constructs only `--model`, `--sandbox`,
`--dangerously-skip-permissions`, and `--print <prompt>` — it never passes `--add-dir` or any
project/workspace flag. Grepping the whole adapter and factory for `add-dir`/`addDir`/`new-project`/
`newProject` returns zero matches. So every Antigravity instance, regardless of the `workingDirectory`
the user or agent selects, actually operates against `agy`'s own default scratch directory.

**Secondary observation, not chased further:** `adapter-factory.ts:291`'s comment "agy has no
`--output-format` flag" is stale — the installed `agy` 1.1.13 does have `--output-format` (text, json,
stream-json). Possibly related to the `[STREAMING_DROP]` "streaming update shrank content" warning
logged for this same instance, but not investigated as part of this defect.

### Impact

This is a workspace-isolation defect with real safety implications, not merely a wrong-answer bug: a
user or agent who scopes an Antigravity instance to a specific repository or disposable directory,
believing tool access is bounded to it, is not actually protected by that boundary — every Antigravity
session reads (and, combined with `--dangerously-skip-permissions`, which AIO passes by default for
managed instances, could write) inside one shared, persistent, cross-session scratch directory instead.

### Required fix

Pass `--add-dir <workingDirectory>` (or the equivalent `--project`/`--new-project` scoping `agy`
actually respects) when spawning an Antigravity instance, so the CLI's own workspace concept matches
the `workingDirectory` AIO believes it configured. Needs live re-verification after the fix: the same
"list files, read a known file" probe should report the disposable workspace's actual contents, not
the shared scratch directory.

### Acceptance

- A fresh Antigravity instance scoped to a disposable workspace reports and operates on that
  workspace's real contents, not `~/.gemini/antigravity-cli/scratch`.
- Verified against a direct `agy` invocation with whatever flag is added, not only through the harness.
- No regression to Antigravity's existing model/sandbox/yolo argument construction.

<a id="lt-148-archived-detail"></a>


## LT-148: the Codex context-pressure diagnostics classifier miscounts the user's own turn echo as a tool-bearing item

**Found:** 2026-08-18, running the baseline case of the Codex context-pressure controlled-reproduction
discovery doc (`docs/superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md`)
against an isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchC`, port 9453,
`AIO_CODEX_CONTEXT_DIAGNOSTICS=1`), instance `xzpa9khi7` → `xg43ohb3x` → `xw745dtwn` (recreated across
a rebuild for the fix).

### Observed behaviour

The baseline case's prompt is "Reply with exactly `baseline complete`. Do not use tools." — a trivial
turn the model correctly completed with **zero** real tool calls (confirmed via the instance's own
output buffer: only a `user` and an `assistant` message, no `tool_use`/`tool_result`). The doc's own
operational expectation for this case is "zero root tool-bearing `item-completed` records". The
diagnostic stream instead showed:

```
item-completed  itemClass:"other"          rootThread:true  observedPayloadBytes:18507  (itemSequence 1)
item-completed  itemClass:"agent-message"  rootThread:true  observedPayloadBytes:17     (itemSequence 2)
```

`itemClass:"other"` is exactly what the doc's own bounded safety monitor (§2, `toolItemClasses`) counts
as tool-bearing "for safety" — so a turn that made no tool call at all still contributed 1 to the
root-tool-item count.

### Root cause

`classifyCodexObservedItem()` (`src/main/cli/adapters/codex/context-pressure-diagnostics.ts:171-200`)
switches on the raw app-server item's `type` field, with explicit cases for `command_execution`,
`mcpToolCall`, `dynamicToolCall`, `webSearch`, `file_change`, `collabAgentToolCall`, `agent_message`,
and `reasoning` — but nothing for the app-server's `item/completed` notification carrying the model's
own echo of the **user's** turn content. A temporary, reverted debug log
(`console.error` in `classifyCodexObservedItem`, removed before this fix was finalized) proved the raw
type directly: `"userMessage"` (keys `["type","id","clientId","content"]`) for the mystery 18.5 KB
item, and `"agentMessage"` for the real reply — ruling out the more plausible-sounding guess
("reasoning trace") before writing this up. Any type not in the switch's case list falls to
`default: return 'other'`, so `"userMessage"` silently landed in the tool-bearing bucket.

### Impact

Two distinct consequences, both real:

1. **Safety-bound noise.** Every real turn — not just this trivial one — spuriously counts at least
   one non-tool item toward the doc's own 10-root-tool-item stop condition, before any genuine tool
   call occurs, making the bound trigger earlier than intended (fails safe, not unsafe, but noisy and
   scientifically confounding for a "controlled reproduction" whose entire purpose is precise counting).
2. **Attribution corruption.** This diagnostic subsystem's stated purpose is distinguishing whether
   context growth is driven by tool-output retention or reasoning-token retention. Bucketing a
   sizeable (18.5 KB observed on a two-word reply) non-tool, non-reasoning item into the same
   ambiguous `'other'` class used for genuinely-unknown items defeats that attribution for every turn.

### Fix

Added `'user-message'` to `CodexObservedItemClass` and a `case 'user_message': case 'userMessage':`
branch returning it, matching the existing dual-casing (snake/camel) pattern used by every other case.
`CodexObservedItemClass` has exactly one consumer file (confirmed by a repo-wide grep before touching
the type), so this is a fully contained change with no external blast radius.

### Verification

- `context-pressure-diagnostics.spec.ts`: updated the existing exhaustive-classification test to cover
  `user_message`/`userMessage`, plus a new dedicated test asserting the class is `'user-message'` and
  explicitly **not** `'other'`. Both watched to **fail** with the fix reverted (`git apply -R`) —
  `'other'` vs `'user-message'` mismatch on both — and pass with it restored.
- **Live-verified end-to-end**, not just unit-tested: rebuilt (`npm run build:main`), restarted the
  isolated dev app, re-ran the *identical* baseline prompt on a fresh Codex instance. The same
  18507-byte item now reports `itemClass:"user-message"` instead of `"other"`. A follow-up
  small-ticket case (the doc's own §6, a real TypeScript-error-finding task with genuine tool calls)
  now shows exactly 3 `"command"` items (matching 3 real `tool_use`/`tool_result` pairs observed),
  3 `"reasoning"`, 1 `"user-message"`, 3 `"agent-message"`, and **0** `"other"` — clean attribution.
- Gates green: `tsc` ×2, `ng lint`, `check:ts-max-loc` (file not in the violation list), `build:main`,
  targeted `test:quiet` (14/14 in the touched spec file).

### Acceptance

- A turn with zero real tool calls reports zero tool-bearing root `item-completed` records under the
  doc's own safety-bound classification.
- A turn with N real tool calls reports exactly N tool-bearing root items, not N+1.
- The fix is contained to `CodexObservedItemClass`'s single consumer file; no other module's
  classification logic was touched.

<a id="lt-160-archived-detail"></a>


## LT-160: `instance.waitReason` never reaches the canonical main-process Instance object

### Observed behavior

Filed while driving WS7 Phase B (regular-session failover) check 6 (offered switch on a long park).
Setup: real `InstanceProviderLimitHandler.maybePark()` call (the exact production entry point a real
429/rate-limit classification calls) against a live, genuinely-created dev-app instance, with
`instanceProviderLimitResumeEnabled: true` and `sessionFailoverOfferAfterMinutes: 1`.

The park itself worked correctly end to end: `maybePark()` returned `'parked'`, `isParked(instanceId)`
returned `true`, and the real "parked until …" offer notification fired via `NotificationService`
(`notificationList()` showed `title: "claude parked until 2:35:43 AM"`, `delivery: "desktop"`,
mentioning the "Switch provider" button — exactly what check 6 expects for the renderer-visible half).

But a fresh `listInstances()` IPC call immediately afterward showed **no `waitReason` key at all** on
the parked instance — not `null`, entirely absent, as if it were never set. Testing further with a
direct call to the real `SessionAdmissionService.admitAutomatedWrite()` (the guard that is supposed to
suppress automated writes to a parked/waiting instance) against the same, confirmed-parked instance
returned `{kind: 'admitted'}` instead of the expected `{kind: 'suppressed', reason: 'quota-parked'}`.

### Root cause

`InstanceProviderLimitHandler`/`InstanceAuthRepairHandler`/the loop coordinator's D7 quota-park wiring
all set `waitReason` exclusively through `InstanceManager.queueInstanceUpdate()` →
`InstanceStateManager.queueUpdate()`. That function only ever wrote into `pendingUpdates` — the
renderer-broadcast batch, flushed periodically via a `'batch-update'` event that the renderer applies
to its own separate local copy of the instance. It never touched `this.instances.get(instanceId)`, the
canonical main-process `Instance` object.

Every *other* field the same `queueUpdate()` batch carries is different: `status` and `contextUsage`
are additionally assigned directly onto the live object by their own callers (`instance.status = …` at
several sites in `instance-lifecycle.ts`/`instance-communication.ts`; `instance.contextUsage = …`
likewise), and `desiredRuntime` is written directly by `desired-runtime-queue.ts`. `queueUpdate()`
deliberately does *not* duplicate those writes — it is broadcast-only, on the assumption every caller
already keeps the live object true. `waitReason` (added later, "Phase 6 / §G" per its own doc comment)
never got that direct-write step at any of its three call sites, so it was the one field where the
"caller keeps the live object true" assumption silently didn't hold.

Confirmed via exhaustive grep across `src/main`: zero direct `instance.waitReason = …` assignments
anywhere in production code, and two real synchronous main-process readers that gate on it —
`session-admission-service.ts:235,238` (`admitAutomatedWrite`, used for automations/orchestration
children writing to a parent) and `mobile-gateway/mobile-input-queue.ts:85` (the mobile gateway's send
gate) — both structurally unable to ever see a parked/auth-required instance as anything but normal.

### Required fix (implemented)

`InstanceStateManager.queueUpdate()` now also writes `waitReason` directly onto the live `Instance`
object (when the parameter is not `undefined`; `null` clears it, mirroring the existing
"omit=preserve, null=clear" contract), the same pattern every other batched field's caller already
follows — except done once, in the one function every `waitReason` caller already funnels through, so
no future caller can reintroduce the same gap by forgetting a parallel direct write.

### Fix — 2026-08-18

`src/main/instance/instance-state.ts`'s `queueUpdate()`: added `if (waitReason !== undefined) { const
live = this.instances.get(instanceId); if (live) live.waitReason = waitReason ?? undefined; }` right
before building the `pendingUpdates` entry.

New regression test: `src/main/instance/instance-state.spec.ts`, "LT-160: writes waitReason directly
onto the live instance, not only the pending broadcast" — sets a `quota-park` waitReason via
`queueUpdate()` and asserts `state.getInstance(id)?.waitReason` (the synchronous main-process read,
not the pending broadcast) reflects it immediately, then clears it with `null` and asserts it's gone.
**Reverted the fix and watched the test fail** (`AssertionError: expected undefined to match object
{ kind: 'quota-park', … }`), then restored the fix and confirmed it passes.

**Live-verified post-fix**, same dev app, same technique: re-parked a fresh instance via the real
`InstanceProviderLimitHandler.maybePark()` call, then called the real `SessionAdmissionService
.admitAutomatedWrite()` against it — now returns `{kind: 'suppressed', reason: 'quota-parked'}` as
required.

**Regression scope checked:** `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json` clean;
`npm run lint` clean; `npm run check:ts-max-loc` clean (no new ceiling violations); `npm run
build:main` clean. Targeted suites: `session-admission-service.spec.ts`, `mobile-input-queue.spec.ts`,
`instance-state.spec.ts`, `instance-state-machine.spec.ts` (140 tests) and the full `src/main/instance/`
tree (102 files, 1195 tests) all green post-fix, including every existing `status`/`contextUsage`
batching test — confirming the new direct write does not disturb the pre-existing broadcast-only
contract for those fields.

### Acceptance

- `InstanceStateManager.queueUpdate()` writes `waitReason` onto the live `Instance` object
  synchronously, not only onto the renderer-bound pending-update batch.
- `SessionAdmissionService.admitAutomatedWrite()` and the mobile input queue's park check correctly
  suppress against a genuinely parked/auth-required instance immediately after the park call returns,
  with no dependency on the ~batch-timer flush interval.
- No regression to the renderer's own `instance:batch-update` broadcast path or to any other batched
  field's existing behavior.

<a id="lt-161-archived-detail"></a>


## LT-161: `deserializeInstance()` silently drops wire fields — `failoverProviders` plus four more found in a completeness pass

### Observed behavior

Found immediately after fixing LT-160, while completing WS7 Phase B check 6's renderer-visible half
(the composer's quota-park banner should show a third "Switch provider" button once a fallback list is
configured). With LT-160 fixed, `listInstances()` correctly showed both `waitReason` and
`failoverProviders: ["claude","codex"]` for a real, freshly-created, freshly-parked instance. But
opening that instance's detail view in the real renderer (focus-emulated dev app, not occluded) showed
`canOfferFailover()` reading `false`, and `window.ng.getComponent(composer-banners)
.instanceStore.getInstance(id)` had no `failoverProviders` key on it at all — not `undefined`, absent
from the object's own key list.

An independent review, after the first fix, asked the natural follow-up question directly: is
`failoverProviders` the only field this mapper drops? It was not — four more, below.

### Root cause

`InstanceListStore.deserializeInstance()` (`src/renderer/app/core/state/instance/instance-list.store.ts`)
is an explicit field-by-field allowlist mapper: it builds a brand-new plain object naming every field it
keeps from the raw IPC payload, rather than spreading the payload. `failoverProviders` was never added
to that list — even though `src/renderer/app/core/state/instance/instance.types.ts:140` declares
`failoverProviders?: string[]` on the renderer's own `Instance` type, and the main process always sends
it (confirmed via a direct `listInstances()` read). Every renderer hydration path routes through this
one function — `loadInitialInstances()`'s `stateResync()` snapshot and `addInstance()`'s per-creation
event both call `deserializeInstance()` — so the field was unconditionally dropped for every instance,
always, in the real running app, not just the instance under test.

`canOfferFailover()` (`composer-banners.component.ts:304-308`) reads exactly this field:
```ts
readonly canOfferFailover = computed(() => {
  if (!this.quotaPark()) return false;
  const inst = this.instanceStore.getInstance(this.instanceId());
  return Boolean(inst?.failoverProviders?.some((p) => p !== inst.provider));
});
```
With `failoverProviders` always `undefined` on the renderer's copy, this can never be `true` — the WS7
Phase B "Switch provider" button (checks 6 and 7's renderer-visible half) could never render for any
instance in the shipped app, regardless of `sessionFailoverProviders` configuration. The underlying
mechanism itself (settings → `instance.failoverProviders` at creation → `InstanceProviderLimitHandler`
→ `attemptInstanceFailover`/`failoverNow` IPC) all work correctly — proven directly via checks 1–5 and
the `instanceFailoverNow` IPC call — this defect was purely in the renderer's own read of a field it
already had, correctly, on the main-process side.

**Completeness pass — four more dropped fields.** Enumerating the full renderer `Instance` interface
(`instance.types.ts:90-176`) against what `deserializeInstance` actually reconstructs
(`instance-list.store.ts:687-791`) confirmed each of these is also present on the wire — main sends the
full live object via `{...rest}` spreads in both `serializeInstance()` (`instance-handler-serializers.ts:4-19`,
the CREATE response) and `serializeForIpc()` (`instance-state.ts:365-374`, the snapshot/`instance:added`
payload) — and dropped by the mapper the same way:

1. **`hardened`** — never in `InstanceStateUpdatePayload` either, so `deserializeInstance` is its *only*
   path into the renderer, and it drops it. Consumer: `composer-banners.component.ts:315-318`
   `showHardenedDenialBar` — the WS13 "hardened session died, offer allow-and-retry" banner **can never
   render for any hardened instance**. Never recovers short of instance removal+recreation.
2. **`contextEvidence`** — same story, also absent from the batch-update payload. Consumer:
   `context-bar.component.ts:319` — `contextEvidence?.conversationId` is permanently `undefined` via
   this path.
3. **`fastMode`** — dropped, and also absent from the batch-update payload. On `loadInitialInstances()`
   (every app restart/resync) the FAST badge (`instance-header.component.html:229-240`) resets to OFF
   regardless of real state. In-session toggling still works because `toggleFastMode()` patches locally
   by a different path — which is exactly why this stayed invisible.
4. **`executionLocation`** — dropped here, though it *is* carried on subsequent batch updates
   (`transport.types.ts:93`). So every remote-node instance shows as **local** (remote badge,
   project-rail grouping) right after resync or creation until some later `queueUpdate` happens to
   carry it — not guaranteed for an idle remote session. Consumers in
   `project-rail-builder.service.ts:590-593`, `project-group-computation.service.ts:111-112`,
   `instance-row.component.ts:148-152`, `dashboard-project-context.ts:31-32`.

Cleared as *not* actionable: `isRenamed` (no renderer reads it — confirmed by an exhaustive grep for
`.isRenamed` across `src/renderer`) and `pendingYoloMode` (excluded by explicit design comment at
`instance-list.store.ts:398` — sourced from `desiredRuntime` instead, not the wire).

Failure scenario for all five together: restart the app (or resync) with a hardened, fast-mode, remote,
or context-evidence session and the corresponding banner/badge/lookup silently goes blank, off, or
local. Severity raised from P2 to P1 for this reason — four distinct wired features degrading silently,
two of which (`hardened`, `contextEvidence`) never self-recover short of recreating the instance.

### Fix — 2026-08-18

`src/renderer/app/core/state/instance/instance-list.store.ts`'s `deserializeInstance()`: added
`failoverProviders`, then in the completeness pass also added `hardened`, `contextEvidence`, `fastMode`,
and `executionLocation` — all five now carried through alongside the other snapshot-carried fields, each
using the same type-guard pattern (`isRecord`/`typeof`/`Array.isArray`) already used for the adjacent
fields in that function.

**Structural completeness test, not just five individual assertions.** Per the review's explicit
instruction, the fix this time is not only the five fields — it is a test that fails loudly the next
time a field is added to the wire and forgotten here, instead of passing silently the way these five
did. New test in `instance-list.store.spec.ts`: "LT-161: deserializeInstance carries every wire field
forward (structural completeness)" — builds one fixture covering every field on the wire `Instance`
type with a concrete, distinguishable value, runs it through `deserializeInstance()`, and asserts each
field survives except the two deliberately-excluded ones (`isRenamed`, `pendingYoloMode`), which are
named explicitly in the test with the same reasoning as above. The original narrower
"carries failoverProviders…" test is kept alongside it (belt-and-suspenders, and it documents the
original defect's own shape).

**Reverted the four-field fix (via a `/tmp` copy of the file, never `git stash`/`checkout --`) and
watched the structural test fail**:
```
AssertionError: field "contextEvidence" should survive deserializeInstance(): expected undefined to deeply equal { mode: 'shadow', …(2) }
```
(the fixture object's key order put `contextEvidence` first among the four missing fields, so that is
the one the assertion loop reported — the other three would each fail the same way in isolation).
Restored the fix from the `/tmp` copy and confirmed 23/23 tests pass again.

**Regression scope checked:** `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json` clean;
`npm run lint` clean; `npm run check:ts-max-loc` clean (file stays within its existing +50 tolerance
band, now 850/818+50). `npm run build:main` clean. Targeted suites: `instance-list.store.spec.ts`
(23 tests) and `composer-banners.component.spec.ts` (9 tests) green, plus the full
`src/renderer/app/core/state/instance/` tree (9 files, 121 tests) green post-fix.

**Live-verified post-fix (original `failoverProviders` half only — the four additional fields were not
separately live-driven this session, only unit-verified as above)**: rebuilt `dist/main`, dev app
restarted to load the fixed bundle: created a fresh instance with `failoverProviders: ["claude","codex"]`,
parked it via the real `maybePark()` call, opened its detail view in the real renderer —
`instanceStore.getInstance(id).failoverProviders` correctly returned `["claude","codex"]` and
`canOfferFailover()` read `true` (the "Switch provider" button rendered — see the WS7 Phase B evidence
doc for the DOM read). The four completeness-pass fields (`hardened`, `contextEvidence`, `fastMode`,
`executionLocation`) are covered by the structural unit test above but were not separately re-driven
live in the dev app this session — a residual worth a live spot-check in a future session, though the
fix mirrors the already-live-verified `failoverProviders` pattern exactly (same function, same
type-guard style, same round-trip contract).

### Acceptance

- `deserializeInstance()` carries `failoverProviders`, `hardened`, `contextEvidence`, `fastMode`, and
  `executionLocation` through from the raw snapshot/creation payload onto the renderer's local
  `Instance` object.
- `canOfferFailover()` correctly reads `true` for a parked instance with a configured, alternative
  fallback provider, and the composer's "Switch provider" button renders.
- The WS13 hardened-denial banner, context-evidence panel lookup, FAST badge, and remote-node
  badge/grouping all read live-accurate values immediately after a resync or instance creation, not
  only after some later incremental update happens to carry them.
- A structural test fails if a future field is added to the wire `Instance` type but not wired into
  `deserializeInstance()`.
- No regression to any other field `deserializeInstance()` maps.

<a id="lt-167-archived-detail"></a>


## LT-167: `checkCodexCliAuthentication` misclassifies a signed-out Codex CLI as authenticated

**Found:** 2026-08-18, driving the in-session-auth-repair live tests (checks 1 and 3) in an isolated
dev app, using a disposable empty `HOME` override to produce a genuinely signed-out Codex CLI without
touching any real global credentials.
**Source evidence:** dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchU-authtest`, port 9457,
`HOME=/tmp/aio-lt-batchU-fakehome`), real `codex` binary
(`/Users/suas/.nvm/versions/node/v24.15.0/bin/codex`), instance `xdktklch3`.

### Observed behaviour

With `HOME` pointed at an empty, freshly created directory, a direct shell probe under the identical
env confirmed the real CLI genuinely reports signed-out:

```
$ HOME=/tmp/aio-lt-batchU-fakehome codex login status
Not logged in
$ echo $?
1
```

But the app's own Doctor provider diagnosis for Codex, run in the same process tree under the same
`HOME`, reported:

```json
{
  "name": "authenticated",
  "status": "pass",
  "message": "Codex CLI authenticated",
  "metadata": { "authMethod": null, "rawOutput": "Not logged in" }
}
```

`rawOutput` and `message`/`status` directly contradict each other — the raw text the CLI printed is
literally "Not logged in", yet the parsed result says authenticated. The same misclassification then
vetoed the mid-session repair path: sending a real turn on a Codex instance created under this env
failed with a genuine `401 Unauthorized: Missing bearer or basic authentication in header` from
`api.openai.com`, which `detectAuthFailureSignal` correctly matched, but `app.log` recorded:

```
{"level":"info","subsystem":"InstanceAuthRepairHandler",
 "message":"Ignoring auth-shaped turn failure: the provider still reports authenticated",
 "data":{"instanceId":"xdktklch3","provider":"codex"}}
```

`maybeBlockOnAuth` never attached the `auth-required` waitReason, so the instance was left sitting in
plain `error` with no repair banner and no sign-in watch — exactly the "false 'still authenticated'
veto" scenario `InstanceAuthRepairHandler`'s own doc comment warns against, except triggered by a
parser bug rather than a real live sign-in.

### Root cause

`parseCodexAuthOutput()` (`src/main/providers/codex-cli-auth.ts`) checked the **positive** pattern
before the negative ones:

```ts
if (normalized.includes('logged in')) { ... return { authenticated: true, ... }; }
if (normalized.includes('not logged in') || normalized.includes('login required')
    || normalized.includes('logged out')) { ... return { authenticated: false, ... }; }
```

`"not logged in".toLowerCase()` **contains** the substring `"logged in"`, so the first branch always
wins for a genuine sign-out. The function never reaches the correct, second branch. This is a classic
substring-ordering trap of the same shape `detectAuthFailureSignal` in the same feature deliberately
guards against by checking its exclusion list first — but the guard was never applied here.

There was no existing test file for `codex-cli-auth.ts` at all (unlike `claude-cli-auth.ts`, which has
one), so nothing caught it before this run.

### Impact

Every consumer of `checkCodexCliAuthentication()` was affected identically: the Doctor "Codex CLI"
startup-capability row and provider-diagnosis card always report `ready`/`healthy` regardless of real
sign-in state (so a genuinely signed-out Codex CLI never shows as degraded, and the repair action
never surfaces), and `InstanceAuthRepairHandler.maybeBlockOnAuth`/`retryNow` always treat Codex as
signed in, so the mid-session repair banner, auto-resume watch, and "still signed out" retry message
can never fire for Codex — the entire in-session-auth-repair feature was silently inert for this
provider.

### Fix

Reordered `parseCodexAuthOutput()` to check the negative patterns (`not logged in`, `login required`,
`logged out`) before the positive `logged in` check, mirroring `detectAuthFailureSignal`'s own
exclusion-first pattern. Added `src/main/providers/__tests__/codex-cli-auth.spec.ts` (7 tests: positive
ChatGPT/API-key cases, the "Not logged in" regression on both exit 0 and non-zero exit, "login
required", "logged out", and the unrecognised-output fallback). Watched 2 of the 7 fail with the
exact `authenticated: true` vs `false` mismatch on the pre-fix ordering, then pass after the fix.
Live re-verified post-fix in the same fake-`HOME` dev app (rebuilt `dist/main`): Doctor's `provider.codex`
row now correctly reports `degraded`/`authenticated: fail`/`"Codex CLI is not logged in"`.

Gates: `npx tsc --noEmit` clean, `npx tsc --noEmit -p tsconfig.spec.json` clean, `npx eslint` on both
touched files clean, `npm run check:ts-max-loc` unaffected, `npm run build:main` succeeds,
`npm run test:quiet -- src/main/providers/__tests__/codex-cli-auth.spec.ts` — 7/7 pass.

### Acceptance

- `checkCodexCliAuthentication()` reports `authenticated: false` for every real "not logged in" /
  "login required" / "logged out" CLI response, on both a zero and non-zero exit code.
- The Doctor Codex row and provider diagnosis reflect a genuine sign-out as `degraded`, not `ready`.
- `InstanceAuthRepairHandler.maybeBlockOnAuth` no longer vetoes a real Codex auth failure when the CLI
  is actually signed out.

<a id="lt-170-archived-detail"></a>


## LT-170: `skills:activation-delta` never reaches the renderer without a manual refresh (cross-process EventEmitter split)

### Observed behavior

A real skill activation (a "flaky test" trigger sent to a live instance) always wrote its
`skill_activations` row correctly, but the toast and badge that are supposed to react to it live never
appeared, and a raw `electronAPI.onSkillActivationDelta()` listener attached before the send received
**zero** events. Only an explicit `refreshActivations()`/`skillsActivationsRecent()` call ever
surfaced the row to the renderer. Confirmed across five independent sessions before this one
(2026-07-27 ×2, 2026-08-01, 2026-08-12, 2026-08-18 earlier same-day) without the root cause being
isolated.

### Root cause

`SkillAttributionService` is a per-process singleton — the same constraint LT-169 named for its
`controlCache` field. `recordActivation()` (`skill-attribution-service.ts:139`) is called from
`unified-controller.ts:790`, inside `UnifiedMemoryController`, which
`context-worker-main.ts`'s own docstring confirms runs entirely inside the **context-worker child
process**: "Owns a fresh InstanceContextManager… No Database object is shared across process/thread
boundaries." `recordActivation()`'s `this.emit('activation', activation)` therefore fires on *that
worker's own* `EventEmitter` instance — a different OS process's object — while
`registerSkillAttributionHandlers()`'s `attribution.on('activation', onActivation)`
(`skill-attribution-handlers.ts:64`) subscribes to the **main** process's own singleton. Node's
`EventEmitter` cannot cross a process boundary by itself, so the listener could never have fired,
regardless of timing, schema validation, or `webContents` state — every earlier session's suspects
were correctly ruled out because none of them were the actual cause. Unlike LT-169's `controlCache`,
which could be fixed by always re-reading the one genuinely shared source of truth (the DB row), a
live push event has no "re-read" equivalent — the missing hop had to be re-established explicitly.

### Fix

Added a new, genuine fire-and-forget outbound message to the existing worker↔main protocol:

- `WorkerSkillActivationMsg` (`src/main/instance/context-worker-protocol.ts`) — `{ type:
  'skill-activation', activation: SkillActivation }`, alongside the existing `WorkerReadyMsg` /
  `WorkerRpcResponseMsg` in `ContextWorkerOutboundMsg`.
- `src/main/instance/context-worker-main.ts` — subscribes once, at module load, to
  `getSkillAttribution().on('activation', …)` and forwards every activation over the worker's existing
  transport (`transport.postMessage(...)`, the same abstraction that already carries `ready` and
  `rpc-response`).
- `src/main/instance/context-worker-client.ts` — `handleMessage()` now branches on
  `msg.type === 'skill-activation'` and re-emits the activation on the **main** process's own
  `getSkillAttribution()` singleton. `registerSkillAttributionHandlers()`'s existing listener
  (already correctly wired end-to-end to the renderer) fires without any change to that file.

### Regression test, watched failing on revert

Added `src/main/instance/context-worker-client.spec.ts` (new file): a real `EventEmitter`-based fake
`IsolatedWorkerProcess` handle (satisfies the actual interface — `postMessage`/`terminate` plus real
`on`/`emit`), injected via `ContextWorkerClient`'s existing `workerFactory` test seam. Two tests:
"re-emits a worker-forwarded activation on the main process singleton so the existing renderer-push
listener fires" (a listener on `getSkillAttribution()` receives the exact activation payload) and "does
not touch RPC bookkeeping" (metrics unaffected by the new message type). Reverted only the
`handleMessage()` branch (via a `/tmp` copy, never `git checkout`/`stash`) and re-ran:

```
✗ 1 of 2 tests failed in 12.8s:
  ✗ ContextWorkerClient (LT-170: cross-process skill-activation forwarding) re-emits a
    worker-forwarded activation on the main process singleton so the existing renderer-push
    listener fires
    AssertionError: expected [] to have a length of 1 but got +0
```

Restored the fix; both tests pass.

### Live end-to-end re-verification

Rebuilt `dist/main` and restarted the dev app (required — the context-worker process that predates the
fix would still run the old code). Attached a raw `electronAPI.onSkillActivationDelta()` listener,
created a fresh instance, sent a real "flaky test" turn. The listener received **exactly one** event
with the correct payload (`skillName: 'test-stabilizer'`, `matchedTrigger: 'flaky test'`, …), with no
manual refresh at any point — the first live confirmation this delivery path has ever worked.

### Gates

`npx tsc --noEmit` clean, `npx tsc --noEmit -p tsconfig.spec.json` clean, `ng lint` clean, `npm run
build:main` green, targeted `test:quiet` on `context-worker-client.spec.ts` → 2/2 passed.
`check:ts-max-loc` initially **failed** — the fix's own comments pushed `context-worker-client.ts` to
701/707 lines against its 700-line ceiling, which had no pre-existing tolerance headroom (unlike most
other files near their ceiling in this codebase). Trimmed the new code's comments to land at exactly
700 lines; gate green. Any future addition to this file will need either a genuine trim or a deliberate
allowlist entry.

### Provenance

Found and fixed during the 2026-08-18 Batch U2 livetest run, following the brief's explicit
encouragement to chase this defect using the existing `logger.debug` scaffolding
(`electron-window-transport.ts`, `skill-attribution-handlers.ts`) left by an earlier same-day session.
Full check-level evidence: [skill-observability livetest, this evidence
run](./2026-07-23-skill-observability-and-design-skills_livetest.md#evidence-run--2026-08-18-batch-u2--check-8-pass-both-halves-blocked-on-a-new-defect-lt-200-fixed-this-session-check-6-pass-core-mechanism-check-5-doctor-lint-half-pass-check-4-positive-half-root-caused-not-a-defect--an-embedding-threshold-reachability-gap-lt-170-root-caused-and-fixed).

<a id="lt-181-archived-detail"></a>


## LT-181: a genuine race lets the pre-queue "already has an active turn" error back into the transcript

### Observed behavior

While setting up the mobile-queue livetest's check 1 (queue while busy), an early test fired two
`POST /api/instances/:id/input` requests for the same instance close together, on a real dev-app
`codex` instance. One went straight through (`{"ok":true}`); the other produced

```
{"error":"Codex app-server runtime already has an active turn"}
```

and the transcript for the instance contained a raw `error`-type message with that exact text — the
same shape as the original bug the mobile-gateway "queue while busy" feature
(`src/main/mobile-gateway/mobile-input-queue.ts`) exists to prevent.

### Root cause

`shouldQueueInput()` (`mobile-input-queue.ts:89`) decides whether to park or dispatch by reading
`instance.status` at the top of `MobileGatewayServer.handleInput()`. That field only flips to a busy
status once the provider adapter's `sendInputImpl` actually runs (e.g.
`codex-app-server-adapter.ts:515`, `this.emit('status', 'busy')`) — itself reached only after several
`await`s inside `InstanceManager.sendInput()` (permission checks, persistence, etc.). Two
near-simultaneous `handleInput()` calls for the same instance can both read the still-`idle` status
and both proceed straight to `this.source().sendInput()`; whichever one the adapter actually receives
second gets its raw rejection, which `codex-app-server-adapter.ts`'s `sendInputImpl` catch block turns
into an `error`-type output message rather than a queued response. This is a realistic trigger — a
rapid double-tap send, or a client retry racing the original request — not only a synthetic timing
artifact.

### Required behavior

A second `POST /input` for an instance that already has a direct (non-queued) send in flight must be
parked exactly like a send that arrives while `instance.status` is already busy — never dispatched
straight to the adapter.

### Fix — 2026-08-18

`src/main/mobile-gateway/mobile-gateway-server.ts`:
- Added `private readonly directSendInFlight = new Set<string>()`, marked *synchronously* — no
  `await` between the `shouldQueueInput` check and the mark — immediately before the direct
  `this.source().sendInput(...)` call in `handleInput()`, and cleared in a `finally`.
  `handleInput()`'s queue-or-dispatch branch now reads
  `shouldQueueInput(instance, paused) || this.directSendInFlight.has(instanceId)`.
- `handleInstanceRemoved()` also clears the instance's entry, for hygiene.

`src/main/mobile-gateway/mobile-input-queue.ts`:
- `MobileInputQueueDeps.isPaused` widened from `isPaused(): boolean` to a per-instance
  `isPaused(instanceId: string): boolean`, and its one call site in `deliverNext()` now passes
  `instanceId`. Needed because `handleInput()`'s existing "kick a drain in case the ready edge already
  passed" safety net (`void this.inputQueue.drain(instanceId)`, called right after enqueueing) would
  otherwise immediately redeliver the just-queued message anyway — `instance.status` had not changed
  either, so `isReadyForQueuedInput` would still read "ready". `MobileGatewayServer`'s `isPaused` deps
  wiring now returns `this.pauseState().isPaused || this.directSendInFlight.has(instanceId)`, so the
  drain's readiness check correctly treats "another direct send is in flight for this instance" the
  same as a global pause — not ready.

New regression test, `mobile-gateway-server.spec.ts` › *"queues a direct send that races an in-flight
direct send for the same instance (LT-181)"*: holds the first `sendInput` mock call open on a
controllable gate (so the fake instance's status never has to change), fires a second concurrent
`/input` request for the same instance, and asserts the second response is `{queued: true, queueId:
...}` and that `sendInput` was called only once. **Watched it fail red on revert**: reverted both
files to their pre-fix state, reran, and got `AssertionError: expected "spy" to be called 1 times, but
got 2 times` plus an `afterEach` hook timeout (the held-open first mock call never resolved, since the
second, wrongly-dispatched call used the same mock's default resolving implementation and returned
before the fix's guard would have queued it) — then restored the fix and confirmed the same test, plus
the rest of both spec files, passed.

**Regression scope checked:** `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json` clean;
`npm run lint` clean; `npm run check:ts-max-loc` clean (neither file newly over its ceiling); `npm run
build:main` succeeded. Targeted suite: `mobile-gateway-server.spec.ts` + `mobile-input-queue.spec.ts`
→ 2 files · 113 tests passed (the latter's stub `isPaused: () => paused` remained valid — TypeScript
and JS both accept a callback ignoring an added parameter).

**Live-verified**, same dev-app harness the livetest evidence run used: a controlled sequential race
(message A busy-making, message B ~0.6s later while status was confirmed `busy`) now returns
`{"ok":true,"queued":true,"queueId":"..."}` for B with no transcript error, delivered in order once A
completes.

### Completion-gate finding — the first fix was asymmetric, 2026-08-18

An independent completion gate reviewing this work reproduced a second, symmetric instance of the same
race the fix above did not close: `directSendInFlight` was set/cleared only inside `handleInput()`'s
direct-send branch. `MobileInputQueue.deliverNext()`'s own delivery — `this.deps.deliver(...)`, wired
to a raw `this.source().sendInput()` call — reached the adapter without ever marking anything, so a
*fresh direct send* could still race an *in-flight queue delivery* for the same instance (a queued
message drains just as the turn that unblocked it finishes, and the user sends again — an ordinary
sequence, not a contrived one). The gate proved it with a scratch spec: queue while busy, flip the
instance ready, gate the queue's own delivery open, trigger `drain()`, then fire a fresh direct
`POST /input` — `source.sendInput` was called twice, the second response `{ok: true}` rather than
queued, LT-181's exact symptom via the other pairing of callers.

**Fixed by closing the window symmetrically** instead of patching the second path separately: both
callers now funnel through one shared helper, `MobileGatewayServer.dispatchSend()` — the *only* place
that marks/clears a renamed `sendInFlight: Set<string>` around the adapter call. `handleInput()`'s
direct-send branch and the `inputQueue`'s `deliver` dependency both call `dispatchSend()` instead of
`this.source().sendInput()` directly, so there is one place that can be got wrong, not two that must be
kept in step. `MobileInputQueueDeps.isPaused(instanceId)` is unchanged in shape (still per-instance)
but now correctly reflects *either* kind of in-flight send.

Added a second regression test, `mobile-gateway-server.spec.ts` › *"queues a direct send that races an
in-flight QUEUE DELIVERY for the same instance (LT-181)"*, matching the gate's reproduction exactly.
Watched it fail two ways: (1) a full revert of both production files failed both LT-181 tests
(`sendInput` called twice / `queued: undefined`, plus a 10s hook timeout); (2) a *partial* revert that
restored only the queue's `deliver` dependency to call `sendInput()` directly (the exact asymmetric
first-pass shape) left the original direct-vs-direct test **passing** and failed only the new
queue-drain-vs-direct-send test (`AssertionError: expected undefined to be true` on `directBody.queued`)
— confirming the gate's finding was real, specific to the queue-drain path, and not a re-run of the
original bug. Restored the full symmetric fix and confirmed both tests, plus the rest of both spec
files, green (114 tests total, was 113).

`check:ts-max-loc` needed attention: `mobile-gateway-server.ts` grew past its 1585-line ceiling's +50
tolerance (1647 lines) after the new helper and its comments. Trimmed the added doc comments (not the
logic) back to 1625 lines — 40 over ceiling, inside the +50 tolerance, ceiling not raised.

### Acceptance

- A second send for an instance with another send already in flight — direct **or** queue-drained —
  is queued, never dispatched to the adapter a second time.
- The queue's post-enqueue drain safety-net does not redeliver into an instance with any kind of send
  still in flight.
- Exactly one code path (`dispatchSend()`) marks and clears the in-flight guard, for both callers.
- No regression to the existing status-based queue/pause/drain behavior (114/114 tests in the two
  owning spec files, including all pre-existing queue-ordering, cancel, and pause-drain cases).

<a id="lt-188-archived-detail"></a>

## LT-188: manual "Compact Now" races its own auto-compact trigger, producing duplicate compactions and duplicate fallback proposals

### Observed behavior

Driving checks 3/4 of the Local AI Guard live test (`2026-07-26-local-ai-guard_plan_livetest_completed.md`)
against a real `claude` instance whose `outputBuffer` had been grown past the 0.85 `triggerThreshold`
(via large user pastes), a single `compactInstance({instanceId})` IPC call — the app's "Compact Now"
action — consistently logged **two** `[ContextCompactor] Compaction started` entries, at different
`originalTokens`/`fillRatio` values, e.g.:

```
[ContextCompactor] Compaction started { originalTokens: 174819, turnCount: 3, fillRatio: 0.874095 }
[ContextCompactor] Compaction started { originalTokens: 227669, turnCount: 6, fillRatio: 1.138345 }
```

Under the target's `require-confirmation` fallback policy, this was directly observable as **two**
independent pending paid-fallback approval requests (`localAiGuardListPendingFallbacks()` returned 2
entries) for what the user experienced as one "Compact Now" click — one request's `routingEventId`
matched the compaction the IPC caller actually awaited and received a result for; the second request
was created roughly 50 seconds later, well after the `compactInstance()` promise had already resolved
and returned control to the caller, and was never resolved by anything the caller did. Both had to be
resolved separately via `localAiGuardResolveFallback` before the pending queue was empty.

On at least one attempt with the `notify-and-allow` policy, this race went the other way: the
duplicate/racing internal compaction appears to have overwritten or otherwise interfered with the
outer one's state before it reached `generateSummary()`, and the manual compaction completed
(`success: true`) with **no** Local AI Guard routing event created at all for that call — the
compression slot's fallback machinery was silently never exercised, even though `shouldCompact()` was
true for both the inner and outer calls.

### Root cause

`ContextCompactor` is a process-wide singleton (`ContextCompactor.getInstance()`), and its
`addTurn()` unconditionally checks `this.config.autoCompact && this.shouldCompact() &&
!this.compactionInProgress` after every single turn is added, firing an **un-awaited**
`this.compact()` the moment `fillRatio` crosses `triggerThreshold`
(`src/main/context/context-compactor.ts:216-224`).

`CompactionRuntime.restartCompact()` (`src/main/app/compaction-runtime.ts`) — the strategy behind
manual "Compact Now" for any provider without native compaction support (Claude among them, since
`nativeCompact()` returns `false` when the adapter has no `compactContext()` method) — calls
`compactor.clear()` and then rebuilds the *entire* transcript via a loop of `compactor.addTurn(turn)`
calls sourced from `instance.outputBuffer`, before making its own **unconditional**
`await compactor.compact(...)` call once the loop finishes. On a transcript large enough to cross
`triggerThreshold` mid-loop (true for realistically any transcript that actually needs compacting),
the loop itself triggers `addTurn()`'s own auto-compact **inside** `restartCompact()`, and that
auto-triggered `compact()` runs **concurrently** with the loop's own subsequent turns being added and
with the explicit `compact()` call that follows — both operating on the same mutable `this.state`
(`turns`, `summaries`, `totalTokens`) with no coordination between them. `compactionInProgress` only
guards the auto-trigger against *itself* re-firing; it does nothing to stop the manual caller's own
explicit `compact()` from running at the same time.

### Required behavior

A single manual "Compact Now" action must produce exactly one compaction attempt and, if it needs the
compression role, exactly one Local AI Guard routing event/fallback proposal — never zero (silently
skipped) and never two (duplicate proposals, potentially duplicate real paid-provider charges once a
real frontier key is configured). `restartCompact()`'s turn-rebuild loop must not be able to trigger
an independent, uncoordinated background compaction on the same singleton state it is itself about to
compact explicitly.

### Fix

Not implemented this session — needs design, not a one-line patch. Plausible directions worth
weighing: (a) have `restartCompact()` suspend `autoCompact` on the shared `ContextCompactor` for the
duration of its own rebuild-and-compact sequence (`updateConfig({autoCompact: false})` around the
loop, restored after), (b) make `addTurn()`'s auto-trigger check a re-entrancy guard that also covers
an in-flight *caller-driven* `compact()`, not just its own async trigger, or (c) stop rebuilding the
whole transcript through the turn-by-turn `addTurn()` API for a manual restart and instead seed
`ContextCompactor`'s state directly, bypassing the per-turn auto-compact check entirely. Whichever
direction is chosen should include a regression test that reproduces the duplicate-routing-event (or
race-with-no-routing-event) behavior on a revert before trusting the fix.

<a id="lt-190-archived-detail"></a>

## LT-190: Local AI Guard fallback cost estimation silently returns nothing for any real `defaultCli` value

### Observed behavior

With `settings.defaultCli` set to `'claude'` (an ordinary, real setting value — not an edge case),
several real `compression`-slot Local AI Guard fallback routing events persisted correctly with
`provider: 'claude', model: 'opus[1m]'`, but `estimated_cost_usd` was `NULL` on every one of them,
despite `opus[1m]` (`CLAUDE_MODELS.OPUS_1M`) having a real, priced entry in `MODEL_PRICING`
(`{input: 5.0, output: 25.0}`) and being listed under `PROVIDER_MODEL_LIST.claude`.

### Root cause

`LocalAiRoutingGuard.authorizeFallback()`'s pre-authorization cost estimate comes from
`resolveFallbackModel()` (`src/main/local-ai-guard/local-ai-runtime.ts`), which returns
`{ provider: settings.defaultCli, model: ... }` — i.e. the CLI-facing provider id (`'claude'`,
`'codex'`, `'gemini'`, ...), the same namespace `PROVIDER_MODEL_LIST` is keyed by. That value is fed
straight into `computeProviderTokenCost()` → `getProviderModelRate()` →
`normalizePricingProvider()` (`src/shared/data/model-pricing.ts`), whose `switch` only recognized the
*upstream vendor* names — `'anthropic'` → `'claude'`, `'openai'` → `'codex'`, `'google'` → `'gemini'`
— and returned `undefined` for anything else, including `'claude'` itself (never one of the three
recognized cases). `getProviderModelRate()` short-circuits to `undefined` whenever
`normalizedProvider` is falsy, so the rate lookup — and therefore the entire cost estimate — silently
disappeared for every caller passing an already-CLI-style id, which `resolveFallbackModel()` always
does. This affects only the *pre-call* estimate; the separate, correctly-wired *post-call* "known
cost" path (`applyLocalAiRoutingCostAttribution()`, fed by `record.provider` values like `'anthropic'`
from `llm-service.ts`'s real Anthropic/OpenAI completions) was unaffected, since it always passes true
vendor names.

### Required behavior

`computeProviderTokenCost()`/`getProviderModelRate()` must resolve a rate for a provider id in either
of the two namespaces callers legitimately use: the CLI-facing ids (`'claude'`, `'codex'`, `'gemini'`,
...) and the upstream vendor names (`'anthropic'`, `'openai'`, `'google'`) — both already exist as
real call sites in this codebase.

### Fix — 2026-08-18

Added a `CLI_PROVIDER_KEYS` set derived from `Object.keys(PROVIDER_MODEL_LIST)` and checked it first
in `normalizePricingProvider()`: an already-canonical CLI-style id now passes through as an identity
match before falling back to the existing vendor-name switch. Since none of `'anthropic'`/`'openai'`/
`'google'` collide with a `PROVIDER_MODEL_LIST` key, the existing vendor-name behavior (and the
existing `getProviderModelRate('unknown', ...)` → `undefined` test) is unaffected.

Regression coverage: `src/shared/data/model-pricing.spec.ts`, new `describe('getProviderModelRate
provider-id aliasing (LT-190)')` block — 3 tests: an already-CLI-style id (`'claude'` +
`CLAUDE_MODELS.OPUS_1M`) resolves correctly through both `getProviderModelRate` and
`computeProviderTokenCost`, the upstream vendor-name spelling still resolves for both Anthropic and
OpenAI, and a provider that is neither a CLI id nor a known vendor name is still rejected. Reverted
the fix in an isolated copy first and watched the first test fail with `expected undefined to deeply
equal { input: 5, output: 25 }`; restored and confirmed all 19 tests in the file pass.

Live-verified end to end after rebuilding `dist/main` and restarting the dev app on the same profile:
the next two real `compression`-slot fallback routing events persisted `estimated_cost_usd: 0.38982`
and `0.5037` respectively (correctly computed from the real 57,484- and 80,260-token estimates against
`opus[1m]`'s $5/$25-per-1M rate), where every prior event in the same session had `NULL`.

Gates green: `tsc --noEmit` ×2, `ng lint`, `build:main`; `check:ts-max-loc` unaffected (one pre-existing
unrelated violation in `mobile-gateway-server.ts` from other concurrent work, not touched by this fix).
Targeted `model-pricing.spec.ts` suite green (19/19).

### Completion-gate finding — 2026-08-18: the fix's own widening was itself unsafe

An independent completion gate confirmed the original defect, the repro, and the revert evidence
above, then found a **new** problem introduced by the fix itself: `CLI_PROVIDER_KEYS`'s
identity-passthrough widened `normalizePricingProvider()` to accept *any* `PROVIDER_MODEL_LIST` key,
but `getProviderModelRate()`'s static-table fallback (`MODEL_PRICING[normalizedModel]`) is a **flat
map keyed by raw model id, not namespaced by provider** — only the live overlay (`providerOverlayRates`,
keyed `${provider}:${id}`) is namespaced. `PROVIDER_MODEL_LIST.copilot` and `.cursor` reuse the exact
same raw id strings as the primary vendors they proxy for pass-through models:
`COPILOT_MODELS.CLAUDE_OPUS_5 === CLAUDE_PINNED_MODELS.OPUS_5 === 'claude-opus-5'`;
`COPILOT_MODELS.GPT53_CODEX === OPENAI_MODELS.GPT53_CODEX === 'gpt-5.3-codex'` (also reused verbatim
in Cursor's curated list); `COPILOT_MODELS.GEMINI_3_1_PRO` literally aliases
`GOOGLE_MODELS.GEMINI_3_1_PRO`. So on the fixed tree, `getProviderModelRate('copilot',
'claude-opus-5')` returned `{input: 5, output: 25}` — Anthropic's direct API rate — instead of the
pre-fix `undefined`. Before the fix this was a silent zero; after it, a **confidently wrong,
non-zero number**, which is worse: `resolveFallbackModel()` legitimately returns
`{provider: 'copilot', model: 'claude-opus-5'}` for a Copilot-pinned default, that value flows
straight into the `estimatedCostUsd` recorded on the routing event and into the budget-ceiling
check (`local-ai-fallback-store.ts`'s `exceedsConfiguredCeiling()`), so a wrong rate there changes
whether a paid fallback is actually blocked.

Domain context surfaced by the gate: Copilot here is a **subscription seat** (James's EBRD-scoped
seat, deliberately excluded from automation provider-selection), not per-token billing — pricing its
usage at Anthropic's direct API rate is not merely imprecise, it is the wrong billing model. The same
applies to Cursor.

Checked what the gate asked before designing a fix:

- **Does `exceedsConfiguredCeiling()` already distinguish "unpriceable" from "priced at zero"?**
  Yes, and it already fails closed on unknown: `exceedsConfiguredCeiling(ceiling, estimate, spend)`
  (`local-ai-fallback-store.ts:267-273`) returns `true` (blocks) whenever `estimate === undefined`,
  *before* ever comparing it against the ceiling — an unpriceable estimate is already treated as
  worse than a merely-large one. `createRoutingEvent()` (`local-ai-routing-guard.ts:271`) only sets
  the `estimatedCostUsd` field when `input.estimate !== undefined` — an unpriceable model gets no
  key at all (not a `0`), so `undefined` reaches the ceiling check intact. The gate-reported bug
  therefore didn't just misprice a fallback, it *bypassed this existing fail-closed guard* by
  handing it a defined-but-wrong number instead of the `undefined` that would have tripped it.
- Confirmed `defaultCli === 'auto'` never reaches the normalizer (`local-ai-runtime.ts:232`'s
  `provider !== 'auto' && model ? {...} : undefined` guard), the legacy `'openai'` vendor-name alias
  still resolves, and `'ollama'` stays deliberately unpriced (`PROVIDER_MODEL_LIST.ollama` is `[]`,
  so the `.some(...)` membership check always fails regardless of the allowlist).

**Fix — 2026-08-18 (same day, addressing the gate finding):** Added an explicit
`STATIC_TABLE_PROVIDERS` allowlist (`new Set(['claude', 'codex', 'gemini', 'grok'])`) — the primary
vendors that actually own the raw-id space `MODEL_PRICING` is keyed by — and gated the static-table
fallback branch of `getProviderModelRate()` on membership in it, checked *after* the
provider-namespaced live-overlay lookup (which is safe and unaffected: a real per-provider rate for
`copilot`/`cursor` could still be registered there if one is ever known) and *before* the
`PROVIDER_MODEL_LIST` membership check. Deliberately an allowlist, not a denylist, per the gate's own
guidance, so a future provider added to `PROVIDER_MODEL_LIST` is unpriced by default rather than
silently inheriting whatever raw id it happens to share with an existing vendor.

Added the regression test the gate asked for, in the same `describe` block: "does not price a
reseller/proxy model at the primary vendor rate just because the raw id string collides" — asserts
`COPILOT_MODELS.CLAUDE_OPUS_5 === CLAUDE_PINNED_MODELS.OPUS_5` (the collision is real, not assumed),
then that `getProviderModelRate('copilot', COPILOT_MODELS.CLAUDE_OPUS_5)` is `undefined` and is
`not.toEqual` the real Claude rate; the same shape for the Codex-family id on both `copilot` and
`cursor`; that `computeProviderTokenCost` propagates `undefined` (never `0`) for the colliding case;
and that Cursor's `AUTO` sentinel is unpriced too (Cursor is excluded from the static table entirely,
not just for the one colliding id checked). Reverted the allowlist gate in a `/tmp` copy (never
`git stash`/`checkout --`/`restore`/`reset`/`clean`) and watched the new test fail with `expected
{ input: 5, output: 25 } to be undefined` — the exact aliasing bug — then restored and confirmed
20/20 tests pass in the file.

Re-ran all gates after the follow-up fix: `tsc --noEmit` ×2 clean, `ng lint` clean, `build:main`
clean, `check:ts-max-loc` unaffected (`model-pricing.ts` not flagged; the one pre-existing
`mobile-gateway-server.ts` violation is unrelated concurrent work). Targeted
`model-pricing.spec.ts` suite green, 20/20, read from the summary line (not exit code alone).

Sent back to a fresh completion gate.

**One related, pre-existing, out-of-scope observation:** `getModelRate(model)` — the
provider-agnostic sibling used by `computeTokenCost()`/`CostTracker` elsewhere — resolves purely by
raw model id with no provider disambiguation at all, so it has the same theoretical id-collision
exposure this gate finding describes. It was not touched by either LT-190 change (before or after
today) and is a different call path (real cost accounting from a provider's own reported usage, not
a pre-authorization estimate), so fixing it was out of scope here — flagged for whoever next touches
that function, not fixed.

<a id="lt-193-archived-detail"></a>

## LT-193: Unpriced fallback dispatches display as `$0` rather than unknown

**Observed behaviour.** A Local AI Guard fallback dispatch whose token cost cannot be priced
contributes `0` to the incident and effectiveness dollar totals shown in the UI, so a run of
genuinely unpriceable dispatches reads as "this cost nothing" rather than "this cost is unknown".

**Root cause.** `addAccountingCost()` (`src/main/local-ai-guard/local-ai-row-mappers.ts:655-659`)
folds a routing event into an incident with `const total = current + (incoming ?? 0)`. The
destination field `LocalAiIncident.estimatedCostUsd` is a required, non-nullable `number`
(`src/shared/types/local-ai-guard.types.ts:217,311`), so there is nowhere for "unknown" to live and
the `?? 0` is forced. The value is then rendered as a dollar figure directly in
`local-ai-target-card.component.ts:479`, `local-ai-incident-panel.component.ts:295-296` and
`local-ai-effectiveness-panel.component.html:71`.

**Why this is not the same bug as LT-190, and not a regression from it.**
`local-ai-row-mappers.ts` was untouched by the LT-190 fix. Before LT-190, essentially *every*
fallback event was undefined-cost, so this collapse already applied to all providers; after LT-190 it
applies only to the four deliberately-unpriced providers (`copilot`, `cursor`, `ollama`,
`antigravity`). LT-190 narrowed it rather than causing it.

**Note the layer below already does this correctly**, which is both the proof that "unknown" is
representable here and the template for the fix: `LocalAiFallbackSpend` persists `NULL` rather than
`0` and carries a separate `unknown_reservations` counter
(`src/main/local-ai-guard/local-ai-fallback-spend.ts:50-55`), and `exceedsConfiguredCeiling()`
(`local-ai-fallback-store.ts:268-275`) treats an undefined estimate as *exceeding* a configured
ceiling — i.e. the safety-critical path fails closed correctly. Only the human-facing aggregate
loses the distinction.

**Required behaviour.** An unpriceable dispatch must remain distinguishable from a zero-cost one
wherever a total is shown to the user.

**The decision needed.** Copilot (and arguably Cursor) is a subscription seat, so `$0` *marginal*
cost is defensible — but it should be shown as a deliberate "not metered" rather than as an
arithmetic zero. Whether the UI should render `—`, `$X + N unknown`, or an explicit "not metered"
badge for seat-based providers is a small product call, so it is recorded here rather than decided.

**Acceptance.** `LocalAiIncident` carries an unknown-cost count alongside `estimatedCostUsd`;
the three render sites above distinguish unknown from zero; a regression test asserts that folding an
event with no `estimatedCostUsd` into an incident does not increment the dollar total and does
increment the unknown count.

**Provenance.** Surfaced by the LT-190 second completion gate on 2026-08-18, which traced one layer
past the ceiling check it had been asked to verify and found the coalesce downstream. Reported rather
than fixed because it lives entirely in files outside that review's scope and predates the diff.

<a id="lt-194-archived-detail"></a>

## LT-194: Workboard Decision Timeline's compaction source could never produce an entry

**Observed behaviour.** Compacting a real instance (Preview→Confirm or plain "Compact Now") never
produced a "Context compacted after N turns" entry in the Workboard item's Decision Timeline, no
matter how many times it was run.

**Root cause.** `buildCompactionDecisions()` (`src/main/workboard/operational-decision-projection.ts`)
is fed by `CompactionCoordinator.getEpochTracker(instanceId).getHistory()`
(`src/main/ipc/handlers/workboard-handlers.ts:110`). `CompactionEpochTracker.onCompaction()`
(`src/main/context/compaction-epoch.ts`) is the only method that ever pushes into `.history`, and
`incrementTurn()` is the only method that ever advances `turnCount` (which becomes
`turnsBeforeCompaction`) — neither had a single call site anywhere in `src/main` outside the class
itself. `CompactionCoordinator.executeCompaction()` never called `onCompaction()` on success, and
`onContextUpdate()` (the per-turn context-usage report hook) never called `incrementTurn()`. The
source was consequently permanently, silently empty for every user.

**Live reproduction.** Grew a real Claude instance to several exchanges, ran a real
`compactInstance()` IPC call (confirmed `success: true`), then queried
`workboardGetDecisionsForItem({instanceId})` and got `[]` back — no compaction source entry at all.

**Fix.** `src/main/context/compaction-coordinator.ts`: call
`this.getEpochTracker(instanceId).onCompaction()` in `executeCompaction()` immediately after a
successful compaction (native or restart-with-summary, before the `result` object is built), and
call `this.getEpochTracker(instanceId).incrementTurn()` in `onContextUpdate()` (the existing
per-turn context-usage report hook) so `turnsBeforeCompaction` reflects real activity rather than
always reading `0`.

**Re-verification (post-fix, rebuilt `dist/main`, restarted dev app).** A real compaction now
produces `{"source":"compaction","title":"Context compacted after 7 turns"}` from
`workboardGetDecisionsForItem`, and the real Workboard item detail DOM renders `"Decision timeline …
Context compacted after 7 turns"`.

**Regression test.** `src/main/context/compaction-coordinator.spec.ts`, new describe block
"CompactionCoordinator epoch tracking (LT-194 — Workboard decision timeline feed)" (4 tests: records
on native success, records on restart-with-summary success, does NOT record on failure, counts real
turns via `onContextUpdate` and starts the next epoch at zero). Reverted both call sites via a `/tmp`
copy and watched exactly the 3 assertion-bearing tests fail (`expected [] to have a length of 1 but
got +0`); restored and confirmed 22/22 tests pass in the file.

<a id="lt-195-archived-detail"></a>

## LT-195: automation retry/backoff silently cancelled by an async `automation:changed` race, for every one-time automation

**Observed behaviour.** A one-time automation (manual `runNow`, a provider-limit-resume automation,
or any user-created one-time schedule) whose fired run failed with a genuinely retryable error never
actually retried, even though `maxAttempts` allowed more attempts and the failure type was retryable.
The run stayed at `attempt: 1`, status `failed`, forever — no second attempt, no auto-disable, no
error surfaced beyond the one lonely failed run. `consecutiveFailures` on the automation never
incremented either, because the runner correctly believed a retry was pending and deliberately skips
recording a streak outcome in that case.

**Root cause.** `AutomationRunner.handleTerminalRun()` synchronously schedules a retry via
`this.retryScheduler(run, attempt + 1, maxAttempts, delayMs)` when a failed run is retryable and
attempts remain. For a `oneTime` run, the same function then calls `this.emitAutomationState()`
(`src/main/automations/automation-runner.ts:566-575`), which is asynchronous:
`this.store.get(automationId).then((automation) => this.events.emitChanged({...}))`. That `.then()`
callback re-emits `'automation:changed'` *after* the synchronous retry-scheduling call above has
already returned. By the time it lands, the automation's own `nextFireAt` has already gone `null`
(the one-time schedule "spent" by firing — independent of the retry), so
`AutomationScheduler`'s generic `'automation:changed'` listener
(`src/main/automations/automation-scheduler.ts:93-102`) evaluates `active && enabled && nextFireAt
!== null` as `false` and falls to its `else` branch, calling the FULL `deactivate()` — which cancels
**every** retry timer currently armed for that automation, including the one just scheduled a moment
earlier. The existing `'automation:run-terminal'` listener (the target of the earlier, correctly
applied "BUG 1" fix) is fine — it fires synchronously and uses the safe `deactivateSchedule()`. This
second, async listener was never given the same guard.

**Live reproduction (certainty via instrumentation).** Monkey-patched
`AutomationScheduler.prototype.deactivate` via the Node Inspector Protocol on the real running main
process to capture a stack trace on every call, alongside `retryHandlesBefore` (the retry-handle keys
present at the moment of the call). Fired a real one-time automation whose `workingDirectory` pointed
at a plain file (guaranteeing a genuine spawn failure, not a permission-wait). Captured:
```
AutomationScheduler.deactivate
  ← AutomationEvents 'automation:changed' listener (automation-scheduler.js:82)
  ← AutomationEvents.emit
  ← AutomationEvents.emitChanged
  ← automation-runner.js:433 (emitAutomationState's .then() callback)
```
with `retryHandlesBefore: ["<the run's own id>"]` — i.e. the retry handle existed immediately before
this call wiped it. The app log independently showed the "Scheduling automation retry" info line
firing (with a real `delayMs`) for the same run, and `AutomationStore.listPendingRetries()` and the
run row both confirmed no retry was actually armed minutes later.

**First-pass fix (superseded — see completion-gate finding below).**
`src/main/automations/automation-scheduler.ts`: added a private `hasPendingRetry(automationId)`
helper (checks `retryHandles` for any entry belonging to that automation). The `'automation:changed'`
listener's `else` branch checked it first: if a retry was pending, only `deactivateSchedule()` ran
(preserving the retry), reasoning that "a genuine disable/delete has no pending retry to preserve".
Re-verified live at the time (rebuilt `dist/main`, restarted dev app): the same repro scenario
genuinely retried — a second run row appeared with `attempt: 2`, and
`workboardGetDecisionsForItem({automationRunId})` and the real Workboard item detail DOM both showed
`"Retried automatically — attempt 2 of 3"`.

**Completion-gate finding — P1 regression, same day.** The first-pass reasoning was wrong for a
*disable*, not just delete. `AUTOMATION_UPDATE` (`src/main/ipc/handlers/automation-handlers.ts:96-97`
— the handler behind toggling `enabled: false` in the Automations page "Pause" control) and the
`update_automation` MCP tool (`src/main/automations/automation-tool-impl.ts:373-376`) both call
`scheduler.schedule(automation)` — which only clears the *fire* handle
(`automation-scheduler.ts:149-152`) — then `events.emitChanged(...)`. Neither calls `deactivate()` or
`cancelRetry()` (delete *is* safe: it explicitly calls `scheduler.deactivate(id)` first in both
places). So on disable-with-armed-retry, `hasPendingRetry` was true, the first-pass fix took the
`deactivateSchedule`-only branch, and the retry timer survived a disable — reachable from ordinary UI
use ("Pause" toggle), not an edge path. `onRetryTimer` → `insertRetryRun`
(`automation-store-retry-ops.ts:58-90`) only checks the automation row still *exists*, never that it
is `enabled`/`active`, so the surviving timer fired and dispatched a run for an automation the user
had just disabled — for the auto-created provider-limit "resume after quota reset" automations
specifically, an unexpected session resume against something the operator believed disabled. Also not
limited to `oneTime`: `handleTerminalRun` (`automation-runner.ts:625-648`) does not gate retry
scheduling on `isOneTimeRun`, so a cron automation disabled mid-backoff hit the identical gap (the
auto-disable-after-repeated-failures path is unaffected — it uses `emitScheduleDeactivated`, which
always fully deactivates). Reproduced empirically by replaying the real
`store.update({enabled:false})` → `scheduler.schedule()` → `emitChanged()` sequence against the
first-pass fix: `retryHandles.size` stayed `1` when it had to be `0`.

**Corrected fix.** The `'automation:changed'` listener's retry-preserving branch now additionally
requires `event.automation?.enabled === true` before taking the `deactivateSchedule`-only path — the
one field every disable path in this codebase actually flips: the Automations-page "Pause" toggle
(`automations-page.component.ts`'s `togglePaused()`), `AUTOMATION_UPDATE`, and `update_automation` all
only ever change `enabled`, never `active` on their own (confirmed by reading all three call sites);
a fired run's own post-fire echo (the race this fix exists for) never touches `enabled` either. So
this is not a heuristic that happens to work for the known cases — it is the same authoritative on/off
bit those write paths themselves use to signal "turned off", checked here to tell a genuine disable
apart from the async echo. `event.automation` being `null` (the delete path) evaluates to
`undefined === true` (false), so it defensively falls through to the full `deactivate()` too, rather
than depending on delete's own explicit `deactivate()` call running first. The misleading first-pass
code comment (which claimed disable had no pending retry to preserve, without qualifying that this was
true only for the echo case) was rewritten to state the actual distinguishing signal and why it holds.

**Re-verification (corrected fix).** Re-ran gates: `tsc --noEmit` ×2, `ng lint`, `check:ts-max-loc`,
`build:main`, and the full `src/main/automations` suite (165/165) — all green. Not re-verified live
against the real dev app a second time this round (the corrected condition is exercised by a
regression test that replays the exact real production call sequence the gate itself used to
reproduce the regression, so this is considered adequately covered without a second live cycle;
flag if independent live verification is still wanted).

**Regression test.** `src/main/automations/automation-retry-integration.spec.ts`, describe block
"LT-195 — oneTime retry survives the automation:changed race", now 4 tests: (1) the original repro —
an `'automation:changed'` echo with `active:true, enabled:true, nextFireAt:null` while a retry is
pending must preserve it; (2) a genuine `enabled:false` disable with NO pending retry still fully
deactivates (control); (3) **new** — a genuine `enabled:false` disable racing an ARMED retry for a
oneTime automation must cancel it (`retryHandles.size` reaches `0`, `insertRetryRun` never called
after advancing past when the timer would have fired); (4) **new** — the same for a cron automation,
proving the gap was not oneTime-specific. Reverted only the corrected condition (the
`event.automation?.enabled === true` guard, restoring the first-pass `hasPendingRetry(...)`-only
check) via a `/tmp` copy and watched exactly tests (3) and (4) fail (`expected 1 to be +0`) with all
other 25 tests — including test (1), the original echo-preserves-retry repro — staying green; restored
and confirmed 27/27 pass.

<a id="lt-200-archived-detail"></a>

## LT-200: instance-detail Review panel's `reviewStartSession` call always fails Zod validation

### Observed behavior

Preparing to drive the skill-observability livetest's check 8 (design-drift review agent), calling
`InstanceReviewPanelComponent.runReview()`'s exact IPC payload live over CDP against a real instance
returned:

```json
{
  "success": false,
  "error": {
    "code": "REVIEW_START_SESSION_FAILED",
    "message": "IPC validation failed for REVIEW_START_SESSION: agentIds: Invalid input: expected array, received undefined"
  }
}
```

This is not specific to `design-drift-analyzer` — the payload shape is wrong for every agent, every
time.

### Root cause

`instance-review-panel.component.ts`'s `runReview()` called:

```ts
this.ipc.getApi()?.reviewStartSession({
  agentId: agentIds[0],
  instanceId,
  workingDirectory: this.workingDirectory() || '',
  files,
  options: { agentIds, diffOnly: this.diffOnly() }
});
```

`ReviewStartSessionPayloadSchema` (`packages/contracts/src/schemas/orchestration.schemas.ts:224-229`)
requires `{ instanceId, agentIds: string[], files, diffOnly? }`. The handler
(`orchestration-ipc-handler.ts:531-585`) reads `validated.agentIds` and resolves the working directory
itself from `instanceManager.getInstance(validated.instanceId).workingDirectory` — it never reads a
`workingDirectory` field from the payload at all. So the panel's call was wrong on every count: the
required array field was never sent (only nested, unread, inside `options`), and two fields it did
send (`agentId`, `workingDirectory`) are not part of the schema and are silently ignored even when
present.

The preload wrapper's TypeScript parameter type
(`src/preload/domains/orchestration.preload.ts:389-397`, before this fix) matched the wrong shape too
— `{ agentId: string; instanceId: string; workingDirectory: string; files?: string[]; options?:
Record<string, unknown> }` — so the component compiled cleanly against a call that could never
succeed at runtime. The sibling caller, `reviews-page.component.ts`, was unaffected: it goes through
`OrchestrationIpcService.reviewStartSession()` (`orchestration-ipc.service.ts:233-241`), which already
builds the correct `{ instanceId, agentIds, files, diffOnly }` shape and was never touched by this bug.

This is the review-agent entry point the skill-observability livetest's check 8 names ("Start a review
session including agent id `design-drift-analyzer` (review panel agent list should show 'Design Drift
Analyzer')"), so that check was structurally unreachable through this panel regardless of which agent
was selected.

### Fix

- `src/renderer/app/features/instance-detail/instance-review-panel.component.ts` — `runReview()` now
  calls `reviewStartSession({ instanceId, agentIds, files, diffOnly: this.diffOnly() })`, matching the
  schema exactly.
- `src/preload/domains/orchestration.preload.ts` — corrected the `reviewStartSession` parameter type to
  `{ instanceId: string; agentIds: string[]; files: string[]; diffOnly?: boolean }` so the wrapper's own
  type can no longer let a caller compile against the wrong shape.

### Regression test, watched failing on revert

Added `instance-review-panel.component.spec.ts` → *"LT-200: runReview() sends a reviewStartSession
payload shaped for ReviewStartSessionPayloadSchema (agentIds array, no bogus
agentId/workingDirectory/options)"*: mocks `reviewStartSession` (and `reviewGetSession`, so
`pollSession()` resolves immediately), drives `runReview()` with one selected agent and one file, and
asserts the exact captured payload plus the explicit absence of `agentId`/`workingDirectory`/`options`.

Reverted only the component's call-site fix (via a `/tmp` copy, never `git stash`/`checkout --`) and
re-ran:

```
✗ 1 of 21 tests failed in 3.9s:
  ✗ InstanceReviewPanelComponent (WS-C4 findings dispatch) LT-200: runReview() sends a
    reviewStartSession payload shaped for ReviewStartSessionPayloadSchema (agentIds array, no
    bogus agentId/workingDirectory/options)
    AssertionError: expected { …(5) } to deeply equal { instanceId: 'inst-1', …(3) }
```

Restored the fix; all 21 tests in the file pass again.

### Gates

`npx tsc --noEmit` clean, `npx tsc --noEmit -p tsconfig.spec.json` clean, `ng lint` clean,
`check:ts-max-loc` unaffected (both touched files were already within their pre-existing +50
tolerance and this change only removed lines), `npm run build:main` green, targeted `test:quiet` on
`instance-review-panel.component.spec.ts` → 21/21 passed.

### Provenance

Found while preparing to drive skill-observability check 8 live during the 2026-08-18 Batch U2
livetest run. Fixed the same session, then re-verified live against a real `design-drift-analyzer`
run: a fixture file with an `Inter` display font and a keyword-eased `transition: all` produced
exactly the two expected `design-drift/typography`/`design-drift/motion` findings with file:line
citations, and a backend-only SQL migration file produced zero findings — check 8 now passes both
halves (see the skill-observability livetest's check 8 evidence for the full detail).

<a id="lt-206-archived-detail"></a>

## LT-206: RLM and Wake renderer events are dead for the worker-routed paths

**Status: FIXED + REGRESSION-TESTED 2026-08-18.** See the index row above for the full fix
description, the empirical live-app confirmation of the diagnosis, the generic-vs-bespoke design
call, the revert-and-watch-it-fail evidence, and the related-but-out-of-scope finding (the
codebase-indexing lane worker has its own separate `RLMContextManager` instance with the same
theoretical exposure — not investigated or fixed here). The sections below are the original,
unmodified diagnosis this fix was built from.

**Observed behaviour.** Renderer live-update channels for RLM store/section activity
(`RLM_STORE_UPDATED`, `RLM_SECTION_ADDED`, `RLM_SECTION_REMOVED`, `RLM_QUERY_COMPLETE`) and for wake
context (`WAKE_EVENT_CONTEXT_GENERATED`) never fire during real usage, so any UI depending on them
only updates on a manual refresh.

**Root cause — the third and fourth instances of a class found twice already today.** The emitting
singleton lives in the **context-worker** process; the forwarding listener is registered on the
**main** process's separate instance of the same singleton. Identical in shape to LT-169 (skill
controls cached per-process) and LT-170 (skill activations emitted in the worker).

- `RLMContextManager` (`src/main/rlm/context-manager.ts:84`) emits `store:created` (:292),
  `section:added` (:315), `query:executed` (:395), `section:removed` (:525).
  `InstanceContextManager` (`src/main/instance/instance-context.ts:120`) holds the worker's instance,
  because production always routes through `ContextWorkerClient`.
  `setupRlmEventForwarding` (`src/main/ipc/ipc-main-runtime-wiring.ts:137-186`) subscribes to main's.
- `WakeContextBuilder` (`src/main/memory/wake-context-builder.ts:43`) emits `wake:context-generated`
  (:295) from `getWakeUpText()`, reached inside the worker via
  `instance-system-prompt.ts:339` → `instance-manager.ts:540` → `ContextWorkerClient.buildWakeContextText`.
  `setupKnowledgeEventForwarding` (`ipc-main-runtime-wiring.ts:243-244`) subscribes to main's.
  `wake:hint-added` shares the emitter and is equally suspect; not verified.

**Required behaviour.** An event emitted during worker-routed work must reach the renderer, or the
channel should be removed rather than left as dead wiring that looks functional.

**Acceptance.** Apply the LT-170 pattern — a worker→main forwarding message re-emitted on main's
singleton — to both emitters, or relocate the forwarding subscription to where the emit actually
happens. Add a per-channel regression test that fails when the event is emitted in the worker and
never reaches the renderer. Confirm `wake:hint-added` in the same pass.

**Why this is filed separately from LT-170.** The LT-170 diff is correct and complete for skill
activations; these are distinct emitters on distinct paths. Recorded so the *class* is not considered
closed just because one instance of it was fixed.

**Provenance.** Found by the LT-170/LT-200 completion gate on 2026-08-18, which was asked whether the
bug class had other live instances and went looking rather than assuming.

<a id="lt-207-archived-detail"></a>

## LT-207: the codebase-indexing lane's own RLMContextManager singleton never reaches main

**Status: FIXED + REGRESSION-TESTED 2026-08-18.** See the index row above for the full fix
description, the empirical live-app confirmation (control emit + real indexing run through the real
lane worker, single-delivery confirmed after a fresh app restart), the transport-adapter design (a
new `LaneOutboundMessage` `'worker-event'` variant threaded through `ProcessLaneGateway` →
`BackgroundJobRuntime` → `CodebaseIndexingLaneGateway`, reusing LT-206's `dispatchWorkerBroadcast()`
unmodified), the `isHighVolumeContextStore()` interaction note, the new import-isolation guard, and
the revert-and-watch-it-fail evidence for both halves of the transport.

**Observed behaviour.** `RLM_SECTION_ADDED`/`RLM_STORE_UPDATED` never fired for sections added by a
real codebase-indexing run (manual `CODEBASE_INDEX_STORE` or the auto-coordinator), even though the
identical LT-206 fix had just made the equivalent context-worker paths live.

**Root cause.** `codebase-indexing-lane-main.ts` constructs its own worker-local
`RLMContextManager.getInstance()` (a *third* process with a *third* instance of this singleton, after
main and the context-worker). `CodebaseIndexingService.addSection()`
(`src/main/indexing/indexing-service.ts:483`) calls `this.contextManager.addSection(...)` on that
instance, whose `section:added` emit (`context-manager.ts:315`) had no listener anywhere outside this
one lane process — the lane had no `registerWorkerEventForwarding`/`dispatchWorkerBroadcast` import at
all before this fix.

**Required behaviour.** A `section:added` fired by a real codebase-indexing job must reach main's
`RLMContextManager` singleton so the existing `setupRlmEventForwarding` (`ipc-main-runtime-wiring.ts`)
subscription can forward it to the renderer (subject to the pre-existing, unrelated
`isHighVolumeContextStore()` filter for `'codebase-auto'`-tagged stores, which is intentional and out
of scope for this ticket).

**Fix.** See the index row and the plan doc's LT-207 section
(`docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`) for the full mechanism.

**Why this is filed separately from LT-206.** LT-206 explicitly flagged this lane as a related,
out-of-scope finding — a different process with different wiring (a `LaneOutboundMessage` transport,
not `ContextWorkerOutboundMsg` directly), not the same code path.

**Provenance.** Found by the LT-206 completion gate on 2026-08-18, which checked whether LT-206's fix
made this lane newly reachable (it did not) and filed it as its own ticket.

<a id="lt-221-archived-detail"></a>

## LT-221: opening a context-evidence record's card always failed with EVIDENCE_AUDIT_FAILED — a stale SQL CHECK constraint, fixed with a schema migration

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

### Observed behaviour

Batch N1, driving check 7 (UI inspection) of the provider-agnostic-context-evidence livetest doc, live
in the real renderer (isolated dev app, `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-N1`, port 9601, CDP with
focus emulation — not a stale-render artifact). `contextEvidenceModeByProvider.claude` set to
`'shadow'` via `setSetting`; a real `claude` instance (`ccg2d60d1`) made real tool calls (`Read` on two
files); the instance context-bar's `.evidence-toggle` button was clicked, opening
`<app-context-evidence-panel>` with real occupancy/metrics/record data rendered — then a real record's
"Open card" button was clicked. The panel rendered `EVIDENCE_AUDIT_FAILED` at the top instead of card
content, in place of the expected card view (exact excerpt / bounded summary). This reproduced on
every attempt, for a fresh conversation and a fresh record.

### Root cause

Confirmed directly against the live SQLite file, not inferred:

```
$ sqlite3 conversation-ledger.db "INSERT INTO evidence_access_log (id,requester,conversation_id,operation,outcome_code,created_at)
  SELECT 'x','r',id,'get-card','OK',1 FROM conversation_threads LIMIT 1;"
Error: stepping, CHECK constraint failed: operation IN ('list', 'search', 'read', 'compare', 'verify')
```

`evidence_access_log`'s `operation` CHECK constraint, defined in migration `004_context_evidence`
(`conversation-ledger-schema.ts`), never included `'get-card'` — even though the column's own
TypeScript type, `EvidenceAccessLogInput.operation`
(`context-evidence-ledger.types.ts:189` — `'list' | 'get-card' | 'search' | 'read' | 'compare' |
'verify'`), always declared `'get-card'` valid. The SQL and the type drifted apart. Every
`contextEvidenceGetCard` call routes through `evidence-card-retrieval.ts`'s `audit()` helper, which
always logs `operation: 'get-card'` (line 190) before allowing the card read to proceed; that insert
always violated the CHECK constraint, `ContextEvidenceLedgerStore.logEvidenceAccess()` always threw,
and the calling code's bare `catch { throw new EvidenceRetrievalError('EVIDENCE_AUDIT_FAILED') }`
(`evidence-card-retrieval.ts:196-198`, and the identical pattern at
`evidence-retrieval-service.ts:648`) discarded the real SQLite error and re-threw only the generic
code — which is why this bug's actual cause was invisible in logs for however long it existed.
`list`/`search`/`read`/`compare`/`verify` were unaffected; only `get-card` — i.e. only the "Open card"
button — was broken, on every provider, every conversation, unconditionally.

### Fix

SQLite cannot `ALTER` an existing `CHECK` constraint, so a new migration (`005_evidence_access_log_get_card`,
`conversation-ledger-schema.ts`, `CONVERSATION_LEDGER_SCHEMA_VERSION` bumped 4→5) rebuilds the table
using the same rename→create→copy→drop pattern already established elsewhere in this codebase
(`rlm-migrations-022-035.ts`): `evidence_access_log` renamed to `evidence_access_log_004`, a new
`evidence_access_log` created with `'get-card'` added to the CHECK list, existing rows copied across,
the renamed table dropped, and the `idx_evidence_access_log_conversation_created` index recreated. This
runs automatically for every existing installation (via `runConversationLedgerMigrations()`'s
sequential apply-by-version loop) and for fresh installs alike (which also apply migrations 1-5 in
order, not just the initial schema).

**Verified.** New regression test in `conversation-ledger-schema.spec.ts` ("LT-221: allows a get-card
evidence_access_log row and preserves existing rows across the rebuild") — reverted the fix via a
`/tmp` copy of the pre-fix file and watched **2 tests fail**: the schema-version assertion
(`expected 4 to be 5`) and the new test itself
(`expected [Function] to not throw an error but 'SQLite3Error: SQLITE_CONSTRAINT_CHECK…' was thrown`,
reproducing the exact live error shape) — then restored the fix and confirmed all 4 tests in that file
pass, plus 65/65 across `src/main/conversation-ledger` and 302/302 across `src/main/context-evidence`
unaffected. `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
`npm run check:ts-max-loc`, and `npm run build:main` all clean.

### Not fixed, out of scope this session

The swallow-and-rethrow pattern (`catch { throw new EvidenceRetrievalError(...) }`, discarding the
real underlying error with no `logger.warn`/`logger.error` call) exists at both
`evidence-card-retrieval.ts:196-198` and `evidence-retrieval-service.ts:648` and is what made this bug
invisible in `app.log` for as long as it existed — the schema fix above resolves the reproduced defect,
but the observability gap that let it hide is still present for whatever the next `logEvidenceAccess`
failure turns out to be. Flagged, not fixed, to keep this ticket's scope to the reproduced behavioural
defect.

<a id="lt-222-archived-detail"></a>

## LT-222: the app-wide log redactor turns a legitimate `null` under any token-shaped key into the literal string "<redacted-secret>"

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

Found while advancing the Codex context-pressure observability livetest's residual (running the
analyzer/privacy-validator pipeline against real diagnostic data for the first time). A real Codex
baseline turn (`AIO_CODEX_CONTEXT_DIAGNOSTICS=1`, isolated dev app, real `codex` instance) produced 6
`CodexContextDiagnostics` log lines; `scripts/analyze-codex-context-pressure.ts` reported 3 of 6 as
malformed. Direct inspection of the raw log lines found the cause: `{"kind":"turn-start", …,
"baselineUsedTokens":"<redacted-secret>"}` and `{"kind":"token-usage", …,
"previousLastTotalTokens":"<redacted-secret>"}` — both fields are typed `number | null`
(`context-pressure-diagnostics.ts`) and legitimately `null` on a session's first turn/request (no prior
baseline/request exists yet), but both key names contain the substring `token`, tripping
`SECRET_KEY_PATTERN` (`/(api[_-]?key|token|secret|password|credential|authorization|cookie)/i`,
`redaction.ts:98`).

`redactSecretField()` (`redaction.ts:174-188`) — the function every secret-shaped key's value is routed
through by `redactValue()`, which every `logger.info`/`warn`/etc. call in the app goes through via
`redactForSink()` (`logger.ts:246`) — correctly passes `number`/`boolean` values through unredacted
(matching the intent documented in the sibling `redactSpanAttributes()`'s own comment: *"numbers/
booleans under secret-shaped keys… pass through"*), but had no explicit case for `null`/`undefined`:
`typeof null` is `'object'`, so it fell through every `typeof` check into the function's final
`return '<redacted-secret>'` — turning a real `null` into the four-word **string**
`"<redacted-secret>"`. `redactSpanAttributes()`'s own inline equivalent (`typeof value === 'string' ?
'<redacted-secret>' : value`) already passed non-strings through correctly, including `null`; only
`redactSecretField()`, the general JSON-sink path, had the gap.

**Blast radius beyond this one doc.** This function is not specific to Codex diagnostics — it is the
redaction primitive for every structured log call in the app. Any `number | null` (or any non-string,
non-boolean, non-number) field logged under a key containing "token", "secret", "password",
"credential", "authorization", or "cookie" would suffer the identical corruption the instant its real
value was `null`/`undefined`, silently turning a typed field into an untyped string for any downstream
consumer that parses `app.log`.

**Fixed.** `redactSecretField()` now returns `null`/`undefined` unchanged, before the `typeof` checks —
a minimal, strictly-widening change (nothing that was correctly redacted before is now passed through;
only the previously-mishandled `null`/`undefined` case changes). Verified: new regression test
(`redaction.spec.ts`, "LT-222…") watched **fail** against the pre-fix source
(`expected '<redacted-secret>' to be null`) via a `/tmp` copy, then pass after restoring the fix; 33/33
`src/main/diagnostics` and 23/23 `src/main/logging` tests unaffected. Rebuilt (`npm run build:main`),
dev app restarted, and the identical live scenario re-run: the same two fields now log as real `null`,
and the analyzer accepts all 6 records with 0 malformed (down from 3 malformed pre-fix) — confirmed
live, not just at the unit-test level.

<a id="lt-223-archived-detail"></a>

## LT-223: the context-pressure analyzer's own itemClass allowlist drifted from LT-148's fix and rejects every real `user-message` record as malformed

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

Same live session as LT-222, same real Codex baseline turn. After fixing LT-222, the analyzer still
reported 1 of 6 records malformed — the turn's `item-completed` record for `itemClass: 'user-message'`
(the user's own 18,508-byte turn echo). Traced to source: `scripts/codex-context-pressure/types.ts`'s
`ItemClass` type and its `ITEM_CLASSES` validation `Set` — the analyzer's own, separately-maintained
copy of the valid `itemClass` values — never included `'user-message'`, even though
`classifyCodexObservedItem()`'s real return type,
[`CodexObservedItemClass`](../superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md)
(`src/main/cli/adapters/codex/context-pressure-diagnostics.ts`), has included it since **LT-148**
(2026-08-18) fixed the classifier to stop miscounting the user's own turn echo as a tool-bearing item.
LT-148's fix shipped correctly in the runtime classifier; this analyzer script's duplicated allowlist
was simply never updated to match, so every real `user-message` record it now correctly produces —
i.e. the exact shape LT-148 exists to create — was rejected as malformed by the tool meant to analyze
it. The doc's own §11 privacy-validator snippet independently carries the same stale allowlist (its
`strings` set), and would flag a legitimate `'user-message'` value as a "privacy failure" for the same
reason — confirmed by running the literal snippet against real post-fix output before correcting it.

**Fixed.** Added `'user-message'` to `ItemClass`/`ITEM_CLASSES`
(`scripts/codex-context-pressure/types.ts`) and to the livetest doc's own §11 `strings` allowlist
(a documentation-content correction, not a behavior change). Verified: new regression test
(`analyze-codex-context-pressure.spec.ts`, "LT-223…") watched **fail** against the pre-fix source via a
`/tmp` copy, then pass after restoring the fix. Re-ran the analyzer against the identical real log range
used for LT-222's live confirmation: **6/6 accepted, 0 malformed** (up from 5/6 and 4/6 across the two
fixes), and `report.md`'s item-size table now correctly lists a `user-message` row. Also ran the
corrected §11 privacy-validator snippet against the same real output: **passes** (file existence,
structural schema/string allowlist, forbidden-source-value scan, and manual table inspection — all four
steps), with the doc's own snippet now current.

<a id="lt-270-archived-detail"></a>


## LT-270: the automatic 4x-cumulative context-cost governor has no measurable path to reducing real cost on this Codex build — DECIDED + RESCOPED

**Current status (2026-08-31): DECIDED + CONTRACT RESCOPED + LIVE EVIDENCE ACCEPTED.** The
automatic path is documented as a safety pause on builds that never confirm native compaction.
Acceptance is no cost increase and no lost work; the measured run reduced input by 3.1% and lost no
work.

**Original status (2026-08-19): found, root-caused, not fixed — a product decision.**

### What was measured, versus what was inferred

Measured directly, not assumed: a paired governor-on/governor-off comparison, same fixture, same
six-turn sequence, real Codex spend on both sides (see the owning doc's evidence run for the full
turn-by-turn numbers). Real billed input tokens via `costGetEntries` (not the app's own
`cumulativeTokens` diagnostic aggregate, which is a same-session running total rather than what the
doc's own check 4 literally asks for): **407,155 (governor on) vs 420,330 (governor off) — a 3.1%
reduction**, against the doc's own **≥60%** acceptance target. Both runs produced the identical
correct final edit with no duplicate edits and no lost task, so the safety half of the target holds;
the cost-reduction half does not. Cached-input-token reduction was 0% on both sides, but this is not
evidence of anything — the fixture deliberately never repeats content turn to turn (each turn reads a
different file), so a 0% cache-hit rate is architecturally expected regardless of the governor.

Inferred, and stated as inference: the mechanism *why* real cost barely differs. The governor-on run's
`contextEvidenceGetMetrics` showed `lastAction: "controlled-recovery"` at the 4x crossing, followed
immediately by the system message *"Codex context recovery paused because a safe interrupt could not
be confirmed. The current turn remains preserved."* — the same `interrupt-unconfirmed` branch the
owning doc's check 3 (2026-08-19) already found. `adapterGeneration` and `sessionId` were unchanged
before and after the pause, i.e. no restart, no compaction, no fresh thread — the paused turn simply
resumed, once manually nudged, on the *same, still-full* context it paused with. Since nothing was
ever actually compacted, there is no expected cost reduction from this run beyond incidental variance
(the interrupted turn's own discarded in-flight reasoning tokens plausibly explains the small
observed 3.1% gap, but that specific attribution was not independently isolated and is offered as the
likely explanation, not a proven one).

### Root cause

Traced one level deeper than the owning doc's check 3 did. `CodexContextCostController.requestRecovery()`
(`context-cost-controller.ts:65-83`) calls `this.deps.interrupt()`; when the result's `status` is not
`'accepted'` it unconditionally pauses via the `interrupt-unconfirmed` branch and returns `{proof:
'none'}` — there is no retry and no fallback. `CodexAppServerThreadRuntime.interrupt()`
(`app-server-thread-runtime.ts:165-169`) returns `status: 'no-active-turn'` whenever `this.activeTurn`
is already `null`, and `activeTurn` is cleared in the turn's own `finally` block the instant
`state.completion` resolves (`app-server-thread-runtime.ts:~306`). `ContextPolicyRuntime`'s own
`observe()`/`decide()` evaluation is asynchronous and serialized behind a per-instance promise queue
(`ContextPolicyRuntime.enqueue`, `context-policy-runtime.ts:139-147`), so by the time a 4x-crossing
decision is actually evaluated and `requestRecovery()` is called, the triggering turn has very
plausibly already completed and cleared `activeTurn` — leaving structurally nothing left to interrupt.
This is a source-consistent explanation for why the scripted `compaction-unobserved` branch (the one
the owning doc's check 3 originally expected) has now been unreachable in 2 of 2 real attempts across
two independent sessions, but the exact race was not instrumented/proven end-to-end (would need
tracing the queue-drain timing against the transport's own turn-completion timing) — recorded as a
strengthened observation, not a separately-filed defect on its own, consistent with the owning doc's
check 3 (2026-08-19) explicitly declining to file it either.

Separately, and independently of that race: even when the `controlled-interrupt` branch *does* land
on an in-flight turn, the resulting native-compaction request still depends on the provider emitting
`thread/compacted` — and **LT-017** already established that no Codex build observed anywhere in this
campaign has ever done so. So even a hypothetically perfect interrupt-timing fix would still run into
the same wall LT-017 already named for the *manual* Compact button. The only reason the manual path
achieves a real fallback today is that it explicitly restarts-with-summary after a timeout
(`compaction-coordinator.ts:440-452`) — a choice the automatic path deliberately does **not** make,
because (per this doc's own 2026-08-12 evidence run) "silently swapping the thread out from under it
is materially riskier" for a path that has already interrupted a live turn mid-flight. That is a
reasonable safety tradeoff on its own terms; the finding here is that, as a direct consequence, the
automatic path currently has **no route at all** to ever satisfying this doc's own ≥60%
cumulative/cached-input-reduction acceptance target, on any Codex build this entire campaign has ever
observed.

### Required behaviour — not decided here

Two legitimate directions, deliberately not chosen unilaterally:

1. **Give the automatic path a bounded, opt-in fallback analogous to the manual one.** E.g. after N
   consecutive `interrupt-unconfirmed`/`compaction-unobserved` pauses within one recovery epoch (the
   policy state already tracks `recoveriesInEpoch`/`recoveriesInOuterSend` with a `MAX_RECOVERIES = 3`
   ceiling in `context-safety-policy.ts`), allow a supervised restart-with-summary instead of a
   permanent pause — accepting the same "thread swapped out from under an interrupted turn" risk the
   2026-08-12 evidence run flagged, now weighed against the newly-measured fact that the current
   design achieves ~0% of its own stated purpose on this provider.
2. **Accept that the automatic path is a pure safety valve, not a cost-reduction mechanism, on Codex
   builds that never confirm native compaction**, and correct the doc's check 4 acceptance target
   for this path specifically (e.g. scope the ≥60% target to providers/builds where
   `compactionProof: 'observed'` is actually achievable, and redefine automatic-path "success" as
   "pauses safely without restart or replay" — which check 2's evidence already shows it reliably
   does).

### Acceptance — what would falsify this finding

A live run on a Codex build that *does* confirm `thread/compacted` (none observed in this campaign to
date) landing in the `controlled-recovery` → `observed-compaction` → `same-thread-continuation`
sequence, with a subsequent paired on/off comparison showing the cost reduction the doc's check 4
expects. Until such a build is observed, the ≥60% target is not achievable through this code path by
construction, not merely difficult to trigger.

<a id="lt-280-archived-detail"></a>

## LT-280: the context-evidence panel is fully built to label degraded (corrupt/failed/deleted/staging) records, but `list()` structurally never lets any reach it

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

### Observed behaviour

Batch P2, driving check 7's third named residual item ("view a corrupt/deleted record if present")
of the provider-agnostic-context-evidence livetest doc, live in an isolated dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-P2`, port 9612, focus-emulated CDP). Set
`contextEvidenceModeByProvider.claude = 'shadow'`, created a real chat (`ChatStore.create`, provider
`claude`) rather than reusing the instance-list path — this exercises the chat-owned evidence scope
(`owner.kind: 'chat'`) for the first time in this doc's history. Sent a real turn with two tool calls
(`Read` on a 13.8 KB synthetic file, `Read` on a 12-byte file), producing two real evidence records.
Confirmed the chat-header `.evidence-toggle` (a separate residual item) renders the real panel. Opened
the large record's card and paginated "Inspect" through all 4 pages to `byteCount` exactly (bytes
0–4000, 4000–8000, 8000–12000, 12000–14896), confirming that residual item too — both via direct DOM
button clicks, not just component-method calls.

Then, to test the corrupt/deleted item: set the small record's `status` directly to `'corrupt'` via
the ledger DB (`sqlite3 conversation-ledger.db "UPDATE evidence_records SET status='corrupt' WHERE
id=...`), then called the panel's own `store.refresh()`. The record **disappeared from the list
entirely** — not shown-and-labeled, not shown-and-disabled, simply absent, as if it had never been
captured. Identical result for `status: 'deleted'`.

### Root cause

The panel's own file-header contract (`context-evidence-panel.component.ts:16-19`) states plainly:
*"degraded evidence statuses (corrupt, failed, deleted, staging) are always visibly labeled, never
presented as complete."* The rendering side of that contract is fully implemented and correctly wired:
`statusLabel()`/`statusDisclosure()`/`isDegradedStatus()` (lines 70-97) handle all five statuses
including `'staging'` ("Staging (capturing)" / "Still capturing — not yet available for inspection.");
the template binds `[class.degraded]="getIsDegradedStatus(record.status)"`,
`{{ getStatusLabel(record.status) }}`, and `{{ disclosure }}` per record
(`context-evidence-panel.component.html:91-110`); `canInspect()` correctly gates "Inspect" on
`status === 'complete'`.

None of it can ever run, because the data never arrives. `EvidenceRetrievalService.list()`
(`src/main/context-evidence/evidence-retrieval-service.ts:156-163`, pre-fix) called:

```ts
const records = await this.options.ledger.listEvidence(input.conversationId, {
  limit: input.limit,
});
```

— never passing `includeMaintenanceStates`. `ContextEvidenceLedgerStore.listEvidence()`
(`context-evidence-ledger-store.ts:164-172`) applies, by default:

```ts
if (!query.includeMaintenanceStates) where.push("evidence_records.status = 'complete'");
```

So every call through this method — which is the **only** method backing both the renderer's
`contextEvidenceList` IPC channel (`context-evidence.handlers.ts:112-124`) and the `evidence_list` MCP
tool (`orchestrator-evidence-tools.ts:94-109`) — silently excludes `staging`/`failed`/`corrupt`/
`deleted` records. `listEvidenceForMaintenance()` is the only other reader capable of returning those
statuses, and it is used exclusively by the internal background `evidence-maintenance-service.ts`
(cleanup/GC), never exposed via any IPC handler or MCP tool. There was, structurally, no path for a
degraded record's existence to ever reach a human or an agent — it just silently vanished, with no
error, no count, no indication anything had gone wrong with a piece of evidence that had previously
been captured successfully.

### Fix

`EvidenceRetrievalService.list()` now passes `includeMaintenanceStates: true` unconditionally. Per-record
authorization (`this.authorize(record, input.requester)`, unrelated to completeness status) still governs
what a given requester may see; corrupt/deleted records carry no readable content regardless (`canInspect`
already gates on `status === 'complete'`, and `getCard()` correctly fails with `EVIDENCE_CARD_NOT_FOUND`
for a record with no card), so surfacing their metadata is safe — no raw content is newly exposed, only
the previously-invisible fact of the record's existence and status.

**Verified.** New regression test in `evidence-retrieval-service.spec.ts` ("asks the ledger to include
maintenance-state (corrupt/failed/deleted/staging) records, not just complete ones") — watched it
**fail** against the pre-fix source (`expected "spy" to be called with arguments... includeMaintenanceStates:
true`, received `{ limit: undefined }` with no such key), then pass after applying the fix. 37 files / 379
tests across `src/main/context-evidence`, `src/main/conversation-ledger`,
`context-evidence.handlers.spec.ts`, and `orchestrator-evidence-tools.spec.ts` unaffected. `npx tsc
--noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, and
`npm run build:main` all clean. Live-reproduced end-to-end after rebuild + dev-app restart: the same
corrupt record now renders with the "Corrupt" badge and the disclosure text "Evidence is corrupt — raw
bytes cannot be trusted." (and, separately, "Evidence has been deleted — content is no longer
available." for `status: 'deleted'`); "Inspect" is correctly `disabled` for it; "Open card" fails
cleanly with `EVIDENCE_CARD_NOT_FOUND` rather than crashing or exposing untrusted content.

<a id="lt-290-archived-detail"></a>

## LT-290: fable-ws16 check 5's `lessons` recall-trace surface had zero production `record()` callers — structurally could never hold a trace

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

### Observed behaviour

Batch P3, driving fable-ws16 checks 5 (`lessons` third) and 6, per this wave's brief. Before chasing
another expensive live-loop attempt, read `RecallTraceStore` and every production caller
(`grep -rn "getRecallTraceStore()" src/main/ --include="*.ts" | grep -v spec`) end to end: exactly
three call sites exist — `context-search.ts:256` (`record`, surface `rlm`), `code-retrieval-service.ts:68`
(`record`, surface `codemem`), and `loop-lesson-use-credit.ts:29` (`markUsed('lessons', …)` only, no
`record`). `markUsed()` (`recall-trace-store.ts:111-130`) filters `this.traces` by `trace.surface`
and can only credit a trace that already exists — with zero production `record({surface: 'lessons'})`
calls anywhere, `getRecallTraceStore().bySurface('lessons')` was permanently empty and `markUsed`
was a guaranteed no-op, regardless of how the loop was driven or how many times it was retried.

### Root cause

`getLessonStore().digest(limit)` is called at loop start (`loop-coordinator.ts`'s `surfaceLearnings`
closure inside `assemblePlanStageContext`'s injected sources) and pushes the surfaced lessons into
`surfacedLessonsForRun` for later crediting — but nothing at that call site ever recorded a
`RecallTraceStore` trace for them. The doc's own "as-built" note (fable-ws16 check 5, written earlier
in this doc's history) read `loop-lesson-use-credit.ts`'s `markUsed()` call as evidence the `lessons`
surface was "wired," which is the mistake: crediting an item and recording a trace for it are two
different operations, and only the second one ever ran.

### Fix

`loop-coordinator.ts`'s `surfaceLearnings` closure now calls `getRecallTraceStore().record({surface:
'lessons', query: config.initialPrompt, returned: …})` whenever `digest()` surfaces at least one
lesson, with a rank-ordered score (`1 - i / surfaced.length`) since lessons have no query-similarity
score the way codemem/rlm hits do (`digest()` is already most-reinforced-first).

**Verified.** New regression test in `loop-coordinator-memory.spec.ts` ("LT-29x: records a recall
trace on the lessons surface when a lesson is surfaced at loop start") — seeds a real lesson via the
real `LessonStore` singleton, starts a real `LoopCoordinator.startLoop()`, and asserts
`getRecallTraceStore().bySurface('lessons')` is non-empty and contains the seeded lesson's id.
Watched it **fail** against the pre-fix source (`expected 0 to be greater than 0`) via a `/tmp` copy,
then restored and confirmed green (2/2 in that file). `npx tsc --noEmit` (both configs), `npm run
lint`, `npm run check:ts-max-loc` (had to trim the fix's own comments to stay within
`loop-coordinator.ts`'s +50 tolerance — see LT-291's note, same file), and `npm run build:main` all
clean.

Live end-to-end re-verification (not just the unit test): rebuilt `dist/main`, restarted the dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-P3`, port 9613), seeded a real lesson (`lesson-uy6v89`) into the
running main process's `LessonStore` singleton via `--inspect=9713`, then started a real loop over CDP
(`loop-1787166879293-5e633139`, provider `claude`, workspace `/tmp/aio-lt-P3-ws16`). Immediately after
start, `getRecallTraceStore().bySurface('lessons')` (queried live via the same inspector port) held
exactly one trace: `{surface: 'lessons', returned: [{id: 'lesson-uy6v89', score: 1}], usedIds:
['lesson-uy6v89']}` — the `usedIds` entry present because the loop had by then also completed and
credited it (see LT-291).

### Note on the check's `rlm` third

Unchanged this session: `rlm`'s `record()` call in `context-search.ts` only fires when the vector store
returns hits, and nothing indexes context stores for semantic search in production
(`RLMContextManager.indexStoreForSemanticSearch()` has no production caller) — already filed as
**LT-055**, an open product decision (lazy/eager/explicit indexing tradeoff), not re-litigated here.

<a id="lt-291-archived-detail"></a>

## LT-291: fable-ws16 check 6's reinforcement-on-use could never fire on a genuinely successful loop — the convergence note is never populated on that path, contrary to its own "always-present" doc comment

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

### Observed behaviour

Same session as LT-290. `creditSurfacedLessonUse(surfaced, outcomeText)` (`loop-lesson-use-credit.ts`)
is called at `terminate()` with `outcomeText = this.completionContext.getConvergenceNote(state.id)`
and bails out immediately when `!outcomeText?.trim()`. Traced every `setConvergenceNote` call site in
`loop-coordinator.ts` and `evidence-resolver.ts`: the accepted-completion branch (`decision: 'stop'`,
the normal successful-loop path) returns `convergenceNote: null` explicitly (comment: "coordinator sets
this itself with reviewer details"), and no code anywhere else in the success path ever sets one — only
stall/pause/blocked-review branches populate it, each with system-generated text describing the
obstacle (e.g. "review-driven stall: …"), never anything a surfaced lesson's wording could plausibly
match. So on the single most common outcome — a loop that finishes cleanly — `outcomeText` was always
`undefined`, and `creditSurfacedLessonUse` never had a chance to run, independent of whether a
cross-model reviewer ran, blocked, or found anything.

This explains why two same-day prior attempts on this exact doc (documented in the
"2026-08-19 (Batch N2)" evidence-run section) never captured a lesson via check 6, and why the
mechanism they were testing (`completion.crossModelReview.enabled` → `captureReviewLessonForVerdict`)
was never going to produce this specific check's evidence: that is a *different* lesson-related
capability (a NEW lesson distilled from a *blocking* cross-model review finding, written via
`getLessonStore().capture()`) that never touches `RecallTraceStore` and never logs "Reinforced surfaced
lessons on use" — the log line and DB field check 6 actually names. Both are real, but only the
`creditSurfacedLessonUse` path is check 6's mechanism.

### Root cause

`loop-lesson-use-credit.ts`'s own module doc comment states the convergence note is "the cheapest,
always-present signal" — a factual claim about the code's own contract that the code did not honour on
its most common path.

### Fix

`terminate()` (`loop-coordinator.ts`) now passes `this.completionContext.getConvergenceNote(state.id)
?? state.terminalIntentHistory?.at(-1)?.summary` — falling back to the accepted terminal intent's own
summary text, which genuinely is present whenever a loop reaches `'completed'` via the real
`aio-loop-control complete --summary` mechanism (`loop-completion-detector.ts`'s `'declared-complete'`
signal is sourced exclusively from `state.terminalIntentPending?.kind === 'complete'`) — the same
mechanism real agent CLIs use in production to declare done, not a synthetic test-only path.

**Verified.** New regression test in `loop-coordinator-terminal-intents.spec.ts` ("LT-29x: reinforces a
surfaced lesson on use when the declared-complete summary echoes it, on a clean successful
completion") — seeds a real lesson, drives a real loop through `aio-loop-control complete --summary`
with wording that echoes the lesson, and asserts `getLessonStore().get(id).uses === 1` and the trace's
`usedIds` includes it. Watched it **fail** against the pre-fix source (`expected +0 to be 1`) via a
`/tmp` copy, then restored and confirmed green (18/18 in that file, no regressions). `npx tsc --noEmit`
(both configs), `npm run lint`, `npm run check:ts-max-loc` (both this fix and LT-290 live in
`loop-coordinator.ts`, which was already within 6 lines of its ratchet ceiling before either change —
comments for both fixes were trimmed to land at 3919/3921 lines), and `npm run build:main` all clean.

Live end-to-end re-verification: same real loop as LT-290 (`loop-1787166879293-5e633139`, a real
Claude CLI turn instructed to include specific wording in its `aio-loop-control complete --summary`
call). `app.log` shows, at the loop's exact termination timestamp:
`{"subsystem":"LoopLessonUseCredit","message":"Reinforced surfaced lessons on use","data":{"count":1}}`
immediately followed by `{"subsystem":"LoopCoordinator","message":"Loop terminated",
"data":{"status":"completed","reason":"signal=declared-complete"}}`. Queried the live `LessonStore`
singleton via `--inspect=9713`: the seeded lesson's `reinforcements` went `1 → 2` and `uses` went
`0 → 1`, `updatedAt` matching the log timestamp to the millisecond.

<a id="lt-480-archived-detail"></a>


## LT-480: real auto-injected skill activations silently persisted to the wrong database

**Status: FIXED + REGRESSION-TESTED 2026-08-24, verified live end-to-end against a rebuilt dev app.**

### Observed behaviour

While re-confirming the skill-observability livetest's "recording" check (a real `sendInput`
containing the `test-stabilizer` trigger "flaky test"), the live `skills:activation-delta` push to
the renderer fired correctly with the right payload (`skillName: 'test-stabilizer'`,
`matchedTrigger: 'flaky test'`, ...) — but neither a direct `sqlite3` query against the profile's own
`<userData>/rlm/rlm.db` nor the app's own `skillsActivationsRecent()` IPC call showed the row.
`skill_activations` read **0 rows** through every profile-scoped path, immediately after a live push
had just delivered exactly that activation to the renderer.

The row was not lost — it landed in the wrong file. `~/.aio/<sha256(process.cwd()).slice(0,12)>/rlm/rlm.db`
(a per-checkout fallback location keyed only on the repo's working directory, shared across **every**
dev-app profile regardless of `AIO_DEV_USER_DATA_PATH`) held it:

```
$ sqlite3 ~/.aio/1b6165d33911/rlm/rlm.db "SELECT skill_name, instance_id, matched_trigger, match_score, created_at FROM skill_activations ORDER BY created_at;"
test-stabilizer|cv0wyntqp|flaky test|0.12987012987013|1787129391961
test-stabilizer|cfz4gtvj0|flaky test|0.125|1787529691884
test-stabilizer|cfz4gtvj0|flaky test|1.0|1787529744985
```

The first row (`cv0wyntqp`, ~4.6 days older) shows this is not new to this session — it has been
silently swallowing real activation history since the bug was introduced.

### Root cause

`context-worker-main.ts` (module load order):

```ts
const transport = createTransport();

// (previously) ran FIRST:
registerWorkerEventForwarding(transport);   // subscribes RLMContextManager.getInstance() among others

// (previously) ran SECOND:
RLMDatabase.getInstance({ dbPath: path.join(userDataPath, 'rlm', 'rlm.db'), contentDir: ... });
```

`registerWorkerEventForwarding()` calls `RLMContextManager.getInstance()` (`context-manager.ts:122`),
whose private constructor eagerly calls `this.db = getRLMDatabase()` (`context-manager.ts:183`) —
i.e. `RLMDatabase.getInstance()` with **no config** — as part of synchronous construction, not
lazily. `RLMDatabase.getInstance()` (`rlm-database.ts:104`) is itself a `getInstance()`-style
singleton: `if (!this.instance) { this.instance = new RLMDatabase(config); }` — only the **first**
caller's config is ever honored. Because the no-config call happened first, the private constructor's
own fallback path resolution ran:

```ts
const userDataPath = getElectronUserDataPath() ?? (() => {
  const hash = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.aio', hash);
})();
```

`getElectronUserDataPath()` here (`rlm-database.ts:62-70`) only tries
`require('electron').app?.getPath?.('userData')` — it does not check `AIO_USER_DATA_PATH`, the env
var `context-worker-main.ts` actually receives, at all. The context worker runs as an Electron
`utilityProcess` of type `node` (confirmed via `ps` during LT-169's investigation:
`node.mojom.NodeService`), which does not expose the browser-side `app` module the same way the main
process does, so `app?.getPath?.('userData')` resolves to `undefined` there and the fallback fires:
`~/.aio/<hash of process.cwd()>` — a location keyed only on the repository's working directory, not
on any per-instance or per-profile identity. By the time the worker's own explicit, correctly-pathed
pre-init call ran second, the singleton was already constructed and the config argument was silently
ignored.

This is the same class of bug as LT-169 (`SkillAttributionService`'s per-process `controlCache`) and
LT-170/LT-206 (worker-local `EventEmitter`s that cannot cross a process boundary), and LT-207's own
register entry explicitly named and avoided this exact ordering hazard for the codebase-indexing lane
worker's copy of the same singleton — but the fix was never carried back to the original context
worker that introduced the pattern in the same commit.

### Impact

- Every real (non-synthetic) skill activation recorded via the actual auto-injection hot path
  (`SkillsLoader.detectRelevantSkills` → `UnifiedMemoryController.fetchSkills` →
  `SkillAttributionService.recordActivation`, which all run inside the context worker) was invisible
  to `skillsActivationsRecent()`, `skillsHealthSummary()`, the Skills page health panel, the
  error-correlation outlier badge (check 6), and any doctor-lint signal keyed on real activation
  counts — for as long as this ordering bug has been present (at least since the LT-206 fix commit
  that introduced `registerWorkerEventForwarding`, 2026-08-19).
- The live toast/badge push (LT-170's fix) was **not** affected, because it is a direct
  `EventEmitter`/IPC forward that does not depend on where the DB write landed — only the persisted,
  queryable activation history was silently wrong. This is why the bug went undetected across
  multiple prior evidence-run sessions that verified the live push but did not independently
  cross-check the DB file the write actually reached.
- Scope is not dev-profile-specific: the same eager-singleton-race mechanism applies to the packaged
  app's context worker identically (the `utilityProcess`/`app` module gap is structural, not
  environment-gated), so real production `skill_activations` telemetry is plausibly affected too,
  though this session did not independently confirm against the packaged app's own fallback file.

### Required behaviour

`RLMDatabase.getInstance()` inside the context worker must be seeded with the worker's real,
per-profile `dbPath`/`contentDir` before any other code path can trigger an unconfigured call to the
same singleton.

### Acceptance

- `context-worker-main.ts` calls `RLMDatabase.getInstance({dbPath, contentDir})` before
  `registerWorkerEventForwarding(transport)`.
- A real `sendInput` turn containing a builtin trigger phrase produces a `skill_activations` row in
  the profile's own `<userData>/rlm/rlm.db`, visible via `skillsActivationsRecent()`, with zero rows
  added to the `~/.aio/<hash>` fallback file for that instance.
- Regression test proving the ordering invariant, watched failing on revert.

### As built (2026-08-24)

Swapped the two top-level statements in `context-worker-main.ts` so the RLM database pre-init (with
explicit `dbPath`/`contentDir`) runs first, and `registerWorkerEventForwarding(transport)` runs
second — mirroring LT-207's fix for the codebase-indexing lane worker. Added
`src/main/instance/__tests__/context-worker-main.spec.ts` → *"LT-480: pre-initialises RLMDatabase with
explicit dbPath before wiring worker event forwarding"*, which mocks both `RLMDatabase.getInstance`
and `registerWorkerEventForwarding` and asserts (a) the first `getInstance()` call's argument contains
the real `dbPath`, and (b) `getInstance`'s first `invocationCallOrder` precedes
`registerWorkerEventForwarding`'s. Reverted only the ordering (via an in-place edit immediately
restored from a `/tmp` backup, diff-verified identical before and after) and watched it fail:
`AssertionError: expected 11 to be less than 10`; restored, both tests in the file pass.

**Live end-to-end re-verification (not just the unit test):** rebuilt `dist/main`
(`npm run build:main`), restarted the dev app fresh (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-E`, port
9455 — a real new context-worker process), created a fresh instance, sent a real `sendInput` turn
containing "flaky test". The activation row landed correctly in `/tmp/aio-lt-E/rlm/rlm.db`, was
returned by `skillsActivationsRecent()`, and the shared fallback DB gained **zero** new rows for that
instance. Also re-confirmed LT-169's kill-switch fix on top of the now-correctly-persisting path:
disabled `test-stabilizer`, sent a second real "flaky test" turn, activation count stayed at exactly
1 after the turn settled — no regression.

Gates: `npx tsc --noEmit` clean, `npx tsc --noEmit -p tsconfig.spec.json` clean, `ng lint` clean,
`npm run build:main` green, `test:quiet` 70/70 across `context-worker-client.spec.ts` +
`context-worker-event-forwarding.spec.ts` + `skill-attribution-service.spec.ts` +
`skills-loader.spec.ts` + `unified-controller.spec.ts` (including the 2 new/updated
`context-worker-main.spec.ts` tests, counted separately as 2/2). `check:ts-max-loc` unaffected (files
touched: 402 and 154 lines respectively, both far under ceiling).

<a id="lt-481-archived-detail"></a>

## LT-481: the Workboard's Snooze control cannot durably hide a Needs You card — deliberate design, not a wiring bug, but it contradicts this doc's own check scenario

**Status: DECIDED, FIXED and REGRESSION-TESTED 2026-09-06.**

The fork was put to James on 2026-09-06 and he took the fix rather than the removal. Removing a
control users already click is worse than repairing it, and a Needs You lane with no way to defer
a card you have already seen is exactly what makes a workboard unusable when several cards are
blocked on the same external thing.

**The fix.** `WorkboardStore.snoozeItem()` now records the item's attention level at snooze time
(`snoozedSignal: ReadonlyMap<string, AttentionLevel>` replacing the bare id set), and the
hand-raise effect calls the new `snoozeClearedByAttention(current, baseline)`
(`workboard-projection.ts`). A snooze clears only when the item completes (`idle`, always worth
surfacing despite being the least urgent rank) or reaches a loud level strictly more urgent than
its baseline. It survives `working`/`waiting` churn — including `working` → `waiting`, which is a
rank rise carrying no new demand — and survives staying at, or dropping below, its snooze-time
urgency.

Reproduced first with a failing test (`workboard.store.spec.ts`, "a snooze set on an
already-blocked card survives"), which failed 1/21 before the change and passes after. Two further
tests cover the genuine-rise and completion paths. Gates: 77/77 workboard tests, `tsc --noEmit`,
`tsc -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:renderer`
all pass. A live click-through on a rebuilt app is still worth doing and remains listed in the
sibling-audit livetest doc.

Original finding, unchanged:

### Observed behaviour

Driving check C2 ("put instances into failed/error/degraded states... snooze hides a card until it
raises its hand") for the first time in this doc's history (five prior evidence-run sessions all
bucketed C2 as "NOT RUN — needs a mobile client", without separating its agent-driveable
Workboard/session-picker half from the genuinely-blocked mobile half):

1. A real Claude instance was driven to a genuine `waiting_for_permission` status (asked it to run a
   Bash command with `yoloMode: false`) — attention level `blocked`, in the Needs You lane.
2. The Workboard's real "Needs You" lane and the real session picker's "Needs You" group both showed
   the same instance consistently — **that half of check C2 passes.**
3. Clicked the real DOM `Snooze` button on the card. It disappeared (`"Needs You 0 All clear"`),
   exactly as expected.
4. **Within 2-5 seconds, with the instance's status unchanged the entire time, the card silently
   reappeared** and the button reverted to reading `Snooze` (not `Un-snooze`). Confirmed at the
   signal level, not just the DOM: `WorkboardStore.isSnoozed('instance:c28lwyh77')` read `true`
   immediately after `snoozeItem()`, then `false` again a couple of seconds later, with `store.items()`
   showing the same instance still at `attentionLevel: 'blocked'` throughout — no new event, no
   escalation, nothing changed except time passing.

### Root cause

`WorkboardStore.snoozeItem(itemId)` (`workboard.store.ts`) stores only the item's id in a
`ReadonlySet<string>` — no record of what the item's attention level *was* when it was snoozed. The
"hand-raise" effect that is supposed to auto-clear a snooze "once the item's attention rises" instead
calls `attentionLevelClearsSnooze(item.attentionLevel)` (`workboard-projection.ts:103-105`), which
takes only the item's *current* level:

```ts
export function attentionLevelClearsSnooze(level: AttentionLevel): boolean {
  return level !== 'working' && level !== 'waiting';
}
```

Every item in the Needs You lane is, by construction, `blocked`/`failed`/`review` — none of which is
`'working'` or `'waiting'` — so this function returns `true` unconditionally for anything already in
that lane, regardless of whether its level has genuinely changed since the snooze was set. The
function's name and its doc comment ("auto-clears the moment the item's attention **rises**") imply a
before/after comparison the implementation has no data to make.

### Why this was never caught

Deliberately, not by accident: every existing test in `workboard.store.spec.ts`'s "WS-C2 snooze with
hand-raise" describe block snoozes an item while it is `'busy'` (`working`) and asserts it correctly
un-snoozes on a transition *into* `blocked`/`error`/`idle` — that is the mechanism working exactly as
designed and tested (mute a non-urgent item; reveal it the instant it becomes something you'd want to
know about). Not one test — and, per the store's own doc comment ("callers never need to un-snooze a
genuinely urgent item themselves"), not the original design intent either — covers snoozing an item
that is *already* urgent, which is precisely this doc's own check C2 scenario. The gap is between the
check's literal steps and a narrower, intentional design, not a broken implementation of the intended
design.

### Not filed as a simple fix — two candidate directions, a product call

**(a) Make the comparison baseline-aware.** Record the attention level at the moment of snoozing
(`snoozedIdsSignal` would need to become a `Map<string, AttentionLevel>` rather than a
`Set<string>`), and only auto-clear when the item's *current* level is a genuine change from that
baseline — this would make the Snooze button behave the way check C2's steps assume, and would still
preserve every existing test's semantics for the working→blocked transition (a baseline of `working`
compared against a new `blocked` level is still a change, so it would still clear).

**(b) Don't offer a Snooze control on Needs You cards at all.** The mechanism was only ever built and
tested for working/waiting items; a control that visibly appears to work for a second or two and then
silently reverts, with no error and no indication to the user, is arguably worse than not offering the
control there in the first place.

Choosing between "broaden the mechanism to support the check's scenario" and "don't expose a control
that structurally cannot do what a user would expect it to do" is a product decision, not an agent's
call — matching this campaign's established precedent for the same shape of gap (LT-220's Antigravity
premise correction, doc 2's check 2/check 4 threshold and precondition questions).

### Required behaviour (once decided)

If (a): a card snoozed from the Needs You lane stays hidden until its attention level genuinely
changes (escalates or resolves) from what it was at snooze time — not merely "is currently non-working".

If (b): the Snooze control is not rendered (or is disabled with an explanatory tooltip) for cards in
the Needs You lane specifically.

### Acceptance (once decided)

- Whichever direction is chosen, add a new `workboard.store.spec.ts` test that snoozes an item while
  it is already `blocked`/`failed` and asserts the chosen behaviour (stays hidden vs. control absent),
  alongside the existing working→blocked tests, which must continue to pass unmodified.

<a id="lt-520-archived-detail"></a>


## LT-520: a dev app silently steals the machine's Chrome native-messaging manifest from the packaged install

**Status: FIXED + REGRESSION-TESTED 2026-08-24. Live confirmation pending a rebuilt app.**

### Observed behaviour

While reading `browser.health` from the packaged app during this campaign, the `localExtension` block
reported a state that contradicted itself:

```
localExtension: { state: "not_installed", installed: false, registered: false,
                  polling: true, contactAgeMs: 8206, extensionVersion: "0.2.2",
                  summary: "No local Harness browser extension registration owned by this install.",
                  remediation: "Install the Harness Chrome extension and restart AI Orchestrator …" }
```

Not installed, yet polling, with a live extension version and contact eight seconds earlier. The
machine's manifest explained it:

```
$ cat ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ai_orchestrator.browser_gateway.json
{ "name": "com.ai_orchestrator.browser_gateway",
  "path": "/tmp/aio-lt-E/browser-gateway/native-host/ai-orchestrator-browser-host", … }
```

`/tmp/aio-lt-E` is a **batch agent's isolated dev profile**, created minutes earlier. The packaged
app started at 00:38 and owns `~/Library/Application Support/harness/browser-gateway/native-host/`;
the manifest was rewritten at 00:51 by the dev app.

The user-visible harm has two parts. While both are running, the last starter owns the local channel
and the other reports itself uninstalled with remediation text that tells the user to reinstall a
perfectly healthy extension. And when the dev profile is deleted — which every campaign batch is
instructed to do — the manifest is left pointing at a path that no longer exists, so the local
channel stays broken until the packaged app is restarted.

### Root cause

There is exactly one native-messaging manifest per Chrome profile, and it is machine-global: it lives
under `~/Library/Application Support/Google/Chrome/`, **not** under the app's `userData`. So
`AIO_DEV_USER_DATA_PATH` isolation, which the campaign runbook relies on to run several dev apps at
once, never covered this file.

`prepareBrowserExtensionNativeHostRuntime` (`src/main/browser-gateway/browser-extension-native-runtime.ts`)
wrote it unconditionally. The codebase already had the right guard —
`assertBrowserExtensionNativeHostManifestWritable`, which refuses to overwrite a manifest this install
does not own — but it is called only from `src/worker-agent/extension-relay-native-registration.ts`
and `src/worker-agent/cli/service-cli.ts`. The Electron main path
(`src/main/browser-gateway/index.ts` → `initializeBrowserGatewayRuntime`) had no ownership check at
all. This is the classic existence-is-not-behaviour shape: the guard is in the tree, and is not on
this path.

**The mirror-image bug was checked for and does not exist.** `removeBrowserExtensionNativeHostRuntime`
unlinks the same shared manifest, so a dev app deleting it on quit would be equally damaging — but it
is called only from `src/worker-agent/cli/service-cli.ts` (an explicit `service uninstall` command),
never from the Electron quit path, and it targets `BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME`, a
different file. The one place that CLI touches the main host's manifest
(`removeLegacyExtensionRelayNativeHostIfOwned`) checks
`isBrowserExtensionNativeHostManifestOwned()` first. So the write path was the only unguarded one.

### Required behaviour

- A **packaged** install always claims the manifest. It is the one the user actually runs, and
  because it rewrites on every start, a stale entry left by a dev app self-heals on the next launch.
- An **unpackaged** install claims the manifest only when it is absent or already its own, and
  otherwise leaves it alone and says so in the log — a dev app with no local extension channel is the
  correct outcome, and is what the campaign runbook already assumes.
- An explicit operator opt-in (`AIO_CLAIM_LOCAL_BROWSER_MANIFEST=1`) still allows a dev app to take
  over deliberately.
- Declining the claim must not stop the install laying down its own native-host files, so nothing
  else about startup changes.

### Acceptance

- With a foreign manifest present, an unpackaged install leaves it byte-identical and still writes its
  own runtime config and wrapper.
- A packaged install overwrites a foreign manifest.
- An unpackaged install rewrites a manifest it already owns.
- Regression tests cover all four arbitration outcomes plus the force-claim opt-in.

### As built (2026-08-24)

`mayClaimBrowserExtensionNativeHostManifest()` decides, `prepareBrowserExtensionNativeHostRuntime`
takes a `claimChromeManifest` option (default `true`, so no existing caller changes behaviour), and
`src/main/browser-gateway/index.ts` computes the decision from `app.isPackaged` plus the env opt-in
and logs a warning when it declines. 6 regression tests in
`browser-extension-native-runtime.spec.ts`; the behavioural one was mutation-checked by forcing the
branch true, which made it fail on the manifest bytes, then restored. 15 tests green in that file.

### Live confirmation of the premise (2026-08-24)

Restoring the manifest to the packaged install's native host and re-calling `browser.health` — with
nothing else on the machine changed and the extension untouched — flipped the block straight back:

```
state: "ready", installed: true, registered: true, polling: true, contactAgeMs: 1671,
extensionVersion: "0.2.2", summary: "Local extension channel is polling (last contact 2s ago)."
warnings: []
```

So `installed`/`state` are driven entirely by manifest ownership, exactly as the root cause says. As a
side effect this closed check §1 of
[local + remote shared-browser control](2026-07-22-local-shared-browser-control_livetest.md), which had
been open since 2026-07-22.

Worth recording precisely because it is the worst case rather than the average one: at the moment of
the restore the manifest pointed at `/tmp/aio-lt-F`, a batch profile that had **already been deleted**
during that batch's normal cleanup. The machine was therefore sitting on a manifest aimed at a binary
that no longer existed — the exact end state a campaign leaves behind if nobody restores it, and one
that persists until the packaged app is restarted.

**Campaign note:** `_scratch/lt-2026-08-24/orchestrator/restore-native-manifest.sh` performs the
restore. Until the packaged app is rebuilt with this fix, every dev app launched by a batch will
re-take the manifest, so the restore must be the last step of a campaign, not an early one.

<a id="lt-521-archived-detail"></a>


## LT-521: check 1's "logs show shadow decisions" wording describes a log line that does not exist anywhere in the shadow/enforce decision path — DOC-CORRECTED

**Current status (2026-08-31): DOCUMENTATION CORRECTED.** The nonexistent log requirement was
removed from the owning check. Shadow mode's already-proven capture-without-alteration behavior is
the contract; no new production logging was added.

**Original status (2026-08-25): FOUND, NOT FIXED — a doc-vs-code wording gap.**

### Observed behaviour

The provider-agnostic-context-evidence livetest's check 1 ("Codex `shadow` run") expects: *"Turn
behaves identically to `off` (no working-set rewriting); evidence records + cards appear in the
Evidence panel; occupancy/cumulative figures shown separately; logs show shadow decisions (policy
computed, action NOT executed)."* The first three clauses are proven live and unchanged since
2026-08-12/2026-08-18. The fourth ("logs show shadow decisions") is not.

The 2026-08-12 evidence run grepped a real shadow-mode session's log for `shadow` and found zero
matches. The 2026-08-18 run went further and read every plausible source location rather than
re-testing live, and concluded no such log line exists in the codebase at all — but left it
deliberately unfiled ("a cosmetic observability gap in a doc-only phrase... this campaign reserves LT
filings for reproduced behavioural gaps"). This session re-confirmed that source read directly rather
than trusting the carried-forward claim, and files it per this campaign's explicit instruction not to
silently accept a real (if cosmetic) gap.

### Root cause

Read every file on the shadow/enforce decision path:

- `src/main/context/output-persistence.ts` — the file that actually implements the shadow-mode
  short-circuit (`maybeExternalize()` line 170: `if (mode === 'shadow') return output;`) — has exactly
  **one** `logger` call in the entire file, an unrelated `logger.warn('Large-output evidence migration
  could not externalize safely', …)` for a migration error path, nothing resembling a per-decision log.
- `src/main/context-evidence/context-evidence-diagnostics.ts` — zero `logger` calls.
- `src/main/context/context-policy-runtime.ts` — zero `logger` calls.
- `src/main/context-evidence/context-safety-policy.ts` — zero `logger` calls.

No file on the path that computes or applies a shadow/enforce decision ever calls `logger.info`,
`logger.debug`, or any other logging method describing "policy computed, action NOT executed" or
anything semantically equivalent. The check's Expected Result describes a log line that was never
implemented, not a log line that regressed.

### Required behaviour (a decision, not a unilateral fix)

Either:
(a) add an `info`/`debug` log line at the point a shadow-mode decision is computed but not executed
(the natural home is `output-persistence.ts`'s `maybeExternalize()`, immediately before the
`mode === 'shadow'` early return), so the check's literal wording becomes true; or
(b) correct check 1's Expected Result to describe shadow mode's real, silent behaviour (capture
without alteration, no decision-level logging), matching how this same doc's 2026-08-20 evidence run
already handled the analogous LT-220 gap ("accept the gap, correct the false claim rather than rewrite
a provider adapter").

Not decided here — editing a check's acceptance criteria, or adding new production logging as scope,
is not this session's call per this campaign's own established precedent (LT-147, LT-220, LT-270 all
left the same shape of question to James).

### Acceptance

Either the log line exists and is observed live in a real shadow-mode session, or check 1's Expected
Result is edited to drop the "logs show shadow decisions" clause and the doc records why. Whichever is
chosen, re-run check 1 against the corrected contract and record the result in the owning livetest
doc's evidence log.

<a id="lt-522-archived-detail"></a>

## LT-522: every `copilot-account:*` IPC channel rejected every renderer call, because `.strict()` schemas did not declare the preload's auth stamp

**Status: FIXED + MUTATION-CHECKED 2026-08-25.** Live UI confirmation still needs a rebuilt app — see
[the Copilot account routing livetest](../superpowers/plans/2026-08-25-copilot-account-routing_plan_livetest.md).

### Observed behaviour

While sweeping Copilot instance-creation provenance for the automation-provider-exclusions doc, the
packaged app's own logs turned out to contain an error storm on the channels belonging to the account
routing feature committed earlier the same day (`20f534775 copilot routing`):

```
2026-08-25T14:00:24.221Z IPC  IPC validation failed for copilot-account:preview-route
                              {"errors":": Unrecognized key: \"ipcAuthToken\""}
2026-08-25T14:00:24.221Z IPC  IPC validation failed for copilot-account:list
                              {"errors":": Invalid input"}
```

Across the whole retained `app.log` set: **239,644** such warnings, split **119,822 / 119,822** between
exactly those two channels. The perfect 1:1 balance is a single renderer caller issuing both in a hot
retry loop; the entries are ~1 ms apart.

The user-visible consequence is that **Settings › GitHub Copilot Accounts cannot work at all** — listing
profiles, creating one, adding a routing rule, previewing a route, and the Doctor report all fail before
any handler runs.

### Root cause

Three facts that are individually reasonable and jointly fatal:

1. `src/preload/preload.ts:79` builds this domain **with** `withAuth`:
   `...createCopilotAccountDomain(ipcRenderer, IPC_CHANNELS, withAuth)`, and all **15** `ipcRenderer.invoke`
   calls in `src/preload/domains/copilot-account.preload.ts` use it (15 invokes, 15 `withAuth(` uses).
2. `withAuth` (`preload.ts:58-63`) returns `{...payload, ipcAuthToken: ipcAuthToken || undefined}`. The key
   is **always present**, even before sign-in, because an explicitly-`undefined` property is still an own
   key — and that is what `.strict()` refuses. This is why the failure was total rather than intermittent,
   and why it is easy to miss when reading a payload printed by `JSON.stringify`, which omits the key.
3. All 10 payload schemas in `packages/contracts/src/schemas/copilot-account.schemas.ts` were `.strict()`
   and none declared `ipcAuthToken`. `validatedHandler` (`src/main/ipc/validated-handler.ts:38`) runs
   `schema.safeParse(payload)` on the raw payload; nothing strips the stamp first.

`copilot-account:list` fails differently from the rest and the difference is diagnostic:
`CopilotAccountEmptyPayloadSchema` was `z.object({}).strict().or(z.undefined())`, so the stamped payload
fails the strict-object arm *and* the undefined arm, and Zod reports the union failure as the much less
helpful `Invalid input`.

**The convention already existed and this domain missed it.** `packages/contracts/src/schemas/provider.schemas.ts`
and `voice.schemas.ts` — the other two domains preload wires through `withAuth` — both declare
`ipcAuthToken: z.string().optional()` on their payloads.

### Why the test suite stayed green

`src/main/ipc/handlers/copilot-account-handlers.spec.ts` contained **zero** occurrences of `ipcAuthToken`.
It registers the real handlers against a mocked `ipcMain` and invokes them directly — but with bare
payloads (`{ workingDirectory: '/Users/me/work/repo' }`) that the preload never sends. The test double was
faithful to the handler and unfaithful to the caller, so it exercised a payload shape that cannot occur in
production. Same shape of gap as the one recorded for a test double that answered from its own state.

### Required behaviour

Every channel the preload exposes must accept the payload the preload actually sends, in both token states
(not yet issued, and issued), while still refusing keys that have no business crossing this boundary.

### Acceptance

- All 15 `copilot-account:*` channels return a non-`VALIDATION_FAILED` result for an auth-stamped payload,
  with the token both absent and present.
- `.strict()` behaviour is retained: `env`, `copilotHome` and `configPath` are still rejected, and a
  non-string `ipcAuthToken` is still rejected.
- The regression fails if the schema change is reverted.

### Fix

A shared `ipcAuthTokenField = { ipcAuthToken: z.string().optional() }` spread into all 10 payload schemas,
documented in place with why the stamp is accepted and then ignored (main authorises from the sender via
`ensureTrustedSender`, never from this value). Admitting it into the parsed payload was checked to be safe
before choosing this over stripping centrally: `store.createProfile()` and `store.createRule()`
(`src/main/providers/copilot/copilot-account-store.ts:179,298`) build their persisted records field by
field and never spread the input, so the stamp cannot reach disk. A central strip in `validatedHandler`
would have touched every channel in the app for no additional benefit here.

32 regression tests were added covering all 15 channels in both token states plus the strictness controls.
**Mutation-checked:** reverting `copilot-account.schemas.ts` to its committed state and re-running produced
**13 failures** naming `Unrecognized key: "ipcAuthToken"`; restoring it returned 45/45 green.

### Gates

`npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`
and `npm run build:main` all clean; targeted spec 45/45.

<a id="lt-527-archived-detail"></a>

## LT-527: Copilot Adapter Constructor Blocked on CLI Discovery

**Observed behaviour.** CI on `main` failed on 2026-08-25 and 2026-08-26 with exactly one failing
test in each of two shards: `copilot-cli-adapter.spec.ts › ... recovers assistant content from a
repaired stream-json line` (shard 1) and `copilot-cli-adapter.server-mode.spec.ts › ... stays in
exec mode when the bundled SDK is unavailable` (shard 2). In both cases the failing test was the
**first** test in its file and the first to construct a `CopilotCliAdapter`; later constructions in
the same file passed. The quiet runner reported the message as `STACK_TRACE_ERROR`, which hid the
real cause.

**Root cause.** `CopilotCliAdapter`'s constructor called `getDefaultCopilotCliLaunch()`
(`src/main/cli/copilot-cli-launch.ts:54`). That resolves the standalone `copilot` binary via
`resolveCommandOnPath` (a `which` subprocess), and when it is absent falls back to probing
`gh copilot --help` through `commandRuns()` — a `spawnSync` with `timeout: 5000`. So on a machine
without the standalone binary, constructing the adapter costs up to three synchronous child
processes, bounded only by that 5s timeout.

**Reproduction (2026-08-26).** With `HOME` pointed at a scratch directory and a `gh` shim on
`$HOME/.local/bin` that burns six seconds, a probe of `resolveCopilotCliLaunch()` returned after
**5007ms**, and both spec files failed 10/10 with `Test timed out in 5000ms` — the CI signature.
With the fix applied and the same environment, the same 10 tests pass in 551ms.

**Why it flapped rather than failing consistently.** The probe has been in the constructor since
`a7dfcaa8c` (2026-04-23). Its cost depends on how long a cold `gh`/`which` exec takes under load,
so a lightly-loaded runner stays under the 5s budget and a heavily-loaded four-way-sharded one does
not. CI was green on 2026-08-23 and red on 2026-08-25/26 with no relevant code change between.

**Required behaviour.** Constructing an adapter must not perform blocking subprocess I/O. Discovery
must happen at most once per adapter, at the point a child process is actually spawned.

**Fix.** The constructor now sets an inert placeholder command, and a private
`ensureLaunchResolved()` performs discovery exactly once, called from an overridden
`protected spawnProcess()` — the single path every Copilot child process (`checkStatus`, each
exec-per-message turn, `listAvailableModels`) already goes through. This is behaviour-equivalent to
the old code, which also resolved exactly once per adapter, just deferred.

**Acceptance.** `src/main/cli/adapters/copilot-cli-adapter.lazy-launch.spec.ts` asserts that
construction and `parseOutput()` trigger no discovery, that the first `spawnProcess()` triggers
exactly one, that a second does not repeat it, and that the discovered command and `argsPrefix` are
in place before the child is spawned. Reverting the fix fails 3 of its 4 tests.

**Residual, deliberately not fixed here.** `createCopilotAdapter()`
(`src/main/cli/adapters/adapter-factory.ts:332`) still calls `getDefaultCopilotCliLaunch()`
synchronously on the ACP spawn path, where it genuinely needs the command at construction. That is
the same up-to-5s main-thread block, once per spawn rather than per adapter, and needs a larger
change.

<a id="lt-528-archived-detail"></a>


## LT-528: warm-started Codex sessions ignored requested YOLO launch permissions

**Status:** fixed, regression-tested, and live-verified 2026-08-31.

### Observed behaviour

During the session-scoped Computer Use autonomy livetest, a Codex instance created with
`yoloMode: true` reused a warm-start adapter. Its serialized instance state correctly reported
`yoloMode: true`, but its first `computer.list_apps` MCP call raised a Codex MCP approval request.
An otherwise-identical session created on a fresh process completed the same read-only call without
approval. This made the launch posture shown in the UI disagree with the actual CLI permissions.

### Root cause

`WarmStartManager` pre-spawns adapters with only the working directory and default reasoning effort;
it does not request YOLO mode. `InstanceSpawnPreflightChain` already rejected warm adapters when a
launch-scoped model, reasoning effort, browser gateway, resume target, or other incompatible option
was requested, but it did not include `spawnOptions.yoloMode`. The warm adapter's launch flags were
already baked in and could not be upgraded by copying `yoloMode: true` onto the new `Instance`.

### Required behaviour

A create whose resolved spawn options request YOLO permissions must never consume a default,
non-YOLO warm adapter. It must take the fresh-spawn path so the CLI is launched with the requested
approval and sandbox posture.

### Fix and evidence

`InstanceSpawnPreflightChain.prepare()` now includes an explicit warm-start blocker when
`spawnOptions.yoloMode === true`. The focused regression test was written first and failed with
`expected 'warm' to be 'fresh'`; after the guard it passes and confirms the warm adapter is never
consumed.

Live re-verification rebuilt `dist/main`, restarted the isolated dev app, and created two consecutive
YOLO Codex sessions so a default warm replacement was waiting before the second create. The second
session reached idle on its own process, completed `computer.list_apps`, returned the expected
Harness policy denial, recorded `requestCount: 1` and `errorCount: 0`, and emitted no approval
request. No application was observed or controlled.

Final verification passed both TypeScript checks, lint, the TypeScript LOC gate, the main-process
build, and the full project-pinned Node 24.15.0 suite (1,832 files and 19,713 tests). An independent
fresh completion-gate review returned `VERDICT: PASS` with no actionable findings.

### Acceptance

- A YOLO create takes the fresh preflight path even when a matching warm adapter is available.
- The warm adapter is not consumed.
- In a rebuilt runtime, a consecutive YOLO Codex create can execute a read-only MCP call without an
  approval prompt.
- Existing eligible non-YOLO warm creates continue to reuse the warm adapter.

<a id="lt-529-archived-detail"></a>


## LT-529: generic Settings selects displayed their first option instead of the persisted value

**Status:** fixed, regression-tested, and live-verified 2026-08-31.

### Observed behaviour

The Computer Use autonomy select rendered `guarded` after restart even though `getSettings()`
returned `unrestricted` and the live app policy behaved as Unrestricted (Harness appeared as
`needs_approval`, not the Trusted/Guarded self-control denial). The mismatch reproduced after two
full Electron restarts and remained after a five-second persistence window. The setting itself was
persisted correctly; only the generic select control was wrong.

### Root cause

`SettingRowComponent` bound `[value]="value()"` on the `<select>` while its options were created by
an Angular `@for` block. Angular applied the select value before those option nodes existed. When the
options were inserted, the browser selected the first option, and Angular did not reapply the
unchanged input value. This affected every select rendered through the generic settings row, not
only Computer Use.

### Required behaviour

On initial mount and after a restart, every generic Settings select must visibly select the value
held by `SettingsStore`. A safety setting must never display a more restrictive posture than the
one the main process is actually enforcing.

### Fix and evidence

Each option now marks itself selected when its normalized value matches the row's current value, so
selection happens when the option node is created. The focused component test was written first and
failed with `expected 'guarded' to be 'unrestricted'`; it and the Computer Use settings-tab suite
pass after the fix.

For live verification, the persisted isolated-profile setting remained `unrestricted` across a full
Electron restart. Before the fix the real select reported `guarded` while IPC reported
`unrestricted`. After restarting the renderer with the fix, both the real select and IPC reported
`unrestricted`, and the discovered-app policy continued to match that value.

Final verification passed both TypeScript checks, lint, the TypeScript LOC gate, the main-process
build, and the full project-pinned Node 24.15.0 suite (1,832 files and 19,713 tests). An independent
fresh completion-gate review returned `VERDICT: PASS` with no actionable findings.

### Acceptance

- A select with `guarded` as its first option and persisted `unrestricted` renders
  `select.value === 'unrestricted'` on first mount.
- The value emitted by a real user change still persists through `SettingsStore`.
- After a full app restart, the Computer Use select and `getSettings()` return the same value.

<a id="lt-538-archived-detail"></a>

## LT-538 — the loop panel told the operator a provider-limit park would never resume — FIXED 2026-09-19

### Observed behaviour

With `instanceProviderLimitResumeEnabled` off (the default), a loop parked on a provider limit showed the
`loop-provider-limit-resume-off` hint: "Provider-limit recovery is off, so it will sit here rather than resume
itself when the window clears — which overnight means the run is simply dead until morning."

### Root cause

The hint keyed off a setting that does not govern loops. `instanceProviderLimitResumeEnabled` is read in exactly
one place, `instance-manager.ts:439`, to enable `InstanceProviderLimitHandler` for regular sessions. The same file
documents (`instance-manager.ts:386-403`) that loop turns never reach that handler; only
`LoopProviderLimitHandler.handleProviderLimit()` parks a loop, and its `scheduleResume`
(`loop-provider-limit-handler.ts:486`) schedules the resume unconditionally, falling back to an in-process timer
when the durable scheduler fails. So the hint's claim was false on the default path.

### Required behaviour

The loop UI must not say a parked loop waits for the operator, and must not offer a settings control that does
not affect loops.

### Fix

Removed the hint (`HintId` member, copy, `shouldHintProviderLimitResumeOff`, its spec block, and the loop panel
binding). The causal timeline keeps its true "It resumes on its own once the provider window reopens." and the
non-actionable "Switch provider" note; the "Turn on auto-resume" action built on the false premise was removed
before landing.

### Acceptance

- No reference to `loop-provider-limit-resume-off` or `shouldHintProviderLimitResumeOff` remains.
- `loop-causal-timeline.spec.ts` (`says a provider-limit park resumes on its own`) and
  `loop-control-timeline.spec.ts` (`says the loop resumes on its own and offers no button …`) pass.

<a id="lt-570-archived-detail"></a>

<a id="lt-570"></a>

## LT-570: the Settings Help drawer is a modal that manages no focus — CONFIRMED FIXED LIVE 2026-09-24

### Observed behavior

Settings Help and compact navigation left keyboard focus behind the modal or on the body.

### Root cause

The open/close handlers managed visibility but not initial focus, trapping or focus return.

### Required behavior

Move focus into the open layer, contain Tab and restore the opener on close.

### Acceptance

Keyboard Tab and Escape through both layers follow that focus sequence in the rebuilt UI.

Live keyboard evidence in the rebuilt dev app showed focus trapped inside the Help drawer and
restored to its trigger on Escape; the compact navigation overlay likewise returned focus to its
toggle instead of `<body>`. See the completed Settings UX live test.

<a id="lt-571-archived-detail"></a>

<a id="lt-571"></a>


## LT-571: Remote Nodes → Pairing renders an entirely empty panel — CONFIRMED FIXED LIVE 2026-09-24

### Observed behavior

Remote Nodes Pairing rendered an empty panel when the server was disabled.

### Root cause

The Pairing template lacked the disabled-state branch present on sibling tabs.

### Required behavior

Show a useful disabled-state explanation and a route to enable the feature.

### Acceptance

The default profile’s Pairing panel has visible explanatory content at supported widths.

With the remote-node server disabled, the rebuilt app rendered the expected explanatory copy in
the Pairing panel at the tested widths. See the completed Settings UX live test.

<a id="lt-572-archived-detail"></a>

<a id="lt-572"></a>


## LT-572: icon-only Settings rail controls are under the 44 × 44 hit-target floor — CONFIRMED FIXED LIVE 2026-09-24

### Status correction — 2026-09-24 (REOPENED, partial)

Live re-check by the `settings` batch: `.settings-nav-toggle` is now 44 × 44
(`settings.component.nav.scss:20-21`). But every collapsed `.nav-item` measures **39 × 44**. The
`.settings-nav` rail has a permanent internal scrollbar (about 1,448 px of content against a rail
never taller than about 400 px, at window heights of 600, 900 and 1,200 px). That scrollbar takes
about 6 px from the content box that `.nav-item`'s `width: 100%` resolves against
(`settings.component.nav.scss:138,289-293`). Height is fixed; width is not.

### Final live re-check — 2026-09-24 (`verify-ui`)

After widening the collapsed rail to 64 px and adding `min-width: 44px`, the toggle measured 44×44
and all 30 collapsed navigation items measured at least 47×44 at 600, 900 and 1,200 px viewport
heights. The permanent internal scrollbar remained present, so this directly covers the reopened
failure rather than a no-overflow special case.


### Observed behavior

Icon-only Settings rail items measured below the 44 × 44 pointer target floor.

### Root cause

Compact rail and toggle CSS constrained the clickable boxes to 37 × 38 and 30 × 30.

### Required behavior

Make those icon-only targets at least 44 × 44 without breaking the narrow rail.

### Acceptance

Rendered target measurements meet 44 × 44 at compact widths and navigation still fits.

The completed Settings UX live test retains the measurement evidence.

<a id="lt-573-archived-detail"></a>

<a id="lt-573"></a>


## LT-573: the save-state banner announces nothing, including its error state — CONFIRMED FIXED LIVE 2026-09-24

### Observed behavior

The shared save-state banner announced neither saves nor errors to assistive technology.

### Root cause

The component had no status, alert or live-region semantics.

### Required behavior

Expose success and error states through suitable live semantics.

### Acceptance

A real failed save is announced as an error and ordinary save state as status across consuming tabs.

The rebuilt app rendered the shared banner with `role="alert"` and `aria-live="assertive"` for an
injected real save failure while preserving the user's input. See the completed Settings UX live
test.

<a id="lt-574-archived-detail"></a>

<a id="lt-574"></a>


## LT-574: Ecosystem lists no commands on any visit after the first — CONFIRMED FIXED LIVE 2026-09-24

### Observed behavior

Ecosystem listed commands once, then returned an empty successful list on later visits.

### Root cause

The list handler cleared command data but retained its directory-mtime cache, causing reuse of a deleted entry.

### Required behavior

Invalidate both caches together so repeat visits rescan or safely reuse the same data.

### Acceptance

Two consecutive list calls return the same commands without touching the directory.

Three consecutive real `ecosystemList` calls returned the same two fixture commands without
touching the directory. See the completed Settings UX live test.

<a id="lt-575-archived-detail"></a>

<a id="lt-575"></a>


## LT-575: light-theme contrast failures on Settings surfaces — CONFIRMED FIXED LIVE 2026-09-24

### Observed behavior

Light-theme Settings text and pills had measured contrast failures.

### Root cause

Several component surfaces and text colors were hardcoded for the dark theme.

### Required behavior

Use coordinated theme colors that preserve readable contrast in light and dark.

### Acceptance

Rendered light-theme measurements pass the target contrast checks for the reported surfaces.

The two originally reported rendered light-theme surfaces both measured 16.16:1 in the rebuilt
app. See the completed Settings UX live test; LT-630 separately owns the later same-colour tint
surfaces found by the broader sweep.

<a id="lt-614-archived-detail"></a>

## LT-614 — a timed-out ACP approval card stayed on screen and its Cancel did nothing — FIXED 2026-09-22

### Observed behaviour

Reproduced in the dev app on 2026-09-22 (OpenCode provider plan, Task 6.2). With YOLO off, an ACP permission request
shows the generic "Input Required" card. If nobody answers, the PermissionRegistry auto-rejects it after 60 s and the
agent carries on — but the card stayed on screen, and clicking its Cancel did nothing. Shared by every ACP provider
(OpenCode, Grok, Cursor, Copilot). Found while fixing it: answering a card through chat never resolved its registry
entry, so for up to 60 s the "N sessions blocked on approval" banner counted an answered request, and the durable
approval audit recorded the user's answer as `denied / timeout`. Stop and agent exit left registry entries open the
same way, and an open ACP elicitation was never cleared when the agent process died.

### Root cause

- Nothing told the renderer when a request was settled without the user. `PermissionRegistry` emitted
  `permission:resolved` (consumed only by the durable store), and `AcpCliAdapter` answered the agent silently.
- Cancel on a generic card called `respond(false)` with no text, which hit `if (!inputText) return;`.
- `AcpCliAdapter.sendRaw` replied to the agent but never resolved the registry entry; the cancel and exit paths did
  the same.

### Required behaviour

A card disappears as soon as its request no longer needs an answer, for every reason (timeout, auto-approve, parent
decision, turn cancelled, agent exit), exactly once per request; Cancel on an ACP card is a real answer; the banner
and approval audit reflect what actually happened.

### Fix

- `AcpCliAdapter` emits `input_required_resolved {id, reason}` on every non-user settle path, at most once per request
  (live-map checks after every await; never for YOLO auto-approvals that showed no card), carried through
  `InstanceCommunication` → `InstanceManager` → IPC `INPUT_REQUIRED_RESOLVED` (`instance:input-required-resolved`)
  and the remote observer, plus the mobile gateway (`permission-cleared`). The renderer removes the card and
  decrements `pendingApprovalCount`.
- Cancel on ACP cards (`metadata.transport === 'acp'`) sends a keyed `cancel` (ACP outcome `cancelled`); other
  generic cards, whose reply is plain stdin, still send nothing.
- A reply to an already-settled request returns `INPUT_REQUIRED_NOT_PENDING`; the renderer drops the card.
- Registry entries are closed with `decidedBy: 'user'` on reply and the new `'cancelled'` on Stop or agent exit; the
  exit handler also drains open elicitations.

### Acceptance

- `acp-cli-adapter.permission-resolved.spec.ts` (12 tests, including three exit-during-await races) and the new
  `user-action-request.component.spec.ts`, `instance-event-forwarding.spec.ts` and `mobile-gateway-server.spec.ts`
  cases pass; each guard was mutation-checked (reverting it fails its test).
- Dev app, OpenCode free model: an unanswered card disappears at 60 s (audit `denied / timeout`); Cancel removes the
  card at once and the tool is refused (audit `denied / user`, no banner); Stop with a card up removes it within a
  second (audit `denied / cancelled`).

<a id="lt-630-archived-detail"></a>


## LT-630 — light-theme text-on-tint contrast failures beyond LT-575 — FIXED 2026-09-24

### Observed behaviour

Live, 2026-09-24, `settings` batch (dev app at `f04f6748`, light theme, contrast computed from live
styles). LT-575's two surfaces now measure 16.16:1. A sweep of six Settings tabs still found real
failures: 4 on Remote Nodes, 7 on Permissions, 8 on Auxiliary Models and 3 on Ecosystem. General and
Advanced had none. Examples:

| Element | Ratio |
| --- | --- |
| `.status-badge.connected` "coordinator" | 2.62:1 |
| `.health-badge[data-healthy]` "0 online" / "1 offline" | 2.62:1 / 3.17:1 |
| save-state banner "All changes saved" | 2.94:1 |
| `.role-choice-row .btn.selected` "Main Harness" | 2.92:1 |

### Root cause

These elements set the foreground to `--pill-ok-fg` or `--pill-error-fg` (which are
`--success-color` and `--error-color`, `_theme.scss:54,64,204,210`), or to `--primary-color`,
directly on a low-alpha tint of the same colour. In light theme the tint composites to near-white
while the foreground stays tuned for dark backgrounds. This is a different root cause from
LT-575's hardcoded dark values.

### Required behaviour / acceptance

Light-theme-aware `--pill-*-fg` values, or `--text-primary` as LT-575 used. Every cited element
measures ≥ 4.5:1 in light theme, and dark theme is unchanged.

### Fix and live re-check — 2026-09-24

The fix is at the token level. Light-theme-only overrides were added in
`src/renderer/styles/_theme.scss`, and mirrored into its `prefers-color-scheme` block:

| Token | Value |
| --- | --- |
| `--pill-ok-fg` | `#14532d` |
| `--pill-warn-fg` | `#92400e` |
| `--pill-error-fg` | `#b91c1c` |
| `--pill-info-fg` | `#1e40af` |
| `--pill-accent-fg` | `#78350f` |

Only the `*-fg` tokens changed, so the tints, borders, base colours and the dark theme are untouched.
`.role-choice-row .btn.selected` now uses `--text-primary`
(`remote-nodes-settings-tab.component.scss`). The fix agent's computed contrast against the
composited tints was 4.6–8.1:1.

**Live re-check (`verify-ui`, dev app from the working tree):**

| Element | Before | After |
| --- | --- | --- |
| `status-badge.connected` | 2.62:1 | 7.45:1 |
| `health-badge` | 2.62:1 / 3.17:1 | 7.45:1 / 5.29:1 |
| save banner | 2.94:1 | 8.73:1 |
| role choice | 2.92:1 | 18.11:1 |

**CONFIRMED FIXED LIVE** for the cited elements. The residual sweep found 3/6/6/3 failures at about
4.4:1 on generic `.field-hint` / `--text-muted` text. That is a different, smaller pattern, recorded
as an observation, not part of LT-630.

<a id="lt-631-archived-detail"></a>


## LT-631 — the project menu is clipped by the instance list's scroll container — FIXED (three causes) + CONFIRMED LIVE 2026-09-24

### Observed behaviour

Live, 2026-09-24, `settings` batch, with 15 seeded Copilot rows so the section is tall.
`.project-menu` has `max-height: min(60vh, 420px); overflow: hidden auto`
(`instance-list.component.scss:514-515`). But it is a `position: absolute` descendant of
`.cdk-drop-list.instance-viewport`, which has `overflow-y: auto` (`:239`) and a visible clip box of
only 413 px in a 900 px window. `elementFromPoint()` returns `null` inside the menu's box past that
line. This happens at the first row as well as near the bottom. About 260 px of the menu is visible,
where 418 px was intended, and the menu ends in a flat clipped edge instead of its rounded corner.

### Root cause

The menu's height cap is computed and applied in isolation. It is painted inside a scroll container
that clips it and is often shorter than the cap.

### Required behaviour / acceptance

The dropdown escapes the list's scroll container (a CDK overlay or `position: fixed` anchored to the
trigger), or sizes itself against the space that is actually visible. Opening it at any row, with a
list pane under 420 px high, shows every item reachable and the menu's own rounded corner intact.
Owning check: copilot-account-routing check 10.

### Fix and live re-check — 2026-09-24

**First fix (renderer agent).** `.project-menu` is now `position: fixed`. It is placed against the
viewport by the tested helper `computeProjectMenuPosition()`
(`src/renderer/app/features/instance-list/project-menu-position.ts`), and it closes when
`.instance-viewport` scrolls.

**Live re-check (`verify-ui`).**

- Check 11 passed.
- The clipping itself was gone.
- But opening any "…" menu on a scrollable list closed it again within the same click. The open
  path's `firstMenuItem.focus()` made Chromium scroll the still-DOM-nested `.instance-viewport`
  (`scrollTop` 0 → 431 measured), and the new close-on-scroll handler treated that as a user scroll.
- **Reopened.**

**Second fix.** Every focus move into the menu uses `focus({ preventScroll: true })`: the open path,
plus the Home, End, Tab-wrap and Arrow handlers, which would have closed the menu the same way. The
handler's doc comment records why. The instance-list specs pass (95). There is no DOM test, because
signal inputs cannot be set in this vitest setup. The live re-check is still pending.

### Third cause and live confirmation — 2026-09-24

After the second fix the menu stayed open, but it rendered entirely off-screen (`left: -418px` in a
1000 px window). `.project-actions` keeps a `transform` in every state, including `translateX(0)`
when visible, and any non-`none` transform makes an element the containing block for its
`position: fixed` descendants. So the viewport coordinates resolved against a box about 400 px wide.
The visible, hover and focus-within states now use `transform: none`.

Confirmed live by `verify-final`:

- `.project-menu.offsetParent === null`;
- the rect is fully in the viewport at the top and bottom rows and with a 362 px list pane;
- every item hit-tests (the menu scrolls internally when tall);
- the rounded corner is intact;
- keyboard navigation keeps it open, a wheel scroll closes it, and Escape restores focus to the
  trigger;
- check 11's paint order still holds.

<a id="lt-642-archived-detail"></a>


## LT-642 — a terminal checkpoint-only loop got the restore path's internal error — FIXED 2026-09-24

### Observed behaviour and root cause

Found live by the `loops` batch (agent-reachable-loop-resume check 4). `aio-mcp loop resume` on an
old terminal loop exits 1 correctly, but prints `Cannot restore non-paused loop checkpoint:
<status>` instead of `Loop <id> is <status>, which is terminal…`. `resumeLoopRun()`
(`src/main/orchestration/loop-resume.ts`) called `restoreLoopFromCheckpoint()` for any checkpoint,
and that throws for terminal states before `notResumableReason()` is ever reached.

### Fix and acceptance

`resumeLoopRun()` now checks the checkpoint first. It is restorable if its status is `paused`,
`running` (which restore reconciles to `paused`) or `provider-limit` with no `endedAt`. Anything else
returns `notResumableReason()` without attempting a restore. A terminal provider-limit checkpoint
also now gets the friendly reason instead of a thrown error. Tests: a terminal checkpoint-only loop
gets the exact message and restore is never called (red first), and a crash-left `running`
checkpoint is still restored. Two `automation-runner.spec.ts` fixtures gained the `status` every
real checkpoint carries. Loop, automation and event-bus suites: 3,220 tests pass.

<a id="lt-651-archived-detail"></a>


## LT-651 — a new instance's `contextEvidence` never reaches the renderer store — FIXED + CONFIRMED LIVE 2026-09-24

### Observed behaviour

Live, 2026-09-24, `runtime` batch. On a fresh instance, `contextEvidence` stayed `undefined` in the
renderer `InstanceStore` for more than 5 s, while a direct IPC read at the same moment returned it.

### Root cause (read, to be confirmed by the fix's failing test)

`src/main/instance/instance-lifecycle.ts:1396-1397` emits `created` synchronously, before
`initializeInstanceEvidenceOwnership` (`:1542`) sets `contextEvidence`. LT-602 closed the identical
gap for `reasoningEffort` with a follow-up emit in the same continuation (`:1589-1594`). No such emit
exists for `contextEvidence`.

### Required behaviour / acceptance

A follow-up state emit carries `contextEvidence`, and the renderer store shows it without a reload.
This is context-evidence check 7, residual (a).

<a id="lt-659-archived-detail"></a>

<a id="lt-659"></a>

## LT-659 — standalone zero-reviewer CLI failed while opening Electron settings — FIXED + CONFIRMED LIVE

**Observed behaviour — 2026-09-27.** The source entrypoint now exists, so LT-G was run with
`npm run review -- --cwd <disposable-ebrd-repo> --target <empty-tree> --reviewers none --json`.
The checker plan correctly selected no reviewers, but the command exited 1 with
`Please specify the projectName option`. A stack capture placed the throw at
`CrossModelReviewService.runHeadlessReview()` calling `getSettingsManager()`, whose
`electron-store` constructor has no Electron `app`/userData context in a plain `tsx` process.

### Root cause

Copilot scope classification already treats an unavailable settings manager as an unscoped CLI
context, but `runHeadlessReview()` read the settings first and unconditionally. The intended
fallback was therefore unreachable. The product default also enables the local advisory pass;
using it without persisted settings would immediately try to discover configured local/remote
model state through the same unavailable store.

### Required behaviour / acceptance

- A plain Node/tsx headless review must not require Electron's `app` or userData path.
- `--reviewers none` must return exit 0 with no remote dispatch, no provider call, stable JSON and
  no infrastructure error.
- Electron-hosted headless review must retain its persisted local-review settings.
- If settings are unavailable, the fallback must not invent a local reviewer target.

### Fix and evidence — 2026-09-27 (working tree)

- `cross-model-review-service.ts` now catches an unavailable headless settings manager and uses
  defaults with the local advisory pass disabled. Electron calls still use persisted settings.
- A new regression in `cross-model-review-service.headless.spec.ts` failed on the original code at
  the exact unconditional settings read. The headless and CLI focused suites then passed **21/21**.
- The original live command then exited **0** with `reviewers: []`, `findings: []`,
  `infrastructureErrors: []`, and `No reviewers available for headless review.` No provider adapter
  was dispatched and no Copilot call was made.

<a id="lt-661-archived-detail"></a>

<a id="lt-661"></a>

## LT-661 — title escalation stopped after the first installed provider failed — FIXED + CONFIRMED LIVE

**Observed behaviour — 2026-09-27.** A new read-only session in the rebuilt dev runtime selected
Antigravity as the first installed fast-tier title provider. `agy` exited with code 1, the runtime
persisted `AI title escalation failed`, and the title request returned no AI title even though
Claude and Codex were installed and eligible. The instant title remained because no later provider
was attempted.

### Root cause

`AutoTitleService.generateTitle()` searched the ordered provider list only until it found one
installed CLI, then built and called exactly that adapter. Every subsequent infrastructure failure
(provider-route setup, adapter without one-shot send, or a rejected call) returned `null` from the
whole escalation. Installation was therefore treated as a successful provider selection even when
that provider produced no response.

### Required behaviour / acceptance

- Preserve the configured fast-provider preference order and all automation exclusions.
- If an eligible provider fails before returning a response, continue to the next eligible provider
  and retain provider-specific diagnostics for the failed attempt.
- Stop after any provider returns a response, including unusable output, so a response-bearing paid
  call cannot cascade into additional paid providers.
- Keep the single routing authorization boundary and attribute the successful provider/model.
- A regression reproduces preferred-provider rejection followed by a healthy later provider.
- Live: a real preferred-provider failure is followed by a later provider's attributed title, and
  the resulting `displayName` and `aiTitle` agree.

### Fix and evidence — 2026-09-27 (working tree)

- The eligible provider loop now owns route setup, adapter construction and one-shot dispatch. It
  continues only for zero-response infrastructure failures; returned content remains terminal and
  goes through the existing title gates.
- The regression used the live topology: installed Antigravity rejects with
  `agy exited with code 1`, installed Claude returns `Deployment fallback title`. It failed on the
  old single-selection loop and the focused title-service suite now passes **48/48**.
- Main TypeScript, the main-process build and the TypeScript line-count gate pass after the change.
- Live session `xrewp0sr4` persisted the Antigravity failure, then a Claude/Haiku success, and
  `listInstances` returned `displayName` and `aiTitle` as exactly
  `Nebula audit fallback complete`.

<a id="lt-663-archived-detail"></a>

<a id="lt-663"></a>

## LT-663 — long tool-heavy turns lose their recorded evidence source outside the 200-row window

**Status: fixed, regression-tested and confirmed live 2026-10-04.** The matching
[completed MCP evidence source repair plan](2026-10-03-mcp-evidence-source_plan_completed.md) and
[completed owning live-test document](2026-10-03-mcp-evidence-source_livetest_completed.md) retain
the implementation and per-check campaign evidence. The historical completed remediation plan
remains closed. A fresh independent [final completion report](../../_scratch/evidence-source-repair/windows-restarted-20261004/final-review/report.md)
returned PASS with no unresolved actionable findings. Its final read-only proof found 349 natural
records after the genuine source, no user in the latest 200, and six distinct complete worker-tool
captures linked to that same source and canonical conversation. Actual Windows synthetic tour
checks and exact-owned cleanup passed. In-memory enforcement remains inferred from the installed
executing path and startup settings; recorded creation times are not direct insertion-order
instrumentation. The historical reproduction and its original limits below are preserved.

### Observed behaviour

After James reinstalled Harness and supplied a genuine new continuation, new live worker discovery
and a harmless literal-output Windows PowerShell command returned usable results. Their complete
captures linked to the correct existing user record and canonical conversation. Later in the same
turn, `read_node_output` and `download_from_node` returned `EVIDENCE_CAPTURE_REQUIRED` with
`execution=not_started reason=SOURCE_MESSAGE_MISSING`, after `run_on_node` had returned an idle
hash-worker instance. The follow-up handlers did not start; that does not undo the earlier worker
execution or establish its result.

A read-only canonical ledger snapshot first found 230 records, with the newest 200 at sequences 31–230
containing 198 tool results and two system records, but no user. The fresh consistent read at
2026-10-04T10:16:42.963Z found 267 records: newest 200 at sequences 68–267, again 198 tool results and
two system records, no eligible user or pending tool call. The genuine current user still existed
at sequence 1, with the correct explicit owner and 266 later records. Persistence and canonical
ownership were intact; only the bounded source window had lost the anchor.

Safe proof and the replay script are retained at
`_scratch/evidence-source-repair/windows-20261004/provenance/source-window-failure-proof.json`
and `replay-live-source-window.cjs` beside it. The proof exports counts, roles, hashed identity tags
and comparisons, without raw user content or credentials. It used a read-only SQLite constructor,
`query_only` and a consistent read transaction. The parent campaign owns the actual live error;
the independent replay is source-selection evidence, not another executed Windows tool call.

### Root cause

The installed `orchestrator-tool-source-context` resolver requests only
`getRecentConversation(threadId, 200)` and searches those rows for an eligible genuine user or
pending matching tool call. Results and system records can occupy the entire window during a
single long turn. Once they do, an existing source outside that window is invisible and the
resolver returns its synthetic timestamp fallback. Enforcement correctly refuses that fallback
as `SOURCE_MESSAGE_MISSING` before dispatch.

The replay confirmed the resolver bytes matched the installed module. Both affected tool names
requested limit 200 and returned the rejected fallback with the actual newest rows. Supplying the
complete set of already-existing genuine canonical rows to the same pure resolver resolved both
to the same sequence 1 user, without changing ownership or inventing a message. This comparison
isolates source-window exhaustion; it is not a proposal to load every transcript row in production.

### Required behaviour

- Resolve the latest eligible recorded user independently of how many tool results or system
  messages follow it. Use a bounded, indexed storage lookup rather than an unbounded transcript
  load or a fabricated/backfilled source.
- Preserve explicit instance-owner and canonical-conversation boundaries, async ownership
  revalidation, unique invocation capture identities and the bounded pending-native-call fallback.
  Missing, foreign, ambiguous or completed-call provenance must remain fail closed.
- Keep source lookup/persistence failures distinguishable from post-execution capture failures,
  with sanitized reason and execution-stage diagnostics. Do not expose raw storage errors,
  arguments, output or secrets, or encourage mutation retries after execution.

### Acceptance

- A regression reproduces this long-turn failure with more than 200 later result/system rows;
  the real ledger storage path and enforced wrapper still select the same genuine current user.
  Lookup returns at most one eligible user and preserves existing rows across migration.
- Ownership, missing-source, throwing-lookup, ambiguous/native-call and repeated/concurrent
  invocation regressions retain enforcement and distinct capture keys. Focused checks and all
  normal project gates pass, followed by a new fresh independent completion-gate PASS covering
  this repair; the earlier local review cannot certify the follow-up.
- After rebuilding and activating the repaired Harness, newly executed discovery and harmless
  Windows commands, plus the blocked result-read/download follow-ups, return usable results in
  the long turn. Read-only provenance checks confirm the correct recorded source and canonical
  conversation, without enforcement changes or live database edits.
- Complete the owning Windows localhost fixture campaign with actual archive/per-file hashes,
  automated synthetic API checks, secure context/WebCrypto, authenticated replay, Next/Back,
  Close/focus restoration, preference persistence and UI duplicate-save guarding. Retained
  native reviews and coordinator tests do not count as new Windows passes.
- Stop/remove only verified owned fixture processes, worker instances, temporary resources and
  the dedicated test tab. At reproduction, fixture acceptance had not passed and owned cleanup
  remained blocked until repaired activation restored this session's worker tools.

<a id="lt-682-archived-detail"></a>


## LT-682 — the interrupt button says "Interrupt Claude" on every provider

**Status: open, cosmetic, observed live 2026-10-04 on Codex sessions (compaction reliability live test
check 3).**

### Observed behaviour

While a Codex session is busy the header button `btn-interrupt` carries the tooltip
"Interrupt Claude (Esc)".

### Root cause

`instance-header.component.html:45` hard-codes `title="Interrupt Claude (Esc)"`.

### Required behaviour

The tooltip names the session's actual provider, as the compaction banner does with
`getProviderDisplayName`.

### Acceptance

- Component test: a Codex instance's interrupt button title does not contain "Claude".

<a id="lt-706-archived-detail"></a>

<a id="lt-706"></a>

## LT-706 — a MiMo step that exhausts the combined cap on reasoning ends the session silently

**Status: fixed and regression-tested 2026-10-14; live-verified 2026-11-11 with real MiMo generation (both checks in the live-test document passed).**
Origin: James's live session `ivx7upc8u` (installed app, OpenCode 1.19.0,
`aio-mimo-comtechspare-f7a6/mimo-v2.6-pro`), 2026-10-14 20:39–21:41 BST.
Plan: [2026-10-14-mimo-reasoning-cap-cutoff_plan_completed.md](2026-10-14-mimo-reasoning-cap-cutoff_plan_completed.md).

### Observed behaviour

- OpenCode session `ses_ec4126b42ffemKuqDOJBnet17O` records three consecutive assistant steps
  with `finish: "length"`: output 0 + reasoning 16388 (21:21:59 BST), output 1 + reasoning 16383
  (21:29:16 BST), and output 0 + reasoning 16386 (21:41:26 BST, after James's manual
  "continue"). Earlier tool-call steps used up to about 12.7k reasoning tokens each.
- `app.log`: all three `ACP turn completed` lines report `stopReason: "end_turn"`,
  `classifierReason: "completed"`, `generationBudget.combinedOutputTokens: 16384`. The shared
  `ProviderTurnEnding` line reclassified the first as `dangling_tool_result` (one automatic
  continuation); the other two stayed `completed`. No notice, no further continuation; the
  session went idle each time, so the manual "continue" also appeared to do nothing.

### Root cause

`outputBudgetSaturated` (`src/main/cli/turn-ending-classifier.ts`, added for LT-690) returned false
for empty text and otherwise required the whole-turn text to end unfinished. ACP usage covers only
the final provider step, so a step cut off while reasoning after earlier finished narration, or
with no text at all, read as a normal completion. `AdapterTurnEndingObservation` reclassifies
without `combinedOutputTokenCap`, and its `dangling_tool_result` overrides the adapter ending.

### Required behaviour

A non-error completion with no open tool call whose final-step output + reasoning reaches the
injected cap (within tolerance) is `max_output / budget_saturated` when the final step's visible
output is within tolerance or the turn text is empty or unfinished. The cap is also read from the
adapter's `generationBudget` metadata so both classification layers agree, and saturation takes
precedence over an unanswered tool result. Failure and transient-error signals keep
saturation out, so a failed turn is never auto-continued.

### Acceptance

- Regression tests for the zero-text, earlier-narration, metadata-cap/dangling, metadata-usage,
  runtime observation and `acp-turn-completion` cases fail on the previous classifier and pass; negative cases (finished answer,
  open tool, error, empty under cap) stay out of saturation.
- Live: [MiMo reasoning-cap live checks](2026-10-14-mimo-reasoning-cap-cutoff_livetest.md). Met 2026-11-11 ("Evidence run — 2026-11-11"): a real ordinary turn completed with cap 32000 and no continuation; three real `finish: length` steps were classified `max_output / budget_saturated`, with exactly two automatic continuations and the visible notices.

<a id="lt-728-archived-detail"></a>

<a id="lt-728"></a>

## LT-728 — Typed messages not saved, so every Harness tool is refused

**Observed:** on 7 November 2026, session `xhsbd42yj` (conversation `ae50cb86-7124-4fbd-9d8a-2c1c342b67e3`) was woken from hibernation at 00:32:49Z by James's message "rebuilt and resttarted I think". The app log shows `IPC INSTANCE_SEND_INPUT received` at 00:32:50.076Z, then `sendInput called` and an immediate provider-limit park at 00:32:51.226Z. The session's own output buffer (`session-continuity/states/xhsbd42yj.json`) holds the message as a `user` entry with id `edf31eff-cd06-4ac4-a0e2-3f9097e29f58`, timestamp 00:32:51.223Z and no metadata. The conversation ledger has no row with that id. The park notice published 3 ms later (`77b976c8-…`, ledger sequence 2860) was saved, as were the later provider-change notice and every assistant and tool row. A second message, "please continue" (`465c69af-…`, 00:39:07Z, just before an account switch), is also missing. The newest `user` row on the conversation is from 6 November 13:33Z under the previous instance id `xwmy5ab9e`. After the provider change and the resume fallback, every orchestrator tool call (`get_setting`, `plan_queue_status`) failed with `EVIDENCE_CAPTURE_REQUIRED execution=not_started reason=SOURCE_MESSAGE_MISSING`; tool search and describe still worked.

**Root cause:** two faults, both reproduced and covered by tests in [the fixing plan](2026-11-07-revived-session-input-provenance_plan_completed.md).

1. The session was revived by crash recovery when the app restarted on 6 November (its creation log hides the history id as `[recovery history identity omitted]`, which happens only for `metadata.reason === 'crash-recovery'`). `InstanceContinuityRecovery.redactProviderEnvelope` deliberately strips `raw` and `sessionId` from every envelope of a revived session. `ChatTranscriptBridge.messageFromEnvelope` kept a `user` output only when `raw.source === 'instance-output'`, its way of telling Harness's own published input from a provider echo. With `raw` gone, every typed message of a revived session was dropped, while assistant, system and tool rows, which do not depend on `raw`, were saved. Under `enforce`, `getLatestInputSource` then finds no input and every Harness tool call fails with `SOURCE_MESSAGE_MISSING`. The usage-limit hold and the account switch were coincidental.
2. Evidence mode is per provider (`contextEvidenceModeByProvider`; on this machine Codex is `enforce`, Claude `off`). `RuntimeReconciler.applyRuntimeChangeLocked` swapped `instance.provider` without re-running `initializeInstanceEvidenceOwnership`, so after the Codex-to-Claude change at 00:36Z the session still enforced Codex's mode. After the session hibernated and was woken at 02:03Z, the wake path re-read the mode as Claude's `off`, and the same `plan_queue_status` call succeeded.

**Required behaviour:** every message James sends to a session, including one that wakes a hibernated session or is held for a provider limit, is saved once as his message on the session's conversation, so Harness tools called while answering it are accepted.

**Acceptance:** a regression test reproduces the lost row on the real send path (wake from hibernation, then a provider-limit hold) and passes after the fix. After a rebuild and restart, a hibernated session woken by a typed message can call `get_setting` successfully, and the ledger shows that message as a `user` row for the current instance.

<a id="lt-782-archived-detail"></a>

<a id="lt-782"></a>

## LT-782 — refreshing during MiMo renewal cooldown hides an unresolved expired-login warning

Numbering note (2026-10-27): the original MiMo LT-708 assignment conflicted with the benchmark reservation. The initial root and queue plan-directory scan at approximately 04:23 UTC confirmed LT-782 was unallocated; this MiMo record uses that number. A later review found a separate LT-790 reservation without an LT-782 conflict. Its earlier evidence retains the original timestamps; no other defect is renumbered.

Status: fixed and verified live 2026-10-27; canonical gates and fresh independent completion review PASS. No unresolved acceptance item. Implementation status: [active follow-up plan](2026-10-27-mimo-stale-session-warning_plan.md). The older 2026-07-19 plan remains closed; new work is recorded in this follow-up under the completed-document rule.

### Observed behaviour

In the isolated rebuilt dev app, omitted outgoing console cookies produce real MiMo 401 responses. Omitting outgoing account cookies for the failed-renewal case reaches the real Xiaomi sign-in page, and the quota retry still receives 401. At 02:49:54 UTC, cached token bars remain and the chip shows OC 94% plus a warning; one quota-reauth notification records desktop delivery. A second real Refresh at 02:50:14 UTC again receives 401, but the renewer is on cooldown: the cached snapshot changes needsReauth from true to false and the warning disappears. No successful quota response intervenes. Evidence: rejected-refresh-one.json, rejected-refresh-two.json and rejected-network-two.json in 2026-09-25-mimo-session-resilience_evidence/2026-10-27-round2/.

### Root cause

MimoTokenPlanProbe returns a windowless transient failure when renewal is unavailable (including cooldown). ProviderQuotaService.retainLastKnownQuotaWindows defaults its absent needsReauth flag to false and drops the prior sign-in instruction. The IPC listener consequently resets its one-shot transition tracking despite no evidence that authentication recovered.

### Required behaviour

A windowless failure with no authentication verdict preserves the previous warning, original instruction, cached bars and original takenAt. An authoritative successful snapshot, explicit false verdict, configuration exclusion or source invalidation can replace that state. Repeated refreshes of the same unresolved expiry issue only one quota-reauth notification.

### Acceptance

- Live rejection plus repeated Refresh retains two cached token bars, their age and warning; exactly one quota-reauth notification is delivered.
- A real saved-SSO walk followed by successful native quota responses clears the warning, advances takenAt and writes the renewal-success log. The 04:26 UTC correction run excludes the original service token from every renewal-phase request: SSO-returned authentication alone gets 200; identity-only negative controls get 401; a persisted-session reread gets 200 again. See the owning live-test report and its `2026-10-27-review-fixes` receipts. Natural expiry was not induced.
- Service regressions cover preserved state, successful and explicit-false replacement, and account isolation; existing healthy-cache and source-invalidation tests remain green. Canonical gates and fresh independent review pass.

<a id="lt-822-archived-detail"></a>

## LT-822

### LT-822 — model-breakdown cost events failed renderer validation

**Status: fixed on main; no rejections seen on 10 November 2026.** `cost:usage-recorded` carrying `byModel` was rejected with `Unrecognized key: "byModel"` and never reached the renderer. The event schema now accepts a bounded, strict per-model array. Live: zero `byModel` rejections in the log across this run's priced turns.

<a id="lt-823-archived-detail"></a>

## LT-823

### LT-823 — a deferred tool permission ended a loop before the operator decided

**Status: fixed on main; held-call path checked live on 10 November 2026.** A real `/goal` reading a fixture ended `error: Claude CLI cancelled` while its parent waited for permission. Borrowed requests now survive the native defer and resume on the same adapter after a decision. Live: a held Bash call approved with "Allow this once" resumed (`Resumed after deferred permission successfully`) and ran once. The full goal composition is not repeated.

<a id="lt-824-archived-detail"></a>

## LT-824

### LT-824 — Costs page rendered a literal backslash before dollar amounts

**Status: fixed on main; checked live on 10 November 2026.** Per-model, per-session and recent-entry cells contained `\$`. Live with real data on two reads: no backslash, 15 and 37 dollar signs.

<a id="lt-826-archived-detail"></a>

## LT-826

### LT-826 — Close all left the original resident provider alive

**Status: fixed on main; checked live on 10 November 2026.** On 27 October the loop was cancelled and the session removed but Claude pid 94693 stayed alive. Re-run: with a same-session loop running, Close all removed every session, cancelled the loop, and the resident and loop processes were gone within 6 s (the first 10 November write-up of a survivor was a misdiagnosis, see LT-1202).

<a id="lt-1018-archived-detail"></a>

<a id="lt-1018"></a>

## LT-1018

### LT-1018 — priced cost events are blocked by the renderer event check

**Status: fixed and verified live on 12 November 2026.**

### Observed behaviour

In an isolated dev app built from this branch, a Claude Haiku turn priced correctly (cost entry and header total), but the
main log carried `Blocked invalid renderer event payload` for channel `cost:usage-recorded` with
`Unrecognized key: "origin"` on every completed turn. The renderer never received the event, so the open Costs page only
changed on its 10-second poll. The same defect class as LT-822 (`byModel`), which was fixed without noticing `origin`.

### Root cause

`communication-completion-cost.ts` passes `origin` (`machine` or `user`) to `CostTracker.recordUsage`, which stores it on the
entry (`cost-tracker.ts`, `CostEntry.origin`). The cost handler forwards the whole entry, and `CostEntryEventSchema`
(`packages/contracts/src/schemas/cost-events.schemas.ts`) is `.strict()` and had no `origin` field. The earlier regression
test recorded usage without an origin, so it could not catch this.

### Required behaviour and acceptance

The event schema accepts a non-empty `origin` string (up to 100 characters; the tracker documents future open tags) and still
rejects an empty one or any other unknown key. Acceptance: `cost-handlers.spec.ts` case "delivers the session origin the
completion recorder attaches to every priced turn" (failed before the fix, passes after). Live: after the rebuild, two
Haiku turns each reached the renderer 1.8 to 1.9 seconds after the send with `origin: "user"`, the Costs page changed 0.17
seconds after the event (not on the poll), and the log held no `Unrecognized key` line.

<a id="lt-1019-archived-detail"></a>

<a id="lt-1019"></a>

## LT-1019

### LT-1019 — the CLI update pill event is blocked at every start-up

**Status: fixed and verified live on 12 November 2026.**

### Observed behaviour

Every launch of the isolated dev app logged `Blocked invalid renderer event payload` for `cli-update-pill:delta`,
`Unrecognized key: "waitingSessionCount"`.

### Root cause

`CliUpdatePollService.setWaitingSessionCount` and `refreshInternal` put `waitingSessionCount` on the pill state
(`CliUpdatePillState.waitingSessionCount`, `diagnostics.types.ts`), and the pill component reads it. The strict
`CliUpdatePillStateEventSchema` (`observability.schemas.ts`) did not list it.

### Required behaviour and acceptance

The schema accepts a non-negative integer `waitingSessionCount`. Acceptance: `renderer-event-validation.spec.ts` case
"delivers the waiting-session count the poll service adds to its state" (failed before, passes after). Live: after the
rebuild, start-up logged no blocked event.

<a id="lt-1022-archived-detail"></a>

## LT-1022

### LT-1022 — Delete session × on the verification dashboard uses a dialog, not the inline confirmation

**Status: closed 19 November 2026 by decision. The shared dialog is kept (it is the app-wide confirmation pattern and meets the check's intent); the Phase F live test "Batch count and confirm" was reworded to match. Restoring the inline pair would be new work.**

### Observed behaviour

With a seeded completed verification session, clicking Delete session × (`verification-dashboard.component.html:316`,
`deleteSession` in the `.ts`) opens the shared confirm dialog: "Are you sure you want to delete this verification
session? This removes the session and its results." with Cancel and "Delete session". Cancel left the row in place. No
inline "Confirm delete / Never mind" pair appears. The Phase F history records an inline two-step confirm; the later
commit `9f7be3041` (Phase E) is the last to touch this file, and the current code calls `confirmService.confirm`.

### Required behaviour and acceptance

Either restore the inline pair or change the Phase F live test wording to the dialog. Acceptance: the live test
"Batch count and confirm" matches the screen.

<a id="lt-1041-archived-detail"></a>

## LT-1041 — searching for "process" does not find the host process tools

**Status:** fixed on main. Installed-app discovery verified 2026-11-07 (`evidence/2026-11-07-host-process-tools-resume/installed-discovery-2026-11-07.json`) and a native Claude session found both tools with the default limit. Pending independent verification. Origin: LT-A1 live test, 2026-10-27 retry (originally recorded there as the branch-local number LT-791, not retained).

### Observed behaviour

The installed forwarder and a fresh worktree build both answered a `process` search with only `set_setting` and `git_batch_pull`. Looking the tools up by exact name worked.

### Root cause

The tool-search ranker matches whole words and does not stem. The tool names contain the plural `processes` and the descriptions said "programs", so the singular `process` matched neither.

### Required behaviour and acceptance

A `process` search with the default limit returns both tools on the deferred and stable surfaces, with no change to search semantics, schemas, ownership rules or the fence. Acceptance: the full-catalogue regressions in `orchestrator-mcp-deferral.spec.ts` (line 176) and `orchestrator-mcp-stable-tools.spec.ts` (line 119) pass; the installed run above found both tools. Implementation notes: root plan `2026-10-27-host-process-discovery-remediation_plan.md`.

<a id="lt-1083-archived-detail"></a>

<a id="lt-1083"></a>

## LT-1083 — the Context details popover, home of "Compact now…", is clipped out of view by the composer panel

**Status: fixed and verified live on 13 November 2026. Priority P2.** Reproduced the same day in a rebuilt dev app (1400×900 window). The popover came in with the calm-screen phase 3 work (`ab5a879db`).

**Repair.** `context-details-popover.component.ts` now positions the popover `fixed` in the window, just above the toolbar that holds it (`place()` reads the toolbar's rectangle when the popover opens and on window resize, keeps it inside the window and caps its height to the room above). The composer panel's `overflow: hidden` no longer clips it. Unit test: `context-details-popover.component.spec.ts`, case "sits in a fixed position just above its toolbar…". Live: a rebuilt dev app, the real ring then "Compact now…" then Confirm with no style override; see the livetest's 13 Nov re-check section.

### Observed behaviour

With a Codex chat selected, clicking the context ring (`button.ctx-ring-btn`, label "Context window: N% used") opens `section.context-details` (not hidden), but nothing readable appears: the screenshot shows only a ~9 px dark strip above the composer. Measured with `getBoundingClientRect` in an idle chat: popover top 538, bottom 700; `div.input-panel` top 691, bottom 872 and `overflow: hidden`; the "Compact now…" button spans 655–685, wholly above the panel. `document.elementFromPoint` at that button's centre returns `button.backdrop`, not the button. A real mouse click there (Input.dispatchMouseEvent at x 490, y 669.75) only closes the popover; the compaction preview dialog never opens (waited 18 s, no `button.cpd-btn`). Repeated on two separate chats (one idle, one busy on a goal) with the same result. For Codex the "Compact Now" banner never shows (`resolveContextWarningLevel` returns null when `selfManagesAutoCompaction`; context reached 89.7% with no banner), so the popover is the only place a person can start a manual compaction.

### Root cause

Source-supported, not yet fixed. `ContextDetailsPopoverComponent` (`context-details-popover.component.ts`) is `position: absolute; bottom: calc(100% + 6px)` inside `app-composer-toolbar` (`position: relative`), which sits inside `.input-panel` (`input-panel.component.scss:14`, `overflow: hidden`) and `app-input-panel` (`:host { overflow: hidden }`, line 6). Everything the popover draws above the panel's top edge, which is nearly all of its 162+ px, is clipped.

### Required behaviour

The popover and its "Compact now…" button are fully visible and clickable from the context ring in the normal composer, at normal window sizes, including while a turn is running.

### Acceptance

A renderer test or rendered-DOM check that opens the popover in the real composer layout and asserts that the "Compact now…" button's centre point hit-tests to the button itself (not the backdrop) and lies inside the visible window. Live: with a Codex chat busy on a goal, open the ring, click "Compact now…", click Confirm, and see the busy refusal ("Busy: compaction is available once the current turn finishes.") from the real control with no style override.

### Evidence

[Codex goal-following livetest](2026-10-27-codex-goal-following-remediation_livetest.md#evidence-run--2026-11-13-queue-worker-rebuilt-dev-app), Check 3. With only a test-injected `div.input-panel, app-input-panel { overflow: visible !important }` the same button is reachable, opens the dialog, and Confirm returns the busy refusal, so the action works once it can be clicked. Screenshots and probe output were kept under `.aio-review/lt-e419d0c0-2026-11-13/`.

<a id="lt-1084-archived-detail"></a>

<a id="lt-1084"></a>

## LT-1084 — status goes idle 250 ms after a goal turn's final answer, before Codex ends the turn

**Status: fixed and verified on 13 November 2026. Priority P2.** Found by the independent verifier's round-2 review of the goal-following livetest, which pointed at a 1.6 s idle span recorded in Check 1's Run B. A recurrence of the LT-683 acceptance ("no idle span longer than the turn gap").

### Observed behaviour

Run B (instance in a rebuilt dev app, 13 Nov 2026): the final reply of native turn `b420ee` was written to the rollout at 19:13:52.769 and Codex's own `task_complete` at 19:13:54.608 (1.84 s later; the normal gap is 65 to 130 ms, measured over 32 other turns). The chat status went `idle` at 19:13:53.051, 0.28 s after the reply, and back to `busy` at 19:13:54.824 when the next goal turn started. The Stop button was gone for those 1.6 s while the native turn was open.

### Root cause

Source-supported and matching the timing. `handleItemCompleted` (`codex-notification-item-events.ts`) called `scheduleInferredCompletion` on every root-thread `final_answer`. That timer (`INFERRED_COMPLETION_MS = 250` in `codex-app-server-notification-adapter.ts`) calls `completeTurn(state, null)`, which resolves the capture, and the provider-turn follow code then emits `idle` (`codex-app-server-turn-adapter.ts`, the `.finally` after `finishProviderTurn`). The inference exists for multi-agent turns whose root `turn/completed` may not arrive after the helper agents drain; a plain turn always gets `turn/completed`.

### Required behaviour and acceptance

A turn that used no helper threads is completed only by Codex's own `turn/completed`, however long after the final answer it arrives; a turn that used helper threads still gets the inferred completion. Acceptance: `codex-notification-item-events.spec.ts` ("records a completed agent message on the root thread" now expects no inference; "still infers completion after a final answer when helper threads took part") and `codex-cli-adapter.app-server.spec.ts` ("keeps a plain turn open until Codex sends turn/completed, however long after the final answer"); both new expectations fail on the old code. Live, rebuilt app: four 8-turn goals (28 turn boundaries) had idle spans of 3 to 17 ms, each matching the native gap, none starting while a native turn was open, every `TURN-n` reply once, 7 of 7 provider-started turns followed per run, no error lines. The 1.8 s tail itself did not recur live, so the slow-tail case is proved by the unit test, not by a live repeat.

### Evidence

[Codex goal-following livetest](2026-10-27-codex-goal-following-remediation_livetest.md#check-1-idle-while-the-native-turn-was-open--lt-1084--2026-11-13-queue-worker-third-pass).

<a id="lt-1099-archived-detail"></a>

<a id="lt-1099"></a>

## LT-1099

### LT-1099 — explicit Harness deny rules never match on the legacy permission-denial path

**Status: fixed and rechecked live on 12 November 2026 (verifier round 1 of the permission remediation item).**

### Observed behaviour

In an isolated dev app, a non-YOLO Claude session whose adapter had no permission hook (the legacy `permission_denial`
class that LT-708 kept reachable) was asked to run `rtk proxy pwd`. A project rule in the disposable workspace
(`.orchestrator/permissions.json`, rule `bash_execute` literal `bash:rtk proxy pwd`, action deny) was loaded. The CLI
returned the genuine error `This command requires approval`, and the card still offered **Always allow (adds a rule to
~/.claude/settings.json and restarts)**. A second workspace used a rule in the scope the legacy branch actually uses
(`tool_use`, literal `bash:rtk proxy pwd`, deny) and showed the same card. On the normal hooked path the first rule
was honoured: the session logged `Permission auto-denied for Bash: Matched rule: LT fixture deny pwd`, showed no card
and the model was told Harness's rules refused the call. For a read of a file outside the folder, the legacy request's
resource was `<working folder>/from /tmp/.../protected/data.txt`, which no real path rule can match (the call was
refused anyway by the filesystem policy, not by the fixture rule).

### Root cause

`InstancePermissionRequestFlow.handleInputRequiredInternal` (`src/main/instance/instance-permission-request-flow.ts`,
the `permission_denial` branch) builds its resource from `meta['path']`. The adapter puts the shortened display label
there (`claude-cli-adapter.ts`, `path: displayPath`) and the real value in `full_path`. For Bash, and any input that is
not path-like, `describePermissionTarget` (`claude-cli-permission-details.ts`) returns `command (13 chars)`, so the gate
sees `bash:command (13 chars)`. Calling the live gate directly with the same fixture showed `bash:rtk proxy pwd` ->
deny (`Matched rule: LT fixture deny tool_use pwd`) and `bash:command (13 chars)` -> ask (`No matching rule`). For reads,
the CLI wording `permissions to read from <path>` makes `extractPermissionDetails` return `from <path>`, and
`normalizeRequestedPath` joins it onto the working folder.

### Required behaviour and acceptance

The branch evaluates the gate with the real tool input (`full_path`, and the original Bash command carried in the
tool-use context) and the scope the hooked path uses (`bash_execute` for Bash), and strips the leading `from ` from read
targets. Display labels stay shortened. An explicit deny short-circuits as the branch's own comment says it should, with
no override card. Acceptance: a new spec drives a `permission_denial` with a Bash command and a matching literal deny
rule and expects no `instance:input-required` event; a read-target case expects the exact path; a command without a rule
still reaches the card. On the rebuilt app the two fixtures above end with a system note and no card.

### As built

`instance-permission-request-flow.ts` (the `permission_denial` branch) now reads `meta.full_path` (falling back to `path`),
judges a Bash denial with `deferredPermissionResource('Bash', { command })` (scope `bash_execute`, resource `bash:<command>`, gate
tool input `{ command }`), and clears the pending entry when it auto-denies. `claude-cli-permission-details.ts` drops the `from `
wording from `permissions to read from <path>` so `full_path` is the exact path. New specs: the flow spec group "permission_denial
is judged by the real target" (three of four cases fail without the fix) and `extractPermissionDetails targets`. Rebuilt-app
recheck: hookless session in the workspace with the `bash_execute` deny rule ends with `Permission auto-denied for Bash: Matched rule:
LT fixture deny pwd`, no input event and no card; a read of the protected file is refused with the exact path in the reason
(filesystem policy answers first, so the file rule itself is covered by the unit spec); a hookless session with no rule still shows
the card and rejecting it leaves both settings files byte-identical.

<a id="lt-1100-archived-detail"></a>

## LT-1100

### LT-1100 — a read by exact title with the switch off says "not found" instead of naming the switch

**Status: FIXED AND VERIFIED LIVE 14 November 2026 (Claude half).** Reproduced 10 November 2026 on a base that did not yet contain the repair (then recorded as LT-1018; renumbered because main already used that number for a different defect).

### Observed behaviour

Rebuilt dev app, base `e429665064` (it predates the repair). With Cross-session messaging on, a Claude and a Codex session in the same folder both
found `read_session` through tool search and answered from a third session by its exact title (audit rows: one per
call, reason `same-folder`). After switching the setting off, both repeated the call by title and received exactly
`{"outcome":"not-found"}`; the audit rows are `not-found`, target empty. The check expects a refusal that names the switch.

### Root cause

`SessionTranscriptReader.readPage` (`src/main/session/session-transcript-reader.ts`) matches titles only among sessions
already readable (`this.scope(...)` is applied before the title comparison), so a title only the switch would open
matches nothing. The plan history records a fix ("Step 1 verifier round 1 repair", 10 November, commit `bd0db3b24`) that answers
`not-allowed` with the switch reason for that case. It was not in the base the live run used; it is in the current branch head, where
`session-transcript-reader.spec.ts` covers the exact-title case.

### Required behaviour and acceptance

An exact title that only the switch would open answers `not-allowed` with the switch reason (no ids, folders or counts;
foreign-folder and scratch titles stay `not-found`). Acceptance: rebuild from the current head and repeat the live check (switch on then off); the off
reply names the switch and the audit row says `not-allowed`.

### Recheck 14 November 2026

Dev app on the test Mac built from head `39e443963`. A Claude reader started with the switch on found `read_session` through the orchestrator tool search and read a sibling session by exact title (audit row `read`, reason `same-folder`). After the switch went off, the same reader's next call by title was refused with "Ask the user to point at this session with @session. Related or same-project sessions also require Cross-session messaging in Settings." (audit row `not-allowed`; one row per call throughout). A reader started while the switch was off was not given the tool at all. The Codex reader half did not run: Codex is not installed on the test Mac.

<a id="lt-1101-archived-detail"></a>

## LT-1101

### LT-1101 — "Working quietly" never appears on a real silent Claude turn

**Status: FIXED AND VERIFIED LIVE 14 November 2026.** Reproduced 10 November 2026 (then recorded as LT-1019; renumbered because main already used that number for a different defect). The fix is in the branch head from the 13 November change.

### Observed behaviour

A Claude session (Opus, effort max) given a hard question with no tools stayed busy for more than 150 s. The activity
line read "Working" until about 8 s, then "Agent active" until the turn ended or was stopped (172 s since the last event
when sampled); "Working quietly" and its hover were never shown.

### Root cause

`InstanceQueries.activityStateToLabel` returns "Agent active" whenever the process state is `active`, and
`selectedInstanceActivity` / `instanceActivities` use it as the `activity` text. `ActivityStatusComponent.displayText`
returns any non-empty `activity` before its ten-second "Working quietly" fallback, so the fallback only applies when
the process state is not `active`, which is never true during a real turn.

### Required behaviour and acceptance

After about ten seconds without a new event the line says "Working quietly" even when the process state is `active`
(the bland state label must not mask it). Acceptance: the live check shows the switch at about ten seconds on a silent
Claude turn, with the hover text.

### Recheck 14 November 2026

Dev app on the test Mac built from head `39e443963`. A silent Opus (effort max) turn with no tools read "Working" for the first ten seconds or so, then "Working quietly" with the running time beside it, and stayed there for more than seven minutes (never "Agent active"). Hovering the words showed "This provider shares its thinking only when a step finishes. Harness shows how long it has been working." After the turn was interrupted the row disappeared. One sample at 1 m 22 s read "Working" again for under ten seconds (an event arrived), then returned to "Working quietly".

<a id="lt-1102-archived-detail"></a>

## LT-1102

### LT-1102 — the Progress panel does not fill when Claude plans with its newer task tools

**Status: FIXED AND VERIFIED LIVE 14 November 2026.** Reproduced 10 November 2026 (then recorded as LT-1202; renumbered because main already used that number for a different defect) and again on 14 November at head `39e443963`.

### Observed behaviour

With the Claude task list setting on, a Claude chat asked to "plan three small steps, then do them" called `ToolSearch`,
three `TaskCreate` and six `TaskUpdate` tools and finished the work. The Progress panel stayed empty and no `TodoWrite`
call appears in the transcript.

### Root cause

`src/main/instance/todo-tool-parser.ts` recognises only `TodoWrite` (and `todo_write`, `todo.write`) and Codex's
`update_plan`. The installed Claude CLI uses `TaskCreate` and `TaskUpdate` for its task list, which nothing parses.

### Required behaviour and acceptance

`TaskCreate` and `TaskUpdate` calls fill the Progress panel (or the setting is documented as `TodoWrite`-only and the
check reworded). Acceptance: repeat the live check; the panel shows the three steps changing state.

### Fix and recheck 14 November 2026

Source: `extractTodoToolItems(message, readCurrent)` in `src/main/instance/todo-tool-parser.ts` builds the list from `TaskCreate` (adds a task from `subject`/`activeForm`) and `TaskUpdate` (changes the task whose number is `taskId`; `deleted` shows as cancelled); the caller in `instance-communication.ts` passes the session's current list. The CLI numbers tasks 1, 2, 3 in creation order (seen in the live transcript), so a task's number is its place in the list; this assumption is stated in the code comment. Specs: `todo-tool-parser.spec.ts` (3 new cases; 7 pass), with the 30 related spec files in `src/main/instance` and `src/main/tasks` passing (360 tests).

Live: reproduced first at head (a Sonnet chat with the setting on called `ToolSearch`, three `TaskCreate`, `TaskUpdate` calls; nothing in the panel). After rebuilding the dev app from the changed tree, the same prompt produced exactly three tasks, all completed, and the panel header read "Tasks 3 of 3 done". Not covered: tasks deleted mid-run, and a Claude session restarted without resume (the CLI restarts its numbering while Harness keeps the old list).

<a id="lt-1157-archived-detail"></a>

<a id="lt-1157"></a>

## LT-1157

### LT-1157 — Land anyway always refused a Codex parent ("provider can't report when a turn starts")

**Status: fixed and verified live 12 November 2026. The rebuilt dev app accepted a Codex parent's typed-message `land-anyway` (07:54) and refused the call made in the goal-started turn (07:57), see livetest check 3.**

### Observed behaviour

Dev app (isolated profile) with a Codex parent session that started a Plan Queue run. The item parked, a message was typed in the real message box ("Land that anyway…"), and the session called `plan_queue_control` with `land-anyway`. Twice (07:47 and 07:48) the call was refused: "This session's provider can't report when a turn starts, so Harness can't tell that you are answering James's message." The same sequence on a Claude parent was accepted. The item stayed parked.

### Root cause

`InstanceCommunicationManager.setupAdapterEvents` read `adapter.getAdapterCapabilities().reportsTurnStarts` once, when the adapter was attached, and stored the boolean in `InputTurnRegistry`. For Codex that capability is `this.useAppServer`, which is only set to true inside `spawn()`. Every attach path (`instance-lifecycle.ts` create and resume) calls `setupAdapterEvents` before `adapter.spawn()`, so a fresh Codex session was recorded as unable to report turn starts for good. The registry unit tests set the flag by hand and the adapter spec sets `useAppServer` directly, so neither saw the order.

### Required behaviour and acceptance

The registry asks the adapter at each check (`setReportsTurnStarts(instanceId, () => boolean)`), so a resident Codex session reports, an exec-mode fallback or terminated one is refused. Acceptance: `instance-communication-turn-start-capability.spec.ts` (fails with the old eager read, mutation-checked), `input-turn-registry.spec.ts` case "asks the adapter at check time"; on the rebuilt app (done 12 November 2026), a Codex parent's typed-message `land-anyway` is accepted ([livetest check 3](2026-11-04-pq-b1-land-anyway_plan_livetest.md)).

<a id="lt-1168-archived-detail"></a>

<a id="lt-1168"></a>

## LT-1168

### LT-1168 — Escape on a focused Settings icon also leaves Settings

### Observed behaviour

Dev app on this Mac, 10 November 2026, Settings menu squeezed to icons. Tab to the "General" icon: its hint opens.
Press Escape: the hint closes and the browser URL goes from `/settings` to `/`, so the whole Settings page closes
too. Reproduced with a real key press over the debugging connection (`esc-probe.mjs` in the run's scratch folder):
focused General, tooltip `["General"]`, URL `/settings`; after Escape, tooltip `[]`, URL `/`.

### Root cause

`aio-tooltip.directive.ts` binds `(keydown.escape)': 'hide()'` with no `stopPropagation`. The key then bubbles to
`SettingsComponent.onKeydown` (`settings.component.ts`), whose own comment says Escape closes "the deepest open
overlay first ... never more than one thing at a time", and which calls `goBack()` when no drawer is open. It does not
know a hint is open.

### Required behaviour and acceptance

Escape pressed while a hint is open closes only the hint; a second Escape then leaves Settings. Acceptance: with a
Settings icon focused and its hint open, one Escape leaves the URL on `/settings`; a second Escape returns to `/`. Add a
directive spec that the key event is stopped only when a hint was actually open (Escape with no hint must still reach
other handlers).

### Fix (11 November 2026)

Fix: `AioTooltipDirective.onEscape` stops the key only while a hint is open (spec: Escape reaches other handlers only when no hint is open). `plan-handoff-dialog.component.spec.ts` now expects the first Escape to close the open hint and the second to close the picker.


### Live recheck

Verified live 16 November 2026 (rebuilt dev app, real key events): with a collapsed Settings icon focused and its hint open, one Escape closed only the hint and the URL stayed `/settings`; a second Escape returned to `/`. Checked on General, Display & input, Agents and Second opinion.

<a id="lt-1169-archived-detail"></a>

<a id="lt-1169"></a>

## LT-1169

### LT-1169 — a waiting session's reason detail is hover-only in the header

### Observed behaviour

Dev app, 10 November 2026, seeded session with `waitReason: {kind:'backoff', attempt:2, retryAt: now+300 s}`. The header
reads "Charlie waiting rename Backing off — retry in 203s" and nothing else. "Attempt 2, retry at …" appears only in the
hint on the label. The migration plan says "the wait reason is now visible text ('Backing off — retry in 5s — Attempt
2, retry at …')" and the live check 1f.2 requires the detail to be visible without hovering.

### Root cause

`instance-header.component.html` renders `<span class="wait-reason-label" tabindex="0"
[appTooltip]="waitReasonDetail()">{{ waitReasonLabel() }}</span>`; no element prints `waitReasonDetail()`. The
as-built claim was not what landed in `6824ebec1`: `instance-header.component.spec.ts` ("explains the waiting state on a
focusable hover…") asserts `textContent` does **not** contain "Attempt 2".

### Required behaviour and acceptance

Print the detail beside the label whenever the session is waiting, keeping the hint only for anything longer. Acceptance:
the header text of a backoff-waiting session contains the attempt and retry time without hovering; update the spec so it
asserts the visible text rather than its absence.

### Fix (11 November 2026)

Fix: the header prints the detail beside the label (`.wait-reason-detail`); the specs assert the visible text. The old hover wording "allowance resets at" was retired in the wording ledger (a quota wait has no header label; its banner carries the time).


### Live recheck

Verified live 16 November 2026 (rebuilt dev app): a session backing off showed "Backing off — retry in 300s — Attempt 2, retry at 01:48:16" in the header with no hover. The live check also showed the first fix printed "300s— Attempt" with no space before the dash (Angular dropped the whitespace-only text between the label and the detail span); fixed the same day with `&ngsp;` and the header spec now pins "Waiting for interrupt… — Attempt 2".

<a id="lt-1170-archived-detail"></a>

<a id="lt-1170"></a>

## LT-1170

### LT-1170 — the "Sending N" title-bar chip is not keyboard reachable

### Observed behaviour

Dev app, 10 November 2026, resume toast seeded in the app shell. Hover shows "Queued paused traffic is resuming" after
about 225 ms. The chip's `tabIndex` is -1 and a real Tab walk through the title bar never lands on it. Live check 1c.2
requires it to be reachable by Tab.

### Root cause

`app.component.html` renders it as `<span class="title-activity-chip" [appTooltip]="copy('shell.resumeTraffic')">`
with no `tabindex="0"`; the directive does not add a tab stop to non-interactive hosts.

### Required behaviour and acceptance

Give the chip `tabindex="0"` (it only lives a few seconds, so it also needs the hint to stay up while focused).
Acceptance: Tab reaches the chip while it is shown and the hint opens on focus.

### Fix (11 November 2026)

Fix: the chip has `tabindex="0"`; its hover-only exemption was removed from `scripts/ui-hints/hover-only-reasons.ts`; `app.component.spec.ts` asserts the tab stop.


### Live recheck

Verified live 16 November 2026 (rebuilt dev app, real Tab): from the Notifications button one Tab lands on the "Sending 3" chip, its hint "Queued paused traffic is resuming" opens on focus and Escape closes it; hover shows the same hint after about 226 ms.

<a id="lt-1171-archived-detail"></a>

<a id="lt-1171"></a>

## LT-1171

### LT-1171 — the automation clock chip on a history row is not keyboard reachable

### Observed behaviour

Dev app, 10 November 2026, seeded history entry with `isAutomation: true`. Hover over the 12 px clock opens "Started by
a scheduled automation". `tabIndex` is -1 and Tab skips it (Tab order on the row: title, Archive, Pin, next row). The
plan's round-2 fix and live check 1e.5 say the chip is keyboard reachable.

### Root cause

`instance-list.component.html` renders `<span class="history-entry-automation-clock" role="img" appTooltip="Started by a
scheduled automation" aria-label="Automation session">` with no `tabindex`.

### Required behaviour and acceptance

Add `tabindex="0"` (the neighbouring change-summary chip already has it). Acceptance: Tab on an automation history row
lands on the clock and shows the hint.

### Fix (11 November 2026)

Fix: the clock chip has `tabindex="0"`; `instance-list-tooltips.component.spec.ts` asserts it.


### Live recheck

Verified live 16 November 2026 (rebuilt dev app, real Tab): from an automation history row's title one more Tab lands on the clock chip, "Started by a scheduled automation" opens on focus and Escape closes it; hover shows it after about 225 ms.

<a id="lt-1172-archived-detail"></a>

## LT-1172

### LT-1172 — a compaction stored the "LLM unavailable" placeholder as its summary

**Status: fixed 16 November 2026; live re-check passed.**

- **Observed.** Dev app, isolated profile with no helper model and no API-key provider. An Antigravity session with about 80K characters of earlier messages, then `compactInstance`: the continuity package's `<summary>` read `[LLM unavailable - unable to process query. Please configure an LLM provider (Anthropic, OpenAI, or Ollama) for intelligent responses.]`, the compaction finished 3 ms after it started and the log said `summaryGenerated: true`.
- **Root cause.** `ContextCompactor.generateSummary` (`context-compactor.ts`) asks `LLMService.isAvailable()`, which is true when the configured provider is `local`. The auxiliary compression slot then answers `source: 'fallback'` with frontier fallback allowed, and `LLMService.generate()` (no API key, no Ollama) returns `LLM_UNAVAILABLE_TEXT` through `generateLocalFallback`, because the compaction prompt does not contain the word "summarize". That text became the summary, so the new session started with no real summary and nothing said so. The plan (Step 10) required "decide on `summaryGenerated`, never the placeholder".
- **Required behaviour.** A summary is a model's text or the deterministic basic summary, never the placeholder.
- **Fix.** In `generateSummary`, a frontier reply that is empty or equal to `LLM_UNAVAILABLE_TEXT` uses `generateBasicSummary` (recorded as `aio-basic-summary`, free). Specs: `context-compactor-isolated.spec.ts` (sentinel falls back; a real frontier reply is kept).
- **Acceptance.** Re-run live after the fix: the summary is the local one ("(local compaction — no LLM verification available; 4 turns compacted)"). With a helper model enrolled the summary is the helper's text. Both observed on 16 November 2026.

<a id="lt-1173-archived-detail"></a>

## LT-1173

### LT-1173 — the cost-entry event schema rejected its own `origin` field

**Status: fixed 16 November 2026; live re-check passed.**

- **Observed.** Dev app, isolated profile, a few hours of real Claude, Codex and Antigravity turns: 100 log lines `Blocked invalid renderer event payload … channel: 'cost:usage-recorded' … issues: [ { path: '', message: 'Unrecognized key: "origin"' } ]`, one per priced entry. The renderer never received those events (the Costs page and header still got figures from polling, so the damage was a stale live feed, not wrong totals).
- **Root cause.** `CostTracker` stores `origin` with each entry and `cost-handlers.ts:363` sends the whole `CostEntry` to the renderer, but `CostEntryEventSchema` (`packages/contracts/src/schemas/cost-events.schemas.ts`) is `.strict()` and had no `origin`. LT-822 fixed the same class for `byModel`.
- **Required behaviour.** An entry the tracker publishes passes the event validator.
- **Fix.** `origin: z.string().min(1).max(200).optional()` in the schema; `renderer-event-validation.spec.ts` covers a payload with `origin`.
- **Acceptance.** After rebuilding and restarting, a priced Claude turn logs zero blocked `cost:usage-recorded` events. Observed 16 November 2026 (100 before, 0 after).

<a id="lt-1188-archived-detail"></a>

<a id="lt-1188"></a>

## LT-1188

### LT-1188 — a queued job held back by the folder limit gives no reason

**Status: fixed on main by capability repair `capability-d7663a38…` (the pump now writes the note); verified live on 21 November 2026 on a test Mac copy of the MiMo-spend worktree merged with main (limit 2, three runs: two worked, the third showed "Waiting for a free work folder (2 in use)" with no folder for the 2 minutes until a run was removed, then started with its own folder and the note cleared; no park). Originally reproduced 18 November 2026; wording only, no wrong behaviour.**

### Observed behaviour

Live-test copy of this worktree on the test Mac (`dev-app.js start`, OpenCode, Codex, Cursor and Claude detected), `maxConcurrentWorktrees` set to 2, three
disposable queue runs of one document each (`planQueueLiveTestFixtureStart`, Claude haiku workers, Codex checker):

- 16:22:11Z all three started. Two went `working` with a work folder; the third stayed `state: queued`, `detail: ''`, no folder, `parkReason: null`, for
  the 98 s until the cancel below (three reads 20 s apart, all the same). Nothing parked for capacity and no `capacity-wait` event was written.
- 16:23:49Z the first run was cancelled and its job discarded (folder freed). The third job started working by itself; its first round activity was logged at 16:24:32Z.

### Root cause

`plan-queue-pump.ts:154` skips a queued item with `folderFree()` false and only calls `store.waits.blocked(item.id)`; no detail or stage is written. The note
`Waiting for a free work folder (N in use)` is written only by `defer` in `plan-queue-error-class.ts:42` (after a `WorktreeCapacityError` at prepare, which queue
folders never raise because `plan-queue-worktree.ts:164` passes `countsTowardLimit: false`) and, for held jobs, by the `no-free-folder` check-wait stage.

### Required behaviour and acceptance

A queued job that the folder limit is holding back shows that reason ("Waiting for a free work folder (N in use)") on its row, and the note clears when it starts.
Acceptance: repeat the reproduction above and read the queued job's `detail` or `stage`; a pump unit test asserts the note is set for a job blocked by `folderFree()`.

<a id="lt-1195-archived-detail"></a>

## LT-1195

### LT-1195 — "Always allow" writes a Claude rule that Claude never matches

**Status: fixed and live verified 10 November 2026.** `buildRulePattern` (`self-permission-granter.ts`) now returns `Edit(//abs)` for Write and Edit and `Read(//abs)` for Read, in `//` absolute form; `self-permission-granter.spec.ts` pins the strings. Live (rebuilt dev app): "Always allow" wrote `Edit(//.../denial-A.txt)`, the session restarted (new pid, resumed), and the retried Write created the file. Read(//abs) was also confirmed with a native probe. Global settings were restored byte for byte afterwards.

### Observed behaviour

A non-YOLO Claude session (CLI 2.1.310) was asked to write a file outside its working directory. Claude denied it natively and Harness showed the card with "Don't allow" and "Always allow (adds a rule to ~/.claude/settings.json and restarts)". Clicking "Always allow" wrote `Write(/Users/.../outside-dir/denial-3.txt)` into `~/.claude/settings.json` (and a matching Harness rule in `~/.orchestrator/permissions.json`), restarted the session (new process, restartCount 1), and the retried write was denied again with the same message. Both global files were restored byte for byte afterwards (SHA-1 equal to the pre-test copies).

### Root cause

Proved with native one-shot probes (`claude --print --settings '<inline rules>'`, same directory, no Harness): `Edit(//abs/path)` allows the write; `Edit(/abs/path)`, `Write(/abs/path)` and `Write(//abs/path)` all still deny. In Claude's rule syntax a single leading `/` means project-relative and `//` means absolute, and the allow rule belongs to the `Edit` family. `buildRulePattern` in `src/main/security/self-permission-granter.ts` returns `` `${tool}(${trimmed})` `` for the tool name and the raw absolute path.

### Required behaviour and acceptance

For Write/Edit (and Read, checked separately) denials the rule must be one the CLI matches (`Edit(//abs/path)` for writes). Acceptance: after "Always allow" and the restart, the same write succeeds in a live session; a regression test pins the exact string; the unrelated-key and idempotence behaviour of the granter is unchanged.

<a id="lt-1196-archived-detail"></a>

## LT-1196

### LT-1196 — a refused Claude denial can never be asked again in that session

**Status: fixed and live verified 10 November 2026.** The card now replies with `permissionMetadata.permissionKey` (`permissionKeyOf` in `user-action-request.rules.ts`, specs added). Live: refuse, retry the same path, a new card appears; settings files unchanged after "Don't allow".

### Observed behaviour

After "Don't allow" on the denial card for `.claude/lt-note.md`, asking Claude to try the same path again produced no new card and no new "Permission required" line (the assistant just reported the block). A different path (`lt-note-2.md`) in the same session produced a new card at once. Settings files were unchanged.

### Root cause (strongly supported, not proved by a debug trace)

`user-action-request.component.ts:879` builds the key sent back as `` `${meta.action}:${meta.path}` ``; the adapter registers `createPermissionKey(action, path)` = `action:<sha256 prefix>` (`claude-cli-permission-details.ts:131`) in `pendingPermissions`. The app log of the reply carries the path-shaped key. `sendRaw` therefore never clears the pending entry, and the duplicate guard at `claude-cli-adapter.ts:1533` skips the next denial silently (debug-level log only). The metadata already carries the right `permissionKey`.

### Required behaviour and acceptance

The reply must use the adapter's own key (`permissionMetadata.permissionKey`). Acceptance: refuse a denial, retry the same path in the same session, and a new card appears; a spec pins renderer key == adapter key.

<a id="lt-1197-archived-detail"></a>

## LT-1197

### LT-1197 — Chrome's HTTP sign-in prompt cannot be answered on a computer with a protected site

**Status: reproduced live 21 November 2026 on `windows-pc`; fixed in 098888229; live checks passed on `windows-pc` the same day.**

### Observed behaviour

21 November 2026, 01:34-02:10, and again at 11:17: `browser.find_or_open` of
`https://dev.myshellartstudio.com/wp-login.php` on `windows-pc` returned
`inspection_unavailable`, `url: https://redacted.invalid/` and no `httpAuthChallenge`.
`browser.request_credential_access` and `browser.fill_http_auth` were refused with
`target_unavailable` (or `invalid_url` without `url`). The Harness log has four
`Saved-login tab check failed` lines, each `snapshot_allowed_failed` /
`browser_secret_inspection_unavailable`. The same login worked on `ct-test-mac`.

### Root cause

`windows-pc` has `login.lcn.com` tabs under secret protection, so the extension checks every tab
for frames of a protected site. While Chrome's prompt waits, Chrome has committed a blank error
page at the challenged URL that no script can run in (measured on Chrome for Testing 158), so the
check fails and every page read on the tab, including the snapshot Harness used to learn the
tab's origin, is refused. Chrome also marks that error page loaded about 20 ms after the
challenge, and the extension deleted its challenge record on every completed load, so the prompt
was never reported on any computer (the open question in the 2026-10-17 HTTP auth live test).

### Required behaviour and acceptance

- A waiting prompt is reported while Chrome shows it, confirmed against the tab's live frames,
  and forgotten once a new top-level navigation starts or the tab closes.
- Saved-login requests and `fill_http_auth` resolve the origin of a waiting prompt from Chrome's
  request record when the page cannot be read; page reads stay refused exactly as before; a tab
  under protection and a prompt for another site are still refused.
- Live: the checks in the linked live-test document pass on `windows-pc`.
- Fix record: [2026-11-21-http-auth-prompt-on-protected-computer_plan_completed.md](2026-11-21-http-auth-prompt-on-protected-computer_plan_completed.md).

<a id="lt-1203-archived-detail"></a>

## LT-1203

### LT-1203 — the short loop card is skipped when the loop config names a model

**Status: fixed and live verified 10 November 2026.** `loopRoundModel` (`loop-execution-authority.ts`) is now used both by the invoker and by the re-anchor check; `loop-iteration-prompt.spec.ts` covers both. Live: config model `haiku` gives prompt bytes 7007 / 2546 / 2546 / 2546 / 2546 (before: 6519 every round).

### Observed behaviour

Counting loops of five to six rounds in a disposable repo, `prompt_bytes` per round: config model `haiku`: 6519 / 6630 / 6519 / 6519 / 6519; model `claude-haiku-5-5`: 7374 / 6630 / 6519 / 6519 / 6519; no model (ran as sonnet): 7925 / 2546 / 2546 / 2733 / 2546 / 2546. Cache-read tokens grew every round in all three, so the thread was continued each time.

### Root cause

`loop-iteration-prompt.ts:143` resolves `thisAttemptModel` with only `payloadModel: input.downshiftModel`, so the loop routing tier (`sonnet`) is used; the round runs `downshiftModel ?? config.model ?? executionAuthority.model` (`loop-child-invoker.ts:208`). The recorded model differs, so `shouldReanchorLoopGoal` fails closed every round. The loop settings panel does not set `model`, so this affects automations, `/goal` or programmatic starts that set one.

### Required behaviour and acceptance

Resolve the model the round will actually run with. Acceptance: the same loop with an explicit model shrinks to the card from round 2.
