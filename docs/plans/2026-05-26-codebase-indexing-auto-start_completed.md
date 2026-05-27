# CodebaseIndexingService Auto-Start on Workspace Open

**Date:** 2026-05-26
**Status:** Completed and verified
**Owner:** James

## Problem

`CodebaseIndexingService` (`src/main/indexing/indexing-service.ts`) is
a heavier, separate indexing pipeline from codemem:

- Tree-sitter chunking (`tree-sitter-chunker.ts`)
- Metadata extraction (`metadata-extractor.ts`)
- BM25 lexical index (`bm25-search.ts`)
- Vector embeddings via `VectorStore` (`../rlm/vector-store`)
- Merkle-tree incremental change detection (`merkle-tree.ts`)
- Hybrid search + reranker on top (`hybrid-search.ts`, `reranker.ts`)

This is what powers the `codebase-panel` feature in the renderer
(`src/renderer/app/features/codebase/codebase-panel.component.ts`) and
the `CODEBASE_*` IPC handlers
(`src/main/ipc/handlers/codebase-handlers.ts`).

Right now it is **entirely manual**:

- Only triggered by IPC `CODEBASE_INDEX_STORE` (handlers.ts:71-95),
  which is in turn only called when the user clicks "Index" in the
  Codebase panel.
- The service exists, is fully wired, has progress events, watchers,
  cancellation — but nobody fires it automatically.

The user expectation: "if there is a code base, it does whatever it
does to it." Today that's true for codemem; it's not true for this
service.

## Goal

When a workspace is opened in AI Orchestrator, the
`CodebaseIndexingService` automatically (a) detects whether it has
already indexed that workspace, and (b) runs an incremental index in
the background — without blocking the UI, with progress visible if the
user opens the Codebase panel, and respecting size limits so it doesn't
trash the user's machine on a 10 GB monorepo.

## Non-Goals

- Replacing the manual "Index" button. It stays as the explicit
  "re-index now / force" affordance.
- Indexing every recent directory on app start. Active workspace only,
  same policy as codemem auto-warm.
- New search UX. We're feeding existing indices; the search panel is
  out of scope.

## Design

### Reuse the same hook point as codemem auto-warm

Spec 1 (`2026-05-26-codemem-auto-warm-on-workspace-open.md`)
establishes `RecentDirectoriesManager`'s `'directory-added'` event as
the canonical "workspace is present" trigger. This spec extends that
hook to also fan out to `CodebaseIndexingService`.

If spec 1 has landed, we subscribe a second coordinator. If spec 1 has
not yet landed, ship the listener bootstrap as part of this spec —
either way both coordinators read from the same event source. The two
indexers run independently; codemem is fast and AST/LSP-focused, this
one is heavier and embedding/search-focused.

### Listener: `CodebaseIndexingAutoCoordinator`

New file:
`src/main/indexing/codebase-indexing-auto-coordinator.ts`

Responsibilities:

1. Subscribe to `recentDirectoriesManager.on('directory-added', …)`.
2. On each event:
   - Skip if `entry.nodeId` is present (remote paths — those nodes
     manage their own indices).
   - Skip if `settings.codebaseAutoIndexEnabled` is false.
   - Skip if the path is excluded via
     `ProjectRootRegistry.isExcluded(path)` (reuse existing exclusion
     mechanism from
     `src/main/memory/project-root-registry.ts`).
3. Resolve a `storeId` for the workspace:
   - Convention: `codebase:${workspaceHash}` using
     `workspaceHashForPath` from `src/main/codemem/symbol-id.ts` so the
     id is stable and matches codemem's hash.
   - If the store doesn't exist, create it via
     `RLMContextManager.getInstance().createStore(...)` with metadata
     `{ kind: 'codebase-auto', rootPath }`.
4. Preflight (size guard) — count files and bytes using the same
   ignore patterns as `ProjectCodeIndexBridge.preflight`
   (`src/main/memory/project-code-index-bridge.ts:37` + the
   `DEFAULT_IGNORES` list). Skip and record `'too_large'` if it
   exceeds `codebaseAutoIndexMaxFiles` (default 10 000) or
   `codebaseAutoIndexMaxBytes` (default 500 MiB).
5. Concurrency cap: at most **1** simultaneous full-index run. Queue
   subsequent requests. This is heavier than codemem; we don't want
   two cold indexes hammering the disk and the embedder.
6. Call `indexingService.indexCodebase(storeId, rootPath, { force: false })`.
   Because of the Merkle tree, this is incremental after the first
   run — subsequent triggers for the same workspace are cheap.
7. Fire-and-forget; the existing `progress` events already pipe to the
   renderer via `codebase-handlers.ts:53`. No new UI is required —
   if the user opens the Codebase panel mid-run, they'll see progress
   automatically.
8. On completion, register the workspace with
   `getCodebaseFileWatcher().startWatching(storeId, rootPath)` so
   subsequent file changes are picked up incrementally. This watcher
   is already wired into the IPC events at handlers.ts:58.

### Status surface

Add a `CodebaseAutoIndexStatus` per workspace:

```ts
interface CodebaseAutoIndexStatus {
  rootPath: string;
  storeId: string;
  state: 'idle' | 'queued' | 'running' | 'complete' | 'skipped' | 'failed';
  reason?: 'too_large' | 'excluded' | 'disabled' | 'remote' | 'error';
  startedAt?: number;
  completedAt?: number;
  filesProcessed?: number;
  chunksProcessed?: number;
  errorMessage?: string;
}
```

Stored in-memory on the coordinator (no persistence needed — re-derives
on next startup). Expose via:

- `IPC_CHANNELS.CODEBASE_AUTO_STATUS_GET` (request)
- `IPC_CHANNELS.CODEBASE_AUTO_STATUS_CHANGED` (push)

Renderer subscribes and shows a small badge in the Codebase panel
header ("Indexed", "Indexing…", "Too large — index manually",
"Failed").

### Active-workspace prioritisation

Same pattern as codemem spec 1: a `hintActiveWorkspace(path)` API
called from `new-session-draft.service.setWorkingDirectory` (over IPC)
jumps the path to the front of the queue.

### Startup behaviour

On app start (`initialization-steps.ts`, after
`getCodebaseIndexingService` is constructed): emit a hint for the
most-recent directory if it's local and `codebaseAutoIndexEnabled` is
true. Same rule as codemem — only the most-recent, not all recent dirs.

### Settings (additions to `src/shared/types/settings.types.ts`)

```ts
codebaseAutoIndexEnabled: boolean;          // default true
codebaseAutoIndexMaxFiles: number;          // default 10_000
codebaseAutoIndexMaxBytes: number;          // default 500 * 1024 * 1024
codebaseAutoIndexConcurrent: number;        // default 1
codebaseAutoIndexDebounceMs: number;        // default 3_000 (heavier than codemem)
```

## Files to touch

| File | Change |
|---|---|
| `src/main/indexing/codebase-indexing-auto-coordinator.ts` | **new** — listener, queue, status map |
| `src/main/indexing/index.ts` | export `getCodebaseIndexingAutoCoordinator()` |
| `src/main/app/initialization-steps.ts` | start coordinator after indexing service init; emit startup hint |
| `src/shared/types/ipc.types.ts` | new channels `CODEBASE_AUTO_STATUS_GET`, `CODEBASE_AUTO_STATUS_CHANGED`, `CODEBASE_AUTO_HINT` |
| `src/main/ipc/handlers/codebase-handlers.ts` | register the three new handlers + forward status events |
| `src/preload/preload.ts` | expose `codebase.autoStatus.get()`, `.onChanged()`, `codebase.autoHint(path)` |
| `src/renderer/app/core/services/ipc/codebase-ipc.service.ts` | add three new methods |
| `src/renderer/app/core/services/new-session-draft.service.ts:60` | call `codebase.autoHint(path)` (alongside the codemem hint from spec 1) |
| `src/renderer/app/features/codebase/codebase-panel.component.ts` | display new status badge |
| `src/shared/types/settings.types.ts` | new settings keys + defaults |

## Tests

1. **`src/main/indexing/__tests__/codebase-indexing-auto-coordinator.spec.ts`**
   - Fires `indexCodebase` on `'directory-added'` for local path.
   - Skips remote paths.
   - Skips when `codebaseAutoIndexEnabled` is false.
   - Skips and records `'too_large'` when preflight exceeds limits.
   - Reuses existing storeId if one already exists for the workspace
     hash.
   - Concurrency cap of 1 honoured; second event queues.
   - `hintActiveWorkspace` reorders the queue.
   - On completion, calls `fileWatcher.startWatching`.
2. **`src/main/ipc/handlers/__tests__/codebase-handlers.spec.ts`**
   - New channels respond with current status.
   - `CODEBASE_AUTO_STATUS_CHANGED` events forwarded to renderer.
3. **`src/renderer/app/features/codebase/codebase-panel.component.spec.ts`**
   - Status badge renders for each state.
4. **Integration**: open a small fixture directory via
   `addDirectory`, wait for `'complete'` status, assert
   `indexingService.getStats(storeId).totalChunks > 0` and that the
   file watcher is registered.

## Acceptance criteria

- [x] Opening a workspace ≤ size limits triggers an incremental
      indexing run within `debounceMs`, observable via
      `CODEBASE_AUTO_STATUS_CHANGED`.
- [x] Re-opening the same workspace in the same session is a no-op
      (incremental Merkle scan finds zero changes; status flips
      straight to `'complete'`).
- [x] Workspaces exceeding the file/byte limit are recorded as
      `'too_large'` and do **not** start indexing.
- [x] The Codebase panel shows the auto-status badge.
- [x] The existing manual "Index" button still works and forces a
      full re-index (`force: true`).
- [x] Disabling `codebaseAutoIndexEnabled` cleanly stops auto-triggers
      without touching the manual path.
- [x] `npx tsc --noEmit` clean.
- [x] `npx tsc --noEmit -p tsconfig.spec.json` clean.
- [x] `npm run lint` clean.

## Risks

- **Resource cost** is real — embeddings + BM25 build are expensive.
  Mitigations: concurrency cap of 1, debounce, size limit defaults
  conservative, off by single setting flag.
- **First run on a large repo can take minutes.** UX needs to make
  this visible (the status badge) but non-blocking. The existing
  progress event stream already supports a progress bar in the panel.
- **Embedder backpressure** — if `VectorStore` is using a local
  embedding model, a giant cold index will pin CPU/GPU. The
  Merkle-incremental path keeps subsequent runs cheap, but a fresh
  monorepo will still cost. Consider adding a soft "schedule overnight
  / when idle" mode as a follow-up.
- **Two indexers (codemem + this) running concurrently** on the same
  workspace at app start. Both are non-blocking and run in separate
  workers (codemem worker thread vs. this service's main-process
  embedder pool). Acceptable, but worth measuring on first roll-out.
