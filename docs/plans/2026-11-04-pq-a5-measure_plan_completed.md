# Plan Queue programme: measure the queue (Phase 2) — implementation plan

**Status:** Implemented 4 November 2026 in the queue worktree, awaiting independent verification. Written as one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md) (left untouched, as asked). Live checks that need the rebuilt app are in [2026-11-04-pq-a5-measure_plan_livetest.md](2026-11-04-pq-a5-measure_plan_livetest.md).

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Evidence → Run outcomes (the table and what cannot be measured today)
- Phases → Phase 2
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

Phase C has landed, so the events and verdicts tables exist (`plan_queue_item_events`, `plan_queue_verdicts`, history store in `src/main/plan-queue/plan-queue-history-store.ts`). Record the new timings as new event kinds in that table, not a new table. Machine load (`os.loadavg()`) is recorded at the start and end of each hook run. Step 2.2 adds a plain-language 'Queue health' summary on the Plan Queue page and in `plan_queue_status`: read `docs/screen-and-wording-guide.md` first. Step 2.3 records today's numbers (the Evidence table) in this plan's as-built notes and in the programme plan's as-built section is **not** yours to edit (leave the programme plan alone; put the baseline in this plan). `plan_queue_status` output is already very large (over a million characters on James's machine): do not make it larger; keep the health summary compact.

## Steps (copied verbatim from the programme plan)

- [x] 2.1 **Add what Phase C's events and verdicts tables don't already record:**
  - each worker and checker session's start and end, with provider and model;
  - slot waits and usage waits;
  - landing time, split into sync, post-merge gate, hook and promote;
  - the machine's load average at the start and end of each hook run.

  S once Phase C is on `main`.

- [x] 2.2 **A "Queue health" summary** on the Plan Queue page and in `plan_queue_status`:
  - attempts that land, and documents that land;
  - passes not landed;
  - first-round pass rate;
  - time from a free slot to the next start;
  - check time and landing time;
  - the share of time spent waiting rather than working;
  - rounds spent on items that ended parked.

  Plain-language labels, per `docs/screen-and-wording-guide.md`. M.

- [x] 2.3 **Save the baseline.** Record today's numbers (the Evidence table) in this plan's as-built notes, and
  compare two weeks after Phase 5.

Targets to check against the baseline (goals, not promises):

| Measure | Baseline | Target |
|---|---|---|
| Attempts that land | 39% | 70% or more |
| Passes not landed | 29% | 5% or fewer |
| Passed plans left open | 50 in 6 weeks | 0 |
| Hook timeouts sent back to a worker | 7 in 4 days | 0 |
| Passes landed with deferred checks | not measured | recorded; reviewed by James after two weeks |
| Rounds spent on items that end parked for non-code reasons | first Phase 2 week | half of that |
| Free slot to next start | first Phase 2 week | under 1 minute |

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- Worker and checker session start/end with provider and model, slot waits, usage waits, landing time split into sync, post-merge gate, hook and promote, and machine load at the start and end of each hook run are recorded as events.
- A 'Queue health' summary shows the listed measures on the Plan Queue page and in `plan_queue_status`, in plain language, computed from the stored events.
- The baseline numbers are recorded in this plan's as-built notes.
- Tests compute each measure from fixture events; renderer tests cover the page.
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

- [x] Step 2.1 implemented, wired, tested and verified (live check of real providers deferred, see the livetest document)
- [x] Step 2.2 implemented, wired, tested and verified (live check in the rebuilt app deferred)
- [x] Step 2.3 baseline recorded below; the comparison two weeks after Phase 5 is a future action in the livetest document
- [x] As-built notes written below

## As-built notes

Built 4 November 2026 on branch `queue/2026-11-04-pq-a5-measure-9bf437`. The programme plan was not edited.

### Step 2.1: what is recorded

All timings are new `reason` values in `plan_queue_item_events` (no new table), defined in `src/main/plan-queue/plan-queue-timings.ts` (`TIMING_REASONS`). The row keeps the item's current state in both state columns and carries a JSON payload in `detail_head`. Decision code that reads state history skips these rows (`NOT_TIMING_SQL`, applied in the history store), so a timing row can never look like a state change or push a decision event out of the window the queue reads.

| Row (`reason`) | Written by | Payload |
|---|---|---|
| `session-start` | worker spawn (`plan-queue-item-flow.ts`), checker spawn (`plan-queue-checker-spawn.ts`) | role, instance id, provider, model |
| `session-end` | `stopInstance` in `plan-queue-item-flow.ts` (via `recordSessionEnd`, looks the role up from the coordinator) | role, instance id |
| `slot-wait` | `PlanQueueSlotWaits`, driven by the scheduler (`plan-queue-pump.ts`) and the store's state-change hook (`plan-queue-store.ts`) | kind (`worker`/`check`), `waitedMs`, `freeToStartMs` |
| `usage-wait` | `PlanQueueUsageWaits` (`plan-queue-usage-wait.ts`) when a wait ends or is cleared early | kind, `waitedMs` |
| `landing-timing` | `LandingTimer` through `plan-queue-item-landing.ts`, `plan-queue-landing.ts`, `plan-queue-squash.ts` | outcome, `syncMs`, `mergeCheckMs`, `commitCheckMs`, `publishMs`, `totalMs`, `loadStart`, `loadEnd` |

- "Hook" is the repository's pre-commit check (`commitCheck`). The machine's 1-minute load average (`os.loadavg()[0]`) is read at the start and end of that step only.
- A write failure is logged and swallowed (`recordTiming`, `recordSessionEnd`): measuring never parks or stalls an item.
- Slot waits are held in memory until the item starts; a wait in progress when the app stops is lost (nothing depends on it). An item counts as waiting only while the scheduler had it ready and every slot was taken, because every item exists from the start of a run.

### Step 2.2: Queue health

- Computation: `src/main/plan-queue/plan-queue-health.ts` (`readQueueHealth` reads the rows for the last 14 days, `computeQueueHealth` is pure). Counting rules are in the file header. Only finished attempts (landed or parked) count; skipped documents are excluded.
- Words: `src/shared/utils/plan-queue-health-lines.ts` is the single source of the nine labelled lines, used by both the page and the status tool so they never differ.
- Page: `plan-queue-health.component.*` shown on the Now tab of `plan-queue-page.component`, with a Refresh button; data comes through the contracts schema `PlanQueueHealth`, the IPC handler and `plan-queue.store.ts`. Lines with nothing measured yet read "Nothing measured yet".
- `plan_queue_status`: gains one compact `queueHealth` object (heading plus nine short lines, once for the whole queue, not per run), so the output does not grow with the number of runs.
> Earlier journal sections moved to `2026-11-04-pq-a5-measure_plan_history_c140b45082584b9765b1970a6b6ff15defdb1f2e65b2db48ce7edf090e4f96c8_completed.md`.
