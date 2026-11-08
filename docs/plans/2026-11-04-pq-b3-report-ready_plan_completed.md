# Plan Queue programme: workers report completion — implementation plan

**Status:** Draft, written 4 November 2026 as one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md). It is queued as its own job. Implemented 5 November 2026 on the queue branch; the per-provider live check is deferred to [the livetest document](2026-11-04-pq-b3-report-ready_livetest.md) (see As-built notes).

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Design → Workers report completion
- Phases → Phase 5 (step 5.1)
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

Follow the checker's existing verdict tool and reminder turns (`plan-queue-verifier-reminder.ts`, `VERDICT_DISCOVERY_STEPS`) closely. The report becomes required one provider at a time: keep a short list in code of providers whose live check has passed; others keep today's turn-end signal. The per-provider live check cannot run here: write it as a `_livetest.md` beside this plan (header, steps, expected result, why it cannot run now) and do not claim it verified. New worker-report storage needs a migration (`worker_report_json`): take the next free version after checking the real migration files.

## Steps (copied verbatim from the programme plan)

- [ ] 5.1 **Workers report completion** with `plan_queue_report_ready`, as in the Design section.
  - Tool, schema, reminder turns, and changes to the worker, fix and step-up prompts. The report is shown on the
    item row.
  - Files: `src/main/mcp/plan-queue-tools.ts`, `plan-queue-coordinator.ts`, `plan-queue-item-flow.ts`,
    `plan-queue-prompts.ts`, contracts schemas.
  - Tests: only the item's worker may report; a turn that ends without a report gets reminders; a background job
    still running at turn end is reminded, not checked; a fix round doesn't reuse the last report.
  - Rollout: the evidence that providers can call such a tool covers checker providers only. So the report becomes
    required one provider at a time: a short list in code names the providers whose live check has passed. Other
    providers keep today's turn-end signal until they pass. Phase 5 can't be closed while a provider in James's
    saved worker routing is still off the list, unless James decides. After that, providers off the list are
    refused as workers, so the old signal doesn't stay for good.
  - Live check: each provider used as a worker calls the tool. M.

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- Tool, schema and reminder turns exist; the stored report is cleared at the start of every worker turn.
- Tests: only the item's worker may report; a turn that ends without a report gets reminders; a background job still running at turn end is reminded, not checked; a fix round does not reuse the last report.
- The report is shown on the item row.
- A `_livetest.md` records the per-provider live check.
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

- [x] Step 5.1 implemented, wired, tested and verified in the repository (the per-provider live check is deferred, see below)
- [x] As-built notes written below

## As-built notes

**Implemented 5 November 2026.** Migration number 043 was free in `loop-schema.ts` (the last applied was 042) and was the one the programme plan reserved for this column, so it was taken as reserved and removed from `PLAN_QUEUE_RESERVED_MIGRATIONS` (`plan-queue-migrations.ts`). The programme plan was not edited.

What was built (paths in the worktree):

- **Schema** (`packages/contracts/src/schemas/plan-queue.schemas.ts`): `PlanQueueWorkerReportSchema` (`summary`, `asBuilt`, `checksRun[]`, `deferredChecks[]` with `title`/`steps`/`expectedResult`/`whyDeferred`, `followUps[]`), the MCP arguments schema `PlanQueueReportReadyArgsSchema` (snake_case at the top level like the other tools, all fields required, `[]` when none), and `workerReport` on the item DTO.
- **Storage**: `worker_report_json` column (migration `043_plan_queue_item_worker_report`, `LOOP_SCHEMA_VERSION` 43); `workerReport?: PlanQueueWorkerReport | null` on `PlanQueueItem`; read and written in `plan-queue-store.ts`; sent to the panel by `itemToDto`.
- **Tool** (`src/main/mcp/plan-queue-tools.ts`, `plan-queue-tool-operations.ts`): `plan_queue_report_ready`, visible to queue-spawned instances like the other role tools, handled by `PlanQueueCoordinator.reportReady` → `recordWorkerReport` in the new `plan-queue-worker-report.ts`. Only the item's current worker (`item.workerInstanceId === caller`) may report, and only while the item is `working` or `fixing`; a verifier, the parent, another item's worker or a late report is refused.
- **Clearing**: the stored report is cleared at the start of every worker turn: `runWorkerTurn` (fix rounds, conflict and gate returns, answering a question) and `spawnWorker` (first start, respawn, crash recovery, Resume, step-up). The transient-failure retry nudge (`plan-queue-turn-retry.ts`) is a continuation of the same turn and does not clear it.
- **Reminders** (`PlanQueueWorkerReports.afterTurn`, called from `PlanQueueItemFlow.onWorkerOutcome` after the Pause check): a clean turn end with no report sends up to two reminder turns in the same session (`MAX_WORKER_REMINDERS = 2`, allowance renewed each turn); after that it becomes a `failed` outcome ("the worker ended its turn without reporting its work ready, after 2 reminders") and so parks `worker-error` through the existing failed-turn path. That failure text is not a transient one, so the retry rule of `isTransientQueueTurnFailure` does not apply to it. A worker whose background job is still running at turn end has no report, so it is reminded (the reminder carries the wait-for-background-commands rule) and is not sent to checking.
- **Prompts** (`plan-queue-prompts.ts`, new `plan-queue-report-prompts.ts`): the plan and livetest worker prompts, fix, step-up, conflict, gate-failure and active-documents prompts now end with the report instead of "your turn ending is the signal". Tool discovery is one shared function (`toolDiscoverySteps`) used by both the verdict tool's steps (unchanged text) and the report tool's.
> Earlier journal sections moved to `2026-11-04-pq-b3-report-ready_plan_history_da825bb16ac1b5425e47024f8b04f715ace354a40fcddc707e9376cbf1a1e589_completed.md`.
