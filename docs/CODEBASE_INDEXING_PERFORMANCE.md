# Codebase Indexing Performance

This guide covers the current codemem-backed indexing path. The performance goal is to keep indexing and retrieval bounded, avoid Electron main-process stalls, and make status/cancellation visible to the UI and IPC clients.

## Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Search latency | <500 ms p95 | Measured against codemem FTS retrieval with bounded snippets |
| Single-file update | <5 s | Watcher event to updated chunk rows |
| Main-process blocking | None for indexing loops | Heavy indexing runs in workers or lane processes |
| Generated folder hits | 0 by default | `node_modules`, `dist`, `build`, `.git`, and similar paths stay ignored |

## Watchers

Codemem uses a bounded native watcher when the platform and workspace size allow it. The watcher has a cap so very large workspaces do not create unbounded native handles or overwhelm the event loop.

When the native watcher cannot be used or the cap is exceeded, codemem falls back to polling scans. Polling is slower, but it keeps updates bounded and avoids native watcher pressure. The polling path still ignores generated and dependency folders.

File-change handling is incremental:

1. Creates and updates re-index the affected file.
2. Deletes remove the manifest entry, workspace chunk rows, FTS rows, and symbols for the file.
3. Batch events are debounced so save storms do not trigger redundant work.

## Storage Shape

Codemem stores source text in CAS chunks and stores search metadata in SQLite:

- `workspace_chunks` maps a workspace file chunk to its CAS `content_hash`, line range, language, type, and name.
- `code_fts` is a contentless FTS5 table keyed by the `workspace_chunks` row id.
- Snippet content is loaded from CAS at retrieval time instead of being stored again in FTS.
- `code_index_status` stores workspace indexing progress, phase, timestamps, errors, and cancellation state.

The contentless FTS design avoids duplicating source text while still giving fast keyword search over chunk content and symbol/import/export text.

## Status and Cancellation

Codemem status is available through worker gateway and IPC paths. Status snapshots include:

- `state`: scanning, chunking, complete, failed, or cancelled
- `phase`: current indexing phase
- `totalFiles` and `processedFiles`
- `totalChunks` and `processedChunks`
- `currentPath`
- `startedAt`, `updatedAt`, and `completedAt`
- `etaMs` when enough progress data exists
- `errorMessage` for failed runs

Cancellation is cooperative. A cancel request sets the workspace status row's cancellation flag. The index manager checks that flag between files and exits with a cancelled status, preserving any chunks already written.

## Retrieval Limits

`CodeRetrievalService` keeps searches bounded:

- It trims empty queries before hitting the index.
- It warms a cold codemem workspace with a short timeout before searching.
- It caps result count and snippet length.
- It falls back to bounded `rg` only when the codemem index has no usable result yet.
- The `rg` fallback excludes generated/dependency folders and has stdout and timeout limits.

## Legacy RLM Indexing

The legacy RLM codebase index is off by default. Manual legacy index buttons and IPC actions are diagnostics, not the canonical automatic path.

When legacy indexing is explicitly enabled or manually triggered, it runs through the background indexing lane. The Electron main process owns scheduling and status only; the indexing loop runs outside the main process.

As of 2026-06 the legacy path no longer generates code embeddings or runs hybrid vector search — that pipeline was removed because no read path consumed it. The legacy index is BM25 + symbols only.

## Vector Store Policy

Do not add LanceDB, `sqlite-vec`, or another vector database to the canonical code-index path in this pass. Vector DB additions are deferred until they have:

1. Benchmarks showing search-quality or latency improvement over codemem FTS plus symbols.
2. Packaging validation for Electron and native dependencies.
3. A clear migration and cleanup story for existing codemem/CAS data.
4. Tests covering cold start, incremental updates, cancellation, and generated-folder exclusions.

## Verification Commands

Focused checks:

```bash
npx vitest run src/main/codemem/__tests__/code-retrieval-service.spec.ts
npx vitest run src/main/indexing/indexed-codebase-context.spec.ts
```

Full checks after indexing changes:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
```
