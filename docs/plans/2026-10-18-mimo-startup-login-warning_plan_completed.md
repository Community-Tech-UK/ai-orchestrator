# MiMo startup login warning repair

Status: implemented and independently verified. The installed-app startup observation remains a deferred live check. Request: investigate and fix ComTechSpare being reported as missing at startup despite its saved login subsequently working.

Goal: reserve sign-in warnings for evidence that sign-in is required; recover automatically from brief secure-storage readiness failures without changing account identity or weakening credential protections.

Architecture: keep the existing saved-session store, per-account reader, quota probe, notifications and renderer wiring. Classify credential-read and session-renewal failures at the probe boundary. Do not alter account presence checks or fall back to another login.

## Evidence and limits

- Both encrypted saved records exist. Read-only HTTPS requests using ComTechSpare's record returned usage/detail HTTP 200, API code 0, Max plan. No credentials were printed or changed.
- The startup warning itself was not retained in the available logs; startup timing is not proven as the original trigger.
- Code defects to reproduce: saved-reader `denied` failures unconditionally become `needsReauth`; failed/skipped renewal and transport failures after renewal likewise become expired-login warnings.
- Existing Accounts-page presence check uses file presence, independently of decryption, and should remain unchanged.

## Implementation and verification

- [x] Reproduce false sign-in warnings through production store/reader/probe using synthetic temporary sessions and bounded injected failures; retain red evidence under `_scratch/mimo-startup-warning/`. Synthetic storage uses an explicitly test-only codec; live verification uses an encrypted temporary copy.
- [x] Retry a saved credential read only when secure storage is temporarily denied, with bounded delay and caller cancellation/current-connection checks. Persistent denied/unsupported reads show a storage/access message without requesting sign-in; absent/corrupt records still require repair/sign-in.
- [x] Distinguish incomplete/skipped/failed renewal and retry transport/server/shape errors from confirmed authentication rejection. Preserve successful-renewal persistence rules and account isolation.
- [x] Verify the production path before updating existing tests; add regressions for recovery, persistent denial, cancellation, missing/corrupt sessions, renewal timeout/throttle/server failure, and confirmed rejections. Preserve existing test strength; update only assertions whose old behavior is this reproduced defect.
- [x] Run focused tests, `npx tsc --noEmit`, `npm run typecheck:spec`, lint, max-LOC, both builds and the full quiet suite, retaining exact exit codes and logs.
- [x] Obtain a genuinely fresh `task-completion-gate` review, fix every actionable finding, and repeat fresh review until PASS.
- [x] Record any check genuinely requiring the installed app restart in a separate livetest file; close this plan only after all agent-runnable gates and independent review pass.

Deferred installed-app observation: [startup live check](2026-10-18-mimo-startup-login-warning_livetest.md).

## Constraints and review focus

- Work in the existing checkout. No branch/worktree, commit, push, install or restart of James's running app.
- Preserve unrelated dirty documentation. Never expose secrets or change actual saved logins during diagnosis.
- All interactive browser work must preflight and target `windows-pc`; no local GUI/Harness interaction. Project headless tests are permitted.
- Pay particular attention to cancellation during retry, reconnect/disconnect invalidation, retry request HTTP status and body validity, no additional remote polling, and correct sign-in guidance for genuinely missing/invalid credentials.

## Decisions and evidence ledger

- Initial: implement inline; independent investigation was read-only. No reproduction proves the historical startup timing cause, so completion claims must distinguish the repaired failure paths from an observed replay of that exact event.
- Runtime red reproduction exits 1 in `before.log`: existing saved login with storage denied and renewal followed by request timeout both emit false `needsReauth: true`. Fixed reproduction exits 0 in `after-final.log` with storage/retry guidance and no sign-in warning.
- The saved reader opts into exactly two delayed local re-reads (250 ms then 750 ms). Chrome reads do not opt in, preventing repeated permission prompts. Caller cancellation and reconnect/disconnect invalidate pending reads. No remote polling intervals changed.
- Final focused regression scope passes (129 tests in seven files), including per-account probe composition and quota rendering; full log `_scratch/test-run.mimo-startup-final-focused2.log`. The independently repeated MiMo slice passes 78 tests, including the unchanged renewal-persistence integration. Existing assertion changes correspond only to the reproduced incorrect auth classifications; genuine missing/corrupt credentials and post-renewal HTTP 401/403 remain explicit positive reauth tests.
- Live production probe with a disposable encrypted copy of ComTechSpare succeeds, returns Max and usage windows, and confirms original source digest unchanged: `_scratch/mimo-startup-warning/live-check.log`. No SSO rotation was allowed during that check.
- Canonical static checks and both builds exit 0, including the final saved-storage-only retry capability: `_scratch/mimo-startup-warning/verification-pinned.json`. The independent clean-install review repeats these gates successfully.
- Browser Gateway preflight confirms `windows-pc` healthy. The synthetic production-component preview could not load over the Mac's LAN service (local loopback works, LAN reads reset). Remote `run_on_node` refused the server setup twice with the existing/shared-browser routing error, despite shell-only intent. No Mac browser was used. James has a pending choice to record the visual check as pending or authorise a Mac browser for this task. Temporary local servers were stopped; two synthetic fixture files were staged in the worker scratch transfer directory, with no credentials.
- A third, purely shell server request was understood correctly by routing but refused because the remote default Claude session cannot enforce the inherited machine/review policy. No remote process was started.
- Production Angular component and actual signal store verified in a separate headless DOM smoke using synthetic production-probe snapshots: denied and interrupted states show ordinary status text, healthy state shows usage, missing credentials show the sign-in control. `_scratch/mimo-startup-warning/dom-smoke.log` exits 0. This opens no local browser or GUI.
- Initial full suite completed with two failures, both SEA executable packaging tests: Homebrew Node 26 lacks the required SEA fuse. `.nvmrc` pins v24.15.0, already installed locally. Both packaging tests pass unchanged under that binary (`_scratch/test-run.mimo-startup-pinned-packaging.log`). The initial full run is not a PASS.
- The second full suite, under pinned Node with automatic eight-worker sizing, completed with one unchanged session-metadata test timing out. Its whole file then passed unchanged in isolation; `_scratch/test-run.mimo-startup-recovery-timeout-check.log`. This run is also not counted as a PASS.
- Final independent unfiltered full suite exits 0 under pinned Node v24.15.0, four supported workers and cache disabled: 2,617 files pass, 33,396 tests pass, seven pre-existing skips, zero failed tests/suites or unhandled errors. Actual exit and structured results are `_scratch/mimo-startup-warning/fresh-gate-1/checkout-suite-results.json` and `full-suite-summary.json`; raw results/logs are retained beside them. The previously timed-out suite and both packaging tests pass unchanged.
- Independent `task-completion-gate` returns `VERDICT: PASS`, no unresolved actionable findings: `_scratch/mimo-startup-warning/fresh-gate-1/final-report.txt`. Exact install, typechecks, lint, max-LOC and builds ran in a clean metadata-free export. Existing real-repository watcher tests require the authorised Git checkout; the final full suite ran there only after byte parity of source, configuration, installed dependency metadata and native binaries was established. The interrupted export attempt and metadata-dependent max-LOC diagnostic are retained and not counted as passing runs. No Git metadata/worktree was created.
- Reviewer independently reproduced the old bug, repeated fixed production behavior and actual component/store DOM checks, and checked final-attempt recovery, single Chrome reads and reconnect during real renewal. Expanded session-security/state review found no task-introduced issue. Parent re-read final report, actual runner exit and full JSON, and confirmed all seven source/spec hashes remain unchanged. Review export removed; branches/worktrees and HEAD unchanged; nothing staged, committed or pushed.
