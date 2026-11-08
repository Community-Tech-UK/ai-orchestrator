# Plan Queue programme: step up only for code problems — implementation plan

**Status:** Draft, written 4 November 2026 as one slice of the programme plan [2026-11-03-plan-queue-autonomy-and-linear_plan.md](2026-11-03-plan-queue-autonomy-and-linear_plan.md). It is queued as its own job. Implemented 8 November 2026; awaiting independent verification.

## Goal

Implement the step(s) below, exactly as the programme plan specifies, so a fresh verifier can judge them against the acceptance criteria.

## Read first

- `AGENTS.md`, `docs/architecture.md`, `docs/testing.md`, `docs/decisions/rejected/` (do not re-propose anything rejected there).
- The programme plan, 2026-11-03-plan-queue-autonomy-and-linear_plan.md, sections:
- Phases → Phase 5 (step 5.4)
- That plan marks itself `Queue: not an item`: **do not edit it**. Record what you build in this plan's "As-built notes".
- Line numbers and file names in the programme plan are from 3 November 2026. Phase C and other work have landed since: re-check every one against the code before relying on it.

## Current state and cautions

Depends on the 'deferred checks and finding kinds' plan having landed (`docs/plans/*pq-c1-deferred-checks*`): check that it has before starting; if not, park and say so.

## Steps (copied verbatim from the programme plan)

- [x] 5.4 **Step up only for code problems.** A stronger worker is used only when the last findings include `code`
  findings; otherwise the item parks under 5.2. Test. S.

## Rules for this job

- Do only the step(s) above. Other steps belong to other plans. Do not take out already-committed planning files from git (step 1.10 needs James's go-ahead).
- Read every file you change whole, with its callers and tests, before editing. Reproduce before fixing. Put new logic in new modules where a file is at its line limit (`npm run check:ts-max-loc`).
- Add a crash-window test and a mutation check (remove the guard, confirm a test fails) for each new state change or guard, as the programme plan's "Verification for every phase" requires.
- Any text a user can see follows `docs/screen-and-wording-guide.md`; Angular code follows `docs/angular-conventions.md`.
- Do not commit, push, create branches or worktrees, or install packages. A check that genuinely needs a rebuilt or restarted app, a human or an external service goes into a `_livetest.md` beside this plan, following AGENTS.md's Live-Test Deferral rules; everything else is verified here.
- Never put secrets or realistic secret-like values in files, tests or logs.

## Acceptance criteria

- A stronger worker is used only when the last findings include `code` findings; otherwise the item parks under 5.2's reasons.
- A test covers both cases.
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

- [x] Step 5.4 implemented, wired, tested and verified (worker's gates below; verifier still to confirm)
- [x] As-built notes written below

## As-built notes

Dependency check: the 'deferred checks and finding kinds' plan (pq-c1) had landed (`plan-queue-deferred-checks.ts`, `findingKind`, `parkingForFailure` are on the base branch).

What changed (all in the worktree, nothing committed):

- `src/main/plan-queue/plan-queue-step-up.ts`: `canStepUp(run, item, verdict)` now also needs the last verdict to list at least one `code` finding (`findingKind`, so a stored finding with no `kind` counts as code). Header comment updated.
- `src/main/plan-queue/plan-queue-item-flow.ts`: the one call site (round limit) passes the verdict.
- How the "otherwise it parks under 5.2" half works: a FAIL whose findings are all `environment`/`needs-human` is already set aside as `needs-setup`/`needs-james` by `parkingForFailure` before the round limit is reached, so it never gets to the step-up check. The case the new guard actually changes is a FAIL with **no findings at all**: it used to be handed to the stronger worker and now parks as `round-limit` ("no findings listed"). Mixed verdicts (a code finding plus other kinds) still step up.
- Tests: new `plan-queue-step-up.spec.ts` (unit: code, kindless, mixed, empty, non-code only, no step-up choice, already stepped up); three coordinator tests in the step-up describe (empty findings parks with no stronger worker and no handover message; environment-only parks as `needs-setup`; code among other kinds still steps up and lands). One existing test ('clears the former conversation before handing work to the step-up worker') failed a FAIL with `findings: []` and expected a handover; its fixture now gives a code finding, since an empty-findings handover is exactly what 5.4 removes.
- Mutation check: removing the `code` finding condition from `canStepUp` fails the unit test and the empty-findings coordinator test; guard restored. (The environment-only coordinator test is not sensitive to that mutation because `parkingForFailure` parks first; it guards the ordering, not the new condition.)
- Crash window: no new state or persisted field was added (`steppedUpAt` and its recovery are unchanged and keep their existing restart tests), so there is no new crash window to test.
- Verification run in the worktree: targeted plan-queue specs (9 files, 345 tests) pass; `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer) all pass (ran on the Windows PC). The full `npm run test:quiet` was not run (verifier's job).
- Programme plan not edited. No live checks deferred; no `_livetest.md`.
