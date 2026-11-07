# Plan Queue: recover a checkout left off its branch by an interrupted landing

## Status

IMPLEMENTED & VERIFIED 2026-10-28 (code and automated checks). James asked for this to go ahead with the recommended options ("whatever you think is best", 28 October). Verification: 14 new real-Git tests; all 941 Plan Queue and Git tests; full suite 2,822 files / 35,743 tests passed; both typechecks, eslint, oxlint, the file-length and unused-export checks passed. A third fresh completion gate returned `VERDICT: PASS` after two earlier gates failed and their findings were fixed (see "As built"). **Not committed:** see Coordination. The running-app checks, and moving the 17 affected work-finding branches, are in [the live-test document](2026-10-28-plan-queue-detached-landing-recovery_livetest.md). Untracked.

Follows: [orphan checkout recovery](2026-10-18-plan-queue-orphan-checkout-recovery_plan_completed.md) (the half-removed folder case) and [checkout timeout](2026-10-18-plan-queue-checkout-timeout_plan.md) (the 30-second default on checkout commands).

**Coordination:** another session has uncommitted edits in `src/main/plan-queue/plan-queue-worktree.ts` (new `PlanQueueCheckoutOwnershipError`) and `src/main/plan-queue/plan-queue-run-hold.ts` (Pause parks the item with `worktree-error` instead of throwing). That is containment: Pause stops failing, but Resume still refuses on the same check. This change was built on top of those edits without overwriting them, and depends on `PlanQueueCheckoutOwnershipError`. It was therefore left uncommitted (28 October): commit it together with that session's work, or after theirs lands. Its own files are `plan-queue-landing-leftover.ts` and its spec (new), the diffs of `plan-queue-squash.ts`, `plan-queue-landing.ts`, `plan-queue-item-landing.ts` and `plan-queue-landing.spec.ts`, and the recovery parts of `plan-queue-worktree.ts` listed under "As built".

## What James saw

The Plan Queue page shows, in red:

> /Users/suas/work/communitytech/work-finding/.worktrees/queue/research-worker-p2-028d52 is not this item's checkout of queue/research-worker-p2-028d52, so nothing was committed

It comes from `assertItemCheckout` (`src/main/plan-queue/plan-queue-worktree.ts`, called first in `checkpoint()`). The guard is right to refuse: it was added on 26 October (commit `80412201a`) so a checkpoint can never sweep the wrong folder onto the wrong branch. The problem is that nothing can ever put this folder back, so the item is stuck for good.

## Evidence (checked 2026-10-28)

1. **The folder is on a detached HEAD at main's old tip.** `git worktree list` shows the item checkout as `detached` at `95e7ba50` (work-finding `main` on 26 October). The item branch tip is `c70f2bb7` ("Plan queue: merge main"). Worktree reflog: `11:35:49 merge main`, then `11:36:42 checkout: moving from queue/research-worker-p2-028d52 to 95e7ba50…`. That is exactly `buildLandingCommit`'s `git checkout -q --detach baseTip` (`plan-queue-squash.ts`). Its `finally` should have put the branch back, and did not.
2. **Nothing in the folder is new work, but not every file is whole.** Compared against a throwaway index of the branch tip: every changed or untracked file on disk matches either main's old tip or the branch tip, except two branch files a killed checkout left cut short (`…/focused-schema-absence.receipt.json` is the first 256 KiB of the branch copy; `…/postgres-full-corrected.log` is the first 16 KiB). That correction came from the 28 October completion gate; the first pass spot-checked only three files. 2,643 branch files are missing from disk. There are no untracked files that are not on the branch. The work is safe on the branch.
3. **Timing points at the 30-second Git timeout (not proven; logs from that day have rotated).** Files and the index were last written at 11:37:27, about 45 seconds after the detach. `gitExec` defaults to 30 s (`src/main/workspace/git/git-exec.ts`). `shutdown.ndjson` records a normal quit and restart at 11:33 but no shutdown in the 24 hours after 11:34, so the app did not quit mid-landing. The likely sequence: `merge --squash` was killed at 30 s, then the `checkout -f` restore in `finally` was also killed at 30 s, which threw out of `finally` and left the detached state. Slice 1 must reproduce this before anything is changed.
4. **The squash was huge because the branch carries a stray commit.** The item's base commit `187b2e29` is "Plan queue checkpoint: parked: worktree-error", which was committed **directly onto work-finding `main`** on 25 October at 11:45 (main reflog). It holds 5,907 files and 2.56 million lines, mostly `documents/plans/**/worker-evidence` logs and receipts. Main was reset back past it on 26 October at 00:03, but every queue branch created in between was built on it. 17 local `queue/*` branches still contain it and none of them is on main. If any of them lands, the squash puts those 5,907 files back on main, or (more likely) the active-document check refuses the landing. It happened before the checkout guard existed. The same hazard hit this repository on 24 October (`2b949b0df`, same subject line).
5. **Only one code path repairs a detached checkout.** `restoreItemCheckout` runs at the start of `landActive` (`plan-queue-item-landing.ts`, "A crash while the squash was being built…") and inside `buildLandingCommit`. Every other entry point goes straight to `checkpoint()` → `assertItemCheckout` and refuses: the Pause hold (`plan-queue-run-hold.ts`), resume after restart ("before resume", `plan-queue-item-flow.ts`), end of a round, merging main, and parking. The item is `queued` (round 0) in a `paused` run, so the next Resume fails the same way.

## Fix

### Slice 1: reproduce (tests first, no production change)

- [ ] Real-Git test in `plan-queue-squash.spec.ts`: a branch large enough, or a stubbed `gitExec` that times out, so `merge --squash` and then the restore `checkout -f` both fail. Confirm `buildLandingCommit` throws and leaves the worktree detached. That proves evidence point 3 as a mechanism.
- [ ] Test that, from a detached squash leftover, `checkpoint()` throws the ownership error, and that Pause, resume-after-restart and round-end all hit it. These are the failing tests the later slices turn green.

### Slice 2: put a landing leftover back wherever it is found

- [ ] Add `recoverLandingLeftover(worktreePath, branchName)` beside `restoreItemCheckout` in `plan-queue-squash.ts`, and run it inside the git write queue at the start of `checkpoint()` and in `reattach()`'s "already there" branch, before `assertItemCheckout` / `assertQueueCheckout`. It acts only when **all** of these hold, and otherwise does nothing so the existing guard refuses as today:
  1. the folder is its own checkout (`assertOwnCheckout`) of this repository (same common git dir);
  2. HEAD is detached;
  3. the worktree's newest reflog entry is `checkout: moving from <this item's branch> to <sha>` (the queue's own detach) and no commit was made after it;
  4. no merge, rebase or cherry-pick is in progress apart from the squash's own `SQUASH_MSG`.
- [ ] When those hold, compare the disk with the branch tip and the detach target, as in evidence point 2. If any path matches neither, save the whole folder first: commit it through a temporary index with `commit-tree` (no checkout, no hooks) to `refs/plan-queue/rescue/<item-id>-<timestamp>`, and write that ref name into the item's `detail`. Then `checkout -f -q <branch>` with `WORKTREE_CHECKOUT_TIMEOUT_MS`, and remove the squash's `SQUASH_MSG`. Log what was done. This loses nothing even when something was edited while detached.
- [ ] Have `restoreItemCheckout` (landing) use the same helper so there is one repair rule, not two.
- [ ] Tests: leftover found by Pause, resume and round-end is restored and the checkpoint then succeeds; a folder with an unknown edit gets a rescue ref holding that edit; a detached HEAD **not** made by the queue (a different reflog entry, a commit after the detach, a foreign checkout, a plain folder) is still refused untouched.

### Slice 3: stop the landing step leaving it behind

- [ ] In `buildLandingCommit`, run the detach, `merge --squash`, the post-squash `status`, and both restores with `WORKTREE_CHECKOUT_TIMEOUT_MS` instead of the 30 s default. Do not change other Git calls.
- [ ] If the restore in `finally` still fails, do not let the item drop back to `queued`: park it `worktree-error` with a plain detail ("Landing stopped part-way; the work is safe on its branch. Resume puts the folder back."). Slice 2 makes that Resume work.
- [ ] Test: restore failure parks the item with that detail, and Resume recovers it.

### Slice 4: refuse to land a branch carrying a commit main dropped

- [ ] Before squashing (`plan-queue-landing.ts`, before `buildLandingCommit`), check that `item.baseCommit` is an ancestor of the base branch tip. If it is not, park `land-blocked` and say in plain words that the item was started from a commit that is no longer on main and that landing would bring back N files from it. Count N from `git diff --name-only <merge-base(main, branch)> <item.baseCommit>`.
- [ ] Test with real Git: base branch reset past the item's base, then landing refuses and nothing is committed.
- [ ] Do not build automatic rebasing. Moving an item's own work onto current main is a decision for James (see "Decision for James").

### Slice 5: make the message say what to do

- [ ] Keep the exact path and branch in the log. Give the item's `detail` and the run banner one plain sentence instead: what happened, that the work is safe, and what Resume will do. The `PlanQueueCheckoutOwnershipError` message stays as the technical cause in the log.

### Verification

- [ ] Focused: `plan-queue-squash`, `plan-queue-worktree`, `plan-queue-run-hold`, `plan-queue-pause-control`, `plan-queue-pause-landing`, `plan-queue-landing`, `plan-queue-coordinator`, `plan-queue-orphan-checkout` specs.
- [ ] Both typechecks, lint, build, then the full suite through `npm run test:quiet`.
- [ ] Fresh independent completion gate (`task-completion-gate`) until `VERDICT: PASS`.

## Live checks

Moved to [the live-test document](2026-10-28-plan-queue-detached-landing-recovery_livetest.md).

## Decision for James (decided 28 October: the recommended option)

The 17 work-finding `queue/*` branches built on the stray commit `187b2e29` cannot land cleanly. Options:

- **Recommended:** for each item still wanted, start a fresh branch from current main and bring over only that item's own changes (the diff from `187b2e29` to its tip, without the main merges). The old branch stays as a backup until the new one lands. One-off operational work through the queue's own controls, done after Slices 1–4 are in.
- Discard the affected items and re-queue their plans from scratch.

James chose the recommended option. The move itself needs the rebuilt app and the queue's own controls, so it is check 3 of the live-test document. Nothing in this plan's code rewrites, deletes or lands those branches.

## Out of scope

- Why the stray checkpoint reached main on 25 October. The 26 October checkout guard is meant to prevent it; the [orphan checkout recovery](2026-10-18-plan-queue-orphan-checkout-recovery_plan_completed.md) work owns that path. If Slice 1 finds the guard can still be bypassed, write a new dated follow-up.
- Building the squash somewhere other than the item's own folder. The current design does that deliberately so the repository's hooks run.

## As built (2026-10-28)

- **New `src/main/plan-queue/plan-queue-landing-leftover.ts`** with `recoverLandingLeftover`. It runs at the start of every `checkpoint()` (inside its Git write-queue job), in `reattach()` before `assertQueueCheckout`, and at the start of every landing (`returnToItemCheckout`). It acts only on the proof listed in Slice 2. Deviation: the one commit allowed after the detach is the queue's own squash for this item (one parent, message `Plan:`/`Livetest:` ending `Item: <id>`), which covers a restore failing after the commit was made. Folders that fail the proof are untouched and refused.
- **Changed after the first completion gate:** files matching neither the branch tip nor HEAD are **never** carried onto the branch. A killed checkout leaves files cut short (the real stuck folder has two), and a squash interrupted mid-conflict leaves conflict markers. Either would otherwise have been committed. Instead, the whole folder is first saved as a commit under `refs/plan-queue/rescue/<item>-<time>`, and the branch is checked out clean. Untracked files of that kind are removed from the folder, and the squash's `SQUASH_MSG`/`MERGE_MSG`/`AUTO_MERGE` are deleted. The item's note names the rescue ref (checkpoint and reattach). A later status change can replace that note; the ref stays, and the recovery is logged. Cost: an edit someone made while the folder was detached is only in the rescue commit, not on the branch.
- **Landing start no longer forces.** `returnToItemCheckout` (new, used by `landActive` and `buildLandingCommit`) recovers on proof, or throws `PlanQueueCheckoutOwnershipError` untouched. The landing-failure path parks that error without requiring a checkpoint, so the item does not stay stuck in `landing`. `restoreItemCheckout` keeps its forced restore only for the end of a landing attempt, where the detached state is the squash that attempt just made.
- **`plan-queue-squash.ts`:** the detach, squash, post-squash status, `diff --cached` and restore use the 5-minute checkout deadline. A failed final restore throws a plain message ("Landing stopped part-way… Its work is safe on the branch…") after removing the copied closed documents, and the item parks through the existing landing-failure path (`land-blocked`), whose checkpoint puts the folder back. That is a deviation from Slice 3's `worktree-error`.
- **`plan-queue-landing.ts`:** `landItemBranch` refuses (`blocked` → `land-blocked`) when the branch carries any commit not on the base branch that is not the item's own. Concretely: its `baseCommit` is off the base, or `rev-list branch ^base` holds a commit outside the branch's first-parent line, which means it was merged in. The message names the commit. Checked read-only against every real work-finding `queue/*` branch with `main` as base: it catches all 17 carrying `187b2e29` (13 started from it, 4 merged it in) and flags none of the others. A worker merging some other non-base branch would also be refused; the queue itself only merges the base.
- **Slice 5 cut:** the `PlanQueueCheckoutOwnershipError` text belongs to the other session's uncommitted work, and its tests match it word for word, so it was left alone. This change depends on that class, which is not yet committed.
- **Tests:** new `plan-queue-landing-leftover.spec.ts` (11 real-Git cases: clean leftover, cut-short/edited/deleted files, conflicted squash, reattach, restore failure after the squash commit, commit-after-detach refusal, foreign-detach refusal, landing-start refusal, stray start, stray merge, and a normal merge of the base that must still land). With the recovery and the landing check switched off, 7 fail. The 4 refusal and normal cases pass either way, by design. One existing test (`plan-queue-landing.spec.ts`, "recovers a worktree a crash left on the detached squash state") now detaches at main's full hash instead of the name `main`. That is how `buildLandingCommit` actually detaches, and what the proof checks.
- **The stuck work-finding item against the proof:** detached by `checkout: moving from queue/research-worker-p2-028d52 to 95e7ba50…`, HEAD `95e7ba50`, no merge markers. Its next checkpoint puts it back on the branch and saves a rescue ref holding the two cut-short files, which are not put on the branch. It will then refuse to land under the stray-history check, as intended.

### Second gate fixes (2026-10-28)

- **Landing marker.** `buildLandingCommit` writes `plan-queue-landing` (holding the base tip) into the worktree's private git dir before it detaches. The end-of-attempt restore removes it. Recovery now also acts when HEAD is still on the branch but the marker remains: a detach stopped before it moved HEAD, which previously left base files mixed into the branch for the next checkpoint to commit. The gate reported this as an older gap of the same kind; it is fixed here. The "other side" for working out which files are unknown is then the marker's base tip.
- **Exact restore.** Recovery and the end-of-attempt restore both run `read-tree HEAD` before `checkout -f`, so a restore killed after writing the index cannot hide the other side's files. Afterwards they remove every untracked file not on the branch (provisioned and ignored ones aside). Recovery removes only individual files; the end-of-attempt restore uses `git clean -f -d`, which is safe there because the final checkpoint has committed all the item's work. A separate Git repository inside the folder makes recovery refuse with a plain message before changing anything.
- **Proof tightened:** the folder must be a linked worktree (`.git` is a file), and HEAD on some other branch is refused. Not checked: that the folder's common git dir is the run's repository. The checkpoint has no repository root to compare against, and the reflog naming this item's own branch plus `refs/heads/<branch>` existing there make a foreign repository impractical.
- **Rescue ref kept on the item:** after a Git-lock retry of the checkpoint job, and at landing start (`returnToItemCheckout` returns it, `landActive` saves it, and it is carried into the landed note).
- **Not handled:** an item with no recorded `baseCommit` that started from a dropped commit. `prepare` always records one, so this needs a hand-edited row.

