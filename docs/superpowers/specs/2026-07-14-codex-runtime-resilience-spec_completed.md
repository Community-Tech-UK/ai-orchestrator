# Codex Runtime Resilience Architecture Spec

**Date:** 2026-07-14  
**Status:** Completed 2026-07-15; rebuilt-app checks remain in the linked live-test plan  
**Implementation plan:** `docs/superpowers/plans/2026-07-14-codex-runtime-resilience-plan_completed.md`  
**Live-test plan:** `docs/superpowers/plans/2026-07-14-codex-runtime-resilience-plan_livetest.md`  
**Scope:** Codex app-server lifecycle, continuity, event routing, recovery, and compaction safety.

## Problem

The Codex integration has grown into a 3,000-line adapter that owns transport, native thread discovery, resume, turn streaming, notification correlation, watchdogs, interrupt handling, compaction, retry classification, transcript presentation, and exec-mode fallback. Those responsibilities share mutable fields and a single swappable notification handler.

The July 14 incident demonstrated the practical failure mode: a healthy native turn was declared stalled after 90 seconds of notification silence, the error was treated like thread loss, and the next request ran against a new context-empty native thread. Separate unfinished context-cost work then showed a second hazard: an enabled-by-default recovery controller could interrupt a healthy turn based on cumulative spend even while current context occupancy was low.

The continuity fix already removes the specific 90-second/thread-loss coupling and refuses a context-empty retry after an active-thread failure. The remaining architecture still makes similar regressions easy.

## Reference Implementations

### Official Codex app-server

The protocol defines a connection handshake, persisted threads, turns, items, and streamed notifications as separate lifecycle layers. A client starts or resumes one thread, sends turns to that thread, and treats `turn/completed` and `thread/compacted` as observable completion facts. `thread/compact/start` is only request acceptance; compaction progress arrives through notifications.

### T3 Code

Reviewed at `pingdotgg/t3code@3513fa04fbf12c1d4fa2b8d07cfc7f0905714d31`.

T3 Code separates:

- a generated, versioned app-server protocol client;
- a scoped `CodexSessionRuntime` per application thread;
- a small adapter that maps runtime events into provider-neutral events;
- a persisted provider-session directory containing the native resume cursor and status;
- deterministic cleanup through scopes and an inactivity reaper;
- one registered notification stream that is queued and mapped, rather than swapped between idle and active handlers.

T3 still falls back to a fresh native thread for a narrowly classified missing-thread resume error, so its fallback policy should not be copied unchanged. Its separation of ownership and event routing is the useful part.

### OpenCode

Reviewed at `anomalyco/opencode@571e7b852f82415faf65466e1536357a048bdf5a`.

OpenCode owns the model conversation itself rather than wrapping Codex app-server, but its session architecture is valuable:

- persisted messages and parts are the source of truth;
- session status is an explicit evented state (`idle`, `busy`, `retry`);
- processing, retries, aborts, and compaction are separate services;
- compaction is a persisted session operation, not an implicit transport side effect;
- automatic continuation after compaction is represented as a synthetic persisted message;
- retry policy updates visible state and never infers session loss from silence alone.

## Considered Approaches

### 1. Full T3-style provider rewrite

Create a new effect-based Codex runtime, generated protocol package, provider directory, and event projection layer in one change.

This is the cleanest end state but the wrong migration unit. It would overlap the active continuity and context-cost work, require simultaneous changes across adapter, lifecycle, persistence, renderer state, and tests, and make regression attribution difficult.

### 2. Incremental runtime extraction (chosen)

Keep the public `CliAdapter` contract while moving ownership behind narrow, testable components. Start at the highest-risk boundary: notification delivery. Then extract native thread lifecycle and turn orchestration behind explicit state and typed outcomes. Preserve the existing higher-level replay fallback until durable event projection can replace it.

This gives immediate safety improvements, supports staged verification, and does not require a framework migration.

### 3. Patch individual symptoms

Continue adjusting timers, regex classifiers, and booleans in the monolithic adapter.

This is rejected. It caused the current brittleness: each local recovery path can bypass continuity invariants owned elsewhere.

## Target Architecture

```text
Codex app-server process / broker
  -> version-matched protocol client
  -> fault-isolated notification hub (one permanent transport sink)
  -> scoped Codex thread runtime
       - native thread identity + resume proof
       - one active turn state machine
       - approvals / interrupt / compaction completion
  -> provider event mapper
  -> durable AIO conversation + runtime projection
  -> renderer
```

### Invariants

1. One AIO instance has at most one authoritative native Codex thread id.
2. A native thread id changes only after an explicit fresh-start/replay decision, never as a turn retry side effect.
3. Transport silence is `unknown liveness`, not proof of thread loss.
4. Native thread loss and transport loss are distinct typed outcomes.
5. Notifications are delivered through one permanent transport sink. Turn consumers subscribe and unsubscribe; they never replace the sink.
6. One failing observer cannot block other observers or crash transport parsing.
7. Turn completion requires a correlated terminal notification or a terminal response. RPC acceptance is not completion proof.
8. Compaction completion requires a correlated `thread/compacted` notification.
9. Experimental recovery that can interrupt work is disabled until its rebuilt-app live test passes.
10. Fresh-thread fallback must be paired with durable transcript replay or stop visibly.

## Incremental Delivery

### Slice 1: Safe event routing and stop-harm defaults

- Add a notification subscription hub to the app-server client while retaining the legacy setter temporarily.
- Dispatch a snapshot of subscribers and isolate handler failures.
- Keep the compaction observer permanently subscribed.
- Give each captured turn a scoped subscription and remove handler save/restore forwarding.
- Disable the unproven context-cost governor by default; retain explicit opt-in for live testing.
- Add race and isolation tests.

### Slice 2: Scoped native thread runtime

- Extract connection/thread identity, resume proof, and teardown from `CodexCliAdapter`.
- Represent lifecycle with explicit states and typed transition failures.
- Move app-server process exit, turn ownership, and notification correlation into that runtime.
- Persist a single runtime binding rather than duplicating `sessionId`, `appServerThreadId`, and `resumeCursor` authority.

### Slice 3: Protocol and projection hardening

- Generate TypeScript protocol artifacts from the installed Codex version and validate at the transport boundary.
- Persist normalized provider events before renderer projection.
- Rebuild UI state from persisted events after reconnect or restart.
- Remove manual heterogeneous field parsing where a generated schema exists.

### Slice 4: Recovery consolidation

- Replace regex-led recovery branching with typed transport, thread, turn, provider, and policy errors.
- Route all fresh starts through one replay-capable continuity coordinator.
- Remove exec-mode and app-server recovery duplication where the semantics are equivalent.

## Immediate Verification

The first slice is complete only when:

- subscriber fan-out, unsubscribe, snapshot dispatch, and handler-failure isolation are unit tested;
- turn capture no longer reads or replaces `notificationHandler`;
- idle compaction observation remains active during a turn;
- existing turn streaming and continuity tests pass;
- the context-cost governor is off by default and still testable by explicit opt-in;
- TypeScript, spec TypeScript, lint, max-LOC, and the full test suite are run and accurately reported.

## Risks

- Tests and mocks currently call the public `notificationHandler` field directly. The compatibility setter remains during Slice 1 so those tests can migrate without a flag day.
- Subscriber callbacks are synchronous. Slow callbacks remain a latency risk; queueing and backpressure belong in Slice 2, after event ownership is explicit.
- The active context-cost branch overlaps the adapter. Changes must be minimal and preserve its staged work while changing only the default activation policy.
- Existing max-LOC debt may keep the repository gate red independently of this slice; it must be reported, not hidden.
