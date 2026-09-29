# Plan Queue relaxed-worker audit wait

Status: implemented and verified. Request: fix the reported test failure,
commit and push.

## Scope and cause

`src/main/plan-queue/plan-queue-coordinator.spec.ts` waits for a second run's
worker audit using Vitest's default one-second `vi.waitFor` timeout. Startup
passes through triage, real Git worktree creation and worker creation. A delayed
startup can exhaust that timeout despite correct relaxation and audit behavior.
Keep the existing condition and every behavior assertion; allow ten seconds for
the asynchronous audit, within the enclosing thirty-second test budget.

The timeout change appeared from a concurrent session during investigation.
Review and verify it before adopting it. Preserve unrelated staged/unstaged
work; use the existing checkout and branch, and commit only the scoped paths.

## Verification and delivery

- [x] Reproduce the original failure using a disposable copy with a 1.25-second
  delay before beta worker creation. Remove the copy after execution.
- [x] Run the same delayed-start case with the ten-second wait and confirm all
  audit, handoff and restoration assertions pass.
- [x] Run the coordinator spec (38 passed).
- [x] Run the uncached full suite using pinned Node v24.15.0.
- [x] Run main/spec typechecks, lint, maximum-line check and both production builds.
- [x] Obtain a fresh `task-completion-gate` agent verdict with no actionable findings.
- [x] Record evidence and close this plan after the independent verdict.

Delivery after verification: commit scoped paths and push to origin/main.

## Risks and review focus

The extra wait must not remove assertions, hide a missing audit, or change
production settings behavior. Delays beyond the bounded budget still fail.
Existing staged work must remain staged and must not enter this commit. Hooks
may generate assets; inspect the resulting commit paths and preserve the original
index entries. No UI surface or production code changes are required.

## Evidence

Investigation logs: `_scratch/plan-queue-failure-investigation/`.
The full coordinator spec passed 38 tests before adoption; the original default
wait reproduced `sharing run not audited yet` under delayed worker creation.
The same delayed-start case passed with the bounded ten-second wait. The
disposable source copies were removed on both the failing and passing paths.

Initial uncached full run: 26,992 passed, six skipped, two SEA build failures.
The failing cases were `scripts/__tests__/sea-build-repeatability.spec.ts` for
AIO MCP and loop control. Homebrew Node v26.3.0 lacks the SEA fuse; the installed
pinned Node v24.15.0 contains it. Rerun with the pinned binary before completion.

The pinned rerun completed all assertions: 2,259 files, 26,994 passed, six
skipped, zero failed. Its nested RTK wrapper did not return despite the quiet
runner PID having exited; that wrapper was terminated (exit 130). Treat this
as assertion evidence only. A fresh independent direct-subprocess full run
must supply the authoritative exit status.

The six canonical non-test gates all exited zero; retained command logs and
statuses are in `_scratch/plan-queue-failure-investigation/gates.json`.

Authoritative independent full suite: exit 0, 2,259 files, 26,994 passed, six
existing skips, zero failures or unhandled errors, 271.55 seconds. Evidence:
`_scratch/plan-queue-failure-investigation/independent-full-suite-result.json`,
`independent-full-suite.log`, and `_scratch/test-run.pid-57985.log`.
Independent focused reported case: exit 0, one passed, raw log
`_scratch/test-run.pid-91648.log`. All 38 coordinator cases passed in the full run.

Fresh independent review returned `VERDICT: PASS`, no actionable findings;
report: `_scratch/plan-queue-failure-investigation/independent-completion-review.md`.
All 170 existing test assertions remain unchanged. No production code, UI,
dependency or configuration changes were required. No live checks are deferred.

Commit scope is the single timeout line and this completed plan. The task-specific
index and scoped hook preserve unrelated staged entries and generated working
files while executing the original repository pre-commit checks. Delivery uses
the normal pre-push hook and a temporary SSH-over-443 command override; a remote
read confirmed connectivity and the expected base HEAD after SSH port 22 timed out.
