# Codex State Isolation Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with test-first red/green cycles. Do not commit or push without James's explicit authorization.

**Goal:** Keep all AIO-created Codex thread metadata out of the user's Codex app and safely remove metadata that AIO already leaked.

**Architecture:** Prepared AIO `CODEX_HOME` directories exclude the user's Codex thread-state SQLite files and point at AIO-owned persistent equivalents under `~/.ai-orchestrator/codex`. Home preparation is fail-closed. A separate schema-aware startup cleanup backs up the user's Codex state database, discovers only complete AIO temp-home rollout paths, fingerprints and migrates the exact connected state graph, then deletes only the snapshotted IDs when that graph is unchanged under an immediate transaction.

**Tech Stack:** TypeScript, Node filesystem APIs, better-sqlite3 through the repository `SqliteDriver` abstraction, Vitest.

## Global Constraints

- Preserve legitimate Codex sessions and unrelated working-tree changes.
- Never expose or copy credentials into tests or artifacts.
- Cleanup must be idempotent and fail closed: no successful backup and verified private-state migration means no mutation.
- AIO session rollouts and thread metadata must remain persistent for resume.
- Do not commit or push without explicit authorization.

---

### Task 1: Isolate Codex thread-state files

**Files:**
- Modify: `src/main/cli/adapters/codex/codex-home-manager.ts`
- Test: `src/main/cli/adapters/codex/codex-home-manager.spec.ts`

**Interfaces:**
- Produce: private persistent links for `state_5.sqlite` and its WAL/SHM sidecars.
- Preserve: `prepareMcpFreeHome()`, `prepareSessionIsolatedHome()`, and `prepareHomeWithMcpConfig()` public behavior.

- [x] Add a failing test that creates user `state_5.sqlite`, prepares each home variant, and asserts the prepared `state_5.sqlite` resolves under `~/.ai-orchestrator/codex` rather than `~/.codex`.
- [x] Run `npm run test:quiet -- src/main/cli/adapters/codex/codex-home-manager.spec.ts` and confirm the new assertion fails because the generated home still links to the user's database.
- [x] Exclude `state_5.sqlite`, `state_5.sqlite-wal`, and `state_5.sqlite-shm` from generic home mirroring; create AIO-owned link targets in the persistent state directory.
- [x] Ensure temporary-home cleanup removes only links and leaves the AIO-owned state database intact.
- [x] Re-run the targeted spec and confirm it passes.
- [x] Create isolated homes without a pre-existing `~/.codex` and abort adapter spawn when preparation fails.

### Task 2: Add safe leaked-thread cleanup

**Files:**
- Create: `src/main/cli/adapters/codex/codex-state-cleanup.ts`
- Create: `src/main/cli/adapters/codex/codex-state-cleanup.spec.ts`

**Interfaces:**
- Produce: `cleanupLeakedAioCodexThreads(options?: CodexStateCleanupOptions): CodexStateCleanupResult`
- Consume: `SqliteDriverFactory` and `defaultDriverFactory`.

- [x] Write a failing database-fixture test with legitimate threads, leaked rows for all three AIO prefixes, spawn edges, dynamic tools, and an assigned job item.
- [x] Assert cleanup creates a backup, migrates leaked threads, removes only leaked threads and related edges/tools, clears leaked job assignments, preserves legitimate rows, and reports accurate counts.
- [x] Add failing tests for idempotence, missing/incompatible databases, and backup or migration failure preventing mutation.
- [x] Run `npm run test:quiet -- src/main/cli/adapters/codex/codex-state-cleanup.spec.ts` and confirm failures are caused by the missing cleanup implementation.
- [x] Implement strict prefix predicates, schema checks, consistent `VACUUM INTO` backup, private-database migration with rollout-path rewriting, and one transaction for dependent-row cleanup plus thread deletion.
- [x] Catch operational failures, log them, close the database, and return a skipped/failed result without throwing through startup.
- [x] Re-run the targeted cleanup spec and confirm it passes.
- [x] Add regressions for newly added, same-count replacement, same-ID update, and related-job concurrent changes; fingerprint the full connected state and abort deletion on any difference.
- [x] Replace substring ownership with complete temp-root/home/sessions path validation and preserve custom AIO-like paths elsewhere.
- [x] Cover first and repeat private migrations, upsert connected job metadata, prune user-only jobs, and clear assignments outside the migrated thread set.

### Task 3: Wire startup cleanup

**Files:**
- Modify: `src/main/app/initialization-steps.ts`
- Test: `src/main/cli/adapters/codex/codex-state-cleanup.spec.ts`

**Interfaces:**
- Consume: `cleanupLeakedAioCodexThreads()`.

- [x] Add the cleanup call immediately before the stale Codex temporary-home sweep so leaked metadata is removed before stale rollout paths disappear.
- [x] Add a focused source-level wiring assertion if importing `initialization-steps.ts` would require mocking the entire Electron startup graph.
- [x] Run both Codex state specs and confirm they pass.

### Task 4: Clean this machine's existing leaked rows

**Files:**
- Runtime data only: `~/.codex/state_5.sqlite`
- Backup: `~/.ai-orchestrator/codex/backups/`

- [x] Record pre-cleanup counts without printing thread content.
- [x] Invoke the verified cleanup implementation against the real database.
- [x] Confirm the backup exists and opens successfully.
- [x] Confirm the private database contains the migrated AIO threads with persistent rollout paths.
- [x] Confirm AIO-prefix thread and spawn-edge counts are zero in the user database and legitimate thread counts are unchanged.

### Task 5: Verify and finalize documentation

**Files:**
- Rename: `docs/superpowers/specs/2026-07-11-codex-state-isolation-design.md` to `_completed.md`
- Rename: `docs/superpowers/plans/2026-07-11-codex-state-isolation-plan.md` to `_completed.md`

- [x] Run targeted Codex specs.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint` (final repository-wide run passed).
- [x] Run `npm run check:ts-max-loc` (final repository-wide run passed; one allowlisted file remains within its permitted tolerance).
- [x] Run `npm run test:quiet`.
- [x] Review `git diff` to confirm scoped files contain no secrets and unrelated edits were preserved.
- [x] Rename the completed design and plan documents, then report every requested item and verification result.

## Verification Record

- Targeted Codex/home/adapter tests: 61 passed.
- Production and spec TypeScript checks: passed.
- Scoped ESLint: passed.
- Final full suite: 1,276 files and 12,677 tests passed in 301.8 seconds (an earlier unrelated Git-index metadata flake passed on focused rerun and on this complete rerun).
- User Codex database: integrity `ok`; verified cleanup removed the newly leaked review-session batches, but the already-running pre-fix app process immediately recreated active rows. Restart is required to load the fail-closed home isolation, after which startup cleanup removes the final transient rows.
- Private AIO Codex database: integrity `ok`, 56 migrated threads, zero disposable rollout paths.
- Full lint and LOC gates passed after the concurrent review subsystem work settled; the documents now carry the `_completed` suffix.
