# Plan Queue programme: planning files never reach a landing commit — implementation plan

**Status:** Implemented in the queue worktree on 4 November 2026 and ready for independent verification. It is one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md). Live checks are deferred to [2026-11-04-pq-a2-planning-files_plan_livetest.md](2026-11-04-pq-a2-planning-files_plan_livetest.md). See the as-built notes.

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Evidence → Code facts (the planning-file guards disagree; landing cleanup removes untracked files; checkpoint commits)
- Phases → Phase 1 (step 1.1 and its link to 1.10)
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

Step 1.10 (taking the 116 already-tracked planning files out of git) is NOT part of this job and must not be done: it needs James's go-ahead. This job covers new files only. Phase C has landed; re-check every line number cited, `plan-queue-worktree.ts`, `plan-queue-squash.ts`, `plan-queue-landing-leftover.ts` and `active-plan-documents.ts` have all moved. The hook pattern lives in `~/.config/git/hooks/plan-spec-guard.sh`; pin your shared pattern against a fixture copy as the step says (do not read secrets, the file holds none).

**Design change, 5 November 2026 (supersedes any in-place update in earlier rounds):** the branch built an in-place update guarded by a recorded hash. Remove it. A moved planning file must **never replace** an existing root file: if the destination exists, write beside it as `<name>.from-queue-<item>[-n].md` using an exclusive create (never overwrite) so a concurrent edit cannot be clobbered, and tell James. Delete the recorded-hash bookkeeping, and the migration column for it if one was added, and update the tests and the deferred `_livetest.md` to match. The verifier's last finding ("an edit after the final hash check can still be overwritten") is resolved by this design, not by a tighter check.

## Steps (copied verbatim from the programme plan)

- [x] 1.1 **Planning files never reach a landing commit, and are never deleted.**
  - **One pattern.** A shared module holds the active-document pattern, used by checkpoints, the landing guard,
    auto-integration and discovery. It includes `_history` and `-decisions-for-james`, and reads the
    standing-register marker from 8 lines, like the hook. Discovery changes from 40 lines to 8.
  - **Move at every checkpoint.** Before `git add -A` (`plan-queue-worktree.ts:203`), every untracked file matching
    the pattern is moved to the same path in the root checkout. The worker prompt already says those files belong
    there. If a move fails at a checkpoint, the file is copied to the rescue folder and left out of that
    checkpoint's `git add` with a pathspec exclusion, so it is never committed. The landing preflight tries the
    move again.
  - **No overwriting, ever.** A moved file never replaces an existing root file, not even one this same item moved
    earlier. An in-place update cannot be made safe against an edit that lands between the check and the write, and four
    review rounds each found another edge of that window, so the earlier "update in place if the hash is unchanged" rule
    is dropped (decided 5 Nov 2026). Whenever the destination path already exists at the root, the file goes beside it
    as `<name>.from-queue-<item>[-n].md`, with a unique number, created so it can never replace anything, and James is
    told. No hash of earlier moves is kept.
  - **Paths stay inside.** Destinations must stay inside the root checkout.
  - **Tracked files are untouched,** because they are tracked; the rule only moves untracked files. The marker
    check only decides which tracked files count as standing registers. 1.10 deals with the tracked planning
    files.
  - **Checked before landing, not during cleanup.** A preflight before the squash moves any remaining file. If a
    move fails (permissions, a symlink, a file or folder clash at the root, a path outside the root), the item parks
    naming the file, with a rescue copy in Harness's data folder. Parking happens before the squash, so no landing
    cleanup runs for it.
  - **Cleanup never deletes such a file.** If `restoreItemCheckout`'s `git clean` (`plan-queue-squash.ts:96-104`)
    still finds one, it first moves it under this rule. If that fails, it copies it to the rescue folder, then
    cleans. How `restoreAfterLanding` reports its own failures doesn't change.
  - **The rescue path keeps its own rule.** `plan-queue-landing-leftover.ts:119-123` (which uses `fs.rm`) moves
    only active-named files that are absent from both the base tree and the branch tree. Files that exist on the
    base are left to its existing logic.
  - **Prompts.** The worker prompt says planning-named files are always edited at their root path, even when
    tracked. The fix prompt says where any moved file went. `buildActiveDocumentsPrompt`
    (`plan-queue-prompts.ts:160`) stops telling the worker to move files, which could overwrite a root copy. Harness
    moves them under this rule instead.
  - **Scope.** The shared pattern also widens loop mode's auto-integration guard (`active-plan-documents.ts`),
    which then blocks `_history` and decision files too. That is intended, and covered by its specs. The standing
    register marker uses the hook's exact text, `Type: standing register`. The bold `**Type:**` form that
    discovery accepts today is dropped; no current file uses it. The `Queue: not an item` marker from 0.0 moves
    into the same module.
  - **Pattern check.** A test pins the pattern against a fixture copy of the hook's pattern, with a comment that the
    two must change together.
  - Together with 1.10 this fixes the 4 recent `_history.md` refusals. They were edits to tracked files, which only
    1.10 removes from the index.
  - **Tests:**
    - A worker-created `_history.md` is moved to the root at the checkpoint and never committed.
    - A landing attempt, successful or failed, preserves it.
    - A collision keeps both copies.
    - An existing `.from-queue` file gets a new number.
    - A path that would leave the root is refused. S.

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- A planning-named file a worker creates in its worktree is moved to the same path in the root checkout at every checkpoint and is never committed.
- A landing attempt, successful or failed, never deletes such a file; a collision keeps both copies; a path outside the root is refused.
- One shared pattern is used by checkpoints, the landing guard, auto-integration and discovery, and a test pins it to a fixture copy of the hook's pattern.
- Prompts no longer tell the worker to move files itself (`buildActiveDocumentsPrompt`).
- Every bullet of the step text above is met, or this plan's as-built notes say plainly, with the reason, which part was not and what remains.

## Verification

Run the targeted tests for what you changed, then:

- `npx tsc --noEmit`
- `npm run typecheck:spec`
- `npm run lint`
- `npm run check:ts-max-loc`
- `npm run check:ui-hints`
- `npm run build:main`
- `npm run build:renderer`
- `npm run test:quiet`

(Known: three `scripts/__tests__` tests fail on this machine because the installed Vite is older than `package.json` asks for; that is an environment fault, not yours. Say so rather than hide it.)

## Checklist

- [x] Step 1.1 implemented, wired, tested and verified (live checks deferred, see the livetest document)
- [x] As-built notes written below

## As-built notes

Written 4 November 2026 by the queue worker. Paths are in the queue worktree.

### What was built

- **One shared pattern:** `src/main/workspace/git/active-plan-pattern.ts` (pure). It holds `_spec|_spec_planned|_plan|_livetest|_history|-decisions-for-james` + `.md` (case-sensitive, like the hook's `grep -E`), the exact marker `Type: standing register`, the 8-line header read, and the `Queue: not an item` marker moved out of discovery. Users: `active-plan-documents.ts` (loop auto-integration, now also blocks `_history` and decisions files), `plan-queue-squash.ts` (landing guard), `plan-queue-discovery.ts` (reads 8 lines, not 40; bold `**Type:**` dropped, three discovery specs updated), and the new move module.
- **Pattern check:** `active-plan-pattern.spec.ts` extracts the pattern, marker and `head -8` from `src/main/workspace/git/fixtures/plan-spec-guard.hook.sh` (a verbatim copy of `~/.config/git/hooks/plan-spec-guard.sh`) and also runs that fixture hook against staged files in a temporary repository, comparing which names it blocks and which standing-register headers it exempts. Comment in both files: they must change together.
- **Move module:** `src/main/plan-queue/plan-queue-planning-files.ts`. Moves each untracked matching file (never tracked ones) from the work folder to the same path in the root checkout. Root copy absent: copy, remove original. Root copy has identical bytes: remove the original only. Anything else (the root copy differs, even one this item moved earlier; superseded by the 5 November design change below, no in-place update exists any more): saved beside it as `<stem>.from-queue-<last 6 letters/digits of the item id>[-n].md` with the first free number, written with exclusive create so nothing is ever overwritten. Destination folders are created step by step; a step that is a link leading outside the root, a path with `..`, an absolute path, an empty path or a `.git` segment is refused, and a source that is a link or not a regular file is refused (such paths are never read). A failure copies the file to the rescue folder (Harness's data folder) and is reported as `failed`; the move never throws for one file. All moves in the process are serialized.
- **Checkpoints** (`plan-queue-worktree.ts` `checkpoint`): after the conflicted-merge check and before `git add -A`, `movePlanningFiles` runs. A file that could not move is excluded from that checkpoint's `git add` and `git status` with `:(exclude,literal)` pathspecs. The item note (`detail`) tells James what moved, what went beside an existing file, and what failed with where its rescue copy is.
- **Landing preflight** (`plan-queue-item-landing.ts`): right after the `final` checkpoint and before closing documents or the squash, `preflightPlanningFiles` moves anything left. If any file still cannot move, the item parks as land-blocked naming the file ("Nothing was landed. ..."), before any squash, so no landing cleanup runs. Files that did move or go beside add a note.
> Earlier journal sections moved to `2026-11-04-pq-a2-planning-files_plan_history_c3acbbe6ff4e44d7463f69c4c68728cc5368223eec3085d74d1ff5d1fd039df2_completed.md`.
