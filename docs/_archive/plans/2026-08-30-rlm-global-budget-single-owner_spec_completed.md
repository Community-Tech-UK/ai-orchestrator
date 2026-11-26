# RLM Global Loading Budget and Single-Owner Architecture — Specification

**Status:** Completed — implementation and agent-runnable verification passed; rebuilt-app/current-
profile acceptance remains pending in the linked live-test document
**Date:** 2026-08-30
**Revised:** 2026-09-02 — as-built architecture and verification evidence recorded
**Owner:** James
**Implementation plan:** [2026-08-30-rlm-global-budget-single-owner_plan_completed.md](./2026-08-30-rlm-global-budget-single-owner_plan_completed.md)

---

## 1. Problem

Harness currently creates a full persisted `RLMContextManager` in both the context worker and the
Electron main process. Each constructor eagerly reads the same 4.2 GB RLM database into JavaScript
objects. The current loader limits an individual store, but it has no aggregate ceiling across all
stores.

The observed production database makes the per-store rule ineffective as an application-wide
safeguard. A fresh 2026-09-01 read-only measurement found:

- 1,599 stores and 367,310 sections exist in the database.
- 1,559 stores pass every current per-store eager-content gate.
- Those individually-small stores collectively represent 691,411,462 recorded bytes, 189.8 million
  tokens, and 256,768 section objects eligible for eager loading.
- The main process and context worker both had the RLM database open and each retained a multi-GB
  context graph.
- Main's V8 heap repeatedly reached 97–99%, producing long garbage-collection and event-loop stalls.
- A startup allocation profile attributed approximately 955 MiB to synchronous content reads,
  550 MiB to `updateSearchIndex()`, 196 MiB to section-row materialisation, and 1.3 GiB to the
  surrounding persistence loader. Main reached 3.47 GiB before `HarnessApp.initialize()` began.

The `ContextStore.searchIndex.terms` map built by `updateSearchIndex()` is not consulted by any live
query path. Lexical retrieval calls `executeGrep()` over the selected store's content, optionally
using a Bloom filter for a negative check. Semantic retrieval uses the separately persisted vector
store, which already loads vectors per store and skips section IDs that have durable vectors.
Rebuilding the in-memory term map at startup therefore consumes CPU and heap without serving a
query.

This is an ownership, lifecycle, and admission-control defect, not a lack-of-RAM defect. Per-store
limits cannot bound the sum, a worker boundary does not help when main reconstructs the same state,
and raising V8's heap limit cannot make synchronous unused indexing responsive.

## 2. Goals

1. Make the context worker the only long-lived owner of a full interactive RLM context.
2. Ensure no main-process startup, renderer IPC, or event-forwarding path instantiates
   `RLMContextManager`.
3. Bound persisted RLM hydration across all stores with deterministic global limits.
4. Make startup metadata-only: no section content, Bloom filter, lexical term map, or semantic
   embedding work may run in an `RLMContextManager` constructor.
5. Keep deferred stores usable through metadata/content hydration on demand without changing the
   renderer IPC contract.
6. Retire the unused in-memory lexical term index instead of persisting or incrementally rebuilding
   it.
7. Warm only active-session and recently used stores after startup, using a 48-hour hot window and
   the same global residency budget.
8. Repair semantic-vector gaps on demand by indexing only sections that do not already have a
   durable vector row.
9. Bound worker-to-main event payloads before structured cloning.
10. Add measurements that make RLM residency, deferral, budget exhaustion, hot prewarm, and
   delta-index activity visible.
11. Preserve codebase indexing as an isolated, transient lane while making it obey the same load
   policy whenever it constructs an RLM context.

## 3. Non-goals

- Deleting or pruning James's RLM data.
- Changing the RLM storage-maintenance retention policy.
- Removing the RLM context worker or moving SQLite onto the Electron UI thread.
- Introducing a new persisted lexical index or FTS5 table. The live lexical path remains
  `executeGrep()` over on-demand hydrated content.
- Imposing the persisted-load budget on newly-created in-session content in this change. Runtime
  growth needs separate backpressure and retention policy; this work bounds rehydration of existing
  data and prevents duplicate residency.
- Erasing simulator devices or simulator data.
- Treating unrelated Chrome, VS Code, Spotlight, or WindowServer load as part of this fix.

## 4. Root cause and confirmed entry points

`RLMContextManager` eagerly runs `loadPersistedContextState()` from its constructor. The context
worker legitimately creates one owner, but main currently creates another through three independent
routes:

1. `src/main/bootstrap/memory-bootstrap.ts` calls `getRLMContextManager()` during startup.
2. `src/main/ipc/learning-ipc-handler.ts` calls `RLMContextManager.getInstance()` while registering
   renderer RLM handlers.
3. `src/main/ipc/ipc-main-runtime-wiring.ts` and
   `src/main/instance/context-worker-event-forwarding.ts` instantiate/re-emit through a main-local
   singleton solely to bridge worker events to the renderer.

Fixing only event forwarding would leave the bootstrap and renderer IPC routes capable of rebuilding
the duplicate context. All three routes must be removed.

The earliest main-process entry is even earlier than bootstrap: `InstanceManager` constructs
`InstanceOrchestrationManager`, whose `unifiedMemory` field calls `getUnifiedMemory()`. The unified
memory constructor calls `RLMContextManager.getInstance()`, which synchronously hydrates persistence.
The single-owner rule must remove this main-resident dependency as well; otherwise the app can reach
multi-gigabyte heap usage before its logged initialization sequence starts.

## 5. Architecture

### 5.1 Process ownership

The context worker is the sole long-lived interactive RLM owner:

```text
Renderer RLM IPC
      |
      v
Electron main: validation + trusted-sender check + typed RPC client
      |
      v
Context worker: RLMContextManager + SQLite + vector/LLM services
      |
      +---- bounded event DTOs ----> main event relay ----> renderer channels
```

Main keeps only:

- the existing context-worker client;
- a typed RLM RPC facade;
- a lightweight `EventEmitter` relay containing bounded DTOs;
- renderer validation, trust checks, and response-envelope handling.

Main must not import `RLMContextManager` or call `getUnifiedMemory()` in production-resident
orchestration, bootstrap, IPC, or relay modules. Raw database utilities that do not create a context
graph, such as storage maintenance, remain allowed.

The first ownership-gate review also found active main-resident routes outside the original three
call sites: unified-memory IPC registration, auto-index defaults, codebase IPC/file-watcher
construction, indexed prompt-context lookup, the `InstanceManager` local fallback, and a wildcard
memory barrel import. These are part of the same single-owner boundary and must be migrated rather
than allowlisted. Legacy unified-memory renderer operations use a separate clone-safe context-worker
port; codebase mutations and queries that require `CodebaseIndexingService` use the indexing lane.
Internal store discovery may add bounded async RLM worker lookups without changing renderer channels.

The codebase-indexing lane remains a transient worker-local RLM owner because indexing writes through
the manager. It must use the same global load policy and must exit after the lane job. Consolidating
the indexing lane into the context worker is not required for this fix.

Transient means per job, not merely "exits after a later global shutdown": after every terminal
success, failure, or cancellation the gateway requests lane shutdown, awaits clean exit or bounded
termination, clears the process handle, and starts a fresh process for the next job.

### 5.2 Renderer RLM RPC

Add a clone-safe discriminated `RlmWorkerRequest`/`RlmWorkerResult` contract to the existing context
worker protocol. The current renderer operations move unchanged behind that boundary:

- create/delete/get/list stores;
- add/remove/list sections;
- start/end/get/list sessions;
- execute query;
- store/session/storage/query/token-savings stats;
- configure.

The worker serializes `ContextStore` and `ContextSection` before posting a response so full content or
unbounded arrays never enter structured clone. The main handler retains the current Zod validation,
trusted-sender checks, IPC channel names, and `IpcResponse` shape.

Mutating RPCs must reject on timeout and must not be automatically retried. A timeout can occur after
the worker has committed a write; silently treating it as success or retrying an add-section request
could duplicate data. The UI may refresh authoritative state after an error.

### 5.3 Worker event relay

Replace main's singleton re-emission with a dedicated process-local relay. Worker-side forwarding
converts events to explicit DTOs before `postMessage`:

- `store:created`: store metadata with no sections or section content;
- `section:added`: store ID, section metadata with empty content, a high-volume flag, and a store
  snapshot capped at 500 section-metadata records;
- `section:removed`: store ID, section ID, a high-volume flag, and the same capped store snapshot;
- `query:executed`: session ID plus a query result whose result text, accessed-section IDs, and nested
  sub-query tree are capped by named serialization constants.

`ipc-main-runtime-wiring.ts` subscribes to the relay, not `RLMContextManager`. The indexing-lane
gateway publishes into the same relay. Skill-activation and wake-context forwarding keep their
existing behavior.

### 5.4 Metadata-only startup and global residency policy

`loadPersistedContextState()` loads only store shells, active-session rows, authoritative section
counts, and hydration state. It must not query `content_inline`, read external content files,
materialize section arrays, build Bloom filters, construct lexical indexes, or create embeddings.
The constructor returns with zero resident section-content bytes.

The residency policy applies globally to one worker, not separately to each store:

```ts
export const DEFAULT_RLM_RESIDENCY_POLICY = {
  hotWindowMs: 48 * 60 * 60 * 1000,
  maxResidentSectionMetadata: 50_000,
  maxResidentContentBytes: 64 * 1024 * 1024,
  maxResidentContentSections: 20_000,
  maxResidentContentStores: 128,
  maxSectionsPerStore: 5_000,
} as const;
```

All store shells remain resident so list/stats operations stay accurate. Section metadata and content
enter memory only through the residency controller. A separate grouped count query supplies each
store's authoritative total section count without loading section rows. Metadata projections exclude
`content_inline`; content is fetched only after a store and section have been admitted to the global
budget. Actual UTF-8 byte length is checked after each read and retained only if it fits.

### 5.5 Deferred hydration and 48-hour hot prewarm

`RLMContextManager` tracks per-store hydration state separately from public `ContextStore.config`.
Before an operation that needs section metadata or content, it calls an idempotent hydration guard:

- metadata: `listSections`, store detail, removal, export;
- content: query execution, lexical search, Bloom-filter construction, semantic gap repair, export.

The app becoming ready triggers a low-priority, cancellable prewarm. Prewarm never runs inside the
manager constructor and yields between stores so it cannot monopolize the worker event loop.
Candidate order is deterministic:

1. stores referenced by active sessions, newest session activity first;
2. remaining stores whose `last_accessed` or `created_at` is within the last 48 hours, newest first;
3. stable `store.id ASC` tie-breaker.

Prewarm hydrates content only while every global ceiling remains available. It does not build a
lexical index or generate embeddings. Stores outside the hot window remain metadata-only until first
use. On-demand hydration may evict the least-recently-used persisted content and Bloom filters until
the request fits. Active-session stores are protected while their sessions are active. Stores over
the existing 25 MB/2M-token/5,000-section large-store gates stay metadata-only and use bounded lazy
section reads.

`reloadFromPersistence()` clears hydration, LRU, Bloom-filter, and pending-work state before loading
new shells. It must not momentarily retain both old and new context graphs. Renderer serialization
receives the authoritative total section count from hydration state, so a deferred store is reported
as deferred rather than falsely appearing empty.

### 5.6 Index policy: remove eager lexical indexing and repair semantic deltas

Remove `ContextStore.searchIndex`, `SearchIndex`, `TermLocation`, `createSearchIndex()`, and
`updateSearchIndex()` after a whole-repository negative-use check. Preserve the public
`indexedTerms` analytics field for compatibility, returning zero with a deprecation comment until a
separate contract change removes it. Lexical operations continue to use `executeGrep()` over the
one selected, hydrated store. A Bloom filter may be built lazily for that resident store and is
discarded with its content on eviction.

Semantic vectors already provide a durable per-section checkpoint: a vector row is keyed by the
immutable section ID, new sections add vectors, and section removal deletes its vector. Replace the
process-local "index the whole store once" scan with a database query that returns only depth-zero
sections lacking a vector row. On the first semantic query for a store, fetch content and embed only
those missing sections. Existing vector rows require no content read or embedding. Advance no
startup timestamp or speculative checkpoint; a failed or interrupted embedding leaves the vector
row absent, so the next semantic query retries precisely that section.

This is safer than "changed since the last but one startup": durable section/vector membership is
the committed change ledger and is independent of clean shutdown, clock skew, or how many times the
app started.

## 6. Observability

Every persistence load emits one structured summary containing:

- total stores and active sessions discovered;
- startup section-content bytes (required to be zero);
- resident/deferred section-metadata counts;
- resident-content bytes, sections, and stores;
- hot-window candidate, admitted, skipped, and cancelled counts;
- semantic delta sections discovered, indexed, skipped, failed, and retried;
- metadata-only and deferred-store counts;
- budget-exhausted flags by dimension;
- elapsed load time;
- process role (`context-worker` or `indexing-lane`).

Expose the same snapshot through the worker metrics/RLM stats RPC. Do not log section content, query
text, or paths beyond existing logging policy.

## 7. Immediate relief preflight

At plan creation time, a fresh read-only check found no Vitest process and no booted simulator. The
implementation run must check again before starting tests:

1. Identify any Vitest PID by command, working directory, parent, and elapsed time.
2. Stop only a confirmed stale/orphaned run belonging to this repository, using graceful termination
   first; revalidate the PID before any forced termination.
3. Shut down only booted, unused simulators. Never erase devices or simulator data.
4. Verify both conditions after cleanup and avoid overlapping full test-suite runs.

This operational step changes no source and is not evidence that the durable fix works.

## 8. Acceptance criteria

### Ownership

- No production main-resident orchestration, bootstrap, IPC, or relay module imports or calls
  `RLMContextManager.getInstance()` or `getUnifiedMemory()`.
- The context worker serves all renderer RLM operations with unchanged channel and response shapes.
- Main receives live RLM updates without constructing an RLM context.
- The indexing lane remains transient and obeys the same load policy.

### Budget

- A fixture containing many individually-small stores cannot exceed any aggregate limit.
- `RLMContextManager` construction reads zero section-content bytes and builds no lexical or semantic
  index.
- Hot prewarm begins only after app readiness, considers no non-active store older than 48 hours,
  and orders active-session stores first, then recency, with stable ID tie-breaking.
- Metadata queries do not select inline content columns.
- Deferred stores are distinguishable from empty stores and become usable on first relevant access.
- Reload clears old residency before loading new state.

### Indexing

- No production code creates or updates `ContextStore.searchIndex.terms`.
- Lexical search parity passes with the in-memory term index absent.
- An unchanged store with durable vectors performs zero content reads and zero embedding calls on its
  first semantic query after restart.
- Adding one section causes exactly that missing section to be embedded; a failed embedding remains
  eligible for retry; removing a section removes its vector.

### Payload safety

- Worker event messages contain no section content and no unbounded store/session arrays.
- Renderer live updates remain functionally equivalent for ordinary stores.
- High-volume codebase stores remain suppressed from per-section renderer pushes.

### Live resource target

Against James's existing approximately 4.2 GB RLM database after a rebuilt-app restart:

- exactly one long-lived interactive RLM owner is reported;
- startup content residency is zero; post-ready residency never exceeds 64 MiB and section metadata
  never exceeds 50,000;
- hot prewarm touches only active-session or 48-hour stores and remains cancellable/responsive;
- no eager lexical index is built and an unchanged semantic store produces zero embedding work;
- the Electron main heap remains below its warning threshold during a 10-minute idle period and a
  representative RLM query;
- no RLM-startup event-loop stall exceeds 5 seconds;
- renderer store listing, section listing, one lexical query, one semantic query, add/remove section,
  and live-update delivery all pass.

Machine-specific RSS is recorded as evidence but is not the primary correctness assertion; strict
residency counters and absence of a duplicate owner are deterministic.

## 9. Risks and safeguards

- **RPC behavior drift:** retain the renderer schemas and response envelopes; add parity tests for
  every moved channel.
- **Silent empty deferred stores:** explicit hydration state; never infer hydration from
  `sections.length === 0`.
- **Structured-clone spikes:** serialize in the worker before posting; test payload size/content.
- **Write timeout ambiguity:** reject, never auto-retry; refresh state after error.
- **Search regressions:** hydrate before lexical/semantic/index operations and retain existing
  large-store behavior.
- **Hot-window clock semantics:** use a captured prewarm cutoff and stable database timestamps;
  correctness never depends on the window because any store can hydrate on demand.
- **Semantic crash gaps:** use absence of the durable section vector as the retry signal; do not write
  a separate success marker before the vector row exists.
- **Dead-index compatibility:** preserve external stats shapes while retiring only the unused
  internal term map; lexical parity tests remain unchanged.
- **Eviction races:** serialize hydration/eviction mutations inside the worker and protect
  active-session stores.
- **Dirty worktree:** touch only the files named in the implementation plan and preserve all unrelated
  user changes.

## 10. Completion evidence

Implementation is complete only after targeted tests, the repository's canonical verification gates,
a rebuilt-app live check, and a fresh independent `task-completion-gate` review all pass. If the live
check requires a restart unavailable in the implementation session, record it in a linked
`*_livetest.md` document under the repository's live-test deferral rules; do not claim it passed.

## 11. As-built result

The implementation matches this architecture with three evidence-backed refinements:

1. The single-owner boundary covers every main-resident route discovered during implementation,
   including unified-memory IPC, default instance composition, auto-indexing, prompt-context lookup,
   file watchers, and codebase handler registration. A semantic entrypoint-rooted ownership guard and
   real bootstrap behavior tests enforce the exact context-worker/indexing-lane owner manifest.
2. `maxSectionsPerStore` is consumed by both loader eligibility and controller admission. The
   controller rechecks authoritative projected metadata counts, so a changed count cannot bypass the
   per-store or aggregate policy between discovery and hydration.
3. Residency observability is one controller-owned, generation-fenced, clone-safe snapshot. Public
   metrics retain counts/reasons but no store identifier, content, query text, secret, or path. Semantic
   terminal results keep missing/indexed/skipped/failed/retried distinct and reconcilable.

Verification completed on 2026-09-02:

- focused groups passed 74/74 loader/database/residency tests, 60/60 lexical/context/vector/semantic
  tests, 205/205 worker protocol/client/main/forwarding tests, and 528/528 IPC/runtime/indexing/
  bootstrap/ownership tests;
- official Node 24.15.0 passed both TypeScript checks, lint, the TypeScript LOC ratchet,
  `build:main`, and the full 1,872-file/20,455-test suite;
- the realistic aggregate fixture passed repeated native file-backed close/reopen, every configured
  budget dimension, bounded child termination, denied live network, and exactly-one-gap vector repair;
- a genuinely fresh `task-completion-gate` review repeated the focused and canonical verification and
  returned `VERDICT: PASS` with no unresolved actionable findings.

The rebuilt-app checks over James's existing RLM profile are deliberately not claimed as passed.
They remain pending with exact prerequisites, evidence, privacy, and cleanup steps in
[2026-08-30-rlm-global-budget-single-owner_livetest.md](./2026-08-30-rlm-global-budget-single-owner_livetest.md).
