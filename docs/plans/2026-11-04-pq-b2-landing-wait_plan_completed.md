# Plan Queue programme: a blocked landing waits instead of parking (4.1 and 4.2) — implementation plan

**Status:** Implemented in the queue worktree on 5 November 2026 and awaiting an independent verifier. Written 4 November 2026 as one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md). See As-built notes.

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Evidence → Run outcomes (why passes did not land)
- Phases → Phase 4
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

Do 4.1 first and write its finding in this plan's as-built notes before designing 4.2: read-only queries on the queue database give the recorded overlapping paths (`sqlite3 -readonly`, counts and path names only, never transcript text). Landing wait fields need a new migration: take the next free version after checking `loop-schema.ts` and `plan-queue-migrations.ts` (see the migration-numbers plan if it has landed). `plan-queue-item-landing.ts` and `plan-queue-item-flow.ts` are near their line ceilings: put new logic in new modules.

## Steps (copied verbatim from the programme plan)

- [ ] 4.1 **Find out where the overlapping uncommitted code changes come from.** About 17 of the 23 non-markdown
  overlaps since 18 October; the other 6 involve the generated file in 1.2.
  - Before changing anything, find out from the recorded paths who made them: James, loops or other sessions.
  - Include `app-server-protocol.gen.ts`, which the build refreshes (`scripts/test-staged.js`). It appears in 5 of
    the recent blocks.
  - Write the reproduction as a test. S.

- [ ] 4.2 **A blocked landing waits instead of parking.**
  - **Check before committing.** Before building the landing commit and running the 15-minute hook, compare the
    item's changed paths with the root's uncommitted paths, excluding exactly the overlaps promotion can resolve:
    markdown through the merge helper, and generated files under 1.2.
    On overlap, the item waits; no hook runs.
  - **Promotion's answer is structured.** It returns `dirty-overlap` as a code instead of free text (today
    `reason` only, `worktree-integration.ts:454-458`). This covers non-markdown overlaps, staged copies and
    same-line markdown conflicts the helper refuses (`plan-queue-doc-merge.ts:160-161`).
  - **Waiting holds nothing.** `land()` returns and releases the landing chain and the item lock. It records
    `landing_wait_since` and the paths, and the item stays in `landing`.
  - **Rules the phase plan must keep:**
    - Waiting items don't count toward worker or check slots. They still count toward the queue's hard work-folder
      limit from 0.2, because they keep their folders.
    - They don't keep the Mac awake (`hasActiveWork`, `plan-queue-store.ts:151-157`).
    - At most 3 items per run wait at once; any further ones park `land-blocked` as today.
    - The wait re-check runs before the pump's pending-cleanup skip (`plan-queue-pump.ts:52`).
    - The wait fields survive Pause and restart. Boot recovery already re-enqueues `landing` items
      (`plan-queue-recovery.ts:85-87`) and must re-check first. The 24-hour clock keeps running while paused.
  - **When the paths are clear,** the pump calls `enqueueLanding` again. If `main` has moved, the existing sync and
    post-merge gate run first. James is told once, naming the files. After 24 hours the item parks `land-blocked`,
    and the existing Try again resumes it.
  - **Tests:** wait, clear, lands; wait, main moves, resync; wait, timeout, park; a fourth waiter parks; pause
    during the wait; restart during the wait; two items waiting on the same file; the Mac isn't kept awake. M.

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- 4.1: a written finding on where overlapping uncommitted code changes come from, plus a reproduction test.
- 4.2: every test the step lists (wait, clear, lands; main moves and resyncs; 24 h timeout parks; a fourth waiter parks; pause and restart during the wait; two items on one file; the Mac is not kept awake).
- Waiting items hold no landing chain and no item lock, and do not count toward worker or check slots.
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

- [x] Step 4.1 implemented, wired, tested and verified
- [x] Step 4.2 implemented, wired, tested and verified
- [x] As-built notes written below

## As-built notes

**4.1 finding.** The overlapping code changes are hand edits made in the root checkout by sessions working there (James's own and other agents'), committed in bulk later, plus the Codex protocol snapshot `app-server-protocol.gen.ts`, which the build rewrites whenever the installed Codex CLI changes and which the hook's own generated-file list (`scripts/generated-artifacts.json`) does not cover. So the snapshot is a real, separate cause: it is not resolvable by the hook list, and it now waits like any other code overlap. The finding was recorded by the first session from path names only; this resume session did not re-query the queue database. The reproduction test is `4.1: where overlapping uncommitted changes come from` in `plan-queue-landing-wait.spec.ts` (source file, the snapshot, a staged document: each refused by promotion and reported as `dirty-overlap`).

**4.2 as built.**
- `plan-queue-landing-wait.ts` (new): `landingBlockers` (the check before committing: root uncommitted paths against the item's changed paths, leaving out unstaged or untracked Markdown and the hook's generated files), `PlanQueueLandingWaits.begin` / `recheck`, the 24-hour limit and the limit of 3 waiters per run.
- Promotion returns `code: 'dirty-overlap'` with `overlaps` (`worktree-integration.ts`); `landItemBranch` turns it into `{ status: 'dirty-overlap', paths }`.
- `plan-queue-item-landing.ts` checks before the hook runs and waits or parks; "Land anyway" never waits. The item stays in `landing` and holds no chain or lock.
- Migration 45 adds `landing_wait_since` / `landing_wait_paths`; the store drops them when the item leaves `landing`.
- Slots: `itemHoldsWorkerSlot` frees the worker slot while waiting; the work-folder limit still counts the item. `PlanQueueStore.hasActiveWork` and `PlanQueueItemFlow.hasActiveWork` exclude a waiting landing, so it does not keep the Mac awake.
- The pump re-checks waiting landings before its pending-cleanup skip; boot recovery re-checks first. Pause keeps the wait and the clock.
- Every test the step lists is in `plan-queue-landing-wait.spec.ts`.

**Resume repair (5 November, after the post-merge full run failed).** The full run had 22 failures plus a 45-minute timeout (two full runs were going at once, and a full run takes about 35 minutes on its own). Causes and fixes:
- `PlanQueueStore.hasActiveWork` still counted every `landing` item; it now excludes a waiting one (the docstring already said so).
- Existing tests that expected promotion's refusal to be a plain `blocked` result now expect the new `code: 'dirty-overlap'` and `overlaps` (`worktree-manager.spec.ts`, `worktree-integration.spec.ts`, `plan-queue-doc-merge.spec.ts`, `plan-queue-worktree.spec.ts`): a deliberate contract change from this step.
- `plan-queue-reviewed-landing.spec.ts` uses a work folder that is not a git checkout, so it now stubs `landingBlockers` to return no paths.
> Earlier journal sections moved to `2026-11-04-pq-b2-landing-wait_plan_history_ec698b384538d9381fbc8e48c23a751f849ba575ada22c206b635da4591ccd6a_completed.md`.
