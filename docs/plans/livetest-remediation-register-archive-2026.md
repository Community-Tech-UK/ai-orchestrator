Agents do not read this archive unless a register index row points here.

# Live-Test Remediation Register Archive 2026

**Type: standing archive — historical detail, no plan/spec lifecycle.**

Current defect status belongs to the [register index](livetest-remediation-register.md#remediation-index).
Detail blocks below were moved verbatim. Heading-only links preserve cross-references to active entries.

<a id="live-test-remediation-register"></a>

[Read the detail](livetest-remediation-register.md).

## Operating Rules

[Read the detail](livetest-remediation-register.md).

## Remediation Index

[Read the detail](livetest-remediation-register.md).

### Current status corrections — 2026-10-14

[Read the detail](livetest-remediation-register.md).

### Current status corrections — 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Current status corrections — 2026-08-31

[Read the detail](livetest-remediation-register.md).

## LT-001: Existing-Tab Browser Grant Scope Mismatch

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Investigation boundary

[Read the detail](livetest-remediation-register.md).

### Required regression coverage

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-002: Embedded Document-Review Runtime Is Blocked by CSP

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Investigation boundary

[Read the detail](livetest-remediation-register.md).

### Required regression coverage

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-003: Document-Review Draft State Does Not Meet Reload/Reselection Contract

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Investigation boundary

[Read the detail](livetest-remediation-register.md).

### Required regression coverage

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-004: Runtime Exit Classification Bypasses Recovery

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Investigation boundary

[Read the detail](livetest-remediation-register.md).

### Required regression coverage

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-005: Local-Personal Retrieval Benchmark Is a Stub

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Investigation boundary

[Read the detail](livetest-remediation-register.md).

### Required regression coverage

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-006: Migrate Live Provider Coverage from Gemini to Antigravity

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Investigation boundary

[Read the detail](livetest-remediation-register.md).

### Required regression coverage

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-007: Retire Obsolete Automation Blockers

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## Retest-Only Items: No Confirmed Fix Yet

[Read the detail](livetest-remediation-register.md).

## Implementation and Retest Order

[Read the detail](livetest-remediation-register.md).

## LT-008: Fork-Resume Passes a Never-Minted Session Id as the Resume Source

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-009: Skill Registry Is Empty, So Skill Observability Records Nothing

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause (partially established)

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

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

## LT-011: Live-Test Checks That Assert on Signals the App Never Emits

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

## LT-012: `npm run build:main` Has Been Broken Since the TypeScript 6 Upgrade

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-013: A Deliberate Terminate Archives a Session Id That Never Existed

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

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

## LT-015: Runtime-Change System Notices Are Model-Only, Never Rendered

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Knock-on

[Read the detail](livetest-remediation-register.md).

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

## LT-018: Copilot instances report 0 % context for the entire session

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Why this is a defect and not a declared gap

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Required regression coverage

[Read the detail](livetest-remediation-register.md).

### Priority rationale

[Read the detail](livetest-remediation-register.md).

### Reopened 2026-07-31 — the 2026-07-30 fix cannot work, and the visible defect is unchanged

[Read the detail](livetest-remediation-register.md).

### Implemented 2026-08-01 — change 1 done, without the wide blast radius

[Read the detail](livetest-remediation-register.md).

#### Completion-gate round 2 — the first implementation was WRONG, and the gate caught it

[Read the detail](livetest-remediation-register.md).

#### Completion-gate round 3 — round 2 returned PASS, and found the fix was still cosmetically incomplete

[Read the detail](livetest-remediation-register.md).

#### Completion-gate round 4 — the defect existed in two more places nobody had looked at

[Read the detail](livetest-remediation-register.md).

#### Completion-gate rounds 5 and 6 — two more surfaces, and one reviewer finding declined

[Read the detail](livetest-remediation-register.md).

#### Completion-gate rounds 7–10 — the defect had a second transport, and the fix broke a feature

[Read the detail](livetest-remediation-register.md).

#### Completion gate — round 11 **PASS**, after eleven rounds and ten defects

[Read the detail](livetest-remediation-register.md).

##### What eleven rounds actually bought

[Read the detail](livetest-remediation-register.md).

## LT-019: Reasoning Models Exhaust the Local AI Exact-Token Canary Budget

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Required regression coverage

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

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


## LT-022: The renderer heartbeat reports a UI freeze that is not happening

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Priority rationale

[Read the detail](livetest-remediation-register.md).

### Fix — 2026-09-23

[Read the detail](livetest-remediation-register.md).

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

## LT-028: Codex is unusable under hardened mode

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Note

[Read the detail](livetest-remediation-register.md).

### Follow-ups found while gating LT-026/LT-027 (2026-07-31)

[Read the detail](livetest-remediation-register.md).

### Fix — 2026-09-23

[Read the detail](livetest-remediation-register.md).

## LT-029: hardened Keychain refresh limitation

[Read the detail](livetest-remediation-register.md).

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


## 2026-07-26 observations — triage needed, not yet classified as defects

[Read the detail](livetest-remediation-register.md).

## Completion Criteria

[Read the detail](livetest-remediation-register.md).

## LT-031: A long automation description silently never reaches the UI

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour and fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Correction, and the sibling defect it hid

[Read the detail](livetest-remediation-register.md).

### The class is now closed, not just the two instances

[Read the detail](livetest-remediation-register.md).

### The generalisable lesson

[Read the detail](livetest-remediation-register.md).

## LT-032: A hidden window permanently freezes transcript scroll tracking

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Why it matters beyond the test harness

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-033: The stuck-frame-guard shape in three more components

[Read the detail](livetest-remediation-register.md).

### The shape

[Read the detail](livetest-remediation-register.md).

### The three instances

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Why this was worth chasing beyond LT-032

[Read the detail](livetest-remediation-register.md).

### One related hazard deliberately left alone

[Read the detail](livetest-remediation-register.md).

### Ruled out in the same sweep

[Read the detail](livetest-remediation-register.md).

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

## LT-055: RLM's general context stores never populate the vector store, so `semantic_search` silently degrades to keyword

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour (decision needed, not implemented)

[Read the detail](livetest-remediation-register.md).

### Why this is not implemented in this session

[Read the detail](livetest-remediation-register.md).

### Completion gate round 1 — **FAIL**, and it was right: the fix covered 2 surfaces of 7

[Read the detail](livetest-remediation-register.md).

### Remediation

[Read the detail](livetest-remediation-register.md).

## LT-050: A Codex app-server parent's `spawn_child` reliably destroys itself

[Read the detail](livetest-remediation-register.md).

### Fix — 2026-08-12 — FIXED at the classification layer, verified live

[Read the detail](livetest-remediation-register.md).

## LT-061: Tool-loop detector under-detects realistic Bash-tool doom loops (incidental metadata pollutes argsHash)

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Scope note (why this was not fixed in the original session)

[Read the detail](livetest-remediation-register.md).

### Decision and fix (2026-08-12)

[Read the detail](livetest-remediation-register.md).

### Live verification and scope-narrowing discovery (2026-08-12)

[Read the detail](livetest-remediation-register.md).

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

## LT-105: an errored resident Claude turn still skips completion

[Read the detail](livetest-remediation-register.md).

### Why it is filed rather than fixed

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Fix — 2026-09-23

[Read the detail](livetest-remediation-register.md).

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

## LT-130: RendererHeartbeat misreports every lock-screen period as a UI freeze

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Mechanism

[Read the detail](livetest-remediation-register.md).

### Candidates excluded (with the test that excluded each)

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Verification

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Attempted live verification — 2026-08-19 (orchestrator): still NOT verified, and the obvious evidence is a trap

[Read the detail](livetest-remediation-register.md).

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

## LT-147: the context-evidence provider kill switch does not stop capture for instances already running

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Impact

[Read the detail](livetest-remediation-register.md).

### Required fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

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

## LT-168: Auth-repair auto-resume can never revive a still-live errored instance — `target_missing` forever

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Impact

[Read the detail](livetest-remediation-register.md).

### Implemented fix — 2026-08-31

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

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

## LT-192: calendar mutation approval requested before checking the target account can possibly succeed

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Fix — 2026-08-18

[Read the detail](livetest-remediation-register.md).

### Completion-gate finding — 2026-08-18 (fixed)

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-188: manual "Compact Now" races its own auto-compact trigger, producing duplicate compactions and duplicate fallback proposals

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

## LT-189: `notify-and-allow` fallback policy has no notification/banner delivery anywhere

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

## LT-190: Local AI Guard fallback cost estimation silently returns nothing for any real `defaultCli` value

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Fix — 2026-08-18

[Read the detail](livetest-remediation-register.md).

### Completion-gate finding — 2026-08-18: the fix's own widening was itself unsafe

[Read the detail](livetest-remediation-register.md).

## LT-193: Unpriced fallback dispatches display as `$0` rather than unknown

[Read the detail](livetest-remediation-register.md).

## LT-200: instance-detail Review panel's `reviewStartSession` call always fails Zod validation

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Regression test, watched failing on revert

[Read the detail](livetest-remediation-register.md).

### Gates

[Read the detail](livetest-remediation-register.md).

### Provenance

[Read the detail](livetest-remediation-register.md).

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

## LT-194: Workboard Decision Timeline's compaction source could never produce an entry

[Read the detail](livetest-remediation-register.md).

## LT-195: automation retry/backoff silently cancelled by an async `automation:changed` race, for every one-time automation

[Read the detail](livetest-remediation-register.md).

## LT-196: "Scan for corrections" learning-scan is structurally non-functional for Claude sessions

[Read the detail](livetest-remediation-register.md).

## LT-206: RLM and Wake renderer events are dead for the worker-routed paths

[Read the detail](livetest-remediation-register.md).

## LT-207: the codebase-indexing lane's own RLMContextManager singleton never reaches main

[Read the detail](livetest-remediation-register.md).

## LT-215: fresh-fallback degradation notice never lists a child that died during the exact restart window, and the "Reconciled..." log line never fires

[Read the detail](livetest-remediation-register.md).

<a id="lt-220-archived-detail"></a>

## LT-220: Antigravity adapter never surfaces tool events — DECIDED + DOC-CORRECTED

**Current status (2026-08-31): DECIDED + DOCUMENTATION CORRECTED.** Antigravity's missing
tool-result visibility is an accepted capability gap. The false adapter comment and owning-check
premise are corrected; no adapter rewrite is planned unless the capability becomes load-bearing.

**Original status (2026-08-19): found, root-caused, not fixed — a scope decision.**

### Observed behaviour

Batch N1 (2026-08-19), driving `docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md`
check 4's residual re-verification live: `contextEvidenceModeByProvider.antigravity` set to `shadow`
via `setSetting`; a fresh `antigravity` instance (`ishhajrvx`) created scoped to a disposable
two-file `/tmp` workspace; sent a prompt requiring two real tool calls (list directory, read a file).
The turn completed normally — the model correctly listed both files and quoted `notes.txt`'s exact
contents, and the LT-146 workspace-scoping fix held (it read the correct `/tmp` workspace, not the
`~/.gemini/antigravity-cli/scratch` default LT-146 fixed). `instance.contextEvidence` showed
`{mode: "shadow", captureFailureCount: 0}` — no error. But `contextEvidenceList({conversationId,
owner: {kind: 'instance', instanceId}})` returned `[]`. Zero evidence records for a turn that made
two real, confirmed tool calls.

### Root cause

Traced to source, not guessed. Evidence capture for tool output has exactly two entry points:
`InstanceToolResultProcessor.captureParsedEvidence()` (`instance-tool-result-processor.ts:63-67`),
invoked from `instance-communication.ts:1208` on every `OutputMessage` of `type: 'tool_result'`, and
`.captureRawEvidence()` (`instance-tool-result-processor.ts:69-73`), invoked from
`bindRawAdapterProviderEvents`'s `captureToolResult` callback (`instance-communication.ts:1479-1482`)
on raw adapter-emitted `CliToolCall` events. `antigravity-cli-adapter.ts` never does either: its
`sendMessage()`/`sendMessageStream()` only call `this.emit('output', …)` with `type: 'assistant'`
(streaming text chunks, `antigravity-cli-adapter.ts:180-186`) or `type: 'error'`
(`:195-201`, `:398-406`), and its `parseOutput()` (`:255-268`) extracts only thinking-blocks and usage
from the raw text — no tool-call/tool-result structure at all. Nothing in the adapter ever emits
`type: 'tool_result'` or calls the raw `captureToolResult` hook, so neither capture entry point is
ever reached, for any instance, in any mode.

This is not a threshold or ownership-resolution gap (the kind that would show up as
`captureFailureCount > 0` or a `recordMigrationError` call) — it is a complete absence of
instrumentation. The adapter's own header comment states the reason it was built this way:
*"agy reports PLAIN TEXT on stdout (it has no `--output-format stream-json` mode)"*
(`antigravity-cli-adapter.ts:6-8`). That premise is **false**, confirmed live this session:
`agy --help` (the actually-installed binary) lists `--output-format` with values `text, json,
stream-json` and `--input-format stream-json` for NDJSON turn-by-turn input. The flag exists; the
adapter has simply never used it, and `buildArgs()` never passes `--output-format` at all.

### The doc's own check-4 premise is also wrong, not just its expected outcome

Check 4's text argues Antigravity "exercises the identical stateless-provider code path" as Gemini,
because both fall back to the same `sameThreadContinuation: false` conservative default. That is true
of the **capability declaration** (`getContextCapabilities()`), but false of the **instrumentation**
that actually decides whether anything gets captured: `gemini-cli-adapter.ts` *does* emit real
`type: 'tool_result'` `OutputMessage`s (`gemini-cli-adapter.ts:294-312`), so a Gemini shadow-mode
turn with real tool calls would produce real evidence records the same way Claude/Codex/Copilot/
Cursor/Grok do (all confirmed with real records by this doc's 2026-08-18 evidence run). Antigravity
would not, regardless of mode, because it has no equivalent code at all. The two providers share a
capability *label*, not a code path — the doc's "exercises the identical...path" framing does not
hold and should be corrected once the scope decision below is made, one way or the other.

### Required behaviour — not decided here

Two legitimate directions, deliberately not chosen unilaterally:

1. **Fix the instrumentation.** Switch the adapter to `agy --print --output-format stream-json`,
   parse the NDJSON tool-call/tool-result events the way `gemini-cli-adapter.ts` already does, and
   emit them as `type: 'tool_result'` `OutputMessage`s so the existing capture pipeline picks them up
   with no further changes needed downstream. Real scope: a genuine adapter rewrite of the
   stdout-parsing path (`sendMessage`/`sendMessageStream`/`parseOutput`), with its own risk (partial
   NDJSON line buffering, verifying `stream-json`'s tool-event shape actually matches what
   `parseOutput()`'s current callers — usage/thinking extraction — still need), not a small patch.
2. **Accept the gap as intentional** and correct the doc instead: Antigravity's `toolResultVisibility`
   is already `'none'` under the conservative default it inherits from `base-cli-adapter.ts`
   (`getContextCapabilities()` returns `CONSERVATIVE_PROVIDER_CONTEXT_CAPABILITIES` unmodified — no
   Antigravity-specific override exists), so zero capture is arguably the capability table's own
   honest answer; the stale comment and check 4's "identical code path" wording would need fixing
   either way, but the code would not change.

### Provenance

Found by Batch N1 (2026-08-19), closing out the "Antigravity residual" left by the
provider-agnostic-context-evidence doc's 2026-08-18 (batch C) evidence run, which found and fixed the
unrelated LT-146 workspace-scoping defect but explicitly did not re-drive check 4's own evidence-
capture claim end-to-end afterward.

## LT-216: find_or_open cannot attach to an existing tab on a relay-backed remote node, and silently opens a duplicate instead

[Read the detail](livetest-remediation-register.md).

### Live verification — 2026-08-20: CONFIRMED FIXED on the rebuilt app

[Read the detail](livetest-remediation-register.md).

## LT-217: browser_audit_entries is 99.7% internal bookkeeping and grows without bound — ONGOING GROWTH FIXED

[Read the detail](livetest-remediation-register.md).

## LT-218: browser.snapshot reports success with empty text when the extension cannot read the page at all — FIXED

[Read the detail](livetest-remediation-register.md).

## LT-221: opening a context-evidence record's card always failed with EVIDENCE_AUDIT_FAILED — a stale SQL CHECK constraint, fixed with a schema migration

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Not fixed, out of scope this session

[Read the detail](livetest-remediation-register.md).

## LT-222: the app-wide log redactor turns a legitimate `null` under any token-shaped key into the literal string "<redacted-secret>"

[Read the detail](livetest-remediation-register.md).

## LT-223: the context-pressure analyzer's own itemClass allowlist drifted from LT-148's fix and rejects every real `user-message` record as malformed

[Read the detail](livetest-remediation-register.md).

## LT-280: the context-evidence panel is fully built to label degraded (corrupt/failed/deleted/staging) records, but `list()` structurally never lets any reach it

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

## LT-290: fable-ws16 check 5's `lessons` recall-trace surface had zero production `record()` callers — structurally could never hold a trace

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Note on the check's `rlm` third

[Read the detail](livetest-remediation-register.md).

## LT-291: fable-ws16 check 6's reinforcement-on-use could never fire on a genuinely successful loop — the convergence note is never populated on that path, contrary to its own "always-present" doc comment

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

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

## LT-371: short worker-socket losses churn the entire remote-browser channel and can strand a command before handoff

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-370: the quality-tier auto-pick chooses the largest advertised model, which the host cannot load

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Impact — narrower than the original entry claimed

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### As built (2026-08-24)

[Read the detail](livetest-remediation-register.md).

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

## LT-481: the Workboard's Snooze control cannot durably hide a Needs You card — deliberate design, not a wiring bug, but it contradicts this doc's own check scenario

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Why this was never caught

[Read the detail](livetest-remediation-register.md).

### Not filed as a simple fix — two candidate directions, a product call

[Read the detail](livetest-remediation-register.md).

### Required behaviour (once decided)

[Read the detail](livetest-remediation-register.md).

### Acceptance (once decided)

[Read the detail](livetest-remediation-register.md).

## LT-441: hardened mode does not confine a resident Claude session's own `CLAUDE_CONFIG_DIR` writes

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause — what was ruled out, and what remains

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Product-path guard and remaining severity

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Effect on the checks that found it

[Read the detail](livetest-remediation-register.md).

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

## LT-522: every `copilot-account:*` IPC channel rejected every renderer call, because `.strict()` schemas did not declare the preload's auth stamp

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Why the test suite stayed green

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Gates

[Read the detail](livetest-remediation-register.md).

## LT-523: orchestration-protocol response injection (`respondToUserAction` and every other `OrchestrationHandler` command reply) bypasses `SessionAdmissionService`, corrupting a genuinely blocked session

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Measured impact — the storm destroyed the app's retained log history

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-524: WS15 durable resume never fires for a turn whose entire output occurred before the coordinator had accepted any frame — silent total loss

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-525: a mid-turn instance whose worker node disconnects gets permanently stuck in `degraded` after the node reconnects

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-526: `hardened: true` + a remote node silently runs completely unsandboxed — the fail-closed guard is unreachable dead code

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-527: Copilot Adapter Constructor Blocked on CLI Discovery

[Read the detail](livetest-remediation-register.md).

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

## LT-530: Claude structured OAuth failure was rendered as assistant prose and vetoed by a later healthy probe

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Implemented fix and evidence

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-531: a record-mode loop preflight spent its whole budget proving nothing

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Fix and evidence

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-533: title escalation to the CLI never fires and every exit is silent

[Read the detail](livetest-remediation-register.md).

## LT-534: the two title resolvers truncate and sanitize in opposite orders

[Read the detail](livetest-remediation-register.md).

## LT-532: a record-mode preflight with no cheap command still burned the capped budget and looked like a failure

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Fix and evidence

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-535 — a promptless provider-limit park resumed by sending nothing — FIXED 2026-09-17, rebuilt-app check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-536 — loop harvest commits refused by the repository hook stranded finished work — FIXED 2026-09-18, rebuilt-app check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-537 — the operator switch barring agent secret requests was never enforced — FIXED 2026-09-19, rebuilt-app check pending

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-538 — the loop panel told the operator a provider-limit park would never resume — FIXED 2026-09-19

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-539"></a>
## LT-539: a hardened create can adopt an unsandboxed warm-start adapter — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-540"></a>
## LT-540: a packaged smoke-mode app hijacks the machine-global Chrome native-messaging manifest — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-541"></a>
## LT-541: every remote assistant reply was silently dropped by the durable-stream dedupe — REOPENED 2026-09-24 (fix never reached main; now ported)

[Read the detail](livetest-remediation-register.md).

### Status correction — 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-542"></a>
## LT-542: the WS15 parked-work window never opened on a heartbeat-timeout disconnect — REOPENED 2026-09-24 (fix never reached main; now ported)

[Read the detail](livetest-remediation-register.md).

### Status correction — 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-543"></a>
## LT-543: the browser-gateway forwarder's log lines go nowhere — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-544"></a>
## LT-544: both extension channels accept commands and never run them while health calls them healthy — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-545"></a>
<a id="lt-545-archived-detail"></a>

## LT-545: every object-payload renderer IPC call in `OrchestrationIpcService` is double-wrapped — FIXED IN CODE; live check pending

### Observed behavior

Renderer IPC calls such as skills discover, set-control and match failed payload validation.

### Root cause

`OrchestrationIpcService` passed one payload object to preload wrappers that wrapped it a second time.

### Required behavior

Service and preload must use one argument convention across all affected channels.

### Acceptance

The real service calls for skills, workflow, review and supervision reach their Zod handlers with valid payloads.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-545) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-546"></a>

<a id="lt-546-archived-detail"></a>

## LT-546: a suggest-only skill has no reachable control, and the panel mislabels the D1a default — FIXED IN CODE; live check pending

### Observed behavior

A suggest-only global skill had no row to promote, and the panel could label its mode On.

### Root cause

Skill controls were activation-derived, while suggest-only skills never activate; the UI defaulted missing modes to enabled.

### Required behavior

List discovered skills and display their effective source-default control mode.

### Acceptance

A fresh discovered suggest-only skill appears with Suggest selected and can be promoted through the UI.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-546) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-547"></a>

## LT-547: an enabled, detected skill over the injection budget is dropped in silence — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-548"></a>
<a id="lt-548-archived-detail"></a>

## LT-548: a materialised workspace secret is passed to the CLI on the command line — FIXED IN CODE; live check pending

### Observed behavior

A materialized workspace secret appeared in a CLI `--mcp-config` argv value visible to another shell.

### Root cause

Spawn configuration inlined decrypted connector JSON in the process command line.

### Required behavior

Pass secret-bearing configuration through a private transport with no value in argv.

### Acceptance

A real spawn has no materialized secret in process argv and the connector still receives its authorized value.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-548) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-549"></a>

<a id="lt-549-archived-detail"></a>

## LT-549: the secret card keeps a rejected credential in its password input — FIXED IN CODE; live check pending

### Observed behavior

A rejected secret-card save left the credential in the password input.

### Root cause

The input was uncontrolled and draft state cleared only after success.

### Required behavior

Clear a rejected secret value from the form while preserving safe retry context.

### Acceptance

A failed save leaves the password field empty and a fresh value can be entered.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-549) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-550"></a>

<a id="lt-550-archived-detail"></a>

## LT-550: Workspace Secrets management hides the name, the timestamps and the audit trail — FIXED IN CODE; live check pending

### Observed behavior

Workspace Secrets hid the agent-facing slug, timestamps and audit history.

### Root cause

The panel rendered only label/purpose and did not call its wired audit endpoint.

### Required behavior

Display identity and available usage metadata without revealing secret values.

### Acceptance

The panel shows slug, created/last-used times and recent audit entries; refresh and audit failures do not corrupt another workspace’s view.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-550) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-551"></a>

## LT-551: nothing can raise the secret card — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-570"></a>
<a id="lt-570-archived-detail"></a>

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

<a id="lt-571"></a>

<a id="lt-571-archived-detail"></a>

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

<a id="lt-572"></a>

<a id="lt-572-archived-detail"></a>

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

<a id="lt-573"></a>

<a id="lt-573-archived-detail"></a>

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

<a id="lt-574"></a>

<a id="lt-574-archived-detail"></a>

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

<a id="lt-575"></a>

<a id="lt-575-archived-detail"></a>

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

<a id="lt-590"></a>

<a id="lt-590-archived-detail"></a>

## LT-590: the loop diagnosis card loses its severity colours in the light theme — FIXED IN CODE; live check pending

### Observed behavior

The loop diagnosis severity chip, tag and primary buttons lost contrast in light theme.

### Root cause

The card used dark-theme literal fills with no light-theme counterpart.

### Required behavior

Use theme-aware severity and action colors.

### Acceptance

The reported controls have readable contrast in light, dark and high-contrast themes.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-590) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-591"></a>

<a id="lt-591-archived-detail"></a>

## LT-591: the WARN escalation borrows signal A's id, so the card headlines work that never repeated — FIXED IN CODE; live check pending

### Observed behavior

WARN escalation displayed “Repeating the same work” without a matching work-hash signal.

### Root cause

The escalation reused signal id A, whose catalog means identical-work repetition.

### Required behavior

Identify escalation honestly and keep the causal signal attached.

### Acceptance

The real-corpus escalation case headlines the actual condition and gives matching advice.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-591) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-592"></a>

<a id="lt-592-archived-detail"></a>

## LT-592: the fixability tag, the next step and the primary action can name different signals — FIXED IN CODE; live check pending

### Observed behavior

One issue card showed a decision tag, a hint next step and two primary actions.

### Root cause

Fixability, next step and actions selected different signals independently.

### Required behavior

Derive the three from one governing signal and choose at most one primary action.

### Acceptance

Mixed-signal corpus cases show one coherent recommendation and one primary action.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-592) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-593"></a>

<a id="lt-593-archived-detail"></a>

## LT-593: Stop on a busy Claude session terminates it instead of interrupting it — FIXED IN CODE; live check pending

### Observed behavior

Stop on a busy Claude turn ended its session and restored the queued message as a draft.

### Root cause

The settled interrupt left auto-respawn suppression armed; a later clean Claude exit took the termination path.

### Required behavior

A settled user interrupt must keep the session usable and preserve the next message.

### Acceptance

A real Claude Stop settles to an input-ready session with a recorded boundary and queued work retained.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-593) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-594"></a>

<a id="lt-594-archived-detail"></a>

## LT-594: the loop causal timeline's terminal readings are unreachable — FIXED IN CODE; live check pending

### Observed behavior

Terminal causal-timeline readings and cap recovery never appeared in the UI.

### Root cause

The store cleared the active loop on terminal state while the timeline was mounted only below `active()`.

### Required behavior

Keep terminal state visible long enough to show diagnosis and recovery actions.

### Acceptance

A completed or cap-reached loop displays its terminal timeline and reachable recovery control.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-594) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-595"></a>

<a id="lt-595-archived-detail"></a>

## LT-595: the composer picker keeps the old model after a closed-session continuation — FIXED IN CODE; live check pending

### Observed behavior

After closed-session continuation the composer model label stayed on the old model.

### Root cause

The preview handoff seeded from stale store state and discarded the confirmed model change response.

### Required behavior

Hydrate the composer from the confirmed runtime selection.

### Acceptance

Both model pickers and `instance.currentModel` agree after the continuation handoff.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-595) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-596"></a>

<a id="lt-596-archived-detail"></a>

## LT-596: a Codex native sub-agent's token spend is charged to nobody — FIXED IN CODE; live check pending

### Observed behavior

A Codex native child rollout consumed tokens that no instance ledger entry charged.

### Root cause

Child usage was outside root-thread ownership and could arrive after the root boundary scan.

### Required behavior

Attribute child usage once to its parent session, including both observed rollout formats and delayed receipts.

### Acceptance

Child rollout fixtures and a live delegated turn add exactly one child charge without double-counting the root.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-596) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-597"></a>

<a id="lt-597-archived-detail"></a>

## LT-597: an interrupted Codex turn costs zero in the ledger while the quota window moves — FIXED IN CODE; live check pending

### Observed behavior

An interrupted Codex turn produced prose and moved quota usage while the ledger stayed unchanged.

### Root cause

The provider omitted an exact usage record for the aborted shape; estimated and late exact usage need reconciliation.

### Required behavior

Retain a bounded estimate for unreported work and reconcile later exact totals without duplicate spend.

### Acceptance

Partial-call, late-exact and later-cumulative cases produce one consistent charge; live interrupted spend is visible.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-597) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-598"></a>

<a id="lt-598-archived-detail"></a>

## LT-598: the context manifest omits the adapter-appended system-prompt blocks — FIXED IN CODE; live check pending

### Observed behavior

The context manifest omitted adapter-appended Browser Gateway instructions from delivered native input.

### Root cause

The manifest was recorded before adapter creation appended guidance blocks.

### Required behavior

Record the exact supplied blocks in prompt order after all append steps.

### Acceptance

Manifest lengths and hashes match delivered input, including adapter guidance on direct and worker paths.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-598) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-599"></a>

<a id="lt-599-archived-detail"></a>

## LT-599: the streaming rewind guard protects a field the transcript never reads — FIXED IN CODE; live check pending

### Observed behavior

A rendered streaming bubble could shrink despite the canonical content rewind guard.

### Root cause

The display processor preferred shorter incoming `metadata.accumulatedContent` over monotonic `content`.

### Required behavior

Render the longest committed text across duplicate and rewound frames.

### Acceptance

A painted bubble never shrinks on the reproduced short-metadata frame.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-599) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-600"></a>

<a id="lt-600-archived-detail"></a>

## LT-600: an in-place ACP interrupt settle never records that the interrupt completed — FIXED IN CODE; live check pending

### Observed behavior

An ACP Stop settled idle but left only an interrupt-requested record.

### Root cause

The in-place settle disarmed force abort without writing a completion boundary.

### Required behavior

Record the settled interrupt once and keep the session input-ready.

### Acceptance

A real ACP Stop leaves a completed interrupt event and no stuck watchdog banner.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-600) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-601"></a>

<a id="lt-601-archived-detail"></a>

## LT-601: a user Stop is recorded as a completed turn — FIXED IN CODE; live check pending

### Observed behavior

A user Stop was persisted as a completed turn.

### Root cause

Turn-outcome classification treated settled cancellation as ordinary completion.

### Required behavior

Distinguish user cancellation in turn history and downstream consumers.

### Acceptance

A stopped turn records interrupted/cancelled outcome, never successful completion.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-601) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-602"></a>

<a id="lt-602-archived-detail"></a>

## LT-602: the header chip never shows a session's spawn-time reasoning effort — FIXED IN CODE; live check pending

### Observed behavior

The session header omitted reasoning effort chosen at spawn.

### Root cause

The instance creation event preceded the `reasoningEffort` assignment sent to renderer state.

### Required behavior

Publish the assigned effort before first render and preserve later updates.

### Acceptance

A fresh session header immediately shows its configured effort without a second event.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-602) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-603"></a>

## LT-603: the restart's own ready-edge redelivery erases the retained child record before the fresh-fallback reconcile reads it — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-604"></a>
## LT-604: a worker server started after launch has no RPC router, so every worker stays "disconnected" — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-605"></a>
<a id="lt-605-archived-detail"></a>

## LT-605: the session-restart-recovery startup notice is not rendered anywhere — FIXED IN CODE; live check pending

### Observed behavior

A recovery candidate existed but the startup notice never rendered.

### Root cause

The recovery banner component was imported by no runtime template.

### Required behavior

Mount the banner in the app shell and keep its dismiss/recovery actions reachable.

### Acceptance

A rebuilt app with a candidate shows the notice and its dismiss control works.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-605) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-606"></a>

<a id="lt-606-archived-detail"></a>

## LT-606: Resume Picker row actions have no visible focus ring — FIXED IN CODE; live check pending

### Observed behavior

Resume Picker row actions had no visible keyboard focus ring.

### Root cause

The CSS used `var(--focus-ring)` although that variable was absent in desktop, overriding the global ring.

### Required behavior

Use a defined desktop token or fallback for every row action.

### Acceptance

Tab focus shows a measurable visible outline on all Resume Picker actions.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-606) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-610"></a>

<a id="lt-610-archived-detail"></a>

## LT-610: deep-linking to another approval moves the highlight but never the keyboard focus — FIXED IN CODE; live check pending

### Observed behavior

Deep-linking to approval B highlighted B but left keyboard focus on approval A.

### Root cause

Focus ran from a host view hook that zoneless embedded-view refresh did not invoke.

### Required behavior

React to focused-request changes after render and move focus to the selected card.

### Acceptance

A click from A to B moves URL, highlight and active element to B without another click.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-610) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-611"></a>

<a id="lt-611-archived-detail"></a>

## LT-611: a browser mutation with no `instanceId` can never redeem the approval it just raised — FIXED IN CODE; live check pending

### Observed behavior

A browser mutation without `instanceId` raised approval, then could not redeem it on retry.

### Root cause

Grant creation used sentinel `unknown` while matching used an empty string.

### Required behavior

Use one identity sentinel across creation and recheck without broadening other grant scopes.

### Acceptance

A no-instance caller can approve once and retry successfully; a different scope still fails.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-611) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-612"></a>

<a id="lt-612-archived-detail"></a>

## LT-612: every ACP provider records a failed command as a success — FIXED IN CODE; live check pending

### Observed behavior

Cursor and Grok nonzero shell exits were recorded as successful tool results.

### Root cause

ACP `status: completed` meant the tool call ended, while the real nonzero exit code was ignored for `is_error`.

### Required behavior

Use the raw exit code for completed tool outcome and preserve neutral cancelled/unsettled states.

### Acceptance

Fail-then-fix correction mining finds the pair on ACP as it does on Claude.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-612) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

### Investigation — 2026-09-24 (Grok wire capture)

The 2026-09-24 resume-batch evidence run (`docs/superpowers/plans/2026-09-06-lt196-correction-miner_livetest.md`,
"Evidence run — 2026-09-24 (resume batch)") left the Grok half of LT-612 reopened and flagged its
root cause as an **unverified inference**: "Grok's agent-server does not populate `rawOutput.exitCode`".
That inference was wrong in its specifics. This investigation drove `grok agent stdio` directly over
ACP JSON-RPC (initialize → session/new → session/prompt, `--always-approve`, no AIO code in the loop)
in a disposable `/tmp` workspace and captured the raw `session/update` notifications for two bare,
unwrapped tool calls: `/usr/bin/grep --bogus-flag needle haystack.txt` (real exit 2) and
`/usr/bin/grep -F needle haystack.txt` (real exit 0).

**Captured evidence.** Grok's terminal (`status: "completed"`) `tool_call_update` for the failing call
carried:

```json
{
  "sessionUpdate": "tool_call_update",
  "status": "completed",
  "content": [{ "type": "content", "content": { "type": "text", "text": "grep: unrecognized option `--bogus-flag'\n..." } }],
  "rawOutput": {
    "type": "Bash",
    "output_for_prompt": "exit: 2\ngrep: unrecognized option `--bogus-flag'\n...",
    "exit_code": 2,
    "command": "/usr/bin/grep --bogus-flag needle haystack.txt",
    "truncated": false, "signal": null, "timed_out": false,
    "current_dir": "/tmp/lt0924-grok-acp/ws1"
  }
}
```

and the succeeding call carried the same shape with `"exit_code": 0`. **Grok does send a structured,
numeric exit status on every completed `execute` call — it is just under a different key,
`rawOutput.exit_code` (snake_case), not `rawOutput.exitCode` (camelCase, Cursor's key).** An
intermediate (`status: "in_progress"`) update for the same call transiently reports `exit_code: 0`
before the process has actually exited — confirming the fix must key off the *terminal* status only,
which `acpToolFailed()` already does.

**Root cause.** `acpToolFailed()` (`src/main/cli/adapters/acp-tool-call-material.ts`) read only
`rawOutput['exitCode']`. Grok's ACP server never populates that camelCase key, so the `typeof
rawOutput?.['exitCode'] === 'number'` check was always `false` for Grok and every completed call fell
through to "not failed", regardless of the real exit code — reproducing the pre-fix LT-612 defect for
Grok only, exactly as the 2026-09-24 resume-batch run observed.

**Fix.** Added `acpExitCode()` in `src/main/cli/adapters/acp-tool-call-material.ts`, which reads
`rawOutput.exitCode` first (Cursor) and falls back to `rawOutput.exit_code` (Grok); `acpToolFailed()`
now calls it instead of reading `exitCode` directly. Stderr/text content is deliberately **not** used
as a failure signal (both providers' successful and failing calls can write to stderr/print an "exit:
N" line in free text — only the structured numeric field is trusted). File-level doc comments in
`acp-tool-call-material.ts` (top-of-file and above `acpExitCode()`) record the captured Grok shape for
future readers.

**Tests.** `src/main/cli/adapters/acp-tool-call-material.spec.ts` gained three cases built from a
trimmed, path-anonymised copy of the real captured payload: a completed Grok call with
`rawOutput.exit_code: 2` marks `is_error: true` (`buildAcpToolResultMessage`), one with `exit_code: 0`
marks `is_error: false`, a `cancelled` status with the same `rawOutput` stays neutral, and the
no-rendered-output fallback path (`buildAcpToolOutcomeFallback`) also honours `exit_code`. All three
new assertions failed red against the pre-fix `acpToolFailed()` (confirmed by running the suite before
the fix) and pass after it. `npm run test:quiet -- src/main/cli/adapters` (127 files, 1544 tests) and
`npx tsc --noEmit` both pass after the change.

**Residual risk.** Only `cursor-agent` and `grok` were probed directly; Copilot's and OpenCode's
`execute` `rawOutput` shape was not captured here (Copilot has no signed-in account on this box; the
2026-09-21/24 runs did not reach OpenCode's exit-code field either) and could in principle use a third
key name, which `acpExitCode()` would silently miss the way it missed Grok's until now. This closes the
concrete gap the resume-batch evidence run reopened LT-612 for (Grok), but does not newly verify every
ACP provider. The rebuilt-app live re-run of `2026-09-06-lt196-correction-miner_livetest.md` check 2
against Grok is still the outstanding live-test gate for this item.

<a id="lt-613"></a>

<a id="lt-613-archived-detail"></a>

## LT-613: clicking a History entry closes the sidebar instead of expanding it — FIXED IN CODE; live check pending

### Observed behavior

Clicking a History entry expanded it then closed the sidebar.

### Root cause

The entry click bubbled to the backdrop’s unconditional close handler.

### Required behavior

Keep entry expansion inside the sidebar while preserving backdrop close.

### Acceptance

Mouse click and keyboard activation both leave the sidebar open and show the expanded entry.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-613) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

## LT-614 — a timed-out ACP approval card stayed on screen and its Cancel did nothing — FIXED 2026-09-22

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-615 — `close_matching` reported an already-closed tab as one it closed — FIXED 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-616 — a requeued browser command after a failed poll handoff left no trace — FIXED 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-617 — health never shows the remote extension's secret-observation report — FIXED IN CODE 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### What has been ruled out, by reading the code

[Read the detail](livetest-remediation-register.md).

### Not yet checked, and the next step

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Investigation — 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Orchestrator review — 2026-09-24

[Read the detail](livetest-remediation-register.md).

## LT-618 — a command to the local Mac extension times out and the channel then goes silent — PARTLY FIXED IN CODE 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Investigation — 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Independent review note — 2026-09-24 (Low, accepted)

[Read the detail](livetest-remediation-register.md).

### Prior occurrences found in earlier sessions — 2026-09-24

[Read the detail](livetest-remediation-register.md).

## LT-619 — mDNS advertisement invisible; refused answers became uncaught exceptions — CODE FIXED 2026-09-24, PERMISSION NEEDS JAMES

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Fix (code half)

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

## LT-621 — workers never receive the coordinator's MagicDNS URL — FIXED 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause (reproduced)

[Read the detail](livetest-remediation-register.md).

### Fix

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-620-archived-detail"></a>

## LT-620 — LT-611's sentinel mismatch survived in four more grant lookups — FIXED 2026-09-24

### Observed behaviour

Found live on 2026-09-24 by the `resume` batch, while re-checking LT-611 in a dev app (see
[the approval-coherence livetest](../superpowers/plans/2026-09-01-browser-approval-coherence_livetest.md)):

1. Approve a `session` grant raised by `browser.request_grant` with no `instanceId`.
2. Immediately repeat the identical `request_grant`.
3. Result: a brand-new `requires_user`, where `allowed` was expected.

### Root cause

Approvals are created with `instanceId: request.instanceId ?? 'unknown'`, so the approved grant is
stored under `'unknown'`. Non-persistent grants match only on exact `instanceId`
(`grantMatches`, `browser-grant-policy.ts`). The LT-611 fix (`320a6f28`) changed the lookup
sentinel from `''` to `'unknown'` in `browser-gateway-action-guard.ts` only. The same `''` lookup
remained in:

- `browser-grant-request-operations.ts`: the managed-profile and existing-tab `request_grant`
  paths;
- `browser-close-tab-operations.ts`: `matchingGrant`, used by `close_tab` and `close_matching`;
- `browser-existing-tab-operations.ts`: cross-origin `navigate`;
- `browser-upload-grant.ts`: file-upload candidate grants.

### Fix

All five lookups now use `'unknown'`, the same sentinel as approval creation. No `instanceId ?? ''`
remains in `src/main/browser-gateway`. Regression tests, each shown red first:

- `browser-grant-request-no-instance.spec.ts`: real SQLite stores, managed and existing-tab paths,
  request → approve → repeat returns `allowed`;
- `browser-close-tab-operations.spec.ts`: "redeems an approved destructive grant for a caller with
  no instanceId";
- `browser-gateway-service-existing-tabs.spec.ts`: "redeems an approved navigation grant for a
  caller with no instanceId". This one was proven red by temporarily restoring the `''` line.

### Acceptance

After a rebuild, repeat the batch's live probe: a no-`instanceId` `request_grant` → approve →
repeat returns `allowed`, with no second approval raised. A differently scoped request still raises
its own approval.

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

## LT-650 — stale MiMo Token Plan quota survives a switch to a non-Plan model — FIXED; IPC CONFIRMED LIVE 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Fix and verification — 2026-09-24

[Read the detail](livetest-remediation-register.md).

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

<a id="lt-640-archived-detail"></a>

## LT-640 — lifecycle-only loop state broadcasts were blocked by the event schema — FIXED 2026-09-24

### Observed behaviour and root cause

Found live by the `loops` batch on 2026-09-24: a loop's post-completion worktree outcome (promoted,
blocked or cleaned) reached a running renderer only after a reload.
`LoopCoordinator` emits `loop:state-changed` with `lifecycleOnly: true`
(`loop-coordinator.ts:3939`), and `loop-handlers.ts` forwards `data` unchanged.
`LoopStateChangedEventSchema` is `.strict()` and had no such key, so
`validateRendererEventPayload` blocked every one of these broadcasts: `Blocked invalid renderer event
payload … Unrecognized key: "lifecycleOnly"`, 19 times in the production `app.log`.

### Fix and acceptance

`lifecycleOnly: z.boolean().optional()` was added to the schema
(`packages/contracts/src/schemas/loop-events.schemas.ts`), with a regression test in
`renderer-event-validation.spec.ts` that failed red first. Live: stranded-worktree-rescue checks 2
and 4 show the blocked or promoted outcome in the open loop panel without a reload.

### Live re-check 2026-09-24 (`verify-loops`) — REOPENED, second fault fixed

The schema fix held live: no `loop:state-changed` blocks, and `LoopStore.summaryByChat` held the final
`worktreeLifecycle.phase: "blocked"` within about 100 ms. But the "Past loop prompts" panel stayed on
"saving session work" for more than 2 minutes. `loop-control.component.ts`'s `lastTerminalSummaryId`
was keyed by `loopRunId` alone, and the id does not change across harvesting → harvested → blocked,
so the panel's `refreshHistory()` pull fired only once. Fixed: the key is now
`terminalSummaryRefreshKey()` (`src/renderer/app/features/loop/loop-terminal-summary-key.ts`), which
is `loopRunId` plus the lifecycle phase. The panel input is renamed to `terminalSummaryKey`. The
spec `loop-terminal-summary-key.spec.ts` was mutation-checked: a run-id-only key fails it. The live
re-check is still pending.

<a id="lt-641-archived-detail"></a>

## LT-641 — agent secret-card requests were blocked on the push channel — FIXED 2026-09-24

### Observed behaviour and root cause

Found live by the `loops` batch (stranded-worktree-rescue check 7): with agent secret requests
allowed, an agent's `secret_required` request never rendered. `OrchestrationHandler` emits it on
`user-action:request`. `UserActionRequestEventSchema`
(`packages/contracts/src/schemas/orchestration.schemas.ts`) is strict: its `requestType` enum lacked
`secret_required`, and it had no `secretRequest` field. The production log shows the block twice on
2026-09-24 (`1790212064202`, `1790213021146`).

This also reconciles the `settings` batch's same-day PASS of workspace-secret-card check 1. The
renderer can also pull pending requests through the unvalidated `user-action:list-for-instance`
invoke, so the card can appear when a view loads its pending list, but never through the live push.
So workspace-secret-card check 1 is not trustworthy until it is re-run with this fix.

### Fix and acceptance

`secret_required` is added to the enum, and `secretRequest` is added as a **strict** object (`name`,
`label`, `purpose`, optional `expectedFormat`), so a `value` key can never cross this channel. Tests
cover acceptance of a metadata-only request and rejection of one carrying `value`. Main emits no
`input_required` on this channel, so that type was not added. Live: an agent's `secret_required`
request appears in an already-open session without navigating away and back.

### Live re-check 2026-09-24 (`verify-loops`) — REOPENED, second fault fixed

The schema fix held live: the request was forwarded and not blocked. But `app-user-action-request`
was mounted only in `instance-detail.component.html:268`, and the dashboard shows
`app-chat-detail` whenever a chat is selected. So within an open chat, **every** agent request (not
only the secret card) was invisible. It was reachable only by Workboard → instance.
`app-browser-approval-request` had the same gap.

Fixed: `chat-detail.component.html` mounts both, bound to the chat's runtime instance
(`currentInstance()?.id`, not `streamInstanceId`, which falls back to the chat id). The component
already re-scopes on `instanceId` changes through an effect. Verified that the renderer compiles and
that the chats and instance-detail specs pass (815 tests). There is no DOM test, because signal
inputs cannot be set in this vitest setup. The live re-check is pending.

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

<a id="lt-643-archived-detail"></a>

## LT-643 — a ping-pong loop hangs after round 1's reviewer settles — FIXED 2026-09-24

### Observed behaviour

Live, 2026-09-24, `loops` batch, loop `loop-1790213435794-57df2268` (Claude builder, Codex reviewer,
`pingPong.maxRounds: 4`, scratch repo). Timeline:

- `T+11s`: reviewer instance `x40s9alwb` spawned.
- `T+89s`: the reviewer went `idle` with a complete, valid `CHANGES_REQUESTED` JSON verdict as its
  last output.
- From then on, `app.log` has no line about the loop or the reviewer. The loop stayed `running`, at
  0 iterations, stage `IMPLEMENT`. The UI's `pingPong()` state stayed `null`.
- The 600 s review timeout never fired (checked 45 s past it).
- The loop was cancelled by hand.

### Root cause (as of the first pass)

Not yet isolated. The batch traced `agentic-pingpong-reviewer.ts` →
`ReviewerSessionSpawner.runReviewSession()` → `InstanceManager.waitForInstanceSettled()` →
`InstanceSettledTracker.waitForSettled()`, and each step reads correctly in isolation. Full evidence
is in [the ping-pong livetest](PINGPONG_IMPLEMENTATION_STATUS_livetest_completed.md).

### Required behaviour

A settled reviewer's verdict advances the round, or the review timeout fires and surfaces. The loop
never sits silent.

### Investigation — 2026-09-24

**Verified structural defect (high confidence, confirmed by a red→green deterministic test):**
`ReviewerSessionSpawner.runReviewSession()` (`src/main/orchestration/reviewer-session-spawner.ts`,
pre-fix lines 182–190) awaited `instance.readyPromise` **before** ever calling
`InstanceManager.waitForInstanceSettled()` — the only call that carries the caller's configured
`timeoutMs` (the review's 600s budget). The two prior "not fully isolated" checks in this doc were
each individually correct; the break is upstream of both, in the ordering between them.

`instance.readyPromise` is the `createInstance()` background-init promise
(`src/main/instance/instance-lifecycle.ts:1875`); it resolves only once the initial prompt is
delivered — but "delivered" is adapter-specific. For Claude, `sendInput` is fire-and-forget and
returns almost immediately. For Codex in app-server mode, `sendInputImpl`
(`src/main/cli/adapters/codex-app-server-adapter.ts:573-587`) awaits `appServerSendMessage()`, which
awaits `captureTurn()` (`src/main/cli/adapters/codex-app-server-turn-adapter.ts:134`) for the
**entire first turn**, resolving only on a `turn/completed` notification or an inferred-completion
timer (`codex-app-server-notification-adapter.ts:518-537`, itself capped by the CLI's own internal
900s notification-idle watchdog — see `CODEX_TIMEOUTS.NOTIFICATION_IDLE_ACTIVE_MS`, unrelated to the
review's 600s setting). The class-level doc comment in `reviewer-session-spawner.ts` ("2. awaits
`readyPromise` (initial prompt sent)") assumed the fast, Claude-shaped case; it does not hold for
Codex/other stateless-turn adapters (same class of assumption break as
[[wake-broken-for-stateless-exec-adapters]]).

Net effect: if that first Codex turn stalls for any reason (a dropped `turn/completed`
notification, a stuck app-server, etc.), `readyPromise` hangs, `waitForInstanceSettled()` — and its
600s timer — is **never even called**, `agenticPingPongReviewer()` never returns, and nothing further
is logged for that loop or instance. This matches every observed symptom: no
`Ping-pong reviewer produced a verdict` log, no `Ping-pong reviewer did not settle cleanly` log, no
600s timeout, and a reviewer instance that needed manual termination (the spawner's own `finally`
teardown never ran either, because the `try` block never unwound).

I could not, with the evidence retained from the live run alone, prove which specific Codex-side
event (or non-event) made that particular turn's completion promise stall — that would need a fresh
live repro with app-server protocol tracing. What is verified by reading the source and by a
deterministic test is the AIO-side defect: there was no independent deadline guarding the
`readyPromise` await, so *any* stall in a provider's first-turn delivery — regardless of cause — hung
the whole round forever with the round's configured timeout never armed.

**Reproduction:** `src/main/orchestration/reviewer-session-spawner.spec.ts`, test `'LT-643: times out
(rather than hanging forever) when readyPromise itself never settles'`. A fake instance with a
`readyPromise` that never settles, run under Vitest fake timers: pre-fix, the test hung until the
harness's own 8s test-timeout failed it, with `waitForInstanceSettled` never invoked. Post-fix, the
test passes deterministically once fake time is advanced past the configured budget.

### Fix

Added `ReviewerSessionSpawner.awaitReadyWithBudget()` (`reviewer-session-spawner.ts`), which races
`instance.readyPromise` against the review's own `timeoutMs` (and against `signal`/`isCancelled`,
polled every 250ms, resolving early — not erroring — on cancellation so the immediately-following
`waitForInstanceSettled()` call unwinds the same way it always has). On budget exhaustion it rejects
with a `/timed out/i` message, which the existing `runReviewSession` catch-block classification
already maps to `outcome: 'timeout'` — no change needed there, and the `finally` teardown (instance
termination) now actually runs in this case. `runReviewSession()` calls this helper in place of the
old bare `await instance.readyPromise.catch(() => undefined)`.

**Tests: red → green.** New test above went from a hard timeout (current code) to passing (fixed
code). Full existing coverage unaffected: `reviewer-session-spawner.spec.ts` (6/6),
`agentic-pingpong-reviewer.spec.ts`, `agentic-pingpong-reviewer.exclusions.spec.ts`,
`loop-pingpong-builder-done.spec.ts`, `loop-pingpong-completion.spec.ts`,
`pingpong-checking-policy.spec.ts`, `instance-settled-tracker.spec.ts` — 81/81 pass. `npx tsc --noEmit`
clean. `npm run lint:fast` shows no new warnings in the touched file.

**Residual / not verified here:** this fix bounds the *AIO-side* hang. It does not explain (nor was it
asked to fix) why the live Codex turn's completion notification apparently never arrived at the
protocol level; that remains a live-test item if it recurs post-fix. Also not exercised: the UI's
`pingPong()` signal populating correctly once the round now times out cleanly instead of hanging —
that is exactly what Checks 1 and 2 in
[the ping-pong livetest](PINGPONG_IMPLEMENTATION_STATUS_livetest_completed.md) still need to re-run live.

### Orchestrator review — 2026-09-24 (fix replaced)

The investigation's first fix bounded `await instance.readyPromise` with the review timeout. That
ends the hang, but in the observed live run the reviewer was already **idle with a complete
verdict** at T+89s. With that fix, the round would have waited out the 600 s budget and then
discarded that verdict as a `timeout`.

The live evidence shows `readyPromise` can stay unresolved after the reviewer's turn has visibly
finished. For Codex app-server it covers the whole first turn through
`deliverInitialPromptAfterSpawn` → `sendInput`. Gating the settle wait on it was the structural
fault. `ReviewerSessionSpawner.runReviewSession()` now starts `waitForInstanceSettled()` at once:
the settle wait owns `timeoutMs`, and `raceBackgroundInitFailure()` lets background init end the
wait only by rejecting. Why this Codex first turn's `sendInput` did not resolve after the adapter
reported idle is still unexplained. It is an adapter-level inconsistency and needs a protocol trace
if it recurs.

Tests in `reviewer-session-spawner.spec.ts`, all three failing against the HEAD version of the file
and passing now:

- the verdict is returned while `readyPromise` never resolves (the live case);
- a timeout is reported when neither settles;
- a background-init rejection fails fast.

`src/main/orchestration`: 2,982 tests pass. The live re-check is the ping-pong livetest's checks 1
and 2.

## LT-644 — ping-pong reviewer verdicts request changes but carry no findings — FIXED 2026-09-24

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### What the code does

[Read the detail](livetest-remediation-register.md).

### Not yet known

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Evidence found and fix — 2026-09-24 (later the same day)

[Read the detail](livetest-remediation-register.md).

## LT-652 — a send during a Codex Compact turn is burned by a sub-second retry storm and dropped

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

## LT-653 — the context-policy `steer-turn` text is indistinguishable from a user instruction, so agents halt work "as requested"

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Fix and acceptance evidence — 2026-09-24 (both items, working tree)

[Read the detail](livetest-remediation-register.md).

## LT-654 — Codex provider Compact turns are invisible to lifecycle ownership — FIXED IN CODE; live checks pending

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Fix and acceptance evidence — 2026-09-24

[Read the detail](livetest-remediation-register.md).

## LT-655 — normal Codex compaction renders as errors and fabricated 0% occupancy — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Fix and acceptance evidence — 2026-09-24

[Read the detail](livetest-remediation-register.md).

## LT-656 — context policy, provider action proof and compaction lifecycle are not directly queryable — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Fix and acceptance evidence — 2026-09-24

[Read the detail](livetest-remediation-register.md).

## LT-657 — Harness-authored input reached the model and the transcript as the user's own message — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Fix — 2026-09-25 (working tree)

[Read the detail](livetest-remediation-register.md).

### Evidence

[Read the detail](livetest-remediation-register.md).

### Impact and historical data (not rewritten)

[Read the detail](livetest-remediation-register.md).

### Still to do (live, needs a rebuilt app)

[Read the detail](livetest-remediation-register.md).

<a id="lt-658"></a>
## LT-658 — Browser Gateway type mutates disabled and readonly controls — FIXED IN CODE; live re-check pending

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Fix and evidence — 2026-09-27 (working tree)

[Read the detail](livetest-remediation-register.md).

<a id="lt-659"></a>
<a id="lt-659-archived-detail"></a>

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

<a id="lt-660"></a>

## LT-660 — terminate confirmation lets keyboard focus escape its modal — FIXED IN CODE

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Fix and evidence — 2026-09-27 (working tree)

[Read the detail](livetest-remediation-register.md).

<a id="lt-661"></a>
<a id="lt-661-archived-detail"></a>

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

<a id="lt-662"></a>

## LT-662 — single-setting preload calls used the wrong IPC payload shape — FIXED IN CODE

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register.md).

### Fix and evidence — 2026-09-27 (working tree)

[Read the detail](livetest-remediation-register.md).

<a id="lt-663"></a>
<a id="lt-663-archived-detail"></a>

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

<a id="lt-664"></a>

## LT-664 — retiring a Local AI target leaves its incidents open forever

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-665"></a>
## LT-665 — `check_session` treats an unreadable page as logged out and drives a credential re-login

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Further reproduction — 2026-10-11, restored tab reported readable

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-666"></a>
## LT-666 — page-specific login markers make a recipe unrecoverable, misreported as a fill refusal

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-690"></a>
## LT-690 — an OpenCode MiMo output-ceiling ending is classified as an ordinary completion

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-670"></a>
## LT-670 — the renderer respawn watchdog force-terminates a session that is only waiting out the circuit-breaker backoff

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-671"></a>
## LT-671 — crash auto-continuation is silently skipped when recovery uses a fresh-session replay

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-672"></a>
## LT-672 — a user Stop on a Claude session posts "The provider ended this turn with an error"

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-673"></a>
## LT-673 — reloading the renderer leaves the session list empty: the first state resync is sent before the IPC auth token exists

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-674"></a>
## LT-674 — the LT-105 errored-turn completion is dropped by the instance layer, so no cost, ledger capture or hook is recorded

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-680 — a message joined into a running Codex goal turn loses its reply and the session reads idle

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-681 — Compact now on a Codex session shows a fabricated ~0% occupancy

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

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

<a id="lt-675"></a>
## LT-675 — a signed-out Claude CLI's "Not logged in" banner is accepted as the session's AI title

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-683 — a Codex goal turn that starts within milliseconds of the previous one is not followed

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-700 — Plan Queue restart recovery spawns a verifier before the orchestrator-tools socket exists

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-701 — a normal quit mid-run parks every working Plan Queue item and ends the run

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-702 — a ping-pong round can hang with a finished, valid reviewer verdict (LT-643's symptom again)

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-703"></a>
## LT-703 — `fill_credential` cannot reach a login form embedded in a cross-origin subframe, and reports the refusal as a selector miss

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

### Live re-check — 2026-10-11

[Read the detail](livetest-remediation-register.md).

<a id="lt-704"></a>
## LT-704 — OpenCode candidate discovery drops the inherited environment and selects an install without the routed account model

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Implementation status update — 2026-10-14 (Plan Queue worker)

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-704-deferred-packaged-acceptance"></a>
### Deferred packaged acceptance (branch-recorded procedure)

[Read the detail](livetest-remediation-register.md).

<a id="lt-705"></a>
## LT-705 — OpenCode 1 cannot open a folder whose shared database OpenCode 2 changed, and the OpenCode 2 fallback cannot honour per-session settings

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Repair

[Read the detail](livetest-remediation-register.md).

### Implementation status update — 2026-10-14 (Plan Queue worker)

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

<a id="lt-705-deferred-packaged-acceptance"></a>
### Deferred packaged acceptance (branch-recorded procedure)

[Read the detail](livetest-remediation-register.md).

### Not in scope

[Read the detail](livetest-remediation-register.md).

<a id="lt-706"></a>
## LT-706 — a MiMo step that exhausts the combined cap on reasoning ends the session silently

[Read the detail](livetest-remediation-register.md).

### Observed behaviour

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behaviour

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

## LT-707 — benchmark runner loses a scored run when workspace cleanup flakes

[Read the detail](livetest-remediation-register.md).

### Observed behavior

[Read the detail](livetest-remediation-register.md).

### Root cause

[Read the detail](livetest-remediation-register.md).

### Required behavior

[Read the detail](livetest-remediation-register.md).

### Acceptance

[Read the detail](livetest-remediation-register.md).

