# Search and memory repair

Status: implemented and verified on 6 November 2026. James approved all four items that day ("fix all those issues") after the LEANN evaluation. None of it is live until the app is rebuilt and restarted.
Checks that need a rebuilt app are deferred to [the live-test document](2026-11-06-search-and-memory-repair_plan_livetest.md) and have not been run.

## Why

Evaluating LEANN showed AIO's search has larger, cheaper problems than disk space:

1. Code search needed every word to match, so the right file reached the top 10 for 8% of real commit descriptions.
2. 84% of the code index (3.0M of 3.58M rows) belonged to 217 workspaces that no longer exist.
3. All 748,192 stored vectors were hash vectors, so "semantic" memory and skill matching were word overlap.
4. LEANN itself does not fit, and that should be recorded so the sweep is not repeated.

## Item 1: clear leftover index rows and stop them building up

- `coldIndex` registers a workspace only at the end, and a new cold index wipes partial rows, so an unregistered workspace that is not indexing has no value.
- `listWorkspaceIndexStats` starts from `workspace_root`, so the existing pruner cannot see these rows.
- `pruneAbandonedWorkspaces` finds them with one index probe per workspace and deletes them in 1,000-row transactions inside a half-second budget, skipping a workspace with a live run.
- The index worker repeats that with pauses of about a second until none remain. It then releases the space in the same kind of burst: a walk over `chunks` that resumes where it stopped, then FTS5 `merge` steps, then free pages going back to the filesystem in 4 MiB steps.
- Manifest rows are deleted last, because a new cold index clears old rows by walking the manifest. A workspace re-warmed partway through a drain would otherwise keep stale chunks.
- A deletion during a release pass starts the pass again, because the walk may already be past those rows.
- Every maintenance step now has a time budget. The old `optimize` took 157 seconds on the real index and the old chunk delete 13 seconds, at every worker start, with all searches queued behind them.
- Schema version 5 turns off FTS5's `deletemerge`. It merged segments inside the deleting transaction, which held the worker for up to 23 seconds and took 17 minutes of work overall. Without it the drain took 7 minutes of work and its longest step was 950 ms, with the same end state.
- Merging waits until the abandoned rows are gone. A merge can only stop between words, so merging the uncleaned index took up to 5 seconds per step, against 791 ms after the clean-up. Smaller steps did not shorten those, because one very common word has to be merged in a single call.
- Returning free pages was a 10-second hold every 5 minutes. That was harmless while the file had no free pages, but the clean-up leaves 7.6 GB of them, so it would have stalled searches for about 2 hours. It is now the last stage of the same bursts, and took 17 minutes.
- The worktree source of the leak was already guarded on 23 October (6afb32a52). This clears the backlog, and any future cancelled run.
- The live database is only changed by the app's own maintenance after a rebuild. It must not be edited by hand while Harness owns it.

## Item 2: any-word matching with code ranked first

- `code-search-query.ts` reduces a query to informative words joined with OR.
- `searchHydratedChunks` reranks a 100-chunk pool by BM25, file kind and share of query words.
- Automatic callers pass `strongMatchOnly`, which needs two informative words with half the query matched, or the chunk that defines a code name from the query. Merely containing the name is not enough, because a brand such as `GitHub` is shaped like a class name. They also skip ripgrep.
- The ripgrep fallback is now a literal search, and `--` stops a message being read as an option.

## Item 3: a real embedding model for memory and skills

- `EmbeddingService` now runs bge-small-en-v1.5 (8-bit, 32 MB) through `onnxruntime-node`, with the word hash as the fallback when the model cannot run. Each process settles on one model at first use.
- The unused Ollama, OpenAI and Voyage paths are gone. Nothing configured them, and an Ollama server appearing would have changed the vector size under existing stores.
- Queries and stored text are embedded differently, so `embed` takes a purpose.
- Every stored vector already recorded its model. Reads now filter on it, so vectors from different models are never compared.
- `VectorReembedder` converts a store's older vectors in the background the first time it is searched, one store at a time in batches of four, so a search only ever waits behind one small batch. Searches never wait for the conversion itself, and the hash never replaces real vectors.
- Thresholds are per model and per use (`rlm/embedding/embedding-model.ts`).
- `r1-memory-manager` had a second, separate word hash. It now uses the same service, `load()` re-embeds entries from another model, and comparisons skip any entry not yet on the query's model.
- Skill matching takes only the single best semantic match.
- Comparing a new pattern with stored ones is stored text against stored text, so it embeds as a document and uses its own floor.
- Clearing a store cancels its conversion, so a batch in flight cannot bring deleted vectors back.

## Item 4: record LEANN as rejected

`docs/decisions/rejected/vector-index-engines.md`, which also records that embeddings do not beat keywords for code search.

## Decisions

- **Runtime:** `onnxruntime-node`. It is N-API, so it needs no per-Electron rebuild, and inference runs off the event loop. Measured under Electron 42 on the main thread and in a worker thread.
- **Model:** bge-small-en-v1.5, chosen from four candidates run through the shipping code. It put the right skill first 14 and 16 of 17 times on two prompt sets, against 11 and 13 for MiniLM, and matched the 105 MB bge-base at under a third of the size. It keeps 384 dimensions, so stored vectors stay the same size.
- **Model delivery:** fetched at build time with a pinned checksum and packaged as a resource. Nothing is committed and the app needs no network for it.
- **Skill threshold:** 0.62, best match only. No wrong skill and no off-topic match across 68 prompts, with 25 of 34 found. It fired on 6% of a 35-message sample of real messages.
- **Memory thresholds:** set above measured chance level on real memory text. No labelled data exists for memory search, so these are not tuned against relevance. The live checks watch for them being wrong in either direction.
- **Code search stays keyword-based.** The strongest embedding tried reached 58.4% against 70.6%, and combining them gained nothing.
- **R1 retrieval keeps its configured 0.7 threshold.** It is a user-facing setting rather than a model constant, and 0.7 matches the `context-search` floor. A process that falls back to the hash re-embeds R1 entries in memory so they stay comparable, and they convert back on the next run with the model.
- **The ripgrep fallback is literal.** The main index search treats a query as words, so a regular expression only ever worked in this fallback, when the index was unavailable. A literal search behaves the same either way, and text such as `--files` can no longer be misread as an option.
- **The model is required to package the app and optional for a dev start.** `electron:build` fails without it, while `prestart` only warns. `npm run build` does not fetch it, so CI builds that never package do not depend on the download.
- **Bursts are sized to the send deadline.** Each step aims for 500 ms, with a 1.25-second pause, so clean-up takes under a third of the worker's time and a search normally waits less than the deadline.

## Known limits

- Intel Macs have no `onnxruntime-node` binary, so they stay on the word hash.
- Text longer than 256 tokens, about 1,000 characters, is represented by its opening only. bge-small accepts 512, but longer inputs take proportionally longer, and conversion shares the model with searches.
- `listStaleVectors` rescans a store for every batch, so conversion costs more on a large store. On the largest real store, 43,244 vectors, it still ran at about 26 vectors a second with searches unaffected, so this stays simple until a store needs more.
- Only the Mac arm64 package has been built. The packager's real file filter was run for all five release targets and keeps the right runtime binary for each, and the live-test document covers the other packages.
- Old stores convert when next searched. Until a store finishes, its searches see fewer vectors, and callers fall back to keywords as they already do.
- The first clean-up took 44 minutes on a clone: about 26 to delete the rows and merge the index, then about 17 to return the space. While rows are being deleted the index is still bloated, so 43% of searches missed the send deadline, against 23 of 40 for today's search on that index. 12% missed it while space went back, and none after that.
- With `deletemerge` off, rows replaced by ordinary edits stay in the search index, skipped, until the next worker start, or a merge during a loop if the database grows very large. A long-running worker carries them for longer, but an index with most of its rows deleted still searched no slower than before the clean-up.
- Log lines from the index worker and context worker never reach `app.log`, because those processes have no file log. This is existing behaviour, so the live checks use the database and file size instead.

## Measured results

All on this Mac under load, using the shipped code against clones of the real databases. Nothing live was changed.

| Measure | Before | After |
|---|---|---|
| Right file in top 10, tuning commits (197) | 8.1% | 69.0% |
| Right file in top 10, held-out commits (206) | 6.8% | 60.2% |
| Automatic code search, median | 580 ms today, about 300 to 500 ms with the new search before clean-up | about 35 ms |
| Automatic code searches over 500 ms | 23 of 40 today, 49 to 137 of 403 with the new search before clean-up | 0 of 403 |
| Code index file | 14.2 GB | 6.5 GB |
| Longest maintenance step | 157 s | 950 ms |
| Index worker start on the real index | at least 170 s of maintenance | 17 s |
| Right skill first, 34 prompts across both sets | 6 of 17 on the first set | 30 of 34 |

Conversion on a clone of the real memory database ran at about 13 to 26 vectors a second. 566 unique queries during conversion took a median of 11 ms and a maximum of 67 ms, with none over 500 ms. Memory settled around 500 to 550 MB for the whole test process.

## Verification

On the final code:

- `tsc`, `typecheck:spec`, `lint`, `lint:fast`, `check:ts-max-loc`, `check:ui-hints`, `verify:architecture`, `verify:exports`, `verify:embedding-model`, `bench:retrieval`, `build:main` and `build:renderer` all passed.
- The full suite ran 39,037 tests and 39,033 passed. The other 4 are in `src/main/plan-queue/plan-queue-group-landing.spec.ts`, in tests that exist only in another session's uncommitted edit of that file. Their test double has no `isShuttingDown`, which commit 9bb035697 started calling, and they fail the same way when that file runs alone. This work changes nothing in `src/main/plan-queue`.
- A real, unsigned Mac arm64 package built in 24 seconds. It holds the model and only its own runtime binary, and the model loaded from inside it on the main thread and a worker thread.
- The real built index worker ran on a copy of the real index with live searches, as described in `docs/CODEBASE_INDEXING_PERFORMANCE.md`, and shut down cleanly.
- Five independent reviews ran. The first three failed and their findings were fixed. The last two passed, with only minor notes. Those notes were fixed too, except one log line, which behaves as it did before.

Not verified: the installed app, a signed build, and Windows and Linux packages. The live-test document covers these.
