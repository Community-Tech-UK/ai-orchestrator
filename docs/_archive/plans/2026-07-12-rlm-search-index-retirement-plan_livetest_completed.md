# RLM Search-Index Retirement — Live Test

Prerequisites: build and restart the desktop app using the branch containing
`2026-07-12-rlm-search-index-retirement-plan_completed.md`. Run against the
real user-data database, not a test database. This document records checks
that require the real 10.3 GiB RLM database, app UI, or workspace indexing.

## 1. Verify startup migrations

1. Start the rebuilt app and note the time immediately before startup.
2. Confirm migrations `042_drop_search_index` and `043_drop_file_metadata`
   complete without an RLM startup error; record the observed duration here.
3. Use the app normally after startup.

Expected: the app starts normally and the two migrations complete once.

Why deferred: the production database is not safe to mutate from an automated
test run. The drop operation must be timed on the actual large database.

## 2. Reclaim the dropped-table pages

1. Open **Clean up stale RLM sessions** and inspect the preview.
2. Confirm **Reclaimable pages** is approximately 8.9 GiB.
3. Run the cleanup once and wait for the verified success panel.
4. Check the final `rlm.db` size.

Expected: the database compacts from approximately 10.3 GiB to approximately
1.5 GiB, subject to current session content and WAL state.

Why deferred: VACUUM must run against the real persisted database through the
desktop maintenance flow.

## 3. Verify backup retention

1. During the same successful maintenance run, note the success-panel backup
   retention line.
2. Inspect `<userData>/rlm/backups/` afterwards.

Expected: the panel reports removed old backups and freed bytes when applicable;
the directory contains no more than two `rlm-maintenance-*.db` backup sets,
including matching `-wal`, `-shm`, and `_content` siblings. With four existing
sets, roughly three old sets (about 39 GiB) are removed.

Why deferred: this depends on the user's real historical backups and the
maintenance-created backup set.

## 4. Exercise unaffected runtime paths

1. Start a new session and use a lexical RLM query that matches known context.
2. Confirm retrieved context includes an **RLM lexical search** result.
3. Index a workspace and wait for codebase indexing to complete.

Expected: lexical retrieval returns matches and codebase indexing completes
without a persistence error.

Why deferred: both checks require the rebuilt desktop app, a real session, and
a local workspace.

## Evidence run — 2026-07-12

**Status: BLOCKED (0/4 checks passed).** Read-only inspection of the real database found both
`search_index` and `file_metadata` still present, and no startup-log entries for migrations
`042_drop_search_index` or `043_drop_file_metadata`. This proves the installed/running package
did not meet this document's prerequisite build; the migration, VACUUM, retention, lexical
retrieval, and workspace-indexing checks were therefore not run or credited.

The real database measured 11,269,443,584 bytes at inspection time and four historical
maintenance database backups were present. No production database mutation was initiated by
this evidence run.

## Completion evidence — 2026-07-12

**Status: PASSED (4/4 checks).** A freshly rebuilt packaged Harness was restarted against the
real production profile. Migrations `042_drop_search_index` and `043_drop_file_metadata`
completed and independent SQLite inspection confirmed both retired tables were absent. Harness
then reported 9,545,785,344 reclaimable database bytes and completed its real maintenance path
with a verified backup.

The database compacted from 11,321,923,760 bytes to 1,753,782,208 bytes, reclaiming
9,568,141,552 bytes. Three old backup sets were pruned and 41,559,566,810 backup bytes were
freed. Two backup sets remained; the newest backup passed `PRAGMA quick_check`, and all 26,274
external-content references had matching files.

The unaffected runtime checks also passed through the packaged renderer IPC boundary. A unique
lexical marker was returned by an RLM query, and a two-file disposable workspace indexed
successfully. The indexing rerun initially exposed a worker database-path defect; after the
gateway began passing Harness's resolved user-data path to the worker, the packaged rerun
indexed both files without a persistence error.
