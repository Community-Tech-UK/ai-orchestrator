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

A cold index writes chunks as it goes and registers the workspace in `workspace_root` only when it finishes, and a later cold index wipes any partial rows before starting. So a cancelled or failed run leaves rows that cannot be searched and have no further use. Maintenance finds these abandoned workspaces, skips any with a live index run, and deletes them in small batches. It then deletes chunk text nothing refers to and merges the search index, which is what actually gives the space back. The index worker runs all of this in half-second bursts with pauses of about a second, resuming each step where the last one stopped, because every search queues behind it. The last stage returns free pages to the filesystem in 4 MiB steps. The old unbounded steps were far longer: a full optimise took 157 seconds and the chunk delete 13 seconds, both at every worker start.

Two things keep the steps short. FTS5's `deletemerge` setting is off, because it merged segments inside the deleting transaction and held the worker for up to 23 seconds. Deleted rows therefore give back their search index space only when maintenance merges the index, which happens at each worker start, or during a loop if the database grows very large. That includes rows replaced by ordinary edits, which search skips until then. The cost is small: during the clean-up, an index with most of its rows deleted but not yet merged searched at a 382 ms median, against 300 to 500 ms before it started. And merging waits until the abandoned rows are gone: a merge can only stop between words, so merging the uncleaned index took up to 5 seconds per step, against 791 ms afterwards.

The real worker was run on a copy of the 14 GB index holding 3 million abandoned rows, with a search every 2 seconds. It started in 17 seconds, and finished in 44 minutes with a 6.5 GB file. The longest maintenance step in a separate timed run was 950 ms. The first search took 19 seconds, which is the cost of a cold copy: it took 10 to 17 seconds with no clean-up running. Searches queued behind it waited too, and after that none took more than 1.9 seconds. While rows were being deleted 43% of searches missed the 500 ms send deadline, and 12% while free space went back. Once it finished the median was 46 ms and none were over 92 ms.

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

## Matching and Ranking

A query is often a whole message, so `code-search-query.ts` reduces it to its informative words and lets any of them match. Requiring every word found the right file for only 8% of real commit descriptions.

`searchHydratedChunks` then reranks a pool of 100 candidates. Each chunk's BM25 score is multiplied by a file-kind weight and by the share of query words it contains. The weights put code first, then tests, documents and data files, because plan documents repeat the vocabulary of the code they describe and otherwise outrank it.

Text nobody typed as a search (message context, first prompts, fast-path tasks and loop goals) passes `strongMatchOnly`. It needs at least two informative words with half the query matched, or the chunk that defines a code name from the query, so a reply like "yes please" adds no code to the prompt. These callers also skip the ripgrep fallback, which cannot help with a sentence and would hold up sending. For explicit searches, the fallback treats the query as literal text.

Measured on real commit descriptions across every file type, with the right file in the top 10:

| Search | Tuning set (197) | Held-out set (206) |
|--------|------------------|--------------------|
| Every word must match | 8.1% | 6.8% |
| Any word, plain BM25 | 52.8% | 47.6% |
| Any word, reranked | 69.0% | 60.2% |

On a copy of the real index, removing 3 million abandoned rows took the file from 14.2 GB to 6.5 GB. Automatic-context search on that copy had a median of about 300 to 500 ms before the clean-up, depending on how busy the machine was, with 49 to 137 of 403 queries over the 500 ms send deadline. After it the median was about 35 ms, with none over. The every-word search this replaced had a 580 ms median on the same index, over 40 queries.

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

The first condition has been tested for embeddings. On 197 real commit descriptions, keyword search put the right source file in the top 10 for 70.6% of queries, against 58.4% for bge-base-en-v1.5 and 54.3% for a LEANN index, and combining keywords with embeddings gained nothing. See `docs/decisions/rejected/vector-index-engines.md`.

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
