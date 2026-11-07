# Plan Queue: batched checks (one test run for several finished jobs)

**Status:** implemented and independently verified 4 November 2026; see the [completed implementation plan](2026-11-02-plan-queue-batched-checks_plan_completed.md). The installed-app check remains [explicitly deferred](2026-11-02-plan-queue-batched-checks_livetest.md). Written 2 November 2026 at James's request ("some way to combine running tests, so we're
not just constantly and forever running tests").

**Dependency satisfied:** [Phase C](2026-10-20-oct2-phaseC-queue-that-finishes_plan_completed.md) Step 2 landed before implementation. That step makes
Harness run each job's checklist itself and store per-check results ("receipts") before the checker starts, reusing them
while the job's code is unchanged, with gate runs admitted through the per-project-folder check slots (Step 2.8). This
spec builds on those receipts and changes nothing until they exist.

## In plain English

Today every finished job gets its own full run of the checklist (type checks, lint, both builds, the whole test suite).
With four jobs finished in one project, the Mac runs the whole suite four times, side by side.

After this work, when several jobs in the same project are waiting to be checked at the same time, Harness puts their
changes together in a temporary copy and runs the checklist once. If everything passes, every job in the group counts as
passed on those checks, and each job's checker still reads its own job and judges it. If the combined run fails, Harness
falls back to checking each job alone, so a failure is never pinned on the wrong job.

Expected effect: in a busy project, four checklist runs become one. In the worst case (a combined run fails), four
become five.

## What happens today (verified 2 November 2026)

- Each checker session runs every check itself in the job's folder (`plan-queue-prompts.ts:253-254`); nothing records
  or reuses results (`plan-queue-coordinator.ts:547` stores the reported list; nothing reads it).
- Before a checker starts, the job's branch is brought up to date with the base branch (`plan-queue-item-flow.ts`
  `startVerification`, `syncItemWithBase`).
- Landing is one job at a time. When the base moved after a job was checked, landing merges the base again and runs only
  the light `postMergeGate` (type checks, `plan-queue-item-landing.ts:197-212`). So today the combination of two jobs
  that land one after the other is never fully tested.
- Every landing commit also runs the repository's pre-commit hook, which runs the related tests again
  (`.githooks/pre-commit` → `scripts/run-git-hook.js`; landing commits do not pass `--no-verify`,
  `plan-queue-squash.ts`).
- On 2 November 2026 about five full test runs were going at once on James's Mac, mostly queue checks.

## Requirements

1. **When to combine.** When a job is admitted to start its checks (it has a check slot, per Phase C Step 2.8), Harness
   looks for other jobs in the **same project folder** that are also waiting for checks and have no receipts for their
   current code. It may take up to `checkBatchSize - 1` of them into the same run. The whole group uses **one** check
   slot while the checklist runs. Jobs from different project folders are never combined.

2. **Setting.** New run setting `checkBatchSize` (whole number 1-8). Default 4 for plan runs and 1 (off) for livetest
   runs, whose checklist is light. Available on `plan_queue_start` as `check_batch_size`. Older saved runs without it
   behave as 1. It is read when the batch forms, like the other limits.

3. **Building the combined copy.** Harness creates a throwaway checkout of the base branch tip through the queue's own
   worktree service (the same mechanism as Phase C's base checkout; never the root checkout, never a hand-made
   `git worktree add`), then merges each member's branch into it in job order. Every member must already be up to date
   with that same base tip (re-sync first if not). A member whose branch conflicts with the base or with earlier members
   is left out of the group and checked on its own later. If fewer than two members remain, run as a single job. The
   copy is removed after the run, whether it passed or failed.

4. **One run, shared results.** Run the run's checklist once in the combined copy, with the same per-check time limit
   and output handling as Phase C's receipts.
   - **All green:** each member gets receipts keyed by its own current HEAD, marked as coming from the combined run
     (record the group id, the base tip and the member list). Each member's checker is then spawned as usual, with the
     receipts table and "Do not re-run a green check unless you change files."
   - **Any new failure** (one not also failing on the base, using Phase C's base comparison): the combined receipts are
     discarded for every member, and each member is checked alone exactly as if batching were off. Do not try to split
     the group in halves; the fall-back keeps the worst case at one extra run.

5. **Receipts follow the code.** A combined receipt applies only while the member's HEAD is the one recorded. A fix
   round changes the HEAD, so the next round runs again (alone or in a new group).

6. **Landing.** Landing stays one job at a time. When a member lands and main has moved since its check only because
   other members of the same green group landed, its code is part of the tree that was fully tested, so the light
   post-merge check may be skipped for it. In every other case (another job landed in between, or a member was rejected
   by its checker), landing behaves exactly as today. This is never weaker than today: today two jobs landed one after
   the other are never tested together at all.

7. **Pre-commit test run on landing (approved by James on 4 November 2026).** The landing commit's hook runs the related tests
   again on code that already has green receipts. Skip only the hook's test step (keep the plan/spec guard and all
   other hook steps) when the landing tree's code matches a tree with green receipts. If James declines, leave the hook
   as it is.

8. **What James sees.** The job card says "Checked together with N other jobs" when it passed in a group, and "The
   combined check failed; checking each job on its own" after a fall-back. The run summary reports how many checklist
   runs covered how many jobs (for example "3 test runs covered 10 jobs").

9. **Limits stay in charge.** A combined run counts as one check for the per-folder check slots, the Lightest/Light
   machine-wide cap and the load-average gate. Batching never starts more work than the slots allow; it only lets one
   slot cover several jobs.

## Out of scope

- Running only the tests affected by a change (test selection by import graph). It could save more, but it misses
  effects that do not follow imports (config, fixtures, generated files). Revisit after this lands, using its numbers.
- Changing what workers run before handing off (targeted tests, type checks, lint).
- Combining jobs across project folders.

## Tests (each fails before the change)

- Two jobs waiting in one folder with batch size 4: one checklist run, both get receipts tied to their own HEAD, two
  checkers spawn, one check slot used during the run.
- Jobs in two folders never share a run.
- A member that conflicts is left out and checked alone; the others still share a run.
- A new failure in the combined run sends every member to its own run; a failure also present on the base does not.
- A fix round after a combined pass runs the checks again.
- Landing a second member right after the first from the same green group skips the post-merge check; a third job
  landing in between brings the post-merge check back.
- Batch size 1, and older saved runs, behave exactly as today.
- On Lightest, only one checklist run (combined or not) runs machine-wide.
- The throwaway copy is removed after both green and red runs, and after cancellation.

## Done when

All of the above pass, the canonical checklist and an independent completion review pass, and a live run on the
installed app shows the run summary counting fewer checklist runs than jobs for a busy project folder (recorded in a
`_livetest.md` if it needs the rebuilt app).

## As built (4 November 2026)

Requirements 1-9 are implemented. All eight canonical checks and a fresh independent completion gate passed;
37,421 tests passed, eight pre-existing skips are unchanged, and no task spec was skipped. The prerequisite was
merged first and overlapping local edits were preserved. The completed plan records exact command evidence,
source/index/HEAD stability, the lockfile-matched local installation repair and implementation decisions.
James explicitly approved the duplicate hook-test skip; every other hook check remains required. Only the rebuilt
installed-app busy-project check is deferred to the linked live-check document. Nothing was committed or pushed.
