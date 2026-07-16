# RLM Storage Maintenance Live-Test Plan

Prerequisites: rebuild and restart the Harness dev app from this working tree with `npm run dev`. Use a disposable copy of the Harness dev user-data directory or a seeded dev database, never the production RLM database. This validates the UI/runtime behavior that cannot be proven in the headless Vitest environment.

Source plan: [2026-07-11-rlm-storage-maintenance-plan_completed.md](./2026-07-11-rlm-storage-maintenance-plan_completed.md)

## 1. Warning and preview

1. Seed the dev RLM database to report at least 10 GiB but less than 12 GiB, including:
   - one store last accessed more than 60 days ago;
   - one current live-session store;
   - one stale store with `config_json.kind = "codebase-auto"`;
   - at least one externally stored section file.
2. Open a running loop.
3. Confirm the loop HUD shows **RLM storage needs maintenance** with the measured size.
4. Select **Review cleanup**.
5. Confirm focus moves into the modal and Escape closes it while idle.
6. Reopen it and confirm the eligible, live-protected, codebase-protected, database, external-content, reclaimable-page, cutoff, and backup-directory values match the seeded database.

Expected: the warning appears at exactly 10 GiB; preview values match the execution database; retention cannot be edited; live and codebase-auto stores are protected.

Why deferred: requires a rebuilt Electron renderer and controlled user-data/database seeding.

## 2. Maintenance execution and loop coordination

1. Start maintenance from the preview.
2. While backup/prune/compaction/reload is active, confirm:
   - the modal cannot be dismissed;
   - stage progress advances through preparation, backup, prune, compaction, and reload;
   - the loop does not start another child iteration.
3. After completion, inspect the backup directory.
4. Open the backup database and run `PRAGMA integrity_check;`.
5. Confirm each `context_sections.content_file` reference in the backup has a matching file in the sibling `_content` backup directory.
6. Confirm the stale eligible store was deleted, its dependent rows cascaded, and only its external content file was removed.
7. Confirm the live and codebase-auto stores and files remain.
8. Confirm the result shows the verified backup location, stores removed, measured bytes reclaimed, cleanup warnings (if any), and loop resume outcome.

Expected: no deletion begins before the verified database/content backup exists; the worker reloads after compaction; the loop resumes only if the final database measurement is below 12 GiB.

Why deferred: requires observing the rebuilt app, worker process, filesystem backup, and loop runtime together.

## 3. Critical and failure paths

1. Seed a final post-maintenance measurement at or above 12 GiB and repeat maintenance from a paused loop.
2. Confirm the result states the database remains at/above 12 GiB and the loop remains paused.
3. In a disposable run, make the backup directory unwritable and start maintenance.
4. Confirm the UI reports a **Backing up** failure, no candidate store is deleted, and Retry returns to a fresh preview.
5. Restore permissions and verify Retry can complete successfully.

Expected: the 12 GiB resource-governor threshold is never bypassed; backup failure is non-destructive; retry recomputes candidates.

Why deferred: requires controlled filesystem fault injection and a rebuilt running app.

## Evidence run — 2026-07-12

**Status: PARTIAL (substantial real-runtime evidence; seeded UI/coordination cases pending).**

A real maintenance operation already performed by the running packaged app was verified from
the app log and filesystem without initiating another production cleanup:

- stages advanced through preparing, backing up, pruning, compacting, reloading, and complete;
- duration was 437,307 ms;
- 1,177 stores were deleted;
- measured database/external-content bytes reclaimed were 2,638,879,538;
- external-content cleanup failures were zero;
- the latest 13,660,766,208-byte backup passed a fresh read-only `PRAGMA quick_check`;
- all 29,888 externally stored section references had matching canonical files in the sibling
  `_content` directory, with zero missing files and zero unsafe ids.

The transition from backing up to pruning is also runtime evidence that the app's full
`PRAGMA integrity_check` and external-content verification completed before deletion.

Three earlier real operations failed during `backing-up`; every failure recorded
`storesDeleted: 0` and `verifiedBackupExists: false`. This passes the non-destructive backup
failure invariant, although the exact unwritable-directory fault and Retry UI were not driven by
this verifier.

The warning/preview values, modal focus and dismissal behavior, live/codebase protection with a
controlled seed, loop start suppression/resume behavior, at-or-above-12-GiB result, and Retry UI
remain pending. Because this evidence came from the production database rather than the required
disposable seeded database, this document is not renamed complete.

## Evidence run — 2026-07-12 (disposable production clone)

Two additional packaged-app runs used a disposable APFS copy of the real 11.32 GB pre-cleanup
database. The warning appeared at warning level, **Review cleanup** opened the real modal, and
maintenance entered a visible live stage with a spinner. Both runs completed with verified
backups and compacted to approximately 1.75 GB; the production profile was atomically restored
after each run.

These runs strengthen the real UI/runtime evidence but do not supply the plan's controlled stale,
live, and codebase-auto seed, the at-or-above-12-GiB terminal result, or the unwritable-backup
Retry flow. The document therefore remains partial.

## Evidence review — 2026-07-13

**Status remains PARTIAL.** The isolated `harness-dev` profile is healthy but does not satisfy the
controlled-seed prerequisites: its RLM database measured 9,883,440 bytes with 471,024 bytes of
external content, reported zero maintenance-eligible stores, and returned `canRun: false`. It cannot
exercise the 10 GiB warning boundary, protected-store accounting, 12 GiB governor path, or backup
fault/Retry path. The production profile was left untouched. The real packaged-app and disposable
clone evidence above remains valid, but the controlled seeded cases must still be run before this
document can be renamed complete.

## Evidence run — 2026-07-16 (controlled seed, isolated disposable profile)

**Status: COMPLETE — every numbered check in Sections 1–3 was driven end-to-end against a controlled
seeded database in a rebuilt dev app and passed with recorded evidence. The production RLM database
was never touched.**

### Method / environment

- **Isolated disposable profile.** The dev app hard-codes its user-data dir to
  `<appData>/harness-dev` (`src/main/index.ts` → `resolveHarnessUserDataPath`), and a *second* dev
  instance was already running against the shared `harness-dev` profile (holding its single-instance
  lock). To avoid disturbing that instance or the shared profile, the app was launched through a
  small `_scratch/rlm-livetest/main-shim.js` entry that calls `app.setPath('appData', <tmp>)` **before**
  `dist/main/index.js` derives `userData`, yielding a fully isolated profile at
  `/Users/suas/rlm-livetest-appdata/harness-dev` with its own single-instance lock. No tracked source
  was modified; the shim and all seed/driver scripts live under `_scratch/rlm-livetest/` (gitignored).
- **Rebuilt app.** `npm run build:main` (+ desktop-helper) from the current working tree, renderer via
  `ng serve` on `:4567`, then `electron _scratch/rlm-livetest/main-shim.js --remote-debugging-port=9333`.
  The renderer was driven over CDP (real DOM clicks, focus checks, dispatched `keydown` Escape, and
  `window.electronAPI.*` IPC calls) — i.e. the real rebuilt Electron renderer + main-process
  maintenance service, not a stub.
- **Seed.** Built offline with the app stopped (`sqlite3` CLI, schema created by the app itself):
  three 90-day-idle stores — `seed-eligible-store` (`kind:"session"`), `seed-codebase-store`
  (`kind:"codebase-auto"`), `seed-live-store` (`kind:"session"`, `instance_id=seed-live-session`) —
  each eligible/codebase store with a ~2.25 MiB external `content_file` section at the canonical
  `<content>/<2-char>/<id>.txt` path, plus a dedicated `zz_filler` blob table inflated with
  `randomblob` to place `page_size*page_count` in the warning band, with ~200 MiB of freelist for a
  non-zero reclaimable figure. The **live-session store** was protected by creating a real orchestrated
  instance with `sessionId=seed-live-session`, so `getProtectedRlmSessionIds()` returned it live.
- **Verified production profile untouched:** `~/Library/Application Support/harness-dev/rlm/rlm.db`
  measured ~5.8 MB before and after (only the co-resident real instance's own activity), confirming the
  test never wrote to the shared/production RLM database.

### Section 1 — Warning and preview — PASS

1. Seed measured **11.02 GiB** database (`databaseSizeBytes=11,829,224,000`), external content
   **4.50 MiB**, reclaimable **200 MiB**; one 90d-idle store, one live-session store, one
   `codebase-auto` store, external section files present.
2. Opened the live session's detail view — `app-loop-control` (the loop HUD) mounted with a live
   instance.
3. HUD banner rendered: **“RLM storage needs maintenance — 11.0 GiB is in use…”** with the measured
   size.
4. Clicked **Review cleanup** — the app-shell modal (`showModal=true` mount) opened.
5. `document.activeElement` was the dialog (`role=dialog`, focus moved into the modal); a dispatched
   **Escape** keydown while idle closed it (`modalAfterEscape=false`).
6. Reopened; modal metrics matched the seed exactly: **Database size 11.0 GiB · External content
   4.50 MiB · Eligible stores 1 · Live protected 1 · Codebase protected 1 · Reclaimable pages
   200.2 MiB**; cutoff text “…not used since 17/05/2026” (= generatedAt − 60 days); Backup destination
   = `…/harness-dev/rlm/backups`; **no retention input/select/contenteditable** (retention not
   editable). Live + codebase-auto stores shown protected.
   - *Note on “appears at exactly 10 GiB”:* the API returned `warningThresholdBytes=10,737,418,240`
     (exactly 10 GiB) and `hardLimitBytes=12,884,901,888` (12 GiB), and all three bands were observed
     live — `healthy` at <10 GiB (fresh 1.7 MB / 6 MB DBs), `warning` at 11.0 GiB, `critical` at
     14.35 GiB. The exact 10.000 GiB transition point is the hard-coded constant (unit-tested); it was
     not seeded to the byte.

### Section 2 — Maintenance execution and loop coordination — PASS

1. Started maintenance from the modal (**Back up, prune & compact**).
2. During the run: the modal was **non-dismissible** (dispatched Escape ignored, no header ×, no
   footer Close, primary showed “Maintenance running…”); stage progress advanced through the full
   sequence **preparing → backing-up → pruning → compacting → reloading → complete** (observed
   `backing-up` and `compacting` live in the DOM; complete sequence in the app log for
   op `3058ca20…`); and the **loop did not start another child iteration** — a *genuinely running*
   loop (`status:running`, iteration 3) stayed **frozen at iteration 3 for the entire ~57 s
   maintenance window** (a running loop otherwise completes ~3–4 iterations in that time) and advanced
   to iteration 4 only after the gate released.
3. Backup written to `…/rlm/backups/rlm-maintenance-20260716T193112682Z-3058ca20….db` (full 11.83 GB
   snapshot) with a sibling `_content` directory.
4. `PRAGMA integrity_check` on the backup returned **ok**.
5. Every `context_sections.content_file` reference in the backup had a matching file under the sibling
   `_content` directory (`el/eligextsection01.txt`, `cb/cbautoextsection01.txt`).
6. The stale eligible store was **deleted**, its sections **cascaded** (both the external and inline
   section gone), and **only its external content file** was removed (`el/` gone, `cb/` retained).
7. The **live** (`seed-live-store`) and **codebase-auto** (`seed-codebase-store`) stores and the
   codebase external file remained.
8. Result reported: `storesDeleted:1`, verified `backupPath`, `verifiedBytesReclaimed:214,854,104`
   (~205 MiB), external content 4.72 MB → 2.36 MB, `externalContentCleanupFailures:0`,
   `databaseHealthy:true`, and the loop-resume outcome. **No deletion before the verified backup**
   (backing-up precedes pruning in the stage log) and the **worker reloaded after compaction**
   (reloading stage). The **resume-only-if-<12 GiB** rule was proven both ways (see Section 3).

### Section 3 — Critical and failure paths — PASS

1–2. **≥12 GiB governor path (real paused loop).** The DB was grown to **14.35 GiB** (`level:critical`).
   A real coordinator loop was started and the resource governor **paused it before spawning any
   iteration** (`status:paused`, `totalIterations:0`, no child instance). Maintenance was then run
   **from that paused loop**: it compacted to **12.58 GiB** (still ≥12 GiB), returning
   `databaseHealthy:false`, `loopResumed:false`, and the loop **remained paused** (`status:paused`,
   `totalIterations:0`). Conversely, after reclaimable filler was freed so a subsequent vacuum dropped
   the DB to **10.53 GiB (<12 GiB)**, running maintenance from the still-paused loop returned
   `databaseHealthy:true`, `loopResumed:true`, and the loop **resumed** — with no child iteration
   spawned (immediately cancelled). Together these confirm the **12 GiB governor threshold is never
   bypassed** on resume.
3. In a disposable run the backup directory was made unwritable (`chmod 0500`) and maintenance started.
4. The UI reported a **“Cleanup failed during Backing up — unable to open database file”** failure with
   a **Review retry** button; the result was `status:failed`, `failedStage:"backing-up"`,
   `storesDeleted:0` — **no candidate store was deleted** (the eligible store and its section/file
   remained); clicking **Review retry** returned a **fresh, recomputed preview**.
5. Permissions were restored (`chmod 0700`) and **Retry completed successfully**: `status:success`,
   `storesDeleted:1`, a new verified backup, `databaseHealthy:true`. Backup retention held at 2
   (`RLM_BACKUP_RETENTION_COUNT`), each with a `_content` sibling.

### Honest caveats

- The exact 10.000 GiB / 12.000 GiB transition points were not seeded to the byte; the three health
  bands and the exact threshold constants were confirmed live and in code (see Section 1 note).
- The governor-paused loop showed `status:paused, totalIterations:0` at ≥12 GiB with no agent spawned
  (consistent with the pre-iteration resource-governor pause); an explicit textual pause-reason was not
  extracted from the loop state, but the `resumeLoop`/stays-paused behaviour under test was driven
  directly and both branches (<12 GiB resume, ≥12 GiB stay) passed.
- The loop HUD warning banner reflects the renderer’s cached health snapshot (refreshed on loop-state
  change), so after growing the DB out-of-band the banner briefly showed a stale size; the modal,
  preview, and run all used fresh server-side measurements.

All Section 1–3 checks passed with the evidence above; this document is renamed
`…_livetest_completed.md`.
