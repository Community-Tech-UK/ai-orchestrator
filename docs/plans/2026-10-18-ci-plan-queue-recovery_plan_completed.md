# CI Plan Queue recovery repair

Status: implemented and independently verified. Request: repair the failed CI
run for main at 81755b3. Changes remain uncommitted and unpushed.

## Evidence and scope

The GitHub run 39113817400 failed only its shard 2/4 test assertion in
`plan-queue-coordinator.spec.ts`: a completed replacement should retire a
recovered queued item without starting a worker. Logs are retained at
`_scratch/ci-39113817400-failed.log`. The focused test and its full file pass
locally. Investigation found that `_whenSettledForTesting()` silently returns
after 20 immediate callbacks even if the filesystem-backed scheduler is busy.
The restart fixture then mutates queue state while the old scheduler can run.

## Implementation and checks

- [x] Reproduce premature settlement with a controlled delayed scheduler pass.
- [x] Make the existing settlement helper wait for actual quiescence; preserve
      the restart/teardown fixture's explicit timeout for intentionally hung work.
- [x] Keep the original completed-document and no-worker assertions unchanged.
- [x] Verify the regression, coordinator file, type checks, lint, source size
      ratchet, main build, renderer build and full quiet test suite.
- [x] Obtain a fresh independent task-completion-gate PASS; close this plan last.

Risk: settlement can now reveal genuinely unfinished work instead of concealing
it. Review restart and teardown timeout callers and scheduler follow-up passes.
No branches, worktrees, commits, pushes, dependencies or user-document changes
are part of this repair. Browser/UI checks do not apply to this test setup fix.

## Implementation evidence

The controlled regression failed before the fix (`expected true to be false`)
in `_scratch/test-run.pid-60816.log`. The regression and original recovery
case then passed together in `_scratch/test-run.pid-61384.log`.
The helper now yields briefly before draining item operations and checks
scheduler inactivity without an arbitrary iteration cap. Restart and teardown
retain their explicit outer timeouts for intentionally hung landing fixtures.
The change affects a test-only helper, not production recovery decisions.

## Verification

- Coordinator file: 101 tests passed; `_scratch/test-run.pid-62777.log`.
- Full default suite: 2,615 files, 33,338 tests passed, seven pre-existing
  skips, exit 0; `_scratch/test-run.pid-77485.log` and matching JSON report.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`:
  all exit 0; individual logs and command results in
  `_scratch/ci-recovery-verification/`.
- Independent completion review: `VERDICT: PASS`, no actionable findings.
  The fresh reviewer independently repeated all seven canonical checks. The
  full suite ran with `AIO_TEST_NO_CACHE=1`: 2,615 files and 33,338 tests passed,
  seven existing skips, exit 0. Evidence:
  `_scratch/ci-recovery-verification/review-assessment.json`,
  `_scratch/ci-recovery-verification/review-full-tests-no-cache.log`, and
  `_scratch/test-results.pid-93684.json`.
- The reviewer preserved the shared dependency installation rather than
  running a fresh install; `npm ls` passed and installed-lock package versions
  matched the committed lockfile. No dependency manifests were changed.
- No live application checks are deferred because no user-facing runtime
  behavior changed. GitHub itself will require a future authorized commit/push
  before it can test this repair.
