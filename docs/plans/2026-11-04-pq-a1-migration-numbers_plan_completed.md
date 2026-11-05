# Plan Queue programme: reconcile queue migration numbers — implementation plan

**Status:** Implemented 4 November 2026 in the queue worktree, awaiting independent verification. One slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md).

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Phases → Phase 0 (step 0.4)
- Design → Migrations this programme adds
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

Current state on `main` (4 Nov 2026), re-verify before relying on it: `src/main/orchestration/loop-schema.ts` has migrations 30, then `...PLAN_QUEUE_MIGRATIONS` from `src/main/plan-queue/plan-queue-migrations.ts` (31 history, 32 spend), then 40 (`livetest_port`, idempotent because a local build once recorded it as 031), 41 (`base_conflicts`) and 42 (a repair for that history). The old note about 026-029 being reserved by queue branches is stale: check the real branches (`git branch --list 'queue/*'`) and the real database receipts before deciding anything. Never renumber or edit a migration that has already run on a real database (`~/Library/Application Support/harness/loop-mode/loop-mode.db`, read it with `sqlite3 -readonly`, counts only).

## Steps (copied verbatim from the programme plan)

- [x] 0.4 **Reconcile migration numbers.** 026–029 are reserved for queue branches and 030 is used by MiMo
  (`loop-schema.ts:482-488`). Renumber whatever lands second, and add a test that versions are unique and
  increasing. Then reserve the numbers for this programme's migrations. S.

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- A test fails if two migrations share a version or a name, or if versions are not strictly increasing in the array.
- A written, verified statement in this plan's as-built notes of which numbers are taken, which are free for the programme's later migrations (`worker_report_json`, `source_kind`/`sort_key`, `landing_wait_since`, and so on), and why no existing migration was renumbered.
- Existing migration tests still pass unchanged apart from legitimately new columns.
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

- [x] Step 0.4 implemented, wired, tested and verified (worker checks; independent verifier still to run)
- [x] As-built notes written below

## As-built notes

Written by the worker, 4 November 2026. Evidence was read from the code, the branches and the real database; nothing was inferred.

### Which numbers are taken (verified)

- Array in `src/main/orchestration/loop-schema.ts` (now exported as `LOOP_MIGRATIONS`): 1-25, 30, 31 (history), 32 (spend), 40 (livetest port), 41 (base conflicts), 42 (legacy-history repair). `LOOP_SCHEMA_VERSION` is 42.
- Real database receipts (`~/Library/Application Support/harness/loop-mode/loop-mode.db`, read with `sqlite3 -readonly`, version and name only): exactly the same set, versions 1-25, 30, 31 `031_plan_queue_history`, 32, 40, 41, 42. No row is missing from or extra to the array.
- Free below the programme block: 26-29 and 33-39. They are not used by any code, by any of the 200 local `queue/*` branches (checked with `git show <branch>:...` and `git grep` over every branch for migration entries; the only entries found anywhere were 31, 32 and an unrelated `004_context_evidence` in another schema) or by the real database.

### Why nothing was renumbered

The step text said 026-029 were reserved for queue branches and 030 used by MiMo. That is stale: no branch ever used 26-29, and 30 is `030_plan_queue_item_worker_session`, already applied on the real database. Every migration that has run on a real database keeps its number (renumbering would make the runner treat it as new and re-run it). The earlier clash (a local build recording the livetest port at 31 before Phase C took 31) was already repaired by 40 and 42 and is covered by `loop-schema-queue-compat.spec.ts`, which still passes unchanged. The only edit to an existing entry is a comment on 30 that no longer says 26-29 are reserved.

### Numbers reserved for the programme

`PLAN_QUEUE_RESERVED_MIGRATIONS` in `src/main/plan-queue/plan-queue-migrations.ts` holds 43-49, one per group in the programme plan's "Migrations this programme adds" (40 and 41 already cover `livetest_port` and `base_conflicts`, so those two are not repeated):

- 43 `worker_report_json` (5.1)
- 44 `source_kind` and `sort_key` (6.2)
- 45 `landing_wait_since` and `landing_wait_paths` (4.2)
- 46 moved planning-file hashes (1.1)
- 47 worker-retry backoff expiry (1.4, unless the restart counter covers it)
- 48 Linear item columns
- 49 `plan_queue_source_outbox` and the per-run Linear cursor

50 onwards is unreserved. The programme's settings and run config need no migration. If a later step needs a different shape it takes the next free number after the list and amends the list in the same change. A test enforces that a reserved number, once used, is used by the migration of the reserved name.

### What was built

- `src/main/orchestration/loop-migration-numbers.ts`: `findMigrationNumberProblems`, a pure checker (duplicate version, duplicate name, versions not increasing in array order, name not starting with its version, reserved number or name used by something else).
> Earlier journal sections moved to `2026-11-04-pq-a1-migration-numbers_plan_history_87321e1347df7418083193c3bfa7b6df4fd36c9f233b5ae07bd7b87da518dd48_completed.md`.
