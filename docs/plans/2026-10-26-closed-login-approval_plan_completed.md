# Closed sign-in tab approval repair

Status: ready for independent queue verification (31 October 2026); installed-app
validation remains pending. This document remains active and untracked. The
repair source was already included in James's `October updates` commit. The
queue worker made no new source changes and did not commit or push.

## Evidence and cause

The reported approval's audit contains a failed live snapshot with Chrome's
`No tab with id` response, followed by repeated `target_unavailable` decisions.
The approval remains pending. Approval cannot succeed against that closed tab.

## Required work

- Distinguish a confirmed closed tab from a temporary connection/read failure.
- Expire a closed-tab approval without creating permission; notify the owner using
  the existing expired-request resume path so it can request access on a fresh tab.
- Explain the closed-tab failure in plain language.
- Verify closure before and during approval, retry on a new target, temporary
  failures remaining pending, and existing secure-fill restrictions.
- Run the canonical checks and an independent task-completion-gate review.

## Limits

Keep request-time and fill-time live checks. Do not approve the reported login,
change the vault, restart the user's app, commit, or touch unrelated changes.

## Verification in progress

- Initial regression reproduced: four new assertions failed before the repair.
- First canonical pass: type checks, lint, size/UI checks and both builds passed.
  The full suite had one timeout in the unchanged recovery metadata stress fixture;
  that file passed unchanged when rerun alone. This is not a full-suite pass.
- First fresh gate returned FAIL with two reproduced findings: aged-out worker
  suspensions could look closed, and an older vault inspection could restore an
  old target over its replacement. Both have been addressed, with additional
  runtime/store regression coverage. The gate's own full run was stopped (130)
  because the candidate needed changes; it is not counted as verification.
- Updated focused suites pass. The second canonical pass also passed typechecks,
  lint, size/UI checks and both builds. Its full suite failed in the unchanged
  native-finality deadline tests and reported an unhandled source-map parse
  error. The deadline spec passed unchanged in isolation. Evidence:
  `_scratch/closed-login-verification-round2/results.json`.
- A second fresh reviewer found no actionable issue in the repair, but returned
  FAIL because its full run failed a concurrently edited, unrelated plan-queue
  assertion and reported the source-map error. The isolated plan-queue rerun
  passed, which does not erase the full-run failure. Evidence:
  `_scratch/closed-login-final-gate-report.md`.
- An isolated snapshot of committed baseline plus the exact eight-file repair
  passed all seven non-test canonical gates and five focused suites. Its full
  run was interrupted before a result was recorded; it is not a pass. Evidence:
  `_scratch/closed-login-isolated-evidence/results.json`.
- The next fresh reviewer completed one full run in that fixed snapshot: exit 1,
  three failures in files outside the repair. Queue retirement expected a verifier
  instance but received null (`plan-queue-retirement-control.spec.ts:397`);
  scratch-sweep's submodule-preservation test and continuity recovery's large
  metadata fixture exceeded their existing timeouts. Their causes have not been
  established through differential baseline reproduction. No test expectations,
  timeouts or runner settings were changed to hide them. This run had no reported
  unhandled errors; the earlier source-map error did not recur.
- The reviewer found no actionable issue in the repair, and its runtime, service,
  wording and adjacent secure-fill tests passed within that full run. Nevertheless
  the required verdict is FAIL because full verification did not pass. Evidence:
  `_scratch/closed-login-isolated-gate-report.md`,
  `_scratch/closed-login-isolated-evidence/resume-full-result.json`,
  `_scratch/closed-login-isolated-evidence/full-suite.log` and `full-suite.json`.
- No plan closure until an independent gate returns PASS. Do not change unrelated
  tests, test configuration or dependencies to obtain that result.
- Installed-app validation is separately recorded in
  [the live check](2026-10-26-closed-login-approval_livetest.md).

## Queue worker as-built verification (27 October 2026)

The supplied queue branch already contains the eight-file repair. Direct source
inspection confirmed closed-tab classification in the live credential runtime,
expiry without authorization/grant creation in the approval service, replacement
target checks at asynchronous boundaries, and the existing owner-resume notifier
through the browser IPC handlers. Temporary outages and stale worker suspensions
remain retryable. The plain-language recovery messages are present. No linked
spec is named in this plan; the existing adjacent live-check document supplies
the remaining installed-app steps.

Fresh worker checks, all exit 0:

- Focused quiet test run: seven files, 85 tests, with result caching disabled and
  external failure summaries disabled. Covers the credential runtime, approval
  service/store, secure-fill decision/fill, target registry and banner wording.
- `npx --no-install tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, and `npm run check:ui-hints`.
- `npm run build:main` and `npm run build:renderer`. The renderer build reports
  an initial-bundle budget warning (1.63 MB against the 1 MB warning threshold)
  and exits successfully; no warning threshold or build configuration changed.

Evidence is in the worker checkout at
`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-26-closed-login-approv-26dc4e/_scratch/closed-login-queue-worker-20261027/`:
`report.md`, `command-receipts.json`, `candidate-files.json`, `seal.json`, command
logs and the cleanup receipt. The quiet runner's uniquely suffixed raw log and
JSON are also retained in that checkout's `_scratch/` directory.

The queue instruction explicitly reserves the full suite and independent
`task-completion-gate` verdict for the coordinator's verifier. This worker did
not rerun the full suite, grant a PASS verdict, or resolve the earlier full-run
failures by assumption. The verifier must review the already-committed repair,
not just this worker's empty source diff. No test, runner, dependency or unrelated
source was changed to obtain passing worker checks. The current app, browser,
vault and reported approval were not operated or changed. Installed-app testing
remains deferred under the existing live-check document and this plan's limits.

## Queue worker as-built verification (31 October 2026)

The newly supplied queue checkout also already contains the repair. This worker
read the root plan and its live-check document directly, checked the approval
delegation, live-target classification, pending-only persistence updates,
replacement-target protection, owner notification wiring and secure-fill
restrictions, and found no additional implementation change required. No linked
spec is named; a targeted filename search found only this plan and its live
check. The worker changed no source, tests, dependencies or generated interfaces.

Fresh checks all exited 0: ten focused files (110 tests), both typechecks, lint,
size/UI checks, and both builds. Focused result caching and external failure
summaries were disabled. The renderer build retains its initial-bundle warning
(1.64 MB against the 1 MB warning threshold); build settings were not changed.
Source/configuration digests matched before and after the commands and the
tracked checkout remained clean. No generator inputs changed; the normal
main-build protocol refresh and distribution/preload generation ran successfully.

Current evidence is in
`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-26-closed-login-approv-a9f8f6/_scratch/closed-login-queue-worker-20261031/`:
`report.md`, `command-receipts.json`, `candidate-files.json`, `seal.json`, command
logs and `cleanup-receipt.json`. The focused runner's complete raw log and JSON
use the `closed-login-worker-20261031` suffix in that checkout's `_scratch/`.
Temporary build output and local compile caches are removed after the evidence
is recorded; the supplied dependency install is retained for the verifier.

The full suite and independent task-completion-gate verdict remain explicitly
reserved for the coordinator's verifier by the current worker instruction. This
worker did not rerun the full suite or claim a PASS. The verifier must assess
the already-committed repair and the plan's acceptance criteria despite the
empty worker source diff. Earlier failed full runs are not treated as passing.
Installed-app validation remains open in the existing live-check document:
the plan prohibits restarting the user's app or approving the reported login,
and Harness UI interaction requires James. No browser, vault, installed app or
reported approval was operated. The plan remains active, untracked and unrenamed.

## Current checklist

- [x] Implement closed-tab expiry, retryable outage handling and replacement-tab
  protection without broadening saved-login permission.
- [x] Regression coverage, focused tests, both typechecks, lint, size/UI checks,
  both builds, and independent source/security review.
- [x] Queue worker rechecked the current source and reran focused tests and all
  seven non-test canonical gates; evidence retained for the independent verifier.
- [ ] Obtain a passing full suite and an independent `VERDICT: PASS`.
- [ ] Validate the rebuilt/restarted app using the separate live-check document.

Implementation is saved, but verification is incomplete. Keep this plan active;
do not rename it `_completed` or claim the running app has been repaired.
