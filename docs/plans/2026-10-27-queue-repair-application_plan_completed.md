# Apply the prepared Queue repair

Status: source repair applied, verified and independently accepted on 27 October 2026. Installed-runtime acceptance remains deferred. No commit, push, application installation or restart was performed.

Source handover: `/Users/suas/work/communitytech/_scratch/queue-repair/READOUT.md`. Prepared patch and hashes: `complete-candidate.patch` and `candidate-manifest.json` beside that handover.

## Completed source work

- [x] Read the handover and executing code, confirm checkout access, capture the dirty baseline and live Queue status, and verify all original/candidate hashes.
- [x] Apply the prepared patch to the existing checkout after `git apply --check`, preserving unrelated work. All 15 initial applied hashes matched the candidate.
- [x] Reproduce missing reporting guidance before the fix; run all Queue regressions and every canonical gate successfully on the corrected source.
- [x] Correct the first independent review's reproduced failed-stop ownership defect, observe both new regressions fail then pass, and obtain a second fresh task-completion-gate PASS with no unresolved findings.
- [x] Confirm recorded owners are unchanged and document the remaining installed-runtime checks in the live-test document without interrupting existing work.

## As built

Reviewer prompts discover Harness search/describe through provider discovery, follow the returned verdict schema/execution route and require an accepted receipt. Submission remains exclusive to the item's assigned independent verifier.

Missing or superseded owners follow their newest eligible same-conversation replacement; retained idle, sleeping and failed owners remain protected. Explicit handover is owner/panel-only, validates a non-Queue target and uses the existing parent-only persistence writer and question messenger. Requests await canonical internal delivery without holding the run-control lock across an owner's whole turn; delivery errors propagate.

Activity checks item locks and phases, assigned role/tracker ownership, in-flight stops, triage spawn/stop/retirement, and pending landed cleanup. The review correction retains failed retirement ownership separately from retryable stop promises until successful retry or confirmed disappearance. Persisted historical IDs alone do not block settled handover. Only item-flow and handover regression files differ from the prepared candidate; the final task diff and hashes record this correction.

## Verification

All commands below exited 0 using repository-pinned Node 24.22.1 and the documented CI worker cap `AIO_TEST_MAX_FORKS=2`. No diagnostic hooks were active.

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS |
| `npm run typecheck:spec` | PASS |
| `npm run lint` | PASS |
| `npm run check:ts-max-loc` | PASS |
| `npm run check:ui-hints` | PASS |
| `npm run build:main` | PASS |
| `npm run build:renderer` | PASS, existing bundle-budget warning |
| `npm run test:quiet` | PASS, 35,509 passed, 8 existing skips, zero failures; default caching |

Broader Queue regressions passed 41 files / 657 tests with cache disabled. The fresh reviewer independently ran five runtime safety probes and a secret scan, inspected actual full-suite JSON/raw receipts and confirmed final source hashes and unchanged HEAD. These are applied-checkout/source checks, not a clean-install or installed-app certification. The pre-existing dirty checkout and dependencies were retained; no separate copy or reinstall was performed.

Deferred installed-runtime acceptance: [exact prerequisites and checks](2026-10-27-queue-repair-application_livetest.md).

## Evidence and limits

Evidence directory: `_scratch/queue-repair-application-20261027/`. Final independent verdict: `fresh-gate-2/report.md`. Actual canonical exits/environment: `gates.json` and `final-gates-environment.json`; raw full suite: `_scratch/test-run.pid-9544.log` and `_scratch/test-results.pid-9544.json`. Reviewed source range: `task.diff`, `originals/`, `manifest.json`, `baseline-existence.json`, `applied-hashes.json`.

The first review FAIL, red/green regressions, interrupted run and failed diagnostic/full runs remain retained. The Homebrew Node build lacked the SEA fuse required by unchanged packaging tests; a secondary stack-formatting error hid that underlying failure. Both binaries and the executing call path were independently checked. Normal checks subsequently passed under the pinned runtime. Earlier native-finality timing failures passed in isolation; their cause remains unproved. No failed/diagnostic run was retroactively counted as a pass, and diagnostic formatting bypasses contributed no acceptance evidence.

Read-only SQLite ownership checks used `mode=ro` and explicitly checked `PRAGMA query_only=ON`; `ownership-final.json` confirms all three recorded owners unchanged at 02:48:24 UTC. Supported live tool discovery still exposes the pre-repair control schema, recorded in `live-control-description-final.json`. No live Queue mutation, ownership request, database write, application launch/restart, browser action, branch/worktree operation or commit/push occurred. Concurrent unrelated documentation changes were preserved. The task-owned verification process exited; no temporary checkout/dependency copies or diagnostic caches remain.
