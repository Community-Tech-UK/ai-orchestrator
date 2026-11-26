# RLM Vector Store — main-process heap reduction

Status: **completed** (2026-07-22) — all five items implemented, wired, and gate-verified;
live-heap validation deferred to the livetest doc (needs a rebuilt/restarted app).
Owner: agent session 2026-07-21
Related incident: ResourceGovernor culled three live sessions at 21:47 on 2026-07-21 because the
main-process heap sat at 3.1–3.5 GB against a ~3.48 GB critical line. The governor was fixed
separately; this plan attacks the memory itself.

## Diagnosis (measured, not inferred)

`VectorStore`'s constructor (`src/main/rlm/vector-store.ts:57`) calls `loadFromPersistence()`,
which eagerly loads **every vector of every store** into a process-lifetime `Map`. Wired into the
main process via `src/main/bootstrap/memory-bootstrap.ts:73` → `getRLMContextManager()` →
`initializePersistence()` → `getVectorStore()`.

`bufferToEmbedding` (`src/main/persistence/rlm/rlm-vectors.ts:69`) does
`Array.from(new Float32Array(...))`, converting each compact float32 blob into a plain JS array of
**doubles** — a 2x blow-up into boxed heap.

Live measurements against `~/Library/Application Support/harness/rlm/rlm.db` (2.75 GB):

- **238,026 vectors** across **1,306 stores**, 384 dims each (1536-byte blobs)
- embeddings 366 MB on disk -> **~740 MB** heap as `number[]`
- `metadata_json` 64 MB -> ~190–385 MB parsed
- `content_preview` 57 MB -> ~60–115 MB
- ids/`storeVectorIds` Sets ~45 MB; Map + object overhead ~26 MB
- **Total ~1.1–1.3 GB**, i.e. 35–40% of the post-GC floor, from one structure

Ruled out by measurement: output buffers (real messages average 4.1 KB, so a full 1000-message
buffer is ~4 MB/instance), SnapshotManager (metadata only), codemem.sqlite (disk/mmap; RSS 3659 MB
vs heap 3514 MB with external at 7.8 MB means the heap is almost entirely JS objects),
token-counter sample arrays (bounded), context-manager's loader (already bounded by
`PERSISTED_SECTION_QUERY_LIMIT`).

## Consumer contract (checked before changing the cache shape)

Production callers of `VectorStore.search()` are `episodic-rlm-store.ts:282,464`,
`context/context-search.ts:231`, `observation-store.ts:174`. They read only:

- `result.entry.sectionId` (all)
- `result.entry.contentPreview` (context-search only)
- `result.similarity`

Nothing downstream reads `entry.metadata` or `entry.embedding`. `searchAll()` has **no production
callers**.

## Work items

### 1. Store embeddings as `Float32Array`
`bufferToEmbedding` returns a copied `Float32Array` (must copy — a view over `buffer.buffer` would
retain Node's pooled 8 KB slab). `VectorEntry.embedding`, `cosineSimilarity`, and `findSimilar`
accept `Float32Array | number[]`. Saves ~365 MB. No behaviour change.

### 2. Slim the hot cache
Cache holds `id`, `sectionId`, `storeId`, `embedding` only. `contentPreview`/`metadata` are
hydrated from SQLite for the top-K after ranking. Saves ~250–500 MB.

### 3. Lazy per-store load + LRU eviction
Replace the eager constructor load with `ensureStoreLoaded(storeId)` on first use; evict
least-recently-used stores past a cap. `searchAll()` restricted to already-loaded stores unless
`storeIds` is given, so it cannot silently reload the corpus.

### 4. Vector retention, dry-run first
`vectors.created_at` already exists. Add an age-based prune that **defaults to reporting only**, so
the retention cutoff is chosen against real counts rather than guessed. No deletion without an
explicit opt-in.

### 5. Heap-snapshot diagnostic
`v8.writeHeapSnapshot()` into the diagnostics dir, so the remaining unattributed heap is measured
rather than guessed at next time.

## As built

All five items implemented.

- **1. Float32Array** — `bufferToEmbedding` returns a *copied* `Float32Array`
  (`rlm-vectors.ts`). `cosineSimilarity`/`findSimilar` widened to `ArrayLike<number>` so no caller
  is forced to convert. `VectorEntry.embedding: Float32Array`.
- **2. Slim cache** — new internal `CachedVector` holds id/sectionId/storeId/embedding only.
  `hydrate()` reads preview + metadata back from SQLite for ranked matches. Verified safe:
  `context_sections.id` is a PRIMARY KEY and 0 of 238k section ids span multiple stores, so the
  by-section lookup is unambiguous.
- **3. Lazy + LRU** — `ensureStoreLoaded()` / `touchStore()` / `evictColdStores()`,
  `maxResidentStores` default 24. Constructor no longer loads anything.
- **4. Retention** — `pruneVectorsOlderThan(cutoff, { apply })`, reporting-only unless `apply`,
  returning matched/stores/bytes so a cutoff can be chosen against real counts.
- **5. Heap snapshot** — `src/main/diagnostics/heap-snapshot.ts` with `getHeapUsageSummary()` and
  `writeHeapSnapshot()`. Wired into `ResourceGovernor.handleCritical` behind
  `HARNESS_HEAP_SNAPSHOT_ON_CRITICAL=1`, once per process, with the diagnostics dir injected from
  `initialization-steps.ts` (keeps `electron` out of the governor module).

Lazy loading changed the meaning of a cache miss, so these were corrected too: `isIndexed` and
`getEntry` fall through to the database, `removeSection` deletes from the database
unconditionally, and `clearStore`/`indexStore` load before acting. `addSection` loads the store
first — without it, adding to a cold store left a residency entry holding only the new id and the
next search ranked against that single vector (caught in self-review, regression test added).

Expected effect: the vector cache drops from ~1.1-1.3 GB fully resident to ~1.9 KB/vector for the
resident working set only — order of tens of MB at a 24-store cap, versus 238k vectors before.

## Verification

Targeted specs per item, then the canonical gate: `npx tsc --noEmit`,
`npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run test:quiet`.

Targeted specs green (39 tests across `vector-store.spec.ts`, `rlm-vectors.spec.ts`,
`heap-snapshot.spec.ts`, `resource-governor.spec.ts`); `tsc` main + spec, `ng lint`,
`check:ts-max-loc`, and the full `test:quiet` suite (15,352 tests) all pass on the committed tree.
Consumer contract re-verified against source: the three production `VectorStore.search()` callers
(`episodic-rlm-store.ts:282,464`, `context/context-search.ts:231`, `observation-store.ts:174`)
read only `entry.sectionId`, `entry.contentPreview` (hydrated), and `similarity` — grep confirms
zero production reads of `entry.metadata` / `entry.embedding`, and `searchAll()` has no production
callers, so the slim-cache + hydrate change is safe.

Live validation (needs a rebuilt/restarted app on a real large corpus) is deferred to
[2026-07-21-rlm-vector-store-memory_livetest.md](2026-07-21-rlm-vector-store-memory_livetest.md):
post-boot heap floor, `getStats()` working-set counts, real-search relevance with hydrated
preview, and the optional heap-snapshot-on-critical diagnostic.
