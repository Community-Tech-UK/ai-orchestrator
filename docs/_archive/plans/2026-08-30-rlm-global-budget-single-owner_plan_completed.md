# RLM Global Loading Budget and Single-Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task by task. The repository's
> fresh-eyes completion gate and no-worktree/no-branch rules still apply.

**Status:** Completed — implementation and agent-runnable verification passed; rebuilt-app checks are
tracked separately in the pending live-test document
**Date:** 2026-08-30
**Revised:** 2026-09-02 — implementation completed, independently verified, and rebuilt-app checks
deferred under the live-test contract
**Goal:** Make RLM startup metadata-only, eliminate the duplicate main-process owner, and hydrate or
index only the bounded working set that actually needs it.
**Architecture:** The context worker becomes the sole long-lived interactive RLM owner. Main validates
renderer calls and relays typed RPC/events only. Startup loads store shells and active-session rows
without section content. A global residency controller hydrates on demand and optionally prewarms
active/recent stores after readiness; the unused lexical term map is removed, while semantic repair
embeds only sections without durable vectors.
**Tech stack:** Electron 40, Node.js/TypeScript, worker threads/utility process IPC, better-sqlite3,
Zod 4, Vitest.
**Spec:** [2026-08-30-rlm-global-budget-single-owner_spec_completed.md](./2026-08-30-rlm-global-budget-single-owner_spec_completed.md)

## Global constraints

- Work in James's current checkout. Do not create a branch or worktree.
- Do not stage, commit, push, delete, or prune RLM data.
- Preserve unrelated dirty-tree changes.
- Add tests before each behavior change and demonstrate the focused test fails for the intended
  reason before implementing it.
- Do not run more than one full Vitest suite at a time.
- Active plan/spec files remain untracked until every implementation and verification item is done.
- Use the exact live-test deferral procedure if a rebuilt-app restart cannot be performed.

---

## Phase 0 — Relieve and establish a reproducible baseline

### Task 0.1: Recheck stale processes without broad termination

**Files:** None.

- [ ] List Vitest/Node test processes with PID, PPID, elapsed time, working directory, RSS, and full
      command.
- [ ] If a process is a confirmed stale/orphaned Vitest run from this repository, revalidate its PID
      and command, send graceful termination, wait briefly, and verify it exited. Use forced termination
      only after revalidating the same target.
- [ ] List booted simulators. Shut down only booted devices that are not being used; never erase them.
- [ ] Verify there is no lingering repository Vitest process and no unwanted booted simulator.

Expected current result: the 2026-08-30 planning check found neither a Vitest process nor a booted
simulator, so this task should normally be a no-op.

### Task 0.2: Capture a redacted baseline

**Files:**

- Create: `_scratch/rlm-memory-baseline/metrics.txt` (disposable, ignored)

- [ ] Start the existing app once without modifying data.
- [ ] Record process roles, main/context-worker RSS and heap metrics, RLM owner initialisation logs,
      persistence-load counts, and event-loop stalls for five idle minutes.
- [ ] Exercise one existing RLM list operation and one representative query.
- [ ] Confirm the main and context worker both instantiate/open the interactive RLM context before the
      fix. If the defect no longer reproduces, stop and reconcile the plan with the new source/runtime.
- [ ] Keep all captured output redacted; do not copy section content or secret-bearing paths into docs.

---

## Phase 1 — Make startup metadata-only and retire unused lexical indexing

### Task 1.1: Add global residency-policy and load-stat types

**Files:**

- Modify: `src/main/rlm/context-persistence-loader.ts`
- Modify: `src/main/rlm/context-persistence-loader.spec.ts`

- [ ] Add a failing test asserting that construction over many individually-small stores loads store
      shells and active sessions but zero section rows and zero section-content bytes.
- [ ] Add a failing test for deterministic hot-candidate order: active-session store first, then
      stores inside the 48-hour window by `last_accessed DESC`, then `id ASC`.
- [ ] Define these exported types and defaults:

```ts
export interface RlmResidencyPolicy {
  hotWindowMs: number;
  maxResidentSectionMetadata: number;
  maxResidentContentBytes: number;
  maxResidentContentSections: number;
  maxResidentContentStores: number;
  maxSectionsPerStore: number;
}

export const DEFAULT_RLM_RESIDENCY_POLICY: RlmResidencyPolicy = {
  hotWindowMs: 48 * 60 * 60 * 1000,
  maxResidentSectionMetadata: 50_000,
  maxResidentContentBytes: 64 * 1024 * 1024,
  maxResidentContentSections: 20_000,
  maxResidentContentStores: 128,
  maxSectionsPerStore: 5_000,
};

export interface RlmPersistedLoadStats {
  discoveredStores: number;
  activeSessions: number;
  startupContentBytes: 0;
  residentMetadataSections: number;
  deferredMetadataSections: number;
  residentContentBytes: number;
  residentContentSections: number;
  residentContentStores: number;
  hotCandidates: number;
  hotAdmitted: number;
  hotSkipped: number;
  hotCancelled: number;
  metadataOnlyStores: number;
  deferredStores: number;
  exhausted: {
    metadata: boolean;
    contentBytes: boolean;
    contentSections: boolean;
    contentStores: boolean;
  };
  elapsedMs: number;
}
```

- [ ] Extend `PersistedContextState` with immutable load stats and explicit per-store hydration state.
- [ ] Keep the old per-store token/size protections; make aggregate residency counters authoritative
      across the worker and assert that constructor-time content remains zero.
- [ ] Run the focused loader test and confirm it passes.

### Task 1.2: Prevent metadata reads from materializing inline content

**Files:**

- Modify: `src/main/persistence/rlm/rlm-sections.ts`
- Modify: `src/main/persistence/rlm-database.ts`
- Modify: `src/main/persistence/rlm-database.types.ts`
- Create: `src/main/persistence/rlm/rlm-section-metadata.spec.ts`
- Modify: `src/main/rlm/context-persistence-loader.ts`
- Modify: `src/main/rlm/context-persistence-loader.spec.ts`

- [ ] Add a failing database test proving the metadata query does not select/return
      `content_inline` payload data.
- [ ] Add an explicit metadata projection, ordered by `start_offset ASC`, supporting `limit` and
      `offset`; do not reuse `SELECT *`. Return a computed content-size estimate, not the content.
- [ ] Add one grouped `store_id, COUNT(*)` query so hydration state records authoritative section
      totals without issuing a content-bearing query per store.
- [ ] Have the startup loader avoid the section projection entirely. The projection is called only by
      the residency controller after a store is requested or admitted by post-ready prewarm.
- [ ] Check actual UTF-8 byte length after each admitted read and discard the string if it would cross
      the remaining budget. Assert retained bytes never exceed the configured ceiling.
- [ ] Run the focused persistence and loader tests.

### Task 1.3: Implement metadata-only startup and hot-candidate selection

**Files:**

- Modify: `src/main/rlm/context-persistence-loader.ts`
- Modify: `src/main/rlm/context-persistence-loader.spec.ts`

- [ ] Load active sessions first, then retain all store shells with authoritative section counts and
      explicit `deferred` hydration state.
- [ ] Assert startup never calls `getSections()`, `getSectionContent()`, `createSearchIndex()`,
      `updateSearchIndex()`, vector embedding, or Bloom-filter construction.
- [ ] Add a pure selector that captures one cutoff timestamp and orders active-session stores first,
      then stores whose `last_accessed` or `created_at` is inside the 48-hour window, then stable ID.
- [ ] Keep `codebase-auto` and existing individually-large stores metadata-only even when recent;
      on-demand reads use the existing bounded large-store path.
- [ ] Cover corrupt JSON/session records so one bad row does not bypass counters or abort the load.
- [ ] Add boundary tests for exact-limit, one-over-limit, empty DB, one oversized store, and a store
      with zero sections.
- [ ] Run `npm run test:quiet -- src/main/rlm/context-persistence-loader.spec.ts`.

### Task 1.4: Retire the unused in-memory lexical term index

**Files:**

- Modify: `src/shared/types/rlm.types.ts`
- Modify: `src/main/rlm/context/context-cache.ts`
- Modify: `src/main/rlm/context/context-storage.ts`
- Modify: `src/main/rlm/context-persistence-loader.ts`
- Modify: `src/main/rlm/context/context-serialization.ts`
- Modify: `src/main/rlm/context/context-analytics.ts`
- Modify: `src/main/rlm/context/index.ts`
- Modify: `src/main/rlm/context-persistence-loader.spec.ts`
- Modify: `src/main/ipc/rlm-ipc-serialization.spec.ts`

- [ ] Re-run `rg -n "searchIndex|createSearchIndex|updateSearchIndex|TermLocation" src/main src/shared`
      and confirm no production query reads `searchIndex.terms`; stop if a real reader has appeared.
- [ ] Add a failing lexical-parity test that creates a store without `searchIndex` and proves grep,
      optimized lexical search, slice, and get-section results remain unchanged.
- [ ] Remove `SearchIndex`, `TermLocation`, `ContextStore.searchIndex`, `createSearchIndex()`,
      `updateSearchIndex()`, and every add/load/import update call.
- [ ] Keep Bloom-filter functions because `searchStoreOptimized()` uses them. Build a Bloom filter only
      when an already-resident store first requests the optimized path.
- [ ] Preserve the public `indexedTerms` analytics field as zero with a deprecation comment so IPC
      response shapes do not drift in this task.
- [ ] Run the context cache, storage, serialization, analytics, and lexical query specs.

---

## Phase 2 — Make deferred state usable and bounded

### Task 2.1: Add a residency controller

**Files:**

- Create: `src/main/rlm/context-residency-controller.ts`
- Create: `src/main/rlm/context-residency-controller.spec.ts`
- Modify: `src/main/rlm/context-manager.ts`

- [ ] Write failing tests for metadata hydration, content hydration, idempotence, least-recently-used
      eviction, active-session protection, and budget accounting.
- [ ] Implement a controller that owns hydration state and aggregate counters; keep internal state out
      of public `ContextStore.config`.
- [ ] Provide synchronous metadata hydration over better-sqlite3 and guarded content hydration for
      individually-small stores.
- [ ] Before admitting deferred content, evict least-recently-used persisted content until the byte,
      section, and store ceilings all have room.
- [ ] Eviction clears `section.content` and the Bloom filter; it does not remove metadata, durable
      vectors, or database rows.
- [ ] Never evict a store with an active session. If protected stores consume the budget, keep the
      requested store metadata-only and report the reason in stats.
- [ ] Run the new focused tests.

### Task 2.2: Wire hydration guards into every content-dependent operation

**Files:**

- Modify: `src/main/rlm/context-manager.ts`
- Modify: `src/main/rlm/context-manager.semantic-indexing.integration.spec.ts`
- Create: `src/main/rlm/context-manager.persistence-hydration.spec.ts`

- [ ] Add failing parity tests showing a deferred store behaves like a resident store for
      list, lexical query, semantic query, add/remove section, stats, and export.
- [ ] Hydrate metadata before `listSections`, removal, store-detail serialization, and export.
- [ ] Hydrate content before query execution, optimized lexical search, Bloom-filter construction,
      semantic gap repair, and export.
- [ ] Ensure `getSectionContentLazy()` works for both admitted and deferred metadata.
- [ ] Account for newly added content in the resident store without re-reading it from disk.
- [ ] Make `reloadFromPersistence()` clear maps, pending semantic repair, hydration state, Bloom
      filters, and old content before loading the new state.
- [ ] Emit the complete load-stat snapshot from `persistence:loaded`.
- [ ] Run the focused manager/hydration/semantic tests.

### Task 2.3: Add cancellable post-ready hot prewarm

**Files:**

- Modify: `src/main/rlm/context-residency-controller.ts`
- Modify: `src/main/rlm/context-residency-controller.spec.ts`
- Modify: `src/main/rlm/context-manager.ts`
- Modify: `src/main/instance/context-worker-protocol.ts`
- Modify: `src/main/instance/context-worker-client.ts`
- Modify: `src/main/instance/context-worker-main.ts`
- Modify: `src/main/instance/instance-context-port.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/instance/context-worker-client.spec.ts`
- Modify: `src/main/instance/__tests__/context-worker-client.spec.ts`
- Modify: `src/main/instance/__tests__/context-worker-main.spec.ts`

- [ ] Add failing tests proving no prewarm runs during construction, the ready signal starts it once,
      active-session stores precede recent stores, stores older than 48 hours are excluded, and
      cancellation stops before the next store.
- [ ] Add idempotent `startHotPrewarm()` and `cancelHotPrewarm()` worker operations. Repeated start is
      a no-op while running; worker restart or app shutdown cancels outstanding work.
- [ ] Process one store per scheduled turn, yield before the next store, and stop immediately when any
      residency ceiling is exhausted. Do not build lexical indexes or embeddings during prewarm.
- [ ] Capture the hot cutoff once per run so stores do not move across the boundary while selection is
      in progress. Record admitted, skipped, exhausted, and cancelled counters.
- [ ] Signal prewarm only after the main window/app initialization is ready to serve user work.
- [ ] Run the residency, worker protocol/client/main, and initialization-step specs.

### Task 2.4: Repair only missing semantic vectors

**Files:**

- Modify: `src/main/persistence/rlm/rlm-sections.ts`
- Modify: `src/main/persistence/rlm-database.ts`
- Modify: `src/main/persistence/rlm-database.types.ts`
- Create: `src/main/persistence/rlm/rlm-unindexed-sections.spec.ts`
- Modify: `src/main/rlm/vector-store.ts`
- Modify: `src/main/rlm/context-manager.ts`
- Modify: `src/main/rlm/context-manager.semantic-indexing.integration.spec.ts`
- Create: `src/main/rlm/vector-store.delta-indexing.spec.ts`

- [ ] Add failing database tests for a metadata-only `listUnindexedRootSections(storeId)` query that
      returns depth-zero sections with no matching durable vector row and excludes already indexed
      and removed sections.
- [ ] Add failing manager/vector tests proving an unchanged store after singleton reset performs zero
      section-content reads and zero embedding calls; one new section causes exactly one read and one
      embedding; an embedding failure leaves that section discoverable on retry.
- [ ] Implement the missing-section query with a `LEFT JOIN vectors ON vectors.section_id =
      context_sections.id`, returning identifiers and content-location metadata but not inline content.
- [ ] Replace the process-local whole-store scan in `ensureStoreIndexedForSemanticSearch()` with a
      delta repair that fetches content only for returned missing sections and calls
      `VectorStore.addSection()` for each.
- [ ] Keep section deletion's unconditional vector deletion. Use vector-row presence as the durable
      success checkpoint; do not add startup timestamps or a separate optimistic revision marker.
- [ ] Bound one repair batch, yield between batches, deduplicate concurrent repair requests per store,
      and leave failures retryable on the next query.
- [ ] Run the database, vector-store, manager, and semantic integration specs.

---

## Phase 3 — Move renderer RLM operations behind the worker

### Task 3.1: Add a typed RLM worker RPC contract

**Files:**

- Create: `src/main/instance/rlm-worker-port.ts`
- Modify: `src/main/instance/context-worker-protocol.ts`
- Modify: `src/main/instance/context-worker-client.ts`
- Modify: `src/main/instance/context-worker-client.spec.ts`
- Modify: `src/main/instance/__tests__/context-worker-client.spec.ts`

- [ ] Define a clone-safe discriminated request union covering every RLM renderer operation listed in
      spec §5.2 and a typed `invokeRlm(request)` port.
- [ ] Add one `rlm-request` RPC envelope to `ContextWorkerRpcMsg`; keep operation payloads fully typed.
- [ ] Add client tests for result delivery, worker error propagation, timeout, crash/restart, and RPC
      bookkeeping.
- [ ] Extend `postRpc` with a reject-on-timeout mode used by RLM admin requests. Do not automatically
      retry mutations.
- [ ] Preserve existing timeout-to-null behavior for context retrieval calls that deliberately degrade.
- [ ] Run both context-worker client test files.

### Task 3.2: Handle RLM RPCs and serialize before structured clone

**Files:**

- Create: `src/main/instance/rlm-worker-request-handler.ts`
- Create: `src/main/instance/rlm-worker-request-handler.spec.ts`
- Modify: `src/main/instance/context-worker-main.ts`
- Modify: `src/main/instance/__tests__/context-worker-main.spec.ts`
- Reuse/modify: `src/main/ipc/rlm-ipc-serialization.ts`
- Modify: `src/main/ipc/rlm-ipc-serialization.spec.ts`

- [ ] Write failing tests for every request discriminant and for serialization limits.
- [ ] Route `rlm-request` to the worker-local `RLMContextManager`.
- [ ] Serialize stores/sections inside the worker before `respond()`; store lists contain metadata only,
      store details cap section metadata at 1,000, and section content remains empty unless an existing IPC
      contract explicitly requires a bounded preview.
- [ ] Extend store serialization to accept the authoritative section count from hydration state so a
      deferred store is marked truncated rather than appearing empty.
- [ ] Return load/residency stats through the stats request.
- [ ] Reject unknown request kinds rather than falling through to an empty success.
- [ ] Run the worker request-handler and worker-main tests.

### Task 3.3: Replace main's direct RLM IPC manager with the worker port

**Files:**

- Modify: `src/main/ipc/learning-ipc-handler.ts`
- Modify: `src/main/ipc/learning-ipc-handler.spec.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`

- [ ] Change `RegisterLearningHandlersDeps` to accept an `rlmPort`, defaulting to
      `getContextWorkerClient()`.
- [ ] Remove the main-process `RLMContextManager` import and all direct method calls.
- [ ] Keep validation and trusted-sender checks in main before invoking the worker.
- [ ] Preserve every existing channel, request schema, error code, and `IpcResponse` shape.
- [ ] Replace singleton mocks with a worker-port mock and retain all existing validation/trust tests.
- [ ] Add a table-driven parity test covering every RLM channel and expected request discriminant.
- [ ] Add a test proving handler registration does not import or instantiate `RLMContextManager`.
- [ ] Run `npm run test:quiet -- src/main/ipc/learning-ipc-handler.spec.ts`.

### Task 3.4: Remove the pre-initialization orchestration ownership route

**Files:**

- Modify: `src/main/instance/instance-context-port.ts`
- Modify: `src/main/instance/instance-orchestration.ts`
- Modify: `src/main/instance/instance-manager.ts`
- Modify: `src/main/instance/context-worker-protocol.ts`
- Modify: `src/main/instance/context-worker-client.ts`
- Modify: `src/main/instance/context-worker-main.ts`
- Modify: `src/main/instance/instance-orchestration.fast-path.spec.ts`
- Modify: `src/main/instance/context-worker-client.spec.ts`
- Modify: `src/main/instance/__tests__/context-worker-client.spec.ts`
- Modify: `src/main/instance/__tests__/context-worker-main.spec.ts`

- [ ] Add a failing regression test proving construction of `InstanceOrchestrationManager` does not
      import or call `getUnifiedMemory()` and does not instantiate `RLMContextManager` in main.
- [ ] Add `recordTaskOutcome(taskId: string, success: boolean, score: number): void` to
      `InstanceContextPort` and a clone-safe fire-and-forget worker message for it.
- [ ] Add `recordTaskOutcome` to `OrchestrationDependencies`; have `InstanceManager` delegate it to
      its existing context port and have the context worker call its worker-local unified memory
      controller.
- [ ] Remove the `getUnifiedMemory` import and eager `unifiedMemory` field from
      `InstanceOrchestrationManager`; preserve the existing outcome-tracker and habit-tracker writes.
- [ ] Add tests proving one completed child emits exactly one worker outcome message with unchanged
      task ID, success, and score, including safe handling when the worker is unavailable.
- [ ] Run the orchestration and context-worker focused specs.

---

## Phase 4 — Remove main's duplicate owner and bound event transport

### Task 4.1: Remove eager main-process bootstrap

**Files:**

- Modify: `src/main/bootstrap/memory-bootstrap.ts`
- Modify: `src/main/bootstrap/memory-bootstrap.spec.ts`

- [ ] Add a failing test that initializes the RLM bootstrap module and proves
      `getRLMContextManager()` is never resolved.
- [ ] Remove only the `getRLMContextManager()` import/call. Keep episodic store, smart compaction,
      summarization-worker initialization, and teardown behavior intact.
- [ ] Run the focused bootstrap test.

### Task 4.2: Introduce bounded worker event DTOs and a main relay

**Files:**

- Create: `src/main/instance/context-worker-event-relay.ts`
- Create: `src/main/instance/context-worker-event-relay.spec.ts`
- Modify: `src/main/instance/context-worker-protocol.ts`
- Modify: `src/main/instance/context-worker-event-forwarding.ts`
- Modify: `src/main/instance/context-worker-event-forwarding.spec.ts`

- [ ] Replace `event: string; payload: unknown` for RLM events with an explicit discriminated union.
- [ ] Write failing tests proving forwarded store/section events have empty content and bounded arrays
      before `transport.postMessage()`.
- [ ] Normalize the four existing RLM events worker-side. Cap store snapshots at 500 section-metadata
      records, query result text at 100,000 characters, accessed-section IDs at 500, and nested
      sub-queries at 20 total nodes. Do not forward callback-bearing
      `summarize:request` or `sub_query:request` events.
- [ ] Add one process-local relay singleton/helper that contains no RLM manager import.
- [ ] Change main-side dispatch to publish RLM events to the relay. Leave skill activation and
      wake-context behavior unchanged.
- [ ] Add a negative test proving dispatch cannot instantiate an RLM context.
- [ ] Run the forwarding and relay tests.

### Task 4.3: Subscribe renderer wiring and indexing gateway to the relay

**Files:**

- Modify: `src/main/ipc/ipc-main-runtime-wiring.ts`
- Create: `src/main/ipc/ipc-main-runtime-wiring.spec.ts`
- Modify: `src/main/indexing/codebase-indexing-lane-gateway.ts`
- Modify: `src/main/indexing/codebase-indexing-lane-gateway.spec.ts`

- [ ] Add failing tests proving worker and indexing-lane RLM DTOs reach the existing renderer channels
      without a main context manager.
- [ ] Replace `setupRlmEventForwarding()`'s singleton subscription with relay subscriptions.
- [ ] Preserve high-volume `codebase-auto` suppression and current renderer payload shapes.
- [ ] Update the indexing gateway to dispatch into the same relay.
- [ ] Ensure listener registration is idempotent and teardown/reset support prevents duplicate pushes
      in tests or app reinitialization.
- [ ] Run the focused runtime-wiring and indexing-gateway tests.

### Task 4.4: Add an ownership regression test

**Files:**

- Create: `src/main/instance/rlm-process-ownership.spec.ts`

- [ ] Statically import the main bootstrap/IPC/relay/orchestration modules under mocks and assert none
      resolves `../rlm/context-manager` or `getUnifiedMemory()`.
- [ ] Start a fake context worker client, register learning handlers/runtime wiring, deliver an RLM
      event, and prove exactly one worker-side owner is requested while main remains a facade.
- [ ] Allow the explicit worker entrypoints (`context-worker-main.ts`,
      `codebase-indexing-lane-main.ts`) and RLM implementation/tests to import the manager.
- [ ] Add an `rg` assertion or equivalent source-level guard for new production main-resident call
      sites, with an allowlist documented in the test.
- [ ] Run the ownership test.

#### Review-driven ownership remediation (added 2026-09-01)

The first fresh Task 4.4 review proved that the original file list omitted live Electron-main owner
routes. Task 4.4 is therefore widened before closure; a green allowlist over those routes is not
acceptable evidence of single ownership.

**Additional files:**

- Modify: `src/main/ipc/memory-ipc-handler.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`
- Modify: `src/main/instance/instance-manager.ts`
- Modify: `src/main/instance/instance-deps.ts`
- Modify: `src/main/instance/context-worker-protocol.ts`
- Modify: `src/main/instance/context-worker-client.ts`
- Create: `src/main/instance/unified-memory-worker-port.ts`
- Create: `src/main/instance/unified-memory-worker-request-handler.ts`
- Modify: `src/main/instance/context-worker-main.ts`
- Modify: `src/main/indexing/codebase-indexing-auto-defaults.ts`
- Modify: `src/main/indexing/codebase-indexing-auto-coordinator.ts`
- Modify: `src/main/indexing/indexed-codebase-context.ts`
- Modify: `src/main/background-jobs/process-lane-gateway.ts`
- Modify: `src/main/indexing/codebase-indexing-lane-gateway.ts`
- Modify: `src/main/indexing/codebase-indexing-lane-main.ts`
- Modify: `src/main/indexing/codebase-file-watcher.ts`
- Modify: `src/main/ipc/handlers/codebase-handlers.ts`
- Modify the corresponding focused specs and import-isolation tests.

- [x] Move all 13 legacy unified-memory renderer operations behind a separate clone-safe context-worker
      port while preserving channels, validation, error codes, and `IpcResponse` shapes.
- [x] Make `InstanceManager` default to the existing context-worker port rather than constructing an
      `InstanceContextManager` fallback in Electron main; retain explicit injected test ports.
- [x] Replace the main `instance-deps` memory barrel import with the concrete memory-monitor module.
- [x] Make auto-index store creation/discovery and indexed prompt-context lookup use bounded async
      worker RPC, with the existing deterministic store-ID fallback when the worker is unavailable.
- [x] Route codebase handler and file-watcher indexing work through the indexing-lane gateway; no main
      registration or watcher constructor may resolve `CodebaseIndexingService`.
- [x] Make the codebase-indexing lane transient per job: terminal success, failure, or cancellation
      sends shutdown, awaits exit/termination, clears the handle, and the next job spawns a fresh lane.
- [x] Replace path-only owner allowlisting with an entrypoint-rooted runtime import/factory-call guard
      that rejects every owner factory reachable from Electron main and permits exact worker/lane
      roles only. Cover static imports, re-exports, import-equals, literal dynamic imports/requires,
      aliases, factory calls, and stale manifest entries.
- [x] Add a bootstrap-level behavioral ownership test covering real memory/codebase handler
      registration, auto-index/file-watcher initialization, and `InstanceManager` default composition
      under trapped owner factories.

---

## Phase 5 — Observability and resource regression coverage

### Task 5.1: Expose and log residency stats

**Files:**

- Modify: `src/main/rlm/context-manager.ts`
- Modify: `src/main/instance/context-worker-main.ts`
- Modify: `src/main/instance/context-worker-client.ts`
- Modify: `src/main/instance/context-worker-protocol.ts`
- Modify: `src/main/instance/context-worker-client.spec.ts`
- Modify: `src/main/instance/__tests__/context-worker-client.spec.ts`

- [x] Emit one structured load summary after persistence initialization, including process role,
      counts, `startupContentBytes: 0`, exhausted dimensions, and elapsed time.
- [x] Emit hot-prewarm started/completed/cancelled summaries with candidate/admitted/skipped counts,
      residency totals, and elapsed time.
- [x] Emit semantic-delta summaries with missing/indexed/skipped/failed/retried section counts and no
      content, query text, or paths.
- [x] Add the residency snapshot to worker metrics/RLM storage stats without changing existing fields.
- [x] Ensure logs contain no section content, query text, or secret-bearing paths.
- [x] Add tests for zero-data, within-budget, exhausted-budget, and reload snapshots.
- [x] Run the focused diagnostics and worker metrics tests.

### Task 5.2: Add a realistic aggregate-load regression fixture

**Files:**

- Create: `src/main/rlm/context-persistence-loader.integration.spec.ts`

- [x] Build a temporary synthetic RLM database with enough individually-small stores to exceed every
      aggregate dimension. Never use or mutate James's live RLM database.
- [x] Assert constructor-time content reads and residency are exactly zero, hot selection excludes
      stores older than 48 hours, strict residency counters never exceed their limits, hydration is
      correct, and reload never doubles residency.
- [x] Seed durable vectors for one store and omit one section vector; prove restart plus semantic query
      reads/embeds only the missing section.
- [x] Record peak heap only as diagnostic evidence; make deterministic counters the pass/fail rule.
- [x] Run the integration spec alone and check it completes without spawning nested full suites.

---

## Phase 6 — Verification and completion

### Task 6.1: Run focused regression groups

- [x] Confirm no stale Vitest run before starting.
- [x] Run the loader/database/residency tests.
- [x] Run lexical-index-retirement, context manager, vector-delta, and semantic-indexing tests.
- [x] Run context-worker protocol/client/main/forwarding tests.
- [x] Run learning IPC, runtime-wiring, indexing-gateway, bootstrap, and ownership tests.
- [x] Fix implementation defects; do not weaken assertions to make failures pass.

### Task 6.2: Run the canonical repository gates

Run, in order, with no concurrent full Vitest suite:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run test:quiet
```

- [x] Record current output and exit status for all six gates.
- [x] If the full suite exposes load-sensitive failures, diagnose them; do not mask them by leaving an
      orphaned run or permanently reducing coverage.

### Task 6.3: Rebuilt-app live verification

Deferred rebuilt-app checks, exact evidence steps, and cleanup requirements are recorded in
[2026-08-30-rlm-global-budget-single-owner_livetest.md](./2026-08-30-rlm-global-budget-single-owner_livetest.md).
They require restarting the Harness process that hosts this task against the existing non-isolated
RLM profile; no code, test, build, or other agent-runnable verification is deferred.

### Task 6.4: Fresh-eyes completion gate

- [x] Start a genuinely fresh agent context that did not implement the work.
- [x] Require it to use `task-completion-gate` and independently review the merge-base-to-HEAD diff,
      acceptance criteria, architecture, test integrity, security, async/state behavior, performance,
      and renderer behavior.
- [x] Fix every actionable finding, rerun affected focused and canonical checks, then send the updated
      work to another fresh completion-gate pass.
- [x] Repeat until the verdict is `VERDICT: PASS` with no unresolved actionable findings.

### Task 6.5: Close the documentation lifecycle

- [x] Update this plan and the linked spec with as-built decisions and verification evidence.
- [x] If live checks were deferred, move them into the linked livetest document before closing this
      plan.
- [x] Rename this file to
      `2026-08-30-rlm-global-budget-single-owner_plan_completed.md`.
- [x] Update the spec's plan link and rename the spec to
      `2026-08-30-rlm-global-budget-single-owner_spec_completed.md`.
- [x] Verify no active `_plan.md` or `_spec_planned.md` version remains.
- [x] Do not stage or commit unless James separately requests it.

## As-built evidence — 2026-09-02

- Startup now retains store shells, active sessions, authoritative counts, and hydration state with
  zero constructor-time section content. One controller owns global metadata/content byte, section,
  store, and per-store admission; active-session protection, LRU eviction, reload clearing, and
  generation-fenced prewarm are covered by focused tests.
- The unused lexical term map is removed. Bloom filters remain lazy and eviction-owned; semantic
  repair uses durable vector absence as its checkpoint and keeps missing/indexed/skipped/failed/retried
  terminal accounting reconcilable across deletion, retry, failure, and stale generations.
- Renderer RLM operations, unified-memory operations, prompt-context lookup, auto-indexing, and live
  events use bounded typed worker/lane boundaries. Electron main cannot reach an interactive owner;
  the transient indexing lane retires its exact process after every terminal path.
- The semantic ownership guard is entrypoint-rooted with exact worker/lane manifests and covers
  imports, re-exports, dynamic/CommonJS forms, aliases, dataflow, cycles, and bootstrap behavior.
  Bootstrap resource acquisition/disposal is transactional and shared across real registrations.
- Structured load/prewarm/delta diagnostics expose one clone-safe metadata-only residency snapshot.
  The aggregate fixture uses a temporary native SQLite file to exceed every budget and prove a real
  close/reopen plus one-gap semantic repair; its child is time-bounded and denies live network I/O.
- Phase 6 focused groups passed 74/74, 60/60, 205/205, and 528/528 tests. Under official Node 24.15.0,
  both TypeScript checks, lint, LOC, `build:main`, and the full suite passed; the full suite covered
  1,872 files and 20,455 tests in 145.1 seconds. The fresh final completion gate repeated the groups
  and canonical sequence and returned `VERDICT: PASS` with no actionable findings.
- The rebuilt/current-profile runtime checks were not claimed as passed. They are isolated with exact
  evidence and cleanup steps in
  [2026-08-30-rlm-global-budget-single-owner_livetest.md](./2026-08-30-rlm-global-budget-single-owner_livetest.md).

## Final completion checklist

- [x] Immediate stale-process/simulator preflight completed safely.
- [x] Aggregate metadata/content/store budgets enforced and measured.
- [x] Startup is metadata-only with exactly zero section-content residency.
- [x] Post-ready hot prewarm is restricted to active-session and 48-hour stores and is cancellable.
- [x] Deferred stores retain functional parity through guarded hydration.
- [x] Unused in-memory lexical term indexing is retired with lexical-search parity preserved.
- [x] Semantic repair reads and embeds only sections missing durable vectors.
- [x] Renderer RLM IPC uses the context worker with unchanged public contracts.
- [x] Main bootstrap and event wiring cannot instantiate `RLMContextManager`.
- [x] Worker event payloads are bounded before structured clone.
- [x] Indexing lane obeys the same policy and remains transient.
- [x] Focused tests and all six canonical gates pass.
- [x] Rebuilt-app acceptance passes or is precisely recorded in a pending livetest document.
- [x] Fresh independent completion gate returns `VERDICT: PASS`.
- [x] Plan/spec lifecycle is closed accurately, with no completion claim before evidence.
