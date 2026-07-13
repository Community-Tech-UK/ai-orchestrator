# RLM `search_index` Retirement + Storage Loose Ends — Plan (2026-07-12)

Three pieces, in execution order: retire the dead `search_index` table (Phases 1–5),
add backup retention to the maintenance service (Phase 6), and retire the equally dead
`file_metadata` table (Phase 7). Phases 6 and 7 are independent of 1–5 and of each other,
but share the verification gate at the end.

## Why (verified evidence, 2026-07-12)

The RLM database (`~/Library/Application Support/harness/rlm/rlm.db`) is 10.3 GiB after a
full stale-store prune + VACUUM. Per-table breakdown measured via `dbstat` on the live DB:

| Object | Size |
|---|---|
| `search_index` table | 5.4 GiB (31.1M rows) |
| `idx_search_store_term` | 1.36 GiB |
| `idx_search_section` | 1.1 GiB |
| `file_metadata` | 1.1 GiB |
| `vectors` | 345 MiB |
| `context_sections` (actual session content) | **107 MiB** |

So the inverted keyword index is ~7.8 GiB — roughly **70× the content it indexes** — because
`indexSection()` writes one row per term per line, each carrying a 200-char snippet
(`src/main/persistence/rlm/rlm-search.ts:14-74`).

**Nothing reads it.** Verified by whole-repo search (src, packages, benchmarks):

- The live lexical retrieval path ("RLM lexical search" in retrieved context) is
  `executeGrep()` over **in-memory** section content
  (`src/main/rlm/context/context-search.ts:42-99`), reached via
  `instance-context.ts:410-440` → `rlm.executeQuery(...)`. It never touches the table.
- The only readers of the table are `searchIndex()` and `rebuildIndex()` in
  `rlm-search.ts`, exposed as `RLMDatabase.searchIndex()/rebuildIndex()`
  (`src/main/persistence/rlm-database.ts:304-313`) and re-exported from
  `src/main/persistence/rlm/index.ts:56-58` — **zero callers** of any of these in main
  code. (Other `rebuildIndex` hits in the repo belong to unrelated modules: bm25-search,
  hybrid-retrieval, codemem.)
- The writers are three `deps.db.indexSection(...)` calls in
  `src/main/rlm/context/context-storage.ts` (lines 160, 245, 354).
- The separate **in-memory** `store.searchIndex` Map (`context-cache.ts`) and bloom filter
  are a different mechanism, are used (analytics + `searchStoreOptimized`), and are **not**
  part of this plan.

Decision: retire the dead table instead of redesigning it. This removes ~7.8 GiB (~75% of
the DB), removes per-term write amplification from every section persist, and speeds up
store pruning (fewer cascading child rows). A DB-backed FTS5 replacement is explicitly
**out of scope** (see last section) unless James asks for it.

## Phase 1 — stop writing

In `src/main/rlm/context/context-storage.ts`, remove the three `deps.db.indexSection(...)`
calls (lines 160, 245, 354) and, at the third site, the now-empty
`if (deps.db && deps.persistenceEnabled)` loop wrapping it. Read the whole file first;
leave `updateSearchIndex(...)` (in-memory Map) and all `persistSection` calls untouched.

## Phase 2 — remove the dead API

1. Delete `src/main/persistence/rlm/rlm-search.ts`.
2. Remove `indexSection`, `searchIndex`, `rebuildIndex` methods from `RLMDatabase`
   (`src/main/persistence/rlm-database.ts:304-313`, plus the `search` module import).
3. Remove the re-exports from `src/main/persistence/rlm/index.ts` (lines 56-58 region).
4. Types: in `src/main/persistence/rlm-database.types.ts`, remove `SearchIndexEntry`,
   `SearchResultRow`, and `SearchResult` **only if** a repo-wide grep confirms no other
   importer (beware: other modules define their own `SearchResult` types — match by import
   path, not by name). Let `npx tsc --noEmit` be the arbiter.

## Phase 3 — schema and migration

1. Remove the `search_index` DDL block from `src/main/persistence/rlm/rlm-schema.ts`
   (lines ~100-118: the CREATE TABLE and both CREATE INDEX statements), so fresh databases
   never create it.
2. Add migration `042_drop_search_index` to `RLM_MIGRATIONS_041_045` in
   `src/main/persistence/rlm/rlm-migrations-041-045.ts`, following the existing
   `{ name, up, down }` SQL-string shape:
   - `up`:
     ```sql
     DROP INDEX IF EXISTS idx_search_store_term;
     DROP INDEX IF EXISTS idx_search_section;
     DROP TABLE IF EXISTS search_index;
     ```
   - `down`: recreate the table + both indexes with the exact DDL currently in
     `rlm-schema.ts` (copy it before deleting it there).
3. **Startup-cost caution:** this migration drops a ~7.8 GiB table (31M rows) once, at app
   startup, on the main process. DROP TABLE moves pages to the freelist (it does not
   rewrite the file) so it should be seconds-not-minutes, but it is not free. Wrap nothing —
   the migration runner already runs it — but log before/after timing if the migration
   framework supports it, and record the observed duration in the livetest doc. An
   agent-runnable timing rehearsal is possible against a **copy** of a backup DB in
   `~/Library/Application Support/harness/rlm/backups/` (13 GiB free disk needed); this is
   optional, not a gate.

## Phase 4 — space reclamation (user-facing, no code)

Dropping the table only freelists the pages. The existing maintenance modal already
handles this: its preview `canRun` is true when `reclaimableDatabaseBytes > 0`
(`src/main/rlm/rlm-storage-maintenance.ts:136-137`), and its VACUUM shrinks the file.
After migrations 042 + 043 ship, "Reclaimable pages" will show ~8.9 GiB and one run of
"Clean up stale RLM sessions" compacts the DB to roughly 1.5 GiB (and, via Phase 6,
prunes the old backups in the same run). Note this in the completion summary so James
runs it (or it can be a livetest step).

## Phase 5 — tests

Specs that currently reference `indexSection` / `search_index` / `searchIndex` (read each;
update or remove assertions to match the retirement):

- `src/main/indexing/indexing-service-store-reset.spec.ts`
- `src/main/rlm/context-persistence-loader.spec.ts`
- `src/main/rlm/rlm-storage-maintenance.integration.spec.ts`
- `src/main/ipc/rlm-ipc-serialization.spec.ts`

Add a migration test (pattern precedent: `src/main/persistence/rlm/__tests__/`): create a
DB seeded with the old schema + a few `search_index` rows, run migrations, assert the
table and both indexes are gone and other tables intact. Note tests run on the wasm
sqlite driver (never re-add native rebuilds around tests).

## Phase 6 — backup retention for `harness/rlm/backups/`

### Why (verified)

Every maintenance run writes a full DB backup (~13 GiB each) plus a `_content` directory
into `backupDirectory` (`src/main/rlm/rlm-storage-maintenance.ts:174-180`; directory
resolved at `rlm-storage-maintenance-runtime.ts:31` as `<userData>/rlm/backups`). Nothing
ever deletes old ones. As of 2026-07-12 the directory holds four backups from a single
day — 52 GiB spent to reclaim 2.5 GiB.

### Design

Retention runs inside the maintenance service at the end of a **successful** run, after
the new backup is created and verified — never before, so a failed run always leaves every
existing backup untouched. The maintenance run itself is the only producer of backups, so
no startup sweep is needed; the next run self-cleans the current 39 GiB of old backups.

1. **Constant**: `RLM_BACKUP_RETENTION_COUNT = 2` in
   `src/shared/types/rlm-maintenance.types.ts` beside the other `RLM_` constants.
   Semantics: after a successful run, the `RLM_BACKUP_RETENTION_COUNT` newest backups
   (including the one just created) are kept; everything older is deleted.
2. **New module** `src/main/rlm/rlm-backup-retention.ts` exporting a single function:
   `pruneOldBackups(directory: string, keepCount: number): { deleted: number; bytesFreed: number; failed: number }`.
   - Enumerate only entries matching the maintenance naming scheme
     (`/^rlm-maintenance-.*\.db$/` — see the name construction at
     `rlm-storage-maintenance.ts:174-177`). Never touch anything else in the directory.
   - Order by the timestamp embedded in the filename (it is a fixed-width ISO-derived
     string, so lexicographic sort is chronological); fall back to mtime only if parsing
     fails.
   - For each pruned backup, delete the `.db` file and its siblings: `.db-wal`, `.db-shm`,
     and the `<stem>_content` directory (see the `_content` suffix convention in
     `rlm-storage-maintenance-database.ts:85`). Sum sizes before deleting for `bytesFreed`.
   - Deletion failures increment `failed` and are logged (`logger.warn`) — they must never
     throw out of the function or fail the maintenance run.
3. **Service wiring** (`rlm-storage-maintenance.ts`): add a dependency
   `pruneBackups(keepCount: number): { deleted: number; bytesFreed: number; failed: number }`
   to `RlmStorageMaintenanceDependencies` (wired to the new module in
   `rlm-storage-maintenance-runtime.ts`, following the existing dependency-injection
   shape). Call it in `run()` after `reload()` succeeds and the `after` measurement is
   taken, before building the success result. Unit tests inject a fake.
4. **Result surface**: add optional fields to `RlmMaintenanceSuccessResult`
   (`src/shared/types/rlm-maintenance.types.ts`): `backupsPruned?: number` and
   `backupBytesFreed?: number`. There is no Zod schema for this payload (verified — it
   flows through IPC untouched), so the ripple is: types → service result → one new line
   in the success panel of
   `src/renderer/app/features/loop/rlm-storage-maintenance.component.ts` (e.g.
   "2 old backups removed · 26.9 GiB freed", rendered only when `backupsPruned > 0`).
5. **Tests**:
   - New `rlm-backup-retention.spec.ts`: temp dir with mixed content (matching backups
     with siblings + `_content` dirs, plus a non-matching file that must survive); assert
     keep-newest-N ordering, sibling cleanup, byte accounting, and that failures are
     counted not thrown.
   - Service spec (`src/main/rlm/rlm-storage-maintenance.spec.ts`): successful run calls
     `pruneBackups` exactly once with the constant; failed run never calls it; prune
     result lands in the success payload.

## Phase 7 — retire `file_metadata` (same pathology as `search_index`)

### Why (verified 2026-07-12)

`file_metadata` is 1.1 GiB and **write-only**. Whole-repo search (excluding specs/markdown)
finds exactly two non-migration references, both in
`src/main/indexing/indexing-service.ts`: `INSERT OR REPLACE` (line 516 via
`saveFileMetadata`, called at line 506) and two `DELETE`s (lines 573, 593). There is no
`SELECT ... FROM file_metadata` anywhere in the repo. The in-memory `FileMetadata` objects
produced by `metadataExtractor` feed chunking/BM25 directly and are unaffected by dropping
the persistence.

### Steps

1. **Re-verify the negative before editing** (cheap, mandatory):
   `rg -n "file_metadata" src packages benchmarks` must show only
   `indexing-service.ts` (writes/deletes), migration files, and this plan's migration.
   If any reader has appeared since 2026-07-12, stop and report instead of proceeding.
2. Read `src/main/indexing/indexing-service.ts` in full. Remove `saveFileMetadata` and its
   call site, and the two `DELETE FROM file_metadata` statements (the surrounding
   store-reset logic stays — it also clears other tables). Keep all in-memory
   `FileMetadata` usage (extraction, chunk metadata) intact.
3. Migration `043_drop_file_metadata` in `RLM_MIGRATIONS_041_045`:
   - `up`: drop the four `idx_file_metadata_*` indexes (`IF EXISTS`) and
     `DROP TABLE IF EXISTS file_metadata;`
   - `down`: recreate table + indexes with the DDL currently in
     `rlm-migrations-001-015.ts:67-95` (the DDL lives only in that migration — there is
     no block to remove from `rlm-schema.ts`; do not edit shipped migration 001).
4. **Tests**: update `src/main/indexing/indexing-service-store-reset.spec.ts` (it
   references `file_metadata`); extend the Phase 5 migration spec to cover 043 (seed old
   schema + rows, migrate, assert table and indexes gone).

## Verification

1. Targeted specs above, then the full canonical checklist per AGENTS.md
   (`npx tsc --noEmit`, spec tsc, `npm run lint`, `npm run check:ts-max-loc`,
   `npm run test:quiet` — full suite required, this is a multi-file change).
2. Grep gate: `rg -n "search_index|indexSection|file_metadata" src packages` returns only
   migrations `042`/`043` (and their tests) — nothing else.
3. Behaviour gate: lexical retrieval still works — the existing specs covering
   `executeGrep` / `executeQuery` pass unchanged (this plan must not touch
   `context-search.ts`).
4. Livetest (`_livetest.md`, needs the rebuilt app on the real 10.3 GiB DB):
   - Startup migrations 042 + 043 complete (record durations); app functions normally.
   - Maintenance preview shows ~8.9 GiB reclaimable; one cleanup run shrinks `rlm.db`
     to roughly 1.5 GiB.
   - That same run prunes the old backups: `harness/rlm/backups/` afterwards contains at
     most `RLM_BACKUP_RETENTION_COUNT` backup sets (currently 4 sets / 52 GiB, so expect
     ~39 GiB freed), and the modal reports the pruned count and bytes.
   - A new session's lexical search ("Retrieved Context … RLM lexical search") still
     returns matches, and codebase indexing of a workspace completes without errors
     (exercises the removed `file_metadata` write paths).

## Explicitly out of scope (future candidates, do not implement)

- **FTS5 replacement**: if DB-backed lexical search over stores *not* loaded in memory is
  ever wanted, use an external-content FTS5 table over `context_sections` (precedent:
  migration `003_add_fts5_code_search` for `code_fts`). New plan required.
- `vectors` (345 MiB) and `browser_audit_entries` (315 MiB) growth: separate audit if the
  DB creeps again after this plan lands.
- A user-configurable backup retention setting: the hardcoded
  `RLM_BACKUP_RETENTION_COUNT` is deliberate; promote it to a settings key only if James
  asks.
