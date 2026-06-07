# Code Vector-Search Removal (Option B)

**Date:** 2026-06-06
**Status:** ✅ Completed & verified 2026-06-06 (tsc, spec tsc, lint 0 errors, tests pass).
Final cleanup pass 2026-06-06 removed the residual vestigial embedding surface
(see "Follow-up cleanup" below). File renamed `_completed` and doc links updated.
**Owner:** James
**Prereq:** Phase 0 (embedding gate) — superseded by this removal (flag deleted)

## Motivation

A 2026 survey ("AI Agents Don't Need Vector Search Anymore" — agent-as-retriever /
just-in-time context loading) prompted an audit of AIO's code retrieval. Finding:

**AIO maintains two independent code-index systems, and the vector one is write-only.**

| | `codemem/` (cas-store) | `indexing/` (CodebaseIndexingService) |
|---|---|---|
| Stores | BM25/FTS5 + LSP symbols | chunks + **vector embeddings** + own BM25 |
| Read by | agents (MCP tools), `CODEBASE_SEARCH` IPC, ripgrep fallback | **nothing** |

Evidence (verified 2026-06-06):
- `indexing-service.ts` embeds every chunk via `vectorStore.addSection()` on every
  `indexCodebase`/`indexFile` (now gated behind `generateCodeEmbeddings`, default off).
- The only code-side vector reader is `ContextAssembler.assembleContext()` →
  `HybridSearchService.search()`. **`ContextAssembler` has zero callers** (only the
  barrel export in `indexing/index.ts`).
- `CODEBASE_SEARCH` / `CODEBASE_SEARCH_SYMBOLS` IPC (`codebase-handlers.ts`) route to
  `codeRetrievalService.search()` — the **codemem BM25/ripgrep** path — and tag results
  `matchType: 'bm25'`. The renderer method comment "hybrid search (BM25 + vector +
  reranking)" (`codebase-ipc.service.ts:150`) is aspirational and false.

Conclusion: code embeddings were generated cost (indexing latency + local Ollama or
cloud OpenAI/Voyage embedding calls) with **zero read benefit** — dead code, the "index
is a liability" failure mode. This is tech-debt cleanup, **not** a fix for an active
default-on cost (see below).

### When code embeddings were actually generated (corrected framing)

The cost was **opt-in / diagnostics debt, not normal default behavior**. The `indexing/`
`CodebaseIndexingService` is the *legacy RLM* indexer, distinct from the canonical
`codemem` path. Three paths:

1. **Default (legacy auto-index off):** `DEFAULT_SETTINGS.codebaseAutoIndexEnabled = false`
   (`settings.types.ts:403`), and `settings-manager.ts:180-182` **force-migrates any
   stored `true` back to `false`**. So out of the box, the legacy indexer never runs and
   **no code embeddings are generated**.
2. **Manual:** a user clicking "Index" in the codebase panel (`CODEBASE_INDEX_STORE` IPC)
   runs `indexCodebase` once → embedded that run.
3. **Legacy-enabled:** historically, `codebaseAutoIndexEnabled = true` auto-ran it — but
   the migration above now disables that, so this path is effectively closed.

So the removal stops a **manual/legacy diagnostics** cost, not an always-on tax. The honest
case for removal is *dead code + liability reduction*, not performance urgency.

**Cloud-embedding privacy note:** when `embeddingProvider` was `openai`/`voyage`, manual or
legacy code indexing shipped chunks of (potentially proprietary) source to a cloud
embedding API for vectors that were never read. Removing the code-embed path eliminates
that egress entirely — a real, if narrow, privacy win.

**Existing documented policy (this removal aligns with it):** `docs/CODEBASE_INDEXING.md`
already states *"Do not add a vector database to the canonical path until it has benchmark
evidence, packaging validation, and a clear quality gain over codemem FTS plus symbols,"*
and `CODEBASE_INDEXING_PERFORMANCE.md` has a "Vector Store Policy" deferring vector DBs.
Option B is consistent with that policy; Option A (below) would **contradict** it.

**Code is NOT purely agentic — it is already pre-injected (BM25):**
`IndexedCodebaseContextService` injects up to **~900 tokens** (`DEFAULT_MAX_TOKENS`) of
**BM25** hits (codemem `CodeRetrievalService`) into each parent message via
`context-engine.ts` → `buildIndexedCodebaseContext(instance, message)`. So AIO is already a
*BM25 hybrid* (pre-injected lexical context + agentic tool search), not "pure agentic." The
removal does not touch this — it only removes the unused **vector** layer.

**Out of scope / KEEP (must be preserved):** the shared `VectorStore` + `EmbeddingService` +
`HyDEService` stack is genuinely *read* for **non-code memory** — `observation-store.ts`,
`episodic-rlm-store.ts`, `rlm/context/context-search.ts` all call `vectorStore.search()`.
These stay untouched; the removal is scoped strictly to `src/main/indexing/` + the codebase
IPC. Memory vector behavior must remain byte-for-byte identical (verified: observation-store
tests still pass).

## Decision point

Option B = remove the dead code-vector path (lean stack, **aligns with the existing
canonical-path no-vectors policy**). This was chosen and implemented.

**Option A (NOT recommended — policy conflict):** wiring `HybridSearchService` in as an
optional semantic fallback would *re-introduce* code embeddings on the canonical path,
directly contradicting the documented Vector Store Policy. It is under-scoped as written:
it would require (1) reconciling the two corpora — codemem `cas-store.sqlite` chunks vs the
legacy `indexing/` `context_sections`/`vectors` tables — so a single query searches the same
files; (2) an embedding provider/runtime decision (local-only to preserve privacy);
(3) benchmark evidence of quality gain over BM25+symbols per the policy; (4) packaging
validation. Treat Option A as a *new design effort gated on the policy bar*, not a quick
toggle. Only revisit on concrete user demand for concept-spread code search (e.g. `retry`
→ `backoff`/`requeue`/`circuit_breaker` with no shared keyword).

## Scope of removal (Option B)

Delete / simplify, in dependency order:

1. **`indexing/context-assembler.ts`** — delete file. Remove its exports from
   `indexing/index.ts` (`ContextAssembler`, `getContextAssembler`,
   `resetContextAssembler`, `AssembleContextOptions`). Delete `context-assembler.spec.ts`.
2. **`indexing/hybrid-search.ts`** — delete file (only consumer is ContextAssembler).
   Remove exports from `indexing/index.ts`. Delete `hybrid-search.spec.ts`.
   - Note: `HybridSearchResult` type is reused by `codebase-handlers.ts` for
     renderer-compat. Keep the *type* (move it to a types file if it lives in
     hybrid-search.ts) — only remove the search *implementation*.
3. **`indexing-service.ts`** — remove `generateEmbeddings()`, the gated call sites, the
   `vectorStore` field + `getVectorStore()` import, and the `removeSection`/`clearStore`
   vector calls in `removeFileFromIndex` / `clearStoreIndex`. Drop the `'embedding'`
   status from progress state if no longer used.
4. **`shared/types/codebase.types.ts`** + **`indexing/config.ts`** — remove the
   `generateCodeEmbeddings` flag and `embeddingProvider` / `embeddingModel` config if
   nothing else reads them (verify `embeddingProvider` isn't consumed by codemem first).
5. **`testsingleton-reset.ts`** — leave `VectorStore._resetForTesting()` (still used by
   memory subsystems).
6. **Renderer** — fix the false "BM25 + vector + reranking" comment in
   `codebase-ipc.service.ts`; rename `HybridSearchOptions`/result naming if desired
   (low priority — renderer-compat shape).
7. **Docs** — update `docs/CODEBASE_INDEXING.md`, `CODEBASE_INDEXING_API.md`,
   `CODEBASE_INDEXING_PERFORMANCE.md` to drop embedding/hybrid claims.

## Verification

- `npx tsc --noEmit` + `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint:fast`
- `npx vitest run src/main/indexing` (expect context-assembler/hybrid-search specs gone)
- Manual: index a workspace via the codebase panel, run a search, confirm results still
  return (via codemem BM25/ripgrep) and indexing no longer reports an "embedding" phase.
- Grep guard: `rg "getVectorStore|vectorStore" src/main/indexing` → only inert
  `vi.mock('../../../rlm/vector-store', ...)` entries in `.load.ts`/`.bench.ts`
  (excluded from the test run; mock a still-existing shared module). No source reader.

## Follow-up cleanup (2026-06-06)

Item 3's conditional ("drop the `'embedding'` status from progress state if no longer
used") was confirmed satisfiable — the backend never emits `'embedding'` anymore — so it
plus the remaining always-zero embedding fields were fully removed for a coherent
no-embedding-vestige end state:

- `IndexingStatus`: removed the `'embedding'` member (`shared/types/codebase.types.ts`).
- Removed always-zero fields: `IndexingProgress.embeddedChunks`,
  `IndexingStats.embeddingsCreated`, `IndexStats.totalEmbeddings` from the shared types,
  `indexing-service.ts` state/getters, the worker lane protocol + Zod result schema
  (`codebase-indexing-lane-protocol.ts`, `codebase-indexing-lane-gateway.ts`,
  `codebase-indexing-lane-main.ts`).
- Renderer: dropped the dead `status === 'embedding'` branches, the "Embedding" status
  label + `.status-badge.embedding` CSS, the "N chunks embedded" → "N chunks" progress
  text, and the "Embeddings" stat card (`indexing-progress.component.ts`,
  `codebase-panel.component.ts`, `codebase-stats.component.ts`).
- Updated all affected specs and the `CODEBASE_INDEXING_API.md` `getProgress()` shape.

Verified: `tsc` + spec `tsc` clean, `lint:fast` 0 errors, indexing + codebase IPC +
codebase-panel suites green (127 tests). Memory vector stack untouched.

## Risk / rollback

Low. No reader is lost (the path was already dead — `ContextAssembler` had zero callers).
Removal is reversible from git history. The interim `generateCodeEmbeddings` flag (Phase 0)
was deleted as part of this removal; Option A is therefore a fresh design effort (see the
Decision section), not a one-boolean re-enable. Main hazard: accidentally touching the
**shared memory** vector stack (`VectorStore`/`EmbeddingService`/`HyDEService` read by
observation/episodic/RLM-context) — the blast radius was kept strictly inside
`src/main/indexing/` + the codebase IPC, and `observation-store` tests confirm the memory
vector path is unchanged.
