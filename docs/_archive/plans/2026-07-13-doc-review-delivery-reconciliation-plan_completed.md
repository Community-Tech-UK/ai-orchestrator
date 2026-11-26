# Doc-review delivery reconciliation plan

**Status:** Completed — 2026-07-13. Automated implementation and verification are
complete. Electron-only live validation is deferred to
[`2026-07-13-doc-review-delivery-reconciliation-plan_livetest.md`](2026-07-13-doc-review-delivery-reconciliation-plan_livetest.md).
This replaces the in-app portion of `2026-07-13-doc-review-submit-wake-plan.md`,
where that document assumed a resume operation which does not exist.

**Goal:** A submitted review is durably recorded before any delivery attempt, then reaches
the correct owner (chat session or loop) without automatic duplicate delivery; an interrupted
handoff remains visibly recoverable.

**Architecture:** Keep artifact capture and document rendering in `DocReviewService`, but
move delivery policy into a main-process coordinator. A review stores an explicit origin and
an append-only delivery journal. Chat delivery targets a stable conversation identity rather
than an ephemeral instance id; loops request review only while parked and consume the result
through their existing completion/intervention operations.

## Invariants

- A decision is committed before a wake, send, resume, or notification attempt.
- An instance id is never used as the sole identity for a deferred delivery.
- Busy turns are never interrupted by a review result; the result waits for a safe boundary.
- A hibernated session wakes through `InstanceManager.wakeInstance()`; a terminated session
  revives through one lifecycle-owned continuity API, never through doc-review code.
- An approved loop review only calls `acceptCompletion()` while that loop is paused and
  eligible; changes/rejection are queued with `intervene()` and then resumed. A terminal
  `completed-needs-review` run is informational, not resumable.
- Every terminal delivery result is visible in the review pane and retrievable through
  `get_doc_review_result`; failure never deletes the submitted decision.

## Data model

Extend `DocReviewSession` with:

```ts
type DocReviewOrigin =
  | { kind: 'instance'; requestedInstanceId: string; historyThreadId: string; sessionId?: string }
  | { kind: 'loop'; loopRunId: string; chatId: string };

type DocReviewDeliveryState =
  | 'not-attempted' | 'dispatching' | 'queued' | 'delivered' | 'failed';

interface DocReviewDeliveryAttempt {
  id: string;
  state: DocReviewDeliveryState;
  mechanism: 'direct-send' | 'deferred-idle' | 'wake' | 'continuity-revive'
    | 'loop-accept' | 'loop-intervene' | 'none';
  targetInstanceId?: string;
  error?: string;
  at: number;
}
```

Persist sessions and attempts in a SQLite-backed `DocReviewStore`. On first open, import any
existing `electron-store` sessions exactly once, retaining their ids and decisions. The
delivery journal is append-only; the current state is derived from its final entry.

## Runtime boundaries

### `DocReviewService`

Validates/renders artifacts, commits decisions, emits change events, and delegates delivery:

```ts
interface DocReviewDeliveryCoordinator {
  deliver(session: DocReviewSession, feedback: string): Promise<DocReviewDeliveryAttempt>;
}
```

`submitDecision()` writes the decided session first and persists a `dispatching` guard before
invoking `deliver()`. It appends the returned attempt even when it is `failed`, then emits
`doc-review:changed`. A process crash after the handoff leaves the guarded attempt visibly
recoverable and requires an explicit retry rather than risking an automatic duplicate send.

### `InstanceManager`

Add a public, direct-testable `reviveFromContinuity(request)` method. It reads the persisted
`SessionState`, creates a new restored instance using its provider/model/agent/workspace/
history identity, attempts native resume when the stored cursor is valid, and relies on the
existing lifecycle fresh-replay fallback. It returns the *new* instance id and never mutates
or resurrects the original terminal record.

```ts
interface ContinuityReviveRequest {
  sourceInstanceId: string;
  initialPrompt: string;
  reason: 'doc-review-submission';
}
interface ContinuityReviveResult { instanceId: string; restoreMode: 'native' | 'replay'; }
```

### `DocReviewDeliveryCoordinator`

For an instance origin: send directly if idle; queue durably if busy, initializing, respawning,
or globally paused; wake a hibernated instance and send after readiness; revive a terminal or
missing instance only when `docReviewResumeOnSubmit` is enabled (default `true`). It subscribes
to instance state and pause-resumed events and drains queued items serially per conversation.

For a loop origin: `approved` calls `acceptCompletion()` only for a paused eligible loop;
`changes_requested` and `rejected` call `intervene()` with the canonical block then
`resumeLoop()`. Any terminal loop gets a `failed` attempt with an explanatory reason — no
phantom restart.

## Tasks

### Task 1: Persist origin and delivery evidence

**Files:** contracts doc-review schema/types; SQLite migration/store; doc-review service and
its specs; renderer types/page.

1. Add a failing schema/service spec proving an instance review captures the caller's stable
   `historyThreadId`, decision persistence precedes delivery, and a failed delivery remains
   visible.
2. Add the migration/store and one-time ElectronStore import.
3. Replace direct mutable ElectronStore session writes with store transactions.
4. Render delivery state and the latest failure/target in the decided-review UI.

### Task 2: Add continuity revival at the lifecycle boundary

**Files:** `InstanceManager`, a focused continuity-revival helper, session-continuity adapter,
and lifecycle specs.

1. Add failing specs for a native-resume candidate, fresh-replay fallback, missing continuity
   state, and pause/resource-governor refusal.
2. Implement `reviveFromContinuity()` without importing doc-review types into lifecycle code.
3. Assert the returned instance is restored, retains the original history thread, and receives
   the review prompt as its first post-restore user message.

### Task 3: Deliver at safe chat boundaries

**Files:** new `doc-review-delivery-coordinator.ts` and specs; application wiring; settings
types/defaults/schema; notifications adapter.

1. Add failing coordinator specs for idle send, busy queue→idle drain, hibernated wake→send,
   terminated revival, disabled-revival failure, and global-pause queueing.
2. Implement per-conversation serialization and idempotency by review id.
3. Wire state/pause listeners and dispose them on shutdown.
4. Add the default-on, operator-only `docReviewResumeOnSubmit` setting; agent safe-settings
   tooling must not write it.

### Task 4: Make loop review a real gate

**Files:** loop review creation/wiring, contracts, delivery coordinator, loop-handler and
coordinator specs.

1. Add failing specs that a paused loop review persists `loopRunId`; approval accepts only an
   eligible paused loop; feedback queues an intervention and resumes; terminal loops do not
   restart.
2. Create loop reviews at the pause-for-review boundary. Leave post-terminal artifacts as
   read-only informational records, not wake targets.
3. Route loop decisions through `acceptCompletion`, `intervene`, and `resumeLoop` exactly as
   their state contracts require.

### Task 5: Recover and prove behavior

Completed for all agent-runnable implementation and verification work. Deferred Electron
validation is recorded only in the
[`_livetest` checklist](2026-07-13-doc-review-delivery-reconciliation-plan_livetest.md).

## Deliberate non-goals

- Do not resume a loop already in a terminal status.
- Do not use an external hook to wake the in-app app process.
- Do not infer a session identity from artifact HTML or untrusted feedback.
- Do not let an agent alter `docReviewResumeOnSubmit` through safe settings.
