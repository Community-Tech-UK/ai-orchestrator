# Codex Runtime Resilience Implementation Plan

**Status:** Completed 2026-07-15 (agent-runnable gates green; rebuilt-app live checks deferred to `_livetest.md`)  
**Spec:** `docs/superpowers/specs/2026-07-14-codex-runtime-resilience-spec_completed.md`

## Goal

Replace the brittle Codex app-server integration with a scoped native-thread runtime, a generated/version-checked protocol boundary, typed failure classification, and one atomic runtime projection for persistence and recovery. Preserve exec fallback behavior and the existing normalized provider-event pipeline.

## What changes

### 1. Notification hub

**Files:**

- Modify `src/main/cli/adapters/codex/app-server-client.ts`
- Modify `src/main/cli/adapters/codex/app-server-client.spec.ts`

Add scoped notification subscriptions alongside the temporary compatibility setter. Dispatch notifications to a stable snapshot and catch/log subscriber failures so one observer cannot starve the others.

Tests cover fan-out, unsubscribe, self-unsubscribe during dispatch, subscription during dispatch, and exception isolation.

### 2. Scoped turn routing

**Files:**

- Modify `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`
- Modify `src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts` only if its mocks require the new API

Register the idle compaction observer once for the app-server connection. Give `captureTurn` a scoped subscriber and unsubscribe in `finally`. Foreign notifications are ignored by that turn subscriber; permanent observers receive them independently.

Regression tests prove compaction observation remains active while a turn subscription exists and a turn cleanup cannot erase the permanent observer.

### 3. Safe governor activation

**Files:**

- Modify `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`

Change `contextCostGovernorEnabled` from default-on to explicit opt-in. Preserve all current controller code and its live-test path. Test that omission does not interrupt and `true` does enable decisions.

### 4. Verification and close-out

Run focused client and adapter tests, then the canonical project gates. Review the diff against the dirty tree. If all agent-runnable requirements for this slice pass, add as-built evidence and rename this plan to `_completed.md`. If a real rebuilt app is needed for any remaining check, create a `_livetest.md` document before completing the plan.

## Primary risks

- Notification ordering must remain synchronous and in wire order.
- Turn correlation must not consume foreign subagent or compaction notifications.
- Compatibility mocks must not mask production subscription behavior.
- The staged cost-governor work must not be overwritten.

## Required checks

```bash
npm run test:quiet -- src/main/cli/adapters/codex/app-server-client.spec.ts
npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts
npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

## As-built status — 2026-07-14

Implementation is complete for Slice 1:

- added `AppServerNotificationHub` with snapshot fan-out, idempotent unsubscribe, and observer-failure isolation;
- retained the primary-handler compatibility surface without using it for turn capture;
- changed the adapter's idle compaction observer to a connection-lifetime subscription;
- changed each captured turn to a scoped subscription released in `finally`;
- made the permanent observer the sole owner of `thread/compacted` presentation;
- made the experimental context-cost governor explicit opt-in (`contextCostGovernorEnabled: true`).

Verification evidence:

- focused Codex tests: 3 files, 111 tests passed;
- `npx tsc --noEmit`: passed;
- `npx tsc --noEmit -p tsconfig.spec.json`: passed;
- `npm run lint`: passed;
- `npm run check:ts-max-loc`: the new client is 696 lines and passes, but the repository gate remains red because pre-existing `scripts/analyze-codex-context-pressure.ts` is 1,153 lines against the 700-line limit;
- `npm run test:quiet`: run, but the dirty shared tree fails in `storage-retirement-migrations.spec.ts` because staged migration `049_automation_trigger_configuration` alters an `automations` table absent from that fixture. The failing paths are outside this slice.

This plan remains active and untracked. Do not rename it `_completed` until the two repository-wide gate failures are resolved or the concurrent owning work updates those fixtures/gates.

## Extension — 2026-07-15

The first slice removed the notification-handler race, but the follow-up investigation found four remaining structural faults:

1. `CodexCliAdapter` still owns the connection, authoritative thread ID, resume cursor, resume proof, active turn ID, interrupt promise, deferred interrupt, notification routing, UI mapping, and recovery policy in one 3,393-line class.
2. The checked-in protocol types are hand-maintained and have drifted from the installed `codex-cli 0.144.4` bindings. In particular, `turn/interrupt` and `thread/compact/start` return an empty object, not `{ success: true }`; treating the empty response as rejection explains the observed unconfirmed-interrupt recovery failure.
3. Turn lifecycle is represented by independently mutable nullable fields. An early interrupt, a late `turn/start` response, process exit, and turn completion can update them on different paths without one transition authority.
4. Continuity reads session ID, cursor, and resume proof through separate calls, so it can persist a mixed snapshot while a thread transition is in progress.

Reference patterns retained from the OpenCode and T3 Code research:

- keep the server/native thread as the source of truth;
- generate protocol metadata and types from the upstream contract;
- validate at the transport boundary and keep unknown events observable;
- expose a scoped runtime per native thread instead of spreading state across UI adapters;
- project normalized events and durable identity from that runtime rather than rebuilding truth from renderer state.

### 5. Pin and verify the Codex protocol boundary

**Files:**

- Create `scripts/generate-codex-app-server-protocol.ts`
- Create `src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts`
- Create `src/main/cli/adapters/codex/generated/app-server-protocol.gen.spec.ts`
- Modify `src/main/cli/adapters/codex/app-server-types.ts`
- Modify `src/main/cli/adapters/codex/app-server-types.spec.ts`
- Modify `package.json`

Generate a compact manifest from `codex app-server generate-ts --experimental`: CLI version, supported client request methods, server notification methods, and hashes for the contract files used by Harness. Keep the generated artifact deterministic and reviewable instead of vendoring hundreds of one-type files. Add a verification mode that regenerates into a temporary directory and fails on drift.

Update the runtime-facing request/response types from the generated 0.144.4 shapes. Empty-object RPC responses are successful when the JSON-RPC request resolves. Use generated parameter names (`effort`, not the stale `reasoningEffort` turn parameter) while retaining only explicitly tested compatibility fields needed for older supported CLIs.

Tests first prove the current bug: a resolved empty `turn/interrupt` response must be accepted, and the turn request must use generated parameter names.

### 6. Add typed transport and runtime failures

**Files:**

- Create `src/main/cli/adapters/codex/app-server-runtime-errors.ts`
- Create `src/main/cli/adapters/codex/app-server-runtime-errors.spec.ts`
- Modify `src/main/cli/adapters/codex/app-server-client.ts`
- Modify `src/main/cli/adapters/codex/app-server-client.spec.ts`

Introduce a discriminated error taxonomy for transport closure, request timeout/rejection, invalid protocol payload, unavailable native thread, stalled turn, failed turn, and paused recovery. Classify raw CLI/RPC errors once at the boundary. Internal recovery code branches on typed codes; compatibility text matching remains isolated in the classifier for older Codex builds.

Route incoming JSON-RPC messages in the correct order: server requests before responses, correlated responses only when a matching pending request exists, then notifications. Fail pending requests immediately when writes fail or the transport closes. Preserve raw payloads for the existing provider-event capture path without exposing secrets.

### 7. Extract a scoped native-thread runtime

**Files:**

- Create `src/main/cli/adapters/codex/app-server-thread-runtime.ts`
- Create `src/main/cli/adapters/codex/app-server-thread-runtime.spec.ts`
- Modify `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`
- Modify `src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts`

Move app-server client ownership, authoritative native thread binding, connection observer, active-turn phase, current turn ID, completion proof, pending interrupt, watchdog, and scoped notification subscription into one runtime object. Use explicit phases rather than independent booleans/nullables. The adapter remains responsible for preparing prompts and mapping typed turn notifications into existing normalized adapter events.

Required invariants:

- a runtime has zero or one authoritative thread binding;
- binding replacement is atomic and produces one immutable snapshot;
- one turn can be active at a time;
- every accepted interrupt shares a correlated completion proof;
- interrupt-before-turn-ID is delivered once the ID is known and cannot leave an unresolved promise;
- a stale interrupt never targets a newer turn;
- turn cleanup always releases timers and its scoped subscriber without removing connection observers;
- transport silence produces a typed stalled-turn error, never synthetic thread loss;
- closing the runtime settles pending work and releases the owned client exactly once.

### 8. Expose one durable runtime projection

**Files:**

- Modify `src/main/cli/adapters/base-cli-adapter.types.ts`
- Modify `src/main/cli/adapters/base-cli-adapter.ts`
- Modify `src/main/providers/provider-runtime-service.ts`
- Modify `src/main/providers/provider-runtime-service.spec.ts`
- Modify `src/main/session/session-continuity.ts`
- Modify `src/main/session/session-continuity.spec.ts`
- Modify `src/main/instance/instance-lifecycle.ts` only where it reads separate resume fields
- Modify the corresponding lifecycle tests

Add a serializable `ProviderRuntimeSnapshot` containing provider session ID, resume cursor, resume proof, native thread ID, active turn ID, connection/turn phases, capture timestamp, and a monotonic revision. Adapters without a richer runtime return a compatible base snapshot. Codex projects the snapshot atomically from its scoped runtime; the legacy `sessionId`, cursor, and proof getters delegate to that projection.

Update continuity and runtime-readiness callers to read one snapshot when available, with compatibility fallback for other adapters. Stamp the config fingerprint on a copied cursor rather than mutating the adapter-owned object.

### 9. Consolidate Codex recovery policy

**Files:**

- Create `src/main/cli/adapters/codex/app-server-recovery-policy.ts`
- Create `src/main/cli/adapters/codex/app-server-recovery-policy.spec.ts`
- Modify `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify `src/main/cli/adapters/codex/input-cap-recovery.ts`
- Modify related focused tests

Map typed failures to explicit actions: retry current thread, pause and surface, compact current thread, fresh thread with visible reset, or terminal adapter failure. Never infer thread disappearance from silence or a generic transport timeout. Keep input-cap recovery and context-cost recovery behind the same policy vocabulary so fresh-thread creation cannot occur through an unpaired hidden path.

The existing adapter-runtime event bridge remains the only projection into renderer/provider events, and the conversation-ledger provider-event capture remains the durable raw-backed event record. Do not create a second event store.

### 10. Verification and live validation

Run focused tests after each task, then the canonical gates. Also run the protocol drift verifier against the installed Codex CLI. Verify the adapter file is materially reduced and all new non-generated files remain under the repository line limit.

Required focused checks:

```bash
npm run test:quiet -- src/main/cli/adapters/codex/generated/app-server-protocol.gen.spec.ts
npm run test:quiet -- src/main/cli/adapters/codex/app-server-runtime-errors.spec.ts
npm run test:quiet -- src/main/cli/adapters/codex/app-server-thread-runtime.spec.ts
npm run test:quiet -- src/main/cli/adapters/codex/app-server-client.spec.ts
npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts
npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts
npm run test:quiet -- src/main/providers/provider-runtime-service.spec.ts
npm run test:quiet -- src/main/session/session-continuity.spec.ts
npm run verify:codex-protocol
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Real rebuilt-app checks, if still needed after automated integration tests, go into a sibling `_livetest.md` before this plan is renamed. The plan stays active and untracked until every agent-runnable item above is complete.

## Extension as-built status — 2026-07-15

Implementation is complete for the runtime-resilience extension:

- generated and version-checked a deterministic protocol manifest from installed `codex-cli 0.144.4`;
- corrected the real protocol drift: empty `turn/interrupt` and `thread/compact/start` responses are successful RPC acknowledgements, turn reasoning uses `effort`, and thread start no longer sends unsupported reasoning fields;
- added generated request/response validation so stale fields and malformed replies fail at the transport boundary with the exact JSON-RPC method;
- routed server requests before correlated responses, preventing numeric-ID server requests from being silently swallowed;
- introduced typed app-server failures and one explicit recovery policy;
- extracted `CodexAppServerThreadRuntime`, which now owns connection state, authoritative thread binding, active turn, watchdog, interrupt-before-ID, correlated completion proof, notification subscription, and idempotent teardown;
- removed the adapter's duplicate `turnInProgress`, `currentTurnId`, `currentTurnCompletion`, and `pendingAbortResolve` state;
- added an atomic `ProviderRuntimeSnapshot` and changed continuity/resume-readiness paths to consume it, copy cursors before fingerprinting, and reject mixed native-thread/cursor snapshots;
- changed the Codex native conversation-ledger send path to reuse the scoped turn runtime;
- reduced `codex-cli-adapter.ts` from 3,393 to 3,169 lines and kept every new non-generated file below the 700-line repository limit (`app-server-client.ts` is 696 lines; the thread runtime is 462).

Current verification evidence:

- `npm run verify:codex-protocol`: passed against `codex-cli 0.144.4`;
- `npx tsc --noEmit`: passed;
- `npx tsc --noEmit -p tsconfig.spec.json`: passed;
- `npm run lint`: passed;
- focused Codex/runtime/continuity suites: passed, including the final 120-test primary integration set;
- `npm run test:quiet`: full suite passed;
- `npm run build`: passed;
- `npm run check:ts-max-loc`: all files changed by this work pass; the repository gate remains red only for the unrelated pre-existing `scripts/analyze-codex-context-pressure.ts` (1,153 lines, 700-line limit).

Rebuilt-app-only checks are recorded in `docs/superpowers/plans/2026-07-14-codex-runtime-resilience-plan_livetest.md`.

## Close-out re-verification — 2026-07-15

Re-verified the whole slice against the current working tree (the runtime-resilience code is committed in `b9b6375d`; the codex adapter tree is clean). Both previously outstanding blockers are now resolved:

- the repository-wide `npm run check:ts-max-loc` gate **passes** — the unrelated pre-existing `scripts/analyze-codex-context-pressure.ts` overflow was remediated separately (`docs/superpowers/plans/2026-07-15-typescript-loc-ratchet-remediation-plan_completed.md`); no file changed by this work is over the 700-line limit;
- the four remaining checks are genuine rebuilt-app/real-CLI validations and are correctly deferred to the sibling `_livetest.md` per the Live-Test Deferral policy.

Fresh gate evidence (2026-07-15):

- `npm run verify:codex-protocol`: passed (exit 0) against installed `codex-cli 0.144.4`, regenerating from the real binary and diffing the committed manifest — no drift;
- focused Codex protocol/runtime/client/recovery/types suites: 6 files, 48 tests passed;
- focused adapter/provider-runtime/continuity suites (`codex-cli-adapter.app-server`, `codex-cli-adapter.thread-recovery`, `provider-runtime-service`, `session-continuity`): 4 files, 112 tests passed;
- `npx tsc --noEmit`: passed (exit 0);
- `npx tsc --noEmit -p tsconfig.spec.json`: passed (exit 0);
- `npm run lint` (`ng lint`): all files pass; `npm run lint:fast` (oxlint over `src/main`/`src/shared`/`src/preload`): 0 errors (550 pre-existing style warnings);
- `npm run check:ts-max-loc`: passed;
- `npm run test:quiet` (full suite): 1361 files, 13386 tests passed (exit 0).

All agent-runnable requirements for this plan and its extension pass. The only remaining work is the deferred rebuilt-app live validation tracked in the `_livetest.md`, so this plan is closed and renamed `_completed`.

## Extension risks

- Generated bindings follow the installed CLI, so protocol drift verification must report a clear version mismatch rather than silently rewriting during normal builds.
- Strict decoding must not discard unknown future notifications; known methods are validated, unknown methods are captured and logged once.
- Atomic runtime snapshots must remain serializable and must not contain promises, clients, timers, maps, sets, or errors with sensitive raw data.
- Base-adapter compatibility must not force unrelated providers to implement Codex-specific concepts.
- The native conversation-ledger Codex adapter currently has a separate short-lived client path; it should reuse the scoped runtime only after the primary adapter is green, to avoid combining two behavioral migrations in one red step.
