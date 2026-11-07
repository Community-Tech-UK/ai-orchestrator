# Worktree clean-up gaps — plan

**Status:** completed 2026-11-02 after four fresh-eyes rounds (the fourth returned PASS). Two checks that need
the rebuilt, restarted app are deferred to the livetest doc linked at the end. Asked for by James on 2026-11-02 ("fix the clean-up gaps so folders like these
stop building up"), after 13 stale worktree folders (about 8 GB) were removed by hand that day with their
branches kept.

**Rule for every item:** only ever remove the *folder*. Keep the branch. Remove a folder only when it holds
nothing that is not already on its branch (clean tree, or harvested to the branch first). Never touch a folder
that something can still resume from.

Related: the shared worktree limit change of the same day (`maxConcurrentWorktrees`, Plan Queue checkouts
exempt) is done separately and is not part of this plan.

## Findings that drive the design

- Plan Queue: a parked or landed item whose folder removal failed keeps it forever. `parkUnlocked`
  (`plan-queue-item-flow.ts`) and `finishCleanup` (`plan-queue-item-landing.ts`) note "Worktree kept" and
  never retry; boot recovery skips parked rows; the reconciler only reports.
- Plan Queue re-runs: a new run of the same plan never looks at an older parked attempt in an ended run. No
  separate fix: item 1 removes the old folder once it is clean; a folder with unfinished work (for example a
  merge in progress) correctly stays until James resumes or discards it.
- Loops stopped for review: the boot rescue-commit guard (`loop-worktree-lifecycle-reconcile.ts`, "Session
  branch changed outside AIO") and the other `blocked` exits return before folder removal, so a blocked run's
  folder is kept on every start. Nothing reads the folder later; review and landing use the branch.
  "Mark resolved" (`loop-worktree-resolve.ts`) only flips the phase and deletes nothing.
- Loops parked on a usage limit: `provider-limit` with `ended_at` NULL has no expiry; boot does not re-arm it,
  and its folder lives until someone presses Close.
- Repo jobs: nothing removes an `issue-implementation` job's folder at any end state, and after a restart the
  in-memory worktree session is gone, so the in-app merge can no longer use the folder either.

## Items

1. **Plan Queue retries kept folders.** On the pump's tick, for parked and landed items that still record a
   worktree folder, retry the normal checkpoint-then-`removeWithProof` path under the item lock, at most once
   an hour per item. On success, drop the stale "Worktree kept …" note. A folder whose checkpoint or proof
   fails again (unfinished merge, broken checkout, dirty tree) stays and is retried later.
   Tests: kept folder removed on a later tick with the branch kept; unfinished merge never removed; backoff.
2. **Blocked loop folders are removed, branch and block kept.** When boot reconcile leaves an ended run
   `blocked`, remove its folder if it is clean and verifiably owned, keep the branch, keep the run blocked for
   review, and keep the reason James sees. "Mark resolved" removes a clean folder too.
   Tests: rescued-branch run keeps its block and branch but loses its folder; dirty folder kept; Mark resolved
   removes the folder.
3. **Long-parked usage-limit loops are closed.** At boot, before reconcile, close (exactly as the Close button
   does) any loop parked on a usage limit that has no resume left scheduled and no activity for 14 days. A
   scheduled resume always wins, whatever the age: a Copilot monthly allowance can park a loop for weeks. The
   same boot's reconcile then removes its folder, keeping the branch. Tests: 15-day park closed; 2-day park and a
   20-day park with a scheduled resume untouched.
4. **Repo jobs remove their folders.** At each start, finished jobs (and jobs a crash left marked running)
   save any output to the branch and remove the folder; a completed job keeps its folder for the in-app merge
   until then. Jobs held by the global pause are skipped. Tests: failed and cancelled jobs remove folders and keep branches; boot sweep;
   paused-for-restart job untouched.

## Verification

Targeted specs per item, then the canonical checklist in `AGENTS.md`, then a fresh-eyes review. Live checks
that need the rebuilt app go to a `_livetest.md` doc.

## As built (2026-11-02)

1. `plan-queue-kept-folders.ts` (`PlanQueueKeptFolders`, `retryKeptFolder`), owned by `PlanQueueItemFlow`
   (`keptFolders`, run under the item lock) and called at the end of every pump pass across all runs
   (`plan-queue-pump.ts`). Parked folders are checkpointed then removed with the usual proof; landed folders are
   never checkpointed, so late edits still refuse removal; a folder already gone only has its record cleared.
   A refused retry is logged ("a kept folder still cannot be removed; trying again later").
   After a removal, a landed item's branch is deleted, as landing cleanup would have done (a refusal only warns);
   a landed item whose folder was already gone only has its record cleared and keeps its branch; a parked
   branch is always kept. The pump reads only parked/landed rows with a folder (`listItemsWithKeptFolders`).
   Tests in `plan-queue-retirement-control.spec.ts` (retry removes and keeps branch; no early retry; unresolved
   merge never removed; landed late edits still kept; clean landed folder removed then its branch deleted;
   record of a folder already gone cleared) and `plan-queue-kept-folders.spec.ts` (retry after the
   hour; which items qualify).
2. `releaseBlockedFolder` in `loop-worktree-lifecycle-reconcile.ts` runs in a `finally` for every row that ends a
   boot pass `blocked`: only `managedByAio` rows, clean, ownership proven by `removeOrphanWorktree`. An already
   blocked run keeps an existing reason on later starts. `resolveBlockedLoopWorktree` removes a clean, owned
   folder; `getLoopWorktreeRecord` now also returns `workspaceCwd`. Mark resolved now asks first beside the row ("Its
   working copy is removed if nothing in it is unsaved. Its branch is kept."); its tooltip comes from
   `TOOLTIP_COPY` (`loop.markResolved`) and the old "Nothing is deleted" text was retired in the wording ledger.
   Fresh-eyes round 3 found the deletion was only stated in a tooltip; fixed. Not done: clearing a pointer whose folder is
   already gone, because an existing safety test (reused branch name) relies on the pointer staying.
3. `closeStaleProviderLimitParks` in `loop-store-close.ts` (14 days from last round end or start, skipping loops
   with a schedulable `loopProviderLimitResume` automation, read by `scheduledLoopResumes` in
   `late-runtime-initialization-steps.ts`), called from the "Loop store" startup step before reconcile; if the
   schedule cannot be read nothing is closed. Reason "closed: parked on a usage limit for over two weeks". A
   one-off resume automation that already ran is not schedulable, so it cannot fire against a closed loop.
   Fresh-eyes round 1 found the first version (a flat 14 days, on the false premise that usage windows are at
   most a week) would close Copilot loops waiting on a monthly reset; fixed.
4. `repo-job-worktree-release.ts` (`finishedRepoJobs`, `releaseFinishedRepoJobFolders`), called from the new
   "Repository job folders" startup step through `RepoJobService.releaseFinishedJobFolders`. Failed and
   cancelled jobs are released at the next start rather than at job end: a cancelled job's agent is not proven
   stopped when the task ends, and after a restart nothing can use the folder. Untracked files with the names
   Harness copies into a new folder (`.env*.local`, `docker-compose.override.yml`, `.mise.local.toml`) are
   never saved to the branch, which may be pushed for a pull request; a tracked file with such a name is the
   project's own and is saved like any other edit. A folder with unresolved conflicts (merge, cherry-pick,
   revert, stash pop) is left alone; round 3 found the first check covered only a merge. The startup
   step does not hold up the window; jobs live by the time it reads the store are skipped.
   Fresh-eyes round 2 found the first exclusion (by name only) could hide, and so delete, an edit to a tracked
   `docker-compose.override.yml`; fixed.

Live checks: [2026-11-02-worktree-cleanup-gaps_plan_livetest.md](2026-11-02-worktree-cleanup-gaps_plan_livetest.md).
