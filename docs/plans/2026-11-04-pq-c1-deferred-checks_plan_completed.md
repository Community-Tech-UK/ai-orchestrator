# Plan Queue programme: deferred checks, finding kinds and a passed plan always closed — implementation plan

**Status:** Draft, written 4 November 2026 as one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md). Implemented 8 November 2026 on the queue branch; the real-provider live check is deferred to [the livetest document](2026-11-04-pq-c1-deferred-checks_plan_livetest.md) (see As-built notes).

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Design → What the checker judges
- Design → Workers report completion
- Phases → Phase 5 (step 5.2)
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

Depends on the 'workers report completion' plan having landed (`docs/plans/*pq-b3-report-ready*`): check that it has before starting; if it has not, park and say so. The stricter rule 'a passed plan is always closed' must ship together with the deferred-check way out, never before. Replay stored PASS verdicts that have `needJames` entries in tests. Update `PARK_REASON_HELP`, the Zod schema and the MCP tool's input schema together; stored verdicts without a `kind` read as `code`.

## Steps (copied verbatim from the programme plan)

- [ ] 5.2 **Deferred checks, finding kinds, and a passed plan always closed.** These ship together, so the stricter
  rule never arrives before its way out.
  - The verdict changes in "What the checker judges".
  - `reportVerdict` refuses PASS with `document_complete: false` for `plans` runs. The refusal tells the checker to
    FAIL with findings, or to list deferred checks and close (`plan-queue-coordinator.ts:540-553`).
  - The example JSON in `buildVerifierPrompt` becomes kind-specific (`plan-queue-prompts.ts:265-272`). Livetests
    keep their meaning.
  - The new park reasons and help text; the markdown `_livetest.md` checked against `deferredChecks`.
  - Tests for each path, including one replaying stored PASS verdicts that have `needJames` entries. M.

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- PASS with deferred checks lands and closes the document; more than half deferred parks `needs-james`.
- Every finding has a kind (`code`, `environment`, `needs-human`); a FAIL whose findings are all `environment` or `needs-human` starts no new worker round and parks with the new reason.
- `reportVerdict` refuses PASS with `document_complete: false` for plans runs, with a message that tells the checker what to do instead.
- A test replays stored PASS verdicts with `needJames` entries.
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

- [x] Step 5.2 implemented, wired, tested and verified in the repository (the real-provider live check is deferred, see below)
- [x] As-built notes written below

## As-built notes

**Implemented 8 November 2026** (paths in the queue worktree). The prerequisite, step 5.1 (`pq-b3-report-ready`), had landed: its plan is `_completed` and `plan_queue_report_ready`, `workerReport` and `PlanQueueWorkerReport` are in the code. The programme plan was not edited.

What was built:

- **Finding kinds** (`packages/contracts/src/schemas/plan-queue.schemas.ts`): `PlanQueueFindingKindSchema` (`code`, `environment`, `needs-human`) and an optional `kind` plus `missing` on `PlanQueueFindingSchema`. `kind` is optional in the type because stored verdicts have none: every reader goes through `findingKind()` (absent reads as `code`), and `PlanQueueItemFlow.recordVerdict` stores `code` on any finding the checker left without one, so every newly stored finding has a kind. The MCP `inputSchema` (`src/main/mcp/plan-queue-tools.ts`), the Zod schema and `PARK_REASON_HELP` changed together. Descriptions were kept short because `tool-schema-budgets.spec.ts` (75,776 bytes for the full set) left about 1 KB of room; the ceiling was not raised.
- **Verdict fields**: `deferredChecks` (title and why, optional) and `criteriaTotal` on the verdict and as `deferred_checks` and `criteria_total` on the tool's arguments. The deferral share needs a denominator the programme plan did not name, so the checker states how many criteria it judged.
- **New module** `src/main/plan-queue/plan-queue-deferred-checks.ts` (kept out of the coordinator and flow, which are at their line ceilings): `findingKind`, `refuseUnclosedPlanPass`, `refuseInconsistentVerdict`, `parkingForFailure`, `parkingForDeferrals`, `deferredPassProblems`, `livetestPathsFor`. Its prompt half is `plan-queue-verdict-prompts.ts`.
- **`reportVerdict` refuses PASS with `document_complete: false` for a `plans` run** (`refuseUnclosedPlanPass`, called from `PlanQueueItemFlow.recordVerdict`, which `PlanQueueCoordinator.reportVerdict` calls, so the coordinator file did not grow). The error text tells the checker to FAIL with findings, or to list deferred checks and close. It also refuses a non-code finding with no `missing`, and `deferred_checks` without a `criteria_total` that covers them (`refuseInconsistentVerdict`). Livetest runs are untouched: PASS with `document_complete: false` and `need_james` still work.
- **Finding-kind parking** (`finishVerification` in `plan-queue-item-flow.ts`): after the verdict is recorded, a FAIL with findings none of which is `code` parks without a worker round: `needs-james` if any finding is `needs-human`, otherwise `needs-setup`. The note names each missing thing. Any `code` finding keeps the normal fix round, and the fix prompt marks the other findings ("environment: needs X") and tells the worker not to work around them. A FAIL with no findings is judged as before.
> Earlier journal sections moved to `2026-11-04-pq-c1-deferred-checks_plan_history_f41d41a0415b50a8f4fb01c8d64c8750c18bd3267fb91782fc927e09458a0c3e_completed.md`.
