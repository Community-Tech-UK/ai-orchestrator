# Background Job Runtime Design

## Purpose

AI Orchestrator should not let repository-scale work run on the Electron main process. The app currently has several background-ish coordinators, but they are independent and inconsistent: codemem uses a worker thread, legacy codebase indexing runs through the main process, and project-knowledge mirroring has its own queue. The runtime should make heavy work explicit, observable, cancellable, and isolated.

The goal is a general background job runtime where the main process is a scheduler and control plane. Worker lanes do the file walking, parsing, embedding, indexing, database writes, maintenance, and future large-analysis jobs.

## Decision

Build a general `BackgroundJobRuntime`, but implement it incrementally through concrete lanes.

The first production lane should be `indexing`, because legacy `CodebaseIndexingService.indexCodebase(...)` is the highest-risk freeze source. Codemem already has a worker boundary; that boundary should be migrated into the shared runtime after the first lane proves the interfaces.

Production heavy lanes should be process-backed, using Electron `utilityProcess` where packaging permits, with `child_process.fork` as a fallback. Worker-thread adapters remain useful for tests, development, and lighter jobs. Electron documents `utilityProcess` as a Node-enabled child process launched through Chromium services, while Node documents that `worker_threads` can share memory through transferable or shared buffers. For this app, process isolation is the better default for heavy indexing and embedding work.

References:
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Node worker_threads](https://nodejs.org/api/worker_threads.html)

## Lanes

Initial named lanes:

- `indexing`: legacy codebase indexing, codemem cold indexing, incremental FTS updates, watcher-triggered reindex work.
- `embeddings`: chunk embedding batches, provider retries, rate limits.
- `knowledge-mirror`: codemem snapshot to RLM/project-knowledge sync.
- `maintenance`: WAL checkpoints, stale index cleanup, vacuum/analyse, cache pruning.
- `analysis`: future repo scans, summaries, and large-context preparation.

V1 should implement the runtime contracts and the `indexing` lane only. Other lanes can keep their existing coordinators until profiling or repeated freezes justify migration.

## Job Model

Jobs are typed records, not arbitrary callbacks. Payloads should be small and serializable. Large content is read by the lane from disk, CAS, or its own SQLite connection.

```ts
export type BackgroundJobLane =
  | 'indexing'
  | 'embeddings'
  | 'knowledge-mirror'
  | 'maintenance'
  | 'analysis';

export type BackgroundJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale';

export type BackgroundJobPriority =
  | 'user-blocking'
  | 'normal'
  | 'background';

export interface BackgroundJobProgress {
  phase: string;
  completed: number;
  total?: number;
  message?: string;
}

export interface BackgroundJobRecord {
  id: string;
  lane: BackgroundJobLane;
  type: string;
  priority: BackgroundJobPriority;
  coalesceKey?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  status: BackgroundJobStatus;
  progress?: BackgroundJobProgress;
  errorMessage?: string;
}
```

The main process owns job metadata, queue state, cancellation requests, and UI-visible progress. Lane processes own execution, file system traversal, parsing, embedding, and database mutation.

## Scheduler Rules

Each lane has:

- max pending jobs
- max in-flight jobs
- priority ordering
- optional coalescing by key, usually workspace path
- cancellation
- heartbeat timeout
- restart/backoff policy
- progress events
- degraded/lane-unhealthy status

A global resource governor should follow after the first lane. It prevents `indexing`, `embeddings`, `knowledge-mirror`, and `maintenance` from saturating the machine together. The first implementation should not wait for that governor, but it should leave a clean place to add it.

## IPC Contract

The scheduler sends compact commands:

```ts
type LaneInboundMessage =
  | { type: 'run-job'; jobId: string; jobType: string; payload: unknown }
  | { type: 'cancel-job'; jobId: string }
  | { type: 'get-status' }
  | { type: 'shutdown' };

type LaneOutboundMessage =
  | { type: 'ready'; lane: BackgroundJobLane }
  | { type: 'job-started'; jobId: string; startedAt: number }
  | { type: 'job-progress'; jobId: string; progress: BackgroundJobProgress }
  | { type: 'job-succeeded'; jobId: string; result?: unknown }
  | { type: 'job-failed'; jobId: string; errorMessage: string }
  | { type: 'job-cancelled'; jobId: string }
  | { type: 'heartbeat'; lane: BackgroundJobLane; timestamp: number };
```

Lane results should be summaries only. Indexing jobs write directly to their database and return counts, hashes, and status, not chunks or embeddings.

## Cancellation And Restart

Cancellation is cooperative first:

1. The main process marks a job as cancellation requested.
2. The scheduler sends `cancel-job` to the lane.
3. The lane checks cancellation between file batches, chunk batches, and embedding batches.
4. The lane reports `job-cancelled` and persists any safe partial status.

If the lane stops heartbeating:

1. Mark running jobs as `stale`.
2. Kill and restart the lane.
3. Requeue only idempotent jobs.
4. Surface lane-unhealthy state after repeated restart failures.

Restart policy should use exponential backoff with several attempts, not a single permanent degraded state.

## Database Boundaries

Workers and lane processes own their own SQLite connections with WAL and `busy_timeout`. Database handles are never shared across thread or process boundaries.

Do not serialize large DB rows, chunk arrays, embeddings, or file contents over IPC. Pass workspace paths, store ids, content hashes, and job ids. The lane reads or writes the backing store directly.

Native-module packaging must be verified for every process type that loads `better-sqlite3`. Lane startup should fail cleanly with a clear ABI error if the native binary is incompatible.

## First Implementation Phase

Phase 1 should:

1. Add `src/main/background-jobs/` with typed job records, lane interfaces, an in-memory runtime, and process-lane adapter seams.
2. Add an `indexing` lane gateway and lane entrypoint following the existing `IndexWorkerGateway` pattern.
3. Move `CodebaseIndexingService.indexCodebase(...)` execution out of `CodebaseIndexingAutoCoordinator.runOne()` and into the `indexing` lane.
4. Proxy progress, completion, cancellation, and failure back through the gateway.
5. Keep codemem on the existing worker gateway until the new lane proves reliable.
6. Add tests for queue ordering, coalescing, cancellation, heartbeat timeout, degraded state, and coordinator dispatch.

Phase 1 should not:

- Migrate every existing coordinator.
- Build a distributed job database.
- Send large code or embedding payloads over IPC.
- Add a new vector database.

## Testing

Use unit tests around the scheduler and lane gateway with fake adapters. Use integration tests for the indexing lane with temporary workspaces.

Required verification:

- TypeScript app and spec compilation.
- Targeted Vitest files for the runtime, indexing gateway, and coordinator.
- Existing codemem/indexing tests touched by the plan.
- A load-oriented fixture with thousands of ignored generated files and hundreds of source files.
- A manual dev run proving the UI stays responsive while indexing is active.

## Open Risks

- `utilityProcess` packaging may need explicit entrypoint inclusion and native ABI checks.
- Existing coordinators may still stampede independently until the global governor lands.
- Network-mounted paths can block on sync filesystem checks before jobs enter a lane.
- Process-backed lanes increase memory usage compared with worker threads.
- Progress/ETA can only be approximate until scanners know the total work size.

## Rollback

If the process-backed indexing lane regresses packaged builds, keep the runtime contracts and temporarily switch the lane adapter to `worker_threads` or disable legacy auto-indexing while codemem-backed retrieval remains active.

If the runtime itself destabilizes startup, gate it behind settings and keep existing manual indexing commands available.
