# Codex Private-DB Rollout-Path Reconcile Plan

> **For agentic workers:** Implement this plan task-by-task with test-first red/green cycles. Do not commit or push without James's explicit authorization. Follow `AGENTS.md` and `docs/angular-conventions.md`.

**Goal:** Rewrite AIO private Codex thread rows whose `rollout_path` points at a now-deleted disposable temp `CODEX_HOME` to their real, persistent location under `~/.ai-orchestrator/codex/sessions`, so native (fast-path) resume can find the rollout instead of falling back to a full transcript replay.

**Follows:** `docs/superpowers/plans/2026-07-11-codex-state-isolation-plan_completed.md` (the isolation + user-DB cleanup that this extends).

---

## Background / Evidence (verified 2026-07-11)

- Each temp `CODEX_HOME` symlinks its `state_5.sqlite` to the shared private DB (`linkThreadStateStore`, `codex-home-manager.ts:242`). So **live AIO codex sessions write thread rows directly into the private DB** (`~/.ai-orchestrator/codex/state_5.sqlite`) with `rollout_path` set to the disposable temp-home path — on macOS the canonical form `/private/var/folders/.../T/codex-browser-mcp-XXXXXX/sessions/YYYY/MM/DD/rollout-<uuid>.jsonl`.
- The temp dirs are deleted (best-effort `cleanup()` / `sweepStaleCodexTempHomes`), but the rollout **files physically persist** in `~/.ai-orchestrator/codex/sessions/...` because codex wrote them through the `sessions` symlink (`linkSessionStore`, `codex-home-manager.ts:206`).
- Snapshot of this machine's private DB: **129 threads = 74 already-persistent + 55 stale temp-home (`codex-browser-mcp-`) rows**; the persistent rollout file exists for **all 55/55**; every referenced temp dir is gone.
- `cleanupLeakedAioCodexThreads` rewrites `rollout_path` **only for threads it migrates from the user DB** (`rewritePrivateRolloutPaths`, `codex-state-cleanup.ts:390`, `WHERE id IN (threadIds)`). Rows written directly to the private DB are **never reconciled**. This is by design of the cleanup, not a bug in it — see the memory note "Cleanup never touches private DB temp-home rows".
- **Why this matters for resume (verified in `codex-cli-adapter.ts`):** when a session is resumed by its *specific* persisted id (Step 1, lines 762–818), a failed app-server `thread/resume` is treated as recoverable and drops **straight to Step 4 fresh-start / full replay**. The JSONL-scan fallback (Step 3, line 869) is explicitly gated `!hasSpecificResumeTarget` (comment lines 820–822), so it does **not** rescue a specific-id resume. If the app-server resolves the rollout via the stored `rollout_path`, a stale temp path forces the expensive full replay.

## Open Question (must be resolved by live test, not code inspection)

Whether the external `@openai/codex` app-server actually opens the rollout **via `state_5.sqlite.rollout_path`** (so a stale temp path makes `thread/resume` fail) or independently **scans its `CODEX_HOME/sessions`** (which is symlinked to the persistent store, so it would succeed regardless) is **unverified**. This determines whether the stale rows currently break native resume or are merely latent risk + DB hygiene. Resolve via the live test in Task 6 before claiming a resume behavior change. The reconcile is safe and worthwhile either way (removes latent risk, makes the DB self-consistent), but do **not** claim "fixes broken resume" until the live test confirms it.

## Global Constraints

- **Only ever touch the private DB** (`~/.ai-orchestrator/codex/state_5.sqlite`). Never the user DB (`~/.codex/state_5.sqlite`).
- **Never point a row at a file that does not exist.** Only rewrite a row when the computed persistent destination file is present on disk. If the persistent file is genuinely missing, leave the stale path untouched (resume will fresh-start either way; a rewrite would only hide the loss).
- **Backup-first, fail-closed, idempotent, never throw through startup.** Mirror `cleanupLeakedAioCodexThreads`'s operational-error handling: `VACUUM INTO` backup before mutation, `BEGIN IMMEDIATE` transaction, on `SQLITE_BUSY`/any error log + close + return a skipped/failed result.
- Reuse the battle-tested ownership matcher (`isOwnedAioRolloutPath` / `resolveCodexTempRoots`) and the existing `/sessions/`-suffix rewrite transform — do not hand-roll a second, divergent path predicate.
- Preserve unrelated working-tree changes. Do not commit or push without authorization.

---

### Task 1: Export + extract shared helpers (no behavior change)

**Files:**
- Modify: `src/main/cli/adapters/codex/codex-state-leak-snapshot.ts`
- Modify: `src/main/cli/adapters/codex/codex-state-cleanup.ts`
- Test: `src/main/cli/adapters/codex/codex-state-cleanup.spec.ts` (or a new helper spec)

**Interfaces:**
- Export `isOwnedAioRolloutPath(rolloutPath: string, tempRoots: readonly string[]): boolean` from `codex-state-leak-snapshot.ts` (currently module-private).
- Extract the `/sessions/`-suffix → `sessionsDir` rewrite as a reusable, pure function used by both `rewritePrivateRolloutPaths` and the new reconcile — e.g. `persistentRolloutPathFor(rolloutPath: string, sessionsDir: string): string | null` (returns `null` when there is no `/sessions/` segment). Keep the existing SQL rewrite behavior byte-identical, or route it through the shared JS helper.

- [x] Add tests pinning `isOwnedAioRolloutPath` (temp-home match incl. `/private/...` realpath root; non-match for legit `~/.codex/sessions` and custom AIO-like paths) and `persistentRolloutPathFor` (rewrite, backslash/normalization, no-`/sessions/` → null).
- [x] Export/extract; confirm `rewritePrivateRolloutPaths` still produces identical output (existing cleanup spec stays green).
- [x] `npm run test:quiet -- src/main/cli/adapters/codex/codex-state-cleanup.spec.ts`.

### Task 2: Implement `reconcilePrivateCodexRolloutPaths`

**Files:**
- Create: `src/main/cli/adapters/codex/codex-private-rollout-reconcile.ts`
- Create: `src/main/cli/adapters/codex/codex-private-rollout-reconcile.spec.ts`

**Interfaces:**
- Produce: `reconcilePrivateCodexRolloutPaths(options?: ReconcileOptions): ReconcileResult`
  - `options`: `{ privateStatePath?, sessionsDir?, backupDir?, driverFactory?, tempRoots?, fileExists?, now? }` (inject `fileExists` and `driverFactory` for tests; default `existsSync` and `defaultDriverFactory`).
  - `ReconcileResult`: `{ status: 'skipped', reason: 'missing-database' | 'incompatible-schema' | 'no-stale-rows' } | { status: 'failed', reason, error } | { status: 'reconciled', backupPath, candidates, rewritten, skippedMissingFile }`.
- Consume: `resolveCodexTempRoots`, `isOwnedAioRolloutPath`, `persistentRolloutPathFor`, `getAioCodexStateDir`, `getAioCodexSessionsDir`, `defaultDriverFactory`, `getLogger`.

Algorithm:
1. Resolve `privateStatePath`/`sessionsDir`; if the DB is missing → `skipped:missing-database`; if it lacks the `threads(id, rollout_path)` schema → `skipped:incompatible-schema`.
2. Select `id, rollout_path` from `threads`; keep rows where `isOwnedAioRolloutPath(rollout_path, tempRoots)` is true → the candidate set.
3. For each candidate compute `dest = persistentRolloutPathFor(rollout_path, sessionsDir)`. Keep only those where `dest !== null` **and** `fileExists(dest)`.
4. If no rewritable rows → `skipped:no-stale-rows`.
5. `VACUUM INTO` backup of the private DB (`createConsistentBackup`) into `backupDir` (default `<stateDir>/backups`, reuse `uniqueBackupPath`).
6. In one `BEGIN IMMEDIATE` transaction, `UPDATE threads SET rollout_path = ? WHERE id = ?` per row (parameterized; no string interpolation of paths). Return `{ reconciled, candidates, rewritten, skippedMissingFile }`.
7. **Idempotence:** after rewrite the rows are under `sessionsDir` and no longer satisfy `isOwnedAioRolloutPath`, so a second run yields `skipped:no-stale-rows`.
8. Wrap everything: on any driver/backup/transaction error → log (message only, no paths-with-content), roll back, `db.close()`, return `failed`. Never throw.

- [x] Failing fixture tests first: (a) temp-home row with existing persistent file → rewritten to `sessionsDir/...`, file-existence honored; (b) temp-home row whose persistent file is **absent** → left unchanged, counted in `skippedMissingFile`; (c) already-persistent row → untouched; (d) legit `~/.codex/sessions` / custom AIO-like row → untouched; (e) idempotent second run → `no-stale-rows`; (f) missing DB / incompatible schema → `skipped`; (g) backup written before mutation, and a forced transaction error leaves the DB unchanged (fail-closed); (h) accurate counts.
- [x] Implement; re-run the spec to green.

### Task 3: Wire into startup

**Files:**
- Modify: `src/main/app/initialization-steps.ts`
- Test: source-level wiring assertion in the reconcile spec (importing `initialization-steps.ts` pulls the whole Electron graph, so assert on source text like the isolation plan's Task 3 did).

- [x] Add a step immediately after the existing `'Leaked AIO Codex thread cleanup'` step (`initialization-steps.ts:417`), e.g. `{ name: 'Private Codex rollout-path reconcile', fn: () => { reconcilePrivateCodexRolloutPaths(); } }`. Ordering vs. `sweepStaleCodexTempHomes` (418) is **not** load-bearing (the persistent files are independent of the temp dirs), but placing it right after the user-DB cleanup keeps all Codex-state maintenance contiguous.
- [x] Import the new function; confirm no unused imports; source-level wiring test green.

### Task 4: Repository verification gates

- [x] `npm run test:quiet -- src/main/cli/adapters/codex/` (targeted).
- [x] `npx tsc --noEmit`
- [x] `npx tsc --noEmit -p tsconfig.spec.json`
- [x] `npm run lint`
- [x] `npm run check:ts-max-loc` (new file must be < 700 lines; `codex-state-cleanup.ts` is already 494 — do **not** grow it past the gate, which is why the reconcile lives in its own file).
- [x] `npm run test:quiet` (final full-suite gate).
- [x] `git diff` review: scoped files only, no secrets, unrelated edits preserved.

### Task 5: One-time repair of this machine's private DB

Run the **compiled** `reconcilePrivateCodexRolloutPaths` through the project Electron runtime (better-sqlite3 is built for Electron's ABI — do not use plain Node), exactly like the user-DB cleanup was run: build `dist`, write a disposable CommonJS runner under `_scratch/`, invoke via `node_modules/.bin/electron`, then delete the runner.

- [x] Confirm AIO is fully quit (no app / dev server / repo-local electron; a standalone `@openai/codex` CLI holding the DB is fine but note it).
- [x] Record count-only pre-state: private-DB `integrity_check`, total threads, temp-home rows, persistent rows.
- [x] Run the reconcile; record only `status`, `backupPath`, `candidates`, `rewritten`, `skippedMissingFile`.
- [x] Verify: new backup exists and `integrity_check = ok`; private DB `integrity_check = ok`; temp-home rows dropped by `rewritten`; every rewritten row now resolves to an existing persistent file; no `agent_job_items` dangling. Do not expose titles/prompts/session content — counts, integrity, and path structure only.
- [x] Delete the disposable runner.

### Task 6: Live test — does the reconcile actually restore native resume? (deferred)

The load-bearing behavioral proof (and resolution of the Open Question above) requires a rebuilt + restarted app and a live Codex provider session, so it is deferred. Steps, prerequisites, and expected observations are recorded in `2026-07-11-codex-private-rollout-path-reconcile-plan_livetest.md`.

---

## Notes / Rationale

- **Why reconcile after the fact rather than write persistent paths up front:** `rollout_path` is written by the `@openai/codex` app-server, not by AIO — AIO cannot control the value at write time. The temp path is a faithful record of the `CODEX_HOME` codex saw. Reconciling to the persistent location (where the file provably lives via the `sessions` symlink) is the only AIO-side lever.
- **Why file-existence-gated:** a stale row whose persistent file is missing means the rollout is genuinely lost; rewriting it would point at nothing and mask the loss. Leave it — resume fresh-starts either way.
- **Scope discipline:** this does not widen the user-DB cleanup, does not manually mutate rows, and does not alter isolation. It is an additive, idempotent, fail-closed maintenance pass on AIO's own private DB.

## Verification Record (2026-07-11)

- **Task 1:** `isOwnedAioRolloutPath` exported, `persistentRolloutPathFor` added; new `codex-state-leak-snapshot.spec.ts` (8 tests) green; existing cleanup spec unchanged/green.
- **Task 2:** `codex-private-rollout-reconcile.ts` + spec (9 tests incl. wiring) green — rewrite, file-existence gate, idempotence, missing/incompatible DB, backup-failed and rewrite-rollback fail-closed, `/private` realpath match.
- **Task 3:** wired as the `Private Codex rollout-path reconcile` init step immediately after `cleanupLeakedAioCodexThreads` (`initialization-steps.ts:418`); source-level wiring test green.
- **Task 4 gates:** `tsc --noEmit` = 0; `tsc -p tsconfig.spec.json` = 0; `npm run lint` = pass; `npm run check:ts-max-loc` = pass (new file 192 LOC; `initialization-steps.ts` +1 line, within tolerance); `npm run test:quiet` full suite = **12,800 tests passed** (261s). `git diff` scoped to the two tracked files, no secrets; unrelated untracked files preserved.
- **Task 5 (one-time repair, compiled reconcile via Electron):** pre-state private DB integrity `ok`, 129 threads (55 temp-home + 74 persistent). Result: `reconciled`, candidates 55, **rewritten 55**, skippedMissingFile 0, backup `state_5-before-rollout-reconcile-20260711T182106831Z.sqlite` (integrity `ok`, preserves the 55-row pre-image). Post-state: integrity `ok`, temp-home rows **0**, persistent rows 129, no dangling `agent_job_items`; idempotent re-run → `skipped:no-stale-rows`. Note: 2 of the pre-existing 74 persistent rows point at files already missing before this repair (out of scope — the reconcile only touches temp-home rows with an existing target).
- **Task 6:** deferred to `2026-07-11-codex-private-rollout-path-reconcile-plan_livetest.md` (needs rebuilt/restarted app + live Codex session). Not verified.

## Completion

Tasks 1–5 complete and verified in-loop; Task 6 is a deferred live check recorded in the livetest doc (not claimed as verified). Not committed. The Open Question (whether the app-server depends on `rollout_path`) remains unresolved until the live test runs.
