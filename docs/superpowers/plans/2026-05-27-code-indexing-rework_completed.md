# Code Indexing Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI Orchestrator use one bounded, worker-owned code index that agents actually query, stays current when files change, and no longer freezes the Electron main process during workspace indexing.

**Architecture:** Add a general background job runtime so the Electron main process is only a scheduler/control plane for heavy work. Use process-backed lanes for production indexing and embedding workloads, with worker-thread/fake adapters for tests and development. Keep SQLite for durable metadata and FTS, but stop using the RLM database as the canonical code index. Consolidate automatic code retrieval on `codemem` because it already owns WAL `codemem.sqlite`, CAS chunks, workspace manifests, symbols, bounded watchers, and change events. Disable the legacy RLM codebase auto-indexer by default, then route indexed context injection, fast-path retrieval, and IPC code search through a codemem-backed retrieval service.

**Tech Stack:** Electron main process TypeScript, Angular settings UI metadata, Vitest, better-sqlite3, SQLite WAL/FTS5, Electron `utilityProcess`, Node `child_process`/`worker_threads`, chokidar.

---

## Grounding Notes

- SQLite is not the core problem. The failure mode is main-process indexing plus duplicated storage across `context_sections`, `code_fts`, `vectors`, `file_metadata`, and `codebase_trees`.
- SQLite FTS5 supports external/contentless tables that avoid storing source text twice. Use a contentless-delete FTS table keyed by codemem chunk rows, and read rendered snippets from CAS chunk text. Reference: [SQLite FTS5](https://www.sqlite.org/fts5.html).
- SQLite WAL lets readers continue while a writer commits, but checkpointing still matters. Reference: [SQLite WAL](https://www.sqlite.org/wal.html).
- Electron `utilityProcess` provides a Node-enabled child process model suitable for production lanes. Reference: [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process).
- Node `worker_threads` are still useful for tests and lighter adapters, but production indexing and embedding lanes should prefer process isolation. Reference: [Node worker_threads](https://nodejs.org/api/worker_threads.html).
- Claude second-opinion review agreed with the lane architecture and called out `CodebaseIndexingService.indexCodebase(...)` from `CodebaseIndexingAutoCoordinator.runOne()` as the most likely remaining main-process freeze source. Implement the first concrete indexing lane before extracting too much shared abstraction.
- LanceDB is a credible embedded vector/hybrid store, but its OSS index maintenance is manual and adds packaging risk. Do not add it in this pass. References: [LanceDB quickstart](https://docs.lancedb.com/quickstart), [LanceDB vector indexes](https://docs.lancedb.com/indexing/vector-index), [LanceDB FTS](https://docs.lancedb.com/search/full-text-search), [LanceDB hybrid search](https://docs.lancedb.com/search/hybrid-search).
- `sqlite-vec` is promising but pre-v1 and native-extension sensitive. Do not add it in this pass. Reference: [sqlite-vec](https://github.com/asg017/sqlite-vec).
- Sibling project patterns:
  - `mempalace-reference` uses a storage backend abstraction, deterministic upserts, robust ignore handling, and vector fallback/repair logic.
  - `nanoclaw`, `CodePilot`, and `agent-orchestrator` use SQLite WAL/busy timeouts for app state and FTS, not huge main-thread vector scans.
  - `openclaw` isolates local embedding work in a child process and treats sqlite vector extensions as optional/degraded.
  - `codex` memory search is bounded and on-demand, with hidden-path and symlink rejection.

## File Structure

- Create `src/main/background-jobs/types.ts`: shared job, lane, progress, cancellation, and metrics types.
- Create `src/main/background-jobs/background-job-runtime.ts`: main-process scheduler and queue owner.
- Create `src/main/background-jobs/lane-gateway.ts`: common gateway contract for lane adapters.
- Create `src/main/background-jobs/process-lane-gateway.ts`: production process-backed lane adapter using `utilityProcess` with `child_process.fork` fallback.
- Create `src/main/background-jobs/worker-thread-lane-gateway.ts`: worker-thread/fake-friendly adapter for tests and development.
- Create `src/main/background-jobs/index.ts`: singleton/runtime exports.
- Create `src/main/indexing/codebase-indexing-lane-protocol.ts`: typed RPC for legacy codebase indexing jobs.
- Create `src/main/indexing/codebase-indexing-lane-main.ts`: lane entrypoint that owns `CodebaseIndexingService` execution.
- Create `src/main/indexing/codebase-indexing-lane-gateway.ts`: main-process gateway used by the legacy auto-index coordinator.
- Modify `src/shared/types/settings.types.ts`: change defaults so legacy RLM codebase auto-index does not run on workspace open.
- Modify `src/shared/types/settings-metadata-runtime.ts`: relabel legacy settings so they are clearly heavy/manual.
- Modify `src/main/indexing/codebase-indexing-auto-coordinator.ts`: keep manual status support, do not enqueue legacy runs unless explicitly enabled, and dispatch legacy indexing through the background indexing lane.
- Modify `src/main/indexing/codebase-indexing-auto-defaults.ts`: keep broad-root and generated-directory preflight consistent with codemem.
- Modify `src/main/codemem/cas-schema.ts`: add codemem FTS/search/status tables.
- Modify `src/main/codemem/cas-store.ts`: add write/read methods for workspace chunks, FTS rows, and indexing status.
- Modify `src/main/codemem/code-index-manager.ts`: write chunk rows and FTS rows during cold and incremental indexing, update status, and support cancellation.
- Modify `src/main/codemem/index-worker-protocol.ts`: add search/status/rebuild/cancel RPC messages.
- Modify `src/main/codemem/index-worker-main.ts`: handle the new worker RPC messages.
- Modify `src/main/codemem/index-worker-gateway.ts`: expose search/status/rebuild/cancel methods to the main process.
- Create `src/main/codemem/code-retrieval-service.ts`: one main-process service that resolves workspace search using codemem, with grep fallback when the index is cold.
- Modify `src/main/codemem/index.ts`: expose the retrieval service and gateway methods.
- Modify `src/main/indexing/indexed-codebase-context.ts`: use codemem retrieval first, keeping the existing context block format.
- Modify `src/main/ipc/handlers/codebase-handlers.ts`: route codebase search/status IPC through codemem retrieval/status instead of legacy hybrid RLM search.
- Modify `src/main/orchestration/orchestration-protocol.ts`: update agent guidance to describe codemem as the source of code navigation and indexed context.
- Update `docs/CODEBASE_INDEXING.md` and `docs/CODEBASE_INDEXING_PERFORMANCE.md`: document the new canonical path, legacy fallback, and operational limits.

Project instruction override: do not commit during implementation unless James explicitly asks.

---

### Task 0: Add Background Job Runtime Foundation and Indexing Lane

**Files:**
- Create: `src/main/background-jobs/types.ts`
- Create: `src/main/background-jobs/background-job-runtime.ts`
- Create: `src/main/background-jobs/lane-gateway.ts`
- Create: `src/main/background-jobs/process-lane-gateway.ts`
- Create: `src/main/background-jobs/worker-thread-lane-gateway.ts`
- Create: `src/main/background-jobs/index.ts`
- Create: `src/main/background-jobs/__tests__/background-job-runtime.spec.ts`
- Create: `src/main/background-jobs/__tests__/lane-gateway.spec.ts`
- Create: `src/main/indexing/codebase-indexing-lane-protocol.ts`
- Create: `src/main/indexing/codebase-indexing-lane-main.ts`
- Create: `src/main/indexing/codebase-indexing-lane-gateway.ts`
- Create: `src/main/indexing/codebase-indexing-lane-gateway.spec.ts`
- Modify: `src/main/indexing/codebase-indexing-auto-coordinator.ts`
- Test: `src/main/indexing/codebase-indexing-auto-coordinator.spec.ts`

- [x] **Step 1: Write runtime queue tests**

Add tests for the scheduler using fake lane adapters. Assert:

```ts
const runtime = new BackgroundJobRuntime({
  lanes: { indexing: fakeLane },
  maxPendingPerLane: { indexing: 2 },
});

const first = runtime.enqueue({
  lane: 'indexing',
  type: 'index-codebase',
  priority: 'background',
  coalesceKey: '/repo',
  payload: { rootPath: '/repo' },
});

const second = runtime.enqueue({
  lane: 'indexing',
  type: 'index-codebase',
  priority: 'background',
  coalesceKey: '/repo',
  payload: { rootPath: '/repo' },
});

expect(second.jobId).toBe(first.jobId);
expect(runtime.getJob(first.jobId)?.status).toBe('queued');
```

Also cover priority ordering, max-pending rejection, status snapshots, and `cancel(jobId)`.

- [x] **Step 2: Define background job types**

Add:

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

- [x] **Step 3: Implement runtime scheduler**

`BackgroundJobRuntime` must:

1. Keep job metadata in the main process.
2. Accept typed jobs with small serializable payloads.
3. Dispatch jobs to registered lane gateways.
4. Coalesce pending jobs by `(lane, type, coalesceKey)`.
5. Track `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `stale`.
6. Proxy progress events from lane gateways into job records.
7. Support cooperative cancellation.
8. Mark running jobs `stale` if a lane heartbeat exceeds its timeout.

Do not add durable job persistence in this task.

- [x] **Step 4: Define lane gateway contract**

Create:

```ts
export interface LaneGateway {
  readonly lane: BackgroundJobLane;
  start(): Promise<void>;
  stop(): Promise<void>;
  runJob(job: BackgroundJobRecord, payload: unknown): Promise<unknown>;
  cancelJob(jobId: string): Promise<void>;
  getMetrics(): LaneGatewayMetrics;
  on(event: 'progress', listener: (event: LaneProgressEvent) => void): this;
  on(event: 'heartbeat', listener: (event: LaneHeartbeatEvent) => void): this;
  on(event: 'degraded', listener: (event: LaneDegradedEvent) => void): this;
}
```

Use `EventEmitter` subclasses to match existing gateway patterns.

- [x] **Step 5: Write process/worker gateway tests**

Use fake child handles instead of spawning real processes. Assert:

1. `runJob()` sends a compact `run-job` message.
2. Progress messages are emitted.
3. A timeout marks the lane degraded.
4. `cancelJob()` sends a `cancel-job` message.
5. Repeated crashes use exponential backoff and then expose degraded state.

- [x] **Step 6: Implement process-backed production adapter**

`ProcessLaneGateway` should prefer Electron `utilityProcess.fork()` when Electron is available and the app is packaged/runtime-compatible. Fall back to `child_process.fork()` for tests or non-Electron contexts.

The adapter must:

1. Start a long-lived lane process.
2. Send and receive compact messages only.
3. Own restart/backoff and degraded status.
4. Fail all in-flight jobs on lane crash.
5. Never pass SQLite handles, chunk arrays, embeddings, or file contents over IPC.

- [x] **Step 7: Add legacy codebase indexing lane protocol**

Define:

```ts
export type CodebaseIndexingLaneJob =
  | {
      type: 'index-codebase';
      rootPath: string;
      storeId?: string;
      force?: boolean;
    };

export interface CodebaseIndexingLaneResult {
  rootPath: string;
  filesIndexed: number;
  chunksCreated: number;
  completedAt: number;
}
```

Progress events must map to the existing auto-index status fields.

- [x] **Step 8: Implement indexing lane entrypoint**

`codebase-indexing-lane-main.ts` owns `CodebaseIndexingService` construction and runs `indexCodebase()` inside the lane process. It must:

1. Open its own database/service dependencies.
2. Emit progress events.
3. Check cancellation between batches where the service exposes a seam.
4. Return only summary counts.
5. Close resources on shutdown before acknowledging completion.

If the existing service lacks a cancellation seam, add the smallest seam needed and cover it with tests.

- [x] **Step 9: Route legacy auto-index coordinator through the lane**

In `CodebaseIndexingAutoCoordinator.runOne()`, replace direct `indexingTarget.indexCodebase(...)` execution with `CodebaseIndexingLaneGateway.runIndexCodebase(...)`.

Keep the existing setting gate and manual status behavior. The important invariant is that the Electron main process never runs the legacy BM25/vector indexing loop directly.

- [x] **Step 10: Verify Task 0**

Run:

```bash
npx vitest run src/main/background-jobs/__tests__/background-job-runtime.spec.ts src/main/background-jobs/__tests__/lane-gateway.spec.ts src/main/indexing/codebase-indexing-lane-gateway.spec.ts src/main/indexing/codebase-indexing-auto-coordinator.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both commands PASS.

---

### Task 1: Turn Off Legacy RLM Auto-Index by Default

**Files:**
- Modify: `src/shared/types/settings.types.ts`
- Modify: `src/shared/types/settings-metadata-runtime.ts`
- Modify: `src/main/indexing/codebase-indexing-auto-coordinator.ts`
- Test: `src/main/indexing/codebase-indexing-auto-coordinator.spec.ts`

- [x] **Step 1: Write the failing default-setting test**

Add a test that imports `DEFAULT_SETTINGS` and asserts:

```ts
expect(DEFAULT_SETTINGS.codebaseAutoIndexEnabled).toBe(false);
expect(DEFAULT_SETTINGS.codememEnabled).toBe(true);
expect(DEFAULT_SETTINGS.codememIndexingEnabled).toBe(true);
expect(DEFAULT_SETTINGS.codememPrewarmEnabled).toBe(true);
```

- [x] **Step 2: Write the failing coordinator test**

Add a test case to `src/main/indexing/codebase-indexing-auto-coordinator.spec.ts` with a settings fake returning `false` for `codebaseAutoIndexEnabled`. Emit a local `directory-added` event and assert the fake indexing target was not called and the recorded status is `skipped` with reason `disabled`.

```ts
expect(indexingTarget.indexCodebase).not.toHaveBeenCalled();
expect(coordinator.getStatus(workspacePath)).toEqual(expect.objectContaining({
  rootPath: workspacePath,
  state: 'skipped',
  reason: 'disabled',
}));
```

- [x] **Step 3: Run tests and verify failure**

Run:

```bash
npx vitest run src/main/indexing/codebase-indexing-auto-coordinator.spec.ts
```

Expected: FAIL because the current default is enabled or the new assertion is absent.

- [x] **Step 4: Change defaults and labels**

Set `codebaseAutoIndexEnabled: false` in `DEFAULT_SETTINGS`. Update the metadata label/description to:

```ts
label: 'Enable Legacy RLM Codebase Auto-Index',
description:
  'Automatically run the older BM25 + embedding RLM codebase index when a workspace is opened. This is heavier than codemem and should stay off unless debugging the legacy search path',
```

- [x] **Step 5: Keep explicit legacy opt-in working**

In `CodebaseIndexingAutoCoordinator`, keep `isEnabled()` as the single gate. Do not remove the coordinator or manual handlers. The behavior after this task is:

```ts
private isEnabled(): boolean {
  const enabled = this.settings.get('codebaseAutoIndexEnabled');
  return enabled === true;
}
```

- [x] **Step 6: Verify Task 1**

Run:

```bash
npx vitest run src/main/indexing/codebase-indexing-auto-coordinator.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both commands PASS.

---

### Task 2: Add Codemem Chunk Search Schema

**Files:**
- Modify: `src/main/codemem/cas-schema.ts`
- Modify: `src/main/codemem/cas-store.ts`
- Test: `src/main/codemem/__tests__/cas-store.spec.ts`

- [x] **Step 1: Write migration tests**

Add tests that run `migrate(db)` on an in-memory better-sqlite3 test driver and assert these objects exist:

```ts
expect(tableNames).toContain('workspace_chunks');
expect(tableNames).toContain('code_fts');
expect(tableNames).toContain('code_index_status');
```

Also assert the migration is idempotent by calling `migrate(db)` twice.

- [x] **Step 2: Add schema version 3**

Increment `CAS_SCHEMA_VERSION` to `3` and add migration statements:

```sql
CREATE TABLE IF NOT EXISTS workspace_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_hash TEXT NOT NULL,
  path_from_root TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  language TEXT NOT NULL,
  chunk_type TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_hash, path_from_root, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_workspace_chunks_workspace
  ON workspace_chunks(workspace_hash);
CREATE INDEX IF NOT EXISTS idx_workspace_chunks_file
  ON workspace_chunks(workspace_hash, path_from_root);
CREATE INDEX IF NOT EXISTS idx_workspace_chunks_hash
  ON workspace_chunks(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
  content,
  symbols,
  content='',
  contentless_delete=1,
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS code_index_status (
  workspace_hash TEXT PRIMARY KEY,
  abs_path TEXT NOT NULL,
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  processed_files INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  current_path TEXT,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_message TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
```

- [x] **Step 3: Add store types and methods**

Add TypeScript interfaces in `cas-store.ts`:

```ts
export interface WorkspaceChunkRecord {
  id?: number;
  workspaceHash: WorkspaceHash;
  pathFromRoot: string;
  chunkIndex: number;
  contentHash: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: Chunk['chunkType'];
  name: string;
  updatedAt: number;
}

export interface WorkspaceChunkSearchResult {
  rowid: number;
  workspaceHash: WorkspaceHash;
  pathFromRoot: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: Chunk['chunkType'];
  name: string;
  score: number;
}
```

Implement:

```ts
replaceWorkspaceChunksForFile(workspaceHash, pathFromRoot, chunks): void
searchWorkspaceChunks(workspaceHash, query, limit): WorkspaceChunkSearchResult[]
deleteWorkspaceChunksForFile(workspaceHash, pathFromRoot): void
upsertIndexStatus(status): void
getIndexStatus(workspaceHash): CodeIndexStatusRecord | null
requestCancel(workspaceHash): void
clearCancel(workspaceHash): void
isCancelRequested(workspaceHash): boolean
```

- [x] **Step 4: FTS write contract**

`replaceWorkspaceChunksForFile()` must run in one transaction:

1. Select existing chunk ids for `(workspace_hash, path_from_root)`.
2. Delete each existing FTS row with `DELETE FROM code_fts WHERE rowid = ?`.
3. Delete existing `workspace_chunks` rows for the file.
4. Insert new `workspace_chunks` rows.
5. Insert matching FTS rows using the inserted rowid and CAS chunk raw text:

```sql
INSERT INTO code_fts(rowid, content, symbols)
VALUES (?, ?, ?)
```

Use `symbols_json`, `imports_json`, and `exports_json` from `chunks` as the `symbols` input string.

- [x] **Step 5: Search contract**

`searchWorkspaceChunks()` must:

1. Build a sanitized FTS query from non-empty alphanumeric tokens.
2. Query `code_fts` joined to `workspace_chunks` by rowid.
3. Filter by `workspace_hash`.
4. Order by `bm25(code_fts)`.
5. Return absolute content through `getChunk(contentHash)` in the retrieval layer, not from FTS columns.

Query shape:

```sql
SELECT
  f.rowid,
  wc.workspace_hash,
  wc.path_from_root,
  wc.content_hash,
  wc.start_line,
  wc.end_line,
  wc.language,
  wc.chunk_type,
  wc.name,
  bm25(code_fts) AS score
FROM code_fts f
JOIN workspace_chunks wc ON wc.id = f.rowid
WHERE code_fts MATCH ?
  AND wc.workspace_hash = ?
ORDER BY score
LIMIT ?
```

- [x] **Step 6: Verify Task 2**

Run:

```bash
npx vitest run src/main/codemem/__tests__/cas-store.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both commands PASS.

---

### Task 3: Write Codemem FTS Rows During Indexing

**Files:**
- Modify: `src/main/codemem/code-index-manager.ts`
- Modify: `src/main/codemem/types.ts`
- Test: `src/main/codemem/__tests__/code-index-manager.spec.ts`
- Test: `src/main/codemem/__tests__/periodic-scan.spec.ts`

- [x] **Step 1: Add cold-index search test**

Create a temp workspace containing:

```ts
// src/auth.ts
export function issueSessionToken(userId: string): string {
  return `session:${userId}`;
}
```

Run `coldIndex(workspacePath)` and assert:

```ts
const root = store.getWorkspaceRootByPath(workspacePath);
expect(root).not.toBeNull();
const hits = store.searchWorkspaceChunks(root!.workspaceHash, 'issue session token', 5);
expect(hits[0]).toEqual(expect.objectContaining({
  pathFromRoot: 'src/auth.ts',
  name: 'issueSessionToken',
}));
```

- [x] **Step 2: Add incremental update test**

After the cold index, rewrite `src/auth.ts` to contain `refreshSessionToken`, call `manager.onFileChange(authPath, workspaceHash)`, and assert:

```ts
expect(store.searchWorkspaceChunks(workspaceHash, 'issue session token', 5)).toHaveLength(0);
expect(store.searchWorkspaceChunks(workspaceHash, 'refresh session token', 5)[0]).toEqual(
  expect.objectContaining({ pathFromRoot: 'src/auth.ts' }),
);
```

- [x] **Step 3: Add deletion test**

Delete the indexed file, call `onFileChange`, and assert both manifest and search rows disappear:

```ts
expect(store.listManifestEntries(workspaceHash)).toHaveLength(0);
expect(store.searchWorkspaceChunks(workspaceHash, 'refresh session token', 5)).toHaveLength(0);
```

- [x] **Step 4: Run tests and verify failure**

Run:

```bash
npx vitest run src/main/codemem/__tests__/code-index-manager.spec.ts
```

Expected: FAIL because `CodeIndexManager` does not yet write `workspace_chunks` or `code_fts`.

- [x] **Step 5: Implement chunk row writes**

In `indexFile()`, build `WorkspaceChunkRecord[]` while processing chunks. Use the chunk order from `this.chunker.chunk(...)` as `chunkIndex`. Use chunk line metadata from the returned chunk object:

```ts
workspaceChunks.push({
  workspaceHash,
  pathFromRoot,
  chunkIndex,
  contentHash: storedChunk.contentHash,
  startLine: chunk.startLine,
  endLine: chunk.endLine,
  language,
  chunkType: storedChunk.chunkType,
  name: storedChunk.name,
  updatedAt: Date.now(),
});
```

After `replaceWorkspaceSymbolsForFile(...)`, call:

```ts
this.opts.store.replaceWorkspaceChunksForFile(workspaceHash, pathFromRoot, workspaceChunks);
```

- [x] **Step 6: Implement deletion cleanup**

In the missing-file branch of `applyFileChange()`, call:

```ts
this.opts.store.deleteWorkspaceChunksForFile(workspaceHash, relativePath);
```

This must happen in addition to manifest and symbol deletion.

- [x] **Step 7: Verify Task 3**

Run:

```bash
npx vitest run src/main/codemem/__tests__/code-index-manager.spec.ts src/main/codemem/__tests__/periodic-scan.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both commands PASS.

---

### Task 4: Add Index Status, ETA, and Cancellation

**Files:**
- Modify: `src/main/codemem/code-index-manager.ts`
- Modify: `src/main/codemem/index-worker-protocol.ts`
- Modify: `src/main/codemem/index-worker-main.ts`
- Modify: `src/main/codemem/index-worker-gateway.ts`
- Test: `src/main/codemem/__tests__/index-worker-gateway.spec.ts`
- Test: `src/main/codemem/__tests__/code-index-manager.spec.ts`

- [x] **Step 1: Define worker protocol messages**

Add inbound message variants:

```ts
| { type: 'get-index-status'; id: number; workspacePath: string }
| { type: 'cancel-index'; id: number; workspacePath: string }
| { type: 'rebuild-index'; id: number; workspacePath: string }
```

Add a result type:

```ts
export interface CodeIndexStatusSnapshot {
  workspacePath: string;
  workspaceHash: string;
  state: 'idle' | 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  phase: 'none' | 'scanning' | 'chunking' | 'fts' | 'watching';
  totalFiles: number;
  processedFiles: number;
  totalChunks: number;
  processedChunks: number;
  currentPath: string | null;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  etaMs: number | null;
  errorMessage: string | null;
}
```

- [x] **Step 2: Write status test**

Use a fake worker in `index-worker-gateway.spec.ts`. Assert:

```ts
await expect(gateway.getIndexStatus('/repo')).resolves.toEqual(expect.objectContaining({
  workspacePath: '/repo',
  state: 'running',
  phase: 'chunking',
  processedFiles: 10,
  totalFiles: 20,
}));
```

- [x] **Step 3: Write cancellation test**

Start `coldIndex()` on a fixture with enough files to allow cancellation. Request cancel after the first progress update and assert final status:

```ts
expect(status.state).toBe('cancelled');
expect(status.processedFiles).toBeLessThan(status.totalFiles);
```

- [x] **Step 4: Run tests and verify failure**

Run:

```bash
npx vitest run src/main/codemem/__tests__/index-worker-gateway.spec.ts src/main/codemem/__tests__/code-index-manager.spec.ts
```

Expected: FAIL because status/cancel RPC does not exist.

- [x] **Step 5: Implement status updates**

In `coldIndex()`, write status at these points:

```ts
this.opts.store.upsertIndexStatus({
  workspaceHash,
  absPath: absoluteWorkspacePath,
  state: 'running',
  phase: 'scanning',
  totalFiles: 0,
  processedFiles: 0,
  totalChunks: 0,
  processedChunks: 0,
  currentPath: null,
  startedAt: Date.now(),
  updatedAt: Date.now(),
  completedAt: null,
  errorMessage: null,
  cancelRequested: false,
});
```

Update `phase`, `totalFiles`, `processedFiles`, `totalChunks`, `processedChunks`, and `currentPath` during the file loop. Set final state to `complete`, `failed`, or `cancelled`.

- [x] **Step 6: Implement cancellation checks**

Before each file is indexed in `coldIndex()`, check:

```ts
if (this.opts.store.isCancelRequested(workspaceHash)) {
  this.opts.store.upsertIndexStatus({
    ...currentStatus,
    state: 'cancelled',
    phase: 'none',
    updatedAt: Date.now(),
    completedAt: Date.now(),
  });
  return {
    workspaceHash,
    fileCount: processedFiles,
    chunkCount,
    merkleRootHash: this.recomputeRootHash(workspaceHash),
  };
}
```

- [x] **Step 7: Implement gateway methods**

Add methods:

```ts
async getIndexStatus(workspacePath: string): Promise<CodeIndexStatusSnapshot | null>
async cancelIndex(workspacePath: string): Promise<void>
async rebuildIndex(workspacePath: string): Promise<WarmWorkspaceResult>
```

All methods must return degraded results instead of throwing when the worker is unavailable.

- [x] **Step 8: Verify Task 4**

Run:

```bash
npx vitest run src/main/codemem/__tests__/index-worker-gateway.spec.ts src/main/codemem/__tests__/code-index-manager.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both commands PASS.

---

### Task 5: Create Codemem Retrieval Service

**Files:**
- Create: `src/main/codemem/code-retrieval-service.ts`
- Modify: `src/main/codemem/index.ts`
- Test: `src/main/codemem/__tests__/code-retrieval-service.spec.ts`

- [x] **Step 1: Define result and service contract**

Create these exported types in `code-retrieval-service.ts`:

```ts
export interface CodeRetrievalSearchOptions {
  workspacePath: string;
  query: string;
  limit?: number;
  maxTokens?: number;
}

export interface CodeRetrievalResult {
  workspacePath: string;
  relativePath: string;
  absolutePath: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source: 'symbol' | 'fts' | 'grepFallback';
  language: string;
  symbolName: string | null;
  stale: boolean;
}
```

- [x] **Step 2: Write indexed-search test**

Use an in-memory store with an indexed fixture chunk. Assert:

```ts
const results = await service.search({
  workspacePath,
  query: 'issue session token',
  limit: 5,
});
expect(results[0]).toEqual(expect.objectContaining({
  relativePath: 'src/auth.ts',
  source: 'fts',
  symbolName: 'issueSessionToken',
  stale: false,
}));
expect(results[0].content).toContain('issueSessionToken');
```

- [x] **Step 3: Write cold-index fallback test**

Use a workspace path with no `workspace_root` row. Mock the fallback command runner to return an `rg` hit and assert:

```ts
expect(results[0]).toEqual(expect.objectContaining({
  relativePath: 'src/auth.ts',
  source: 'grepFallback',
  stale: true,
}));
```

- [x] **Step 4: Run test and verify failure**

Run:

```bash
npx vitest run src/main/codemem/__tests__/code-retrieval-service.spec.ts
```

Expected: FAIL because the service does not exist.

- [x] **Step 5: Implement search**

The service constructor accepts injectable dependencies:

```ts
export interface CodeRetrievalServiceOptions {
  store?: CasStore;
  indexWorkerGateway?: Pick<IndexWorkerGateway, 'warmWorkspace'>;
  runFallbackSearch?: (workspacePath: string, query: string, limit: number) => Promise<CodeRetrievalResult[]>;
}
```

Search behavior:

1. Trim query. Return `[]` for queries shorter than 2 characters.
2. Resolve workspace root by path.
3. If no root exists, call `warmWorkspace(workspacePath, 2500)` and check again.
4. If still no root exists, return bounded grep fallback results.
5. Query `store.searchWorkspaceChunks(workspaceHash, query, limit * 2)`.
6. For each hit, load chunk text with `store.getChunk(contentHash)`.
7. Return at most `limit` results, with token trimming based on `maxTokens`.

- [x] **Step 6: Implement fallback search**

Use `rg` through `child_process.spawn` with:

```ts
[
  '-n',
  '--no-heading',
  '-S',
  '--glob', '!node_modules/**',
  '--glob', '!dist/**',
  '--glob', '!build/**',
  '--glob', '!.git/**',
  query,
  '.',
]
```

Kill the process after 2500 ms and cap output at 256 KiB.

- [x] **Step 7: Export service singleton**

In `src/main/codemem/index.ts`, export:

```ts
export { CodeRetrievalService, getCodeRetrievalService, resetCodeRetrievalServiceForTesting } from './code-retrieval-service';
export type { CodeRetrievalResult, CodeRetrievalSearchOptions } from './code-retrieval-service';
```

- [x] **Step 8: Verify Task 5**

Run:

```bash
npx vitest run src/main/codemem/__tests__/code-retrieval-service.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both commands PASS.

---

### Task 6: Route Indexed Context and Fast Retrieval Through Codemem

**Files:**
- Modify: `src/main/indexing/indexed-codebase-context.ts`
- Modify: `src/main/indexing/indexed-codebase-context.spec.ts`
- Modify: `src/main/instance/orchestration/fast-path-retriever.spec.ts`
- Test: `src/main/indexing/context-assembler.spec.ts`

- [x] **Step 1: Update indexed context tests**

Change the `IndexedCodebaseContextService` test fake from `HybridSearchResult[]` to `CodeRetrievalResult[]`. Assert the rendered block still contains:

```txt
[Indexed Codebase Context]
Source: AI Orchestrator indexed codebase search
src/auth.ts
issueSessionToken
[End Indexed Codebase Context]
```

- [x] **Step 2: Add empty-index test**

Add a test that returns `[]` from `CodeRetrievalService.search()` and assert `buildContext()` returns `null`.

- [x] **Step 3: Run tests and verify failure**

Run:

```bash
npx vitest run src/main/indexing/indexed-codebase-context.spec.ts src/main/instance/orchestration/fast-path-retriever.spec.ts
```

Expected: FAIL because `IndexedCodebaseContextService` still depends on `getHybridSearchService()`.

- [x] **Step 4: Replace search dependency**

Change `IndexedCodebaseContextSearchTarget` to:

```ts
export interface IndexedCodebaseContextSearchTarget {
  search(options: CodeRetrievalSearchOptions): Promise<CodeRetrievalResult[]>;
}
```

Change `getSearchTarget()` to return `getCodeRetrievalService()`.

- [x] **Step 5: Normalize codemem results**

Map `CodeRetrievalResult` into the existing context result shape:

```ts
return {
  sectionId: `${result.relativePath}:${result.startLine}:${result.endLine}`,
  filePath: result.absolutePath,
  relativePath: result.relativePath,
  content: result.content,
  startLine: result.startLine,
  endLine: result.endLine,
  score: result.score,
  matchType: result.source === 'symbol' ? 'hybrid' : 'bm25',
  language: result.language,
  symbolName: result.symbolName ?? undefined,
};
```

- [x] **Step 6: Verify Task 6**

Run:

```bash
npx vitest run src/main/indexing/indexed-codebase-context.spec.ts src/main/instance/orchestration/fast-path-retriever.spec.ts src/main/instance/__tests__/instance-manager.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both commands PASS.

---

### Task 7: Route Codebase IPC Through Codemem

**Files:**
- Modify: `src/main/ipc/handlers/codebase-handlers.ts`
- Modify: `src/shared/types/codebase.types.ts`
- Modify: `packages/contracts/src/schemas/workspace-tools.schemas.ts`
- Test: `src/main/ipc/handlers/__tests__/codebase-auto-handlers.spec.ts`
- Test: `packages/contracts/src/schemas/__tests__/workspace-tools.schemas.spec.ts`

- [x] **Step 1: Preserve existing channel names**

Keep these IPC channels stable:

```ts
IPC_CHANNELS.CODEBASE_SEARCH
IPC_CHANNELS.CODEBASE_SEARCH_SYMBOLS
IPC_CHANNELS.CODEBASE_INDEX_STATUS
IPC_CHANNELS.CODEBASE_INDEX_CANCEL
```

Their implementation changes to codemem-backed behavior.

- [x] **Step 2: Write IPC search test**

Mock `getCodeRetrievalService().search()` and assert `CODEBASE_SEARCH` returns data shaped as `HybridSearchResult[]` for renderer compatibility:

```ts
expect(response.success).toBe(true);
expect(response.data?.[0]).toEqual(expect.objectContaining({
  filePath: '/repo/src/auth.ts',
  content: expect.stringContaining('issueSessionToken'),
  matchType: 'bm25',
}));
```

- [x] **Step 3: Write status IPC test**

Mock `getCodemem().indexWorkerGateway.getIndexStatus()` and assert `CODEBASE_INDEX_STATUS` includes the codemem snapshot when a `workspacePath` payload is provided.

- [x] **Step 4: Run tests and verify failure**

Run:

```bash
npx vitest run src/main/ipc/handlers/__tests__/codebase-auto-handlers.spec.ts packages/contracts/src/schemas/__tests__/workspace-tools.schemas.spec.ts
```

Expected: FAIL because handlers still call legacy indexing/search services.

- [x] **Step 5: Implement handler routing**

In `registerCodebaseHandlers()`:

1. Keep legacy manual `CODEBASE_INDEX_STORE` and `CODEBASE_INDEX_FILE` handlers for explicit user actions.
2. Route `CODEBASE_SEARCH` and `CODEBASE_SEARCH_SYMBOLS` to `getCodeRetrievalService().search(...)`.
3. Map codemem results to `HybridSearchResult` for renderer compatibility.
4. Route `CODEBASE_INDEX_STATUS` to codemem status when payload contains `workspacePath`; fall back to legacy `indexingService.getProgress()` only when there is no workspace path.
5. Route `CODEBASE_INDEX_CANCEL` to codemem cancel when payload contains `workspacePath`; otherwise call legacy `indexingService.cancel()`.

- [x] **Step 6: Verify Task 7**

Run:

```bash
npx vitest run src/main/ipc/handlers/__tests__/codebase-auto-handlers.spec.ts packages/contracts/src/schemas/__tests__/workspace-tools.schemas.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all commands PASS.

---

### Task 8: Update Agent Guidance and Documentation

**Files:**
- Modify: `src/main/orchestration/orchestration-protocol.ts`
- Modify: `src/main/orchestration/orchestration-protocol.spec.ts`
- Modify: `docs/CODEBASE_INDEXING.md`
- Modify: `docs/CODEBASE_INDEXING_PERFORMANCE.md`

- [x] **Step 1: Update protocol test**

Extend `orchestration-protocol.spec.ts` so the generated prompt contains:

```txt
Use codemem tools when navigating code
Indexed Codebase Context
verify important details against repository files before editing
```

Also assert it does not describe the legacy RLM index as the primary source.

- [x] **Step 2: Run test and verify failure**

Run:

```bash
npx vitest run src/main/orchestration/orchestration-protocol.spec.ts
```

Expected: FAIL until the prompt wording changes.

- [x] **Step 3: Update guidance text**

Change the code navigation section to state:

```txt
AI Orchestrator maintains codemem indexes for known workspaces. User turns may include an [Indexed Codebase Context] block selected from codemem-backed search. Use that block as a starting point, then verify important details against repository files before editing.

Use codemem tools when navigating code because they query the persistent symbol/LSP index and are usually faster and more accurate than broad grep for code structure.
```

- [x] **Step 4: Update docs**

In `docs/CODEBASE_INDEXING.md`, document:

1. `codemem` is the canonical automatic index.
2. Legacy RLM auto-index is off by default.
3. Manual legacy index buttons/IPC are for diagnostics.
4. File changes are picked up by codemem watcher and update affected chunks.
5. Generated/dependency folders are ignored by default.

In `docs/CODEBASE_INDEXING_PERFORMANCE.md`, document:

1. Native watcher cap.
2. Polling fallback.
3. FTS rows are contentless and CAS-backed.
4. Vector DB additions are deferred until benchmarked.
5. Status/ETA fields and cancellation behavior.

- [x] **Step 5: Verify Task 8**

Run:

```bash
npx vitest run src/main/orchestration/orchestration-protocol.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both commands PASS.

---

### Task 9: Add Legacy Index Cleanup Action

**Files:**
- Modify: `src/main/indexing/indexing-service.ts`
- Modify: `src/main/ipc/handlers/codebase-handlers.ts`
- Modify: `packages/contracts/src/channels/workspace.channels.ts`
- Modify: `src/preload/domains/infrastructure.preload.ts`
- Test: `src/main/indexing/indexing-service-store-reset.spec.ts`
- Test: `packages/contracts/src/channels/__tests__/workspace.channels.spec.ts`

- [x] **Step 1: Add cleanup channel test**

Add a channel assertion:

```ts
expect(WORKSPACE_CHANNELS.CODEBASE_LEGACY_CLEAR).toBe('codebase:legacy:clear');
```

- [x] **Step 2: Add service cleanup test**

Test a new public method:

```ts
await service.clearLegacyCodebaseStore('codebase:test');
expect(mocks.bm25.clearStore).toHaveBeenCalledWith('codebase:test');
expect(mocks.vectorStore.clearStore).toHaveBeenCalledWith('codebase:test');
expect(sql).toContain('DELETE FROM codebase_trees WHERE store_id = ?');
```

- [x] **Step 3: Run tests and verify failure**

Run:

```bash
npx vitest run src/main/indexing/indexing-service-store-reset.spec.ts packages/contracts/src/channels/__tests__/workspace.channels.spec.ts
```

Expected: FAIL because the cleanup channel and method do not exist.

- [x] **Step 4: Implement cleanup**

Expose a public wrapper around the existing private `clearStoreIndex()`:

```ts
async clearLegacyCodebaseStore(storeId: string): Promise<void> {
  await this.clearStoreIndex(storeId);
}
```

Add an IPC handler that validates `{ storeId: string }`, calls the method, and returns a standard `IpcResponse<void>`.

- [x] **Step 5: Wire preload API**

Expose:

```ts
codebaseLegacyClear: (storeId: string): Promise<IpcResponse> =>
  ipcRenderer.invoke(IPC_CHANNELS.CODEBASE_LEGACY_CLEAR, { storeId }),
```

- [x] **Step 6: Verify Task 9**

Run:

```bash
npx vitest run src/main/indexing/indexing-service-store-reset.spec.ts packages/contracts/src/channels/__tests__/workspace.channels.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all commands PASS.

---

### Task 10: Load Test and Final Verification

**Files:**
- Create: `src/main/codemem/__tests__/code-retrieval-load.spec.ts`
- Modify: `src/main/codemem/__tests__/soak.spec.ts`

- [x] **Step 1: Add generated-directory load fixture**

Create a temp repo with:

```txt
src/file-0000.ts through src/file-0499.ts
node_modules/pkg/file-0000.ts through node_modules/pkg/file-0999.ts
dist/file-0000.js through dist/file-0999.js
build/file-0000.js through build/file-0999.js
```

Each `src` file contains a unique exported function. Generated folders contain searchable tokens that must not appear in codemem search results.

- [x] **Step 2: Assert ignored folders stay out**

After `coldIndex()`:

```ts
expect(store.searchWorkspaceChunks(workspaceHash, 'generated dependency token', 10)).toHaveLength(0);
expect(store.searchWorkspaceChunks(workspaceHash, 'unique source token 0042', 10)[0]).toEqual(
  expect.objectContaining({ pathFromRoot: 'src/file-0042.ts' }),
);
```

- [x] **Step 3: Assert retrieval remains bounded**

Run 50 searches against the fixture and assert:

```ts
expect(maxDurationMs).toBeLessThan(500);
expect(results.every((result) => result.content.length <= 3600)).toBe(true);
```

- [x] **Step 4: Run focused verification**

Run:

```bash
npx vitest run src/main/codemem/__tests__/code-retrieval-load.spec.ts src/main/codemem/__tests__/soak.spec.ts
npx vitest run src/main/indexing/indexed-codebase-context.spec.ts src/main/ipc/handlers/__tests__/codebase-auto-handlers.spec.ts
```

Expected: both commands PASS.

- [x] **Step 5: Run project verification**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
npm run build
git diff --check
```

Expected:

1. TypeScript commands PASS.
2. Lint PASS.
3. Test suite PASS.
4. Build PASS. Existing Angular budget warnings are acceptable if unchanged.
5. `git diff --check` prints no whitespace errors.

---

## Acceptance Criteria

- A background job runtime exists with typed jobs, named lanes, progress, cancellation, heartbeat, restart/degraded state, and testable lane adapters.
- Legacy `CodebaseIndexingService.indexCodebase(...)` execution no longer runs directly on the Electron main process; it is dispatched through the `indexing` lane when explicitly enabled.
- Production heavy lanes prefer process isolation through `utilityProcess`/`child_process`, while worker-thread/fake adapters remain available for tests and development.
- Opening AI Orchestrator no longer starts the legacy RLM codebase auto-indexer unless the legacy setting is explicitly enabled.
- `codemem` is the only automatic code index path on workspace open.
- Search/context injection uses codemem-backed retrieval.
- Agent prompt guidance tells agents to use codemem tools and indexed context.
- File edits update the affected codemem manifest, chunk rows, FTS rows, and symbols without full reindexing.
- Index status reports phase, progress, ETA, and cancellation state.
- `node_modules`, `dist`, `build`, cache, vendor, lockfile, bundle, and map files are ignored in cold indexing, watcher updates, FTS search, and fallback grep.
- Legacy RLM codebase index data can be cleared explicitly.
- No new vector database dependency is added in this implementation.

## Rollback Plan

- If the process-backed indexing lane regresses packaged builds, keep the runtime contracts and switch the indexing lane adapter to `worker_threads` while the packaging issue is fixed.
- If the background runtime destabilizes startup, gate runtime startup behind settings and keep legacy auto-index disabled by default.
- If codemem-backed search causes regressions, keep `codebaseAutoIndexEnabled` defaulted to `false` and temporarily route `IndexedCodebaseContextService` to return `null`; agents will still use codemem MCP tools and fallback grep.
- If the FTS migration fails for an existing `codemem.sqlite`, catch the migration error, log it once, mark codemem retrieval degraded, and keep app startup unblocked.
- If watcher pressure returns, set codemem watcher startup to polling-only by passing `maxNativeWatchFiles: 0` to `CodeIndexManager` while preserving cold-index and manual search.

## Out of Scope

- LanceDB integration.
- `sqlite-vec` integration.
- Migrating existing legacy RLM codebase chunks into codemem.
- Durable background job persistence across app restarts.
- Moving every existing background coordinator onto the runtime in the first implementation pass.
- Rebuilding the Angular settings UI beyond label/description changes.
- Changing non-code memory, observations, or RLM session storage.

## Implementation Notes

- Keep every task shippable independently.
- Use existing singleton reset patterns in tests.
- Prefer dependency injection seams already present in codemem and indexing tests.
- Do not run `npm run format` unless a modified file already requires formatting.
- Do not commit or push unless James explicitly asks.
