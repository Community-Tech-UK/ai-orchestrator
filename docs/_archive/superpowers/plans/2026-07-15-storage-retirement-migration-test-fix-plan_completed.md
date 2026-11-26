# Storage Retirement Migration Test Fix Implementation Plan

> **For agentic workers:** Execute this plan inline using systematic debugging and test-driven development. Keep this document untracked until implementation and verification are complete, then record as-built evidence and rename it with `_completed`.

**Goal:** Make the storage-retirement migration test exercise only migrations 042 and 043 so unrelated later migrations cannot fail against schema the fixture never created.

**Architecture:** The production migration chain remains unchanged. The test fixture will mark every migration except `042_drop_search_index` and `043_drop_file_metadata` as already applied, leaving `runMigrations()` to execute exactly the two migrations under test against the explicit legacy tables.

**Tech Stack:** TypeScript, Vitest, SQLite, better-sqlite3 test driver

## Global Constraints

- Preserve all unrelated staged and unstaged work in the dirty worktree.
- Do not commit or push.
- Keep this plan untracked and active until all agent-runnable verification passes.

---

### Task 1: Isolate the storage-retirement migration fixture

**Files:**

- Modify: `src/main/persistence/rlm/__tests__/storage-retirement-migrations.spec.ts`
- Verify: `src/main/persistence/rlm/__tests__/storage-retirement-migrations.spec.ts`

**Interfaces:**

- Consumes: the exported `MIGRATIONS`, `computeMigrationChecksum()`, and `runMigrations()` APIs from `rlm-schema.ts`.
- Produces: a fixture whose `_migrations` rows leave only migrations 042 and 043 pending.

- [x] **Step 1: Reproduce the existing failure**

  Run `npm run test:quiet -- src/main/persistence/rlm/__tests__/storage-retirement-migrations.spec.ts` and confirm migration 049 fails because `automations` is absent.

- [x] **Step 2: Narrow the applied-migration fixture**

  Replace the lexical “before retirement” filter with an explicit exclusion set containing `042_drop_search_index` and `043_drop_file_metadata`. Rename the helper to describe that it marks non-retirement migrations as applied.

- [x] **Step 3: Verify the targeted test**

  Re-run `npm run test:quiet -- src/main/persistence/rlm/__tests__/storage-retirement-migrations.spec.ts` and require both storage-retirement tests to pass.

- [x] **Step 4: Run project verification gates**

  Run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, and `npm run test:quiet`. Record actual outcomes below.

## As-Built Notes

- Root cause: the fixture marked migrations 001–041 as applied without creating migration 015's `automations` table, then allowed unrelated later migrations to run. Migration 049 consequently failed while altering a prerequisite the fixture only claimed existed.
- Changed the fixture to mark every migration except `042_drop_search_index` and `043_drop_file_metadata` as applied. Production migrations were not changed.
- RED: targeted spec reproduced `Failed to apply migration "049_automation_trigger_configuration"` / `no such table: automations`.
- GREEN: targeted storage-retirement spec passed: 1 file, 2 tests.
- Adjacent migration coverage passed: 2 files, 5 tests.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed after the separately authorized LOC remediation split the analyzer and reset stale allowlist ceilings.
- `npm run test:quiet`: passed: 1,359 files, 13,369 tests.
- Final canonical rerun passed all five gates; this plan is complete.
