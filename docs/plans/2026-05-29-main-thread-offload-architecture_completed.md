# Main-Thread Offload — Architecture Remediation Plan

- Date: 2026-05-29
- Status: Completed, with project-memory-brief tracked separately and heap-growth investigation still ongoing
- Scope: Eliminate Electron main-process event-loop stalls ("beachballs") on instance create, resume, and message send.

## 1. Why this is happening (and why it's still synchronous)

The beachballs are the Electron main-process event loop being blocked by synchronous work. `better-sqlite3` is a synchronous binding by design, so any query on the main process freezes every window until it returns. Heavy synchronous CPU (FTS scoring, MCP tool-search scoring, per-hint update loops, large JSON) does the same.

We only ever offloaded one subsystem (RLM / unified memory) to a worker thread, and even that was not wired into `InstanceManager` until recently, and was crash-looping in the packaged build (a top-level `import { app } from 'electron'` in `rlm-database.ts` cannot resolve inside a worker thread in `app.asar`). Every other subsystem still runs its SQLite and CPU work directly on the main process. There has never been a systemic rule that "no DB or heavy CPU runs on the main event loop." This plan establishes that rule and sequences the migration.

## 2. Evidence

From `diagnostics/watchdog-report.json` and `app.log` (post-rebuild run):

- Main-process stalls of 2.3s, 3.6s, 14.9s, plus multi-minute event-loop gaps (some are likely GC pauses or machine sleep).
- `contextWorkerDegraded: true`, caused by the worker crash above (now fixed, uncommitted).
- The pre-fix RLM build blocked the main thread for 38.5s (worst case 176s); gone after wiring RLM to the worker.
- RSS ~2.6GB with the V8 heap pinned near its limit, so GC pressure is amplifying every stall.

## 3. Target architecture

Principle: no `better-sqlite3` query, no heavy CPU (embeddings, FTS, similarity, large JSON parse/stringify), and no unbounded synchronous filesystem walk runs on the Electron main-process event loop on any user-facing hot path.

Rules:

- All such work runs in a worker thread (a dedicated worker that owns the relevant DB connection, or a background-jobs lane), reached through an async gateway.
- Every gateway call is deadline-bounded and returns null/empty on timeout, never blocking the caller. We generalize the 500ms race already used for RLM context into one helper.
- The main process keeps only cheap, bounded, synchronous work (orchestration, small in-memory lookups).
- A regression guard fails loudly when a hot path blocks the loop beyond a threshold.

## 4. Inventory of main-thread blockers

### 4.1 Conversation ledger + transcript bridge (worst — fires during every active session)

- `chat-transcript-bridge.ts` `onProviderEvent` runs on every settled provider event (assistant message, tool_use, tool_result, error; streaming chunks are skipped). Per event, all synchronous on the main process: `chatStore.getByInstanceId` + `chatStore.get` (reads) then `ledger.appendMessageReturningRecord` (findThreadById + countMessages + upsert + thread touch) then `chatStore.update` (write). ~6 synchronous SQLite ops per event, dozens to hundreds per agentic turn, growing with conversation length. This is the streaming-time bleed.
- `conversation-ledger-service.sendTurn` (IPC send path): `getMessages` (reads the whole thread) + `upsertMessages` + `upsertThread`, synchronous.
- `getConversation` / `getMessages` (`conversation-ledger-store.ts:224`) load an entire thread unbounded; `listConversations` lists all threads. Hit on open-chat, list-chats, and startup.

### 4.2 Code retrieval (send + create/resume)

- `code-retrieval-service.search()` runs `cas-store.searchWorkspaceChunks` (BM25 FTS) plus a `getChunk` loop, synchronous on the main thread. Triggered by `buildInputContexts` (send) and `buildInitialRuntimeContextBlock` (create/resume, `instance-lifecycle.ts:772`). The index worker exists but exposes no search RPC, so search runs on main. Logged ~2s.

### 4.3 Instance create/resume prompt assembly (`instance-lifecycle.ts` ~1061-1180)

- Wake-up context: `getWakeUpText` is synchronous (`instance-lifecycle.ts:1118`); it reads hints from SQLite and runs a per-hint `UPDATE usage_count` loop (`wake-context-builder.ts`).
- Observation reflections: `observation-store` reflections query.
- MCP tool selection: `getRuntimeToolContext` -> `getMCPToolSearchService().search()` is synchronous and scores every tool across every connected MCP server (scales with how many connectors are attached, and we have many).
- Indexed codebase context (see 4.2).

### 4.4 RLM / learning startup

- `outcome-tracker`, `metrics-collector`, `habit-tracker` load full tables synchronously on app startup (RLM db).

### 4.5 Chats store

- `chat-store.ts` list/get/update are synchronous SQLite, hit on startup, new-session, and per provider event (via the bridge).

### 4.6 Session continuity

- `session.save` logged as a 1.3s slow operation; session continuity save runs on the main thread.

## 5. Existing offload infrastructure to reuse

- Context worker (`context-worker-*`): owns the RLM SQLite connection; handles RLM/unified memory. Precedent for a worker owning a DB.
- Index worker (`index-worker-*`): owns the codemem SQLite connection; today only indexes/warms/status/cancel/rebuild, no search RPC. Best home for code FTS + symbol search.
- Background-jobs lanes (`background-jobs/`): a general-purpose worker-thread / child-process job framework with lanes (`indexing`, `embeddings`, `knowledge-mirror`, `maintenance`, `analysis`) and a `run-job` protocol. Ideal for one-off queries without standing up a new worker.
- LSP worker: specialized, not reusable here.

Routing recommendation:

- Code-index FTS/symbol search -> Index worker (add a `search-workspace-chunks` RPC).
- Conversation-ledger reads/writes -> dedicated Conversation worker (mirror the context-worker pattern; it must own the ledger DB and serialize writes), or a `ledger` background-jobs lane.
- MCP tool search -> background-jobs `analysis` lane, or precompute/cache plus a cheap lookup.
- Observation / memory-brief / wake context -> extend the context worker or a memory lane; bound and deadline.

## 6. Phased plan

Each phase is independently shippable and measurable via the watchdog stall logs.

### Phase 0 — Restore the existing offload (done / in-flight)

- [done, committed] Wire `getContextWorkerClient()` into `InstanceManager`.
- [done, committed] Worker resilience + logging (reset crash counter on recovery, restart cap 3, degradation logs).
- [done, uncommitted] Fix `rlm-database.ts` `electron` import so the context worker starts in the packaged build. Commit + rebuild to confirm `Context worker started` and `contextWorkerDegraded: false`.

### Phase 1 — Stop the streaming-time bleed (highest frequency)

- Status: implemented
- Make `chat-transcript-bridge` non-blocking: batch settled events in memory and flush writes through a worker/lane off the main thread; keep the renderer event emit immediate. Remove the per-event synchronous `chatStore` + `ledger` calls from the main loop.
- Target: zero synchronous ledger/chat-store writes on `provider:normalized-event`.

### Phase 2 — Code retrieval off-thread

- Status: implemented
- Add `search-workspace-chunks` (and symbol search) to the index-worker protocol/gateway; route `CodeRetrievalService.search()` through it. Keep the deadline so create/send never wait on it.

### Phase 3 — Create/resume prompt assembly

- Status: implemented for wake-context, observation reflections, and MCP tool search
- Move or bound wake-context (kill or batch the per-hint UPDATE loop; read off-thread), observation reflections, and MCP tool search. Assemble the system prompt from whatever returns within a deadline and inject the rest on the next turn (the RLM deferred-preamble pattern already exists).
- Project memory brief offload is tracked separately in `docs/plans/2026-05-31-project-memory-brief-offload-spec.md` because it needs a larger worker-safe core extraction.

### Phase 4 — Conversation-ledger reads off-thread + bounded

- Status: implemented
- Route `getConversation` / `listConversations` / `getMessages` through the ledger worker/lane. Bound `getConversation` to the last N messages (the output stream already paginates older messages via `loadOlderMessages`).

### Phase 5 — Startup learning loads

- Status: implemented
- Defer/lazy-load or worker-load `outcome-tracker` / `metrics-collector` / `habit-tracker` so startup doesn't block.

### Phase 6 — Session continuity save

- Status: implemented for queued autosave / non-critical persistence
- Make `session.save` incremental and/or off-thread.

### Cross-cutting

- Memory: capture a main-process heap snapshot to find the ~2.6GB growth; GC pressure amplifies every stall. Likely suspects: unbounded output buffers, retained provider events, listener leaks.
- Guardrail: extend the watchdog / SlowOperations to throw (dev) or warn loudly when any IPC handler or hot path blocks the loop beyond ~100ms; add an architecture check that hot-path main-process modules do not import `better-sqlite3` directly.
- Reusable helper: a single `callWithDeadline(workerCall, ms)` utility (generalizing the RLM race) so each migration is non-blocking by construction.

## 7. Risks and verification

- These are main-process worker changes that cannot be unit-tested for the beachball directly. Each phase: `tsc` + `vitest` on touched specs, then a packaged rebuild and a watchdog-log check (the watchdog plus the new ContextWorkerClient logging already give before/after stall numbers).
- Worker DB ownership: only one writer per SQLite file. When we move ledger writes to a worker, the main process must stop writing the ledger directly (route everything through the worker) to avoid two-writer contention.
- Sequence: Phase 1 first (most frequent), then 2 and 3 (create/resume), then 4-6. Each is shippable alone and should drop the stall counts measurably.

## 8. Status snapshot

- Fixed: transcript-bridge provider-event writes; code retrieval search RPC; wake-context offload; observation-reflection offload; MCP tool-search offload; bounded ledger reads with older-message pagination; startup learning hydration; queued session autosave; IPC timing guardrail; hot-path better-sqlite3 import boundary check.
- Still tracked separately: project-memory-brief offload spec and heap-growth investigation.

## 9. Database choice: do we switch off SQLite?

Short answer: no. Keep SQLite (better-sqlite3). The beachballs are a threading problem, not a database problem. `better-sqlite3` is synchronous by design (that is why it is the fastest Node SQLite binding); the fault is that we call it on the main event loop, not that SQLite is slow. The watchdog proves it: a synchronous call freezes the loop no matter which engine is behind it. Any database called synchronously on the main thread beachballs; any database called from a worker does not.

Why not switch the primary store:

- Postgres/MySQL: a server to bundle and run inside a desktop app, with network/IPC overhead and a large migration, and it still must be called off-thread. Overkill for a local single-user app.
- DuckDB: strong for analytical/columnar scans; our workloads are FTS, transcripts, key-value, and vectors, where SQLite's mature FTS5 and transactional model fit better. Not a clear win, big migration.
- Async SQLite drivers (node-sqlite3, libSQL): would avoid blocking without workers, but they are slower per query and require rewriting every call site. We get the same benefit by keeping the fast synchronous driver and moving it to a worker.
- KV stores (LMDB/RocksDB): excellent for pure key-value (buffers/caches) but weaker for our relational + FTS needs.

The one place a specialized system genuinely helps is vector/similarity search (the RLM/observation/memory cost, including the 38s case), in order of friction:

- `sqlite-vec` extension: keeps everything in SQLite and adds fast ANN vector search. Lowest friction. Evaluate current maturity before adopting.
- Embedded vector DB (e.g. LanceDB): fast native ANN, embedded, async. More moving parts.
- Either still must run off the main thread; a fast vector store called synchronously on main still beachballs.

Access patterns matter more than the engine: the transcript bridge doing ~6 queries per provider event is write amplification that batching fixes regardless of database. Switching engines does not fix bad access patterns or the in-process memory retention (~2.6GB RSS).

Decision: keep SQLite; fix threading (this plan); add `sqlite-vec` for vector search only if profiling confirms similarity compute is the CPU hog.
