# Browser approval after chat replacement

Status: implementation and automated verification complete; installed-app check explicitly deferred to the linked livetest. No commit or branch requested.

## Goal and evidence

Allow saved-login approval to identify the current conversation after edit-and-resend replaces an older runtime. Preserve refusal when more than one eligible runtime genuinely owns the same conversation.

The production read-only approval/audit query found two Microsoft signup requests with `operationError: session_unavailable`. Continuity metadata contains three runtimes sharing their conversation identity; application logs confirm the current runtime was forked from an earlier copy. `InstanceManager.supersedeSourceAfterEditFork` retains the old instance with status `superseded` and `supersededBy`. Before this fix, the browser IPC session resolver excluded only failed/terminated instances, so the retained replacement source made `findCredentialAccessSession` ambiguous. No credentials or transport identities belong in this document.

## Implementation

- [x] Reproduce the ambiguity through production browser IPC registration and session lookup.
- [x] Exclude superseded status and replacement markers from the trusted session resolver. Keep hibernated conversations eligible and genuine duplicates ambiguous.
- [x] Verify decision notification goes only to the eligible replacement; obsolete runtimes cannot request credential access.
- [x] Run focused saved-login/IPC tests and canonical typecheck, spec typecheck, lint, maximum-file-length check, main build, renderer build, full quiet suite.
- [x] Obtain a fresh task-completion-gate review; fix findings and repeat until PASS.
- [x] Record any installed-app check requiring restart separately; close this plan only after runnable gates pass.

## Files and risks

Production change: `src/main/ipc/handlers/browser-gateway-handlers.ts`, in the shared resolver used for both caller identity and decision routing. Regression coverage: its adjacent `__tests__/browser-gateway-handlers.spec.ts` using real credential session lookup/notification and mocked Electron/agent transport boundaries. Regression risks are choosing a wrong conversation, accidentally granting obsolete instances access, and stranding hibernated sessions. No consent, origin, vault-item, computer or lifetime checks will be relaxed.

## Earlier verification attempts

- Lifecycle log confirms a predecessor entered `superseded`; the production resolver previously included that status.
- Regression RED: 4 failures in the IPC handler suite before the source change, `_scratch/test-run.pid-77152.log`.
- Focused GREEN: 4 files / 53 tests, `_scratch/test-run.pid-91922.log`.
- Typecheck, spec typecheck, lint, maximum-file-length gate, main build and renderer build exit 0; results and command logs under `_scratch/browser-approval-replaced-chat/`.
- Initial full suite: 2 packaging failures / 34,395 tests under Homebrew Node 26, which lacks the SEA fuse needed by those tests; `_scratch/test-run.pid-75437.log`. No test assertions or infrastructure were changed to suppress this.
- The failing packaging file passes both tests under the repository's pinned Node v24.15.0; `_scratch/test-run.pid-93633.log`.
- Fresh reviewer independently passed all checks through both builds, focused suites and an additional scratch-only actual approval IPC/service/SQLite/notifier integration smoke. No actionable code findings so far.
- The first independent pinned-Node full run exited 1 with five timeout/wait failures in unchanged worker-capability, Copilot performance, queue-pause and loop-throttle specs; `_scratch/browser-approval-replaced-chat/independent-full-suite.log`. All five files then passed focused (84 tests), `_scratch/browser-approval-replaced-chat/independent-failure-recheck.log`. Load after the full run was above the campaign runbook's 30 threshold. The exact full-run load/fork sample was not recorded, so the historical cause is not asserted as proven.
- The controlled two-worker pinned-Node full rerun observed a different failure in unchanged `plan-queue-retirement-control.spec.ts` ("Cancel arriving during Git promotion retries a subsequent failed landed-worker stop"). That file passed the preceding pinned-Node full run. Current log: `_scratch/test-run.pid-72681.log`. The owned run was interrupted with exit 130 after the observed failure; it is partial/aborted, never a passing full suite. The quiet runner was absent afterward and its raw log was closed and stopped changing. Full descendant enumeration was unavailable because `/bin/ps` was denied; no unrelated process was touched. No tests, timeouts or runner configuration source were altered.
- At that earlier review, independent code inspection and integration smoke found no actionable defect in the task diff, but the full-suite verification gate was not green. The plan therefore stayed active and that review remains FAIL. No queue/worker changes were made for this approval fix.
- Installed-app consent check: [pending live check](2026-10-21-browser-approval-replaced-chat_livetest.md). This requires the updated installed main process and James's visible approval click, not another agent-runnable test.

## Resumed verification — 2026-10-21

- The implementation and regression-test diff were unchanged on resume. No assertions, timeouts or test/configuration source were altered.
- Starting load was 8.81 / 8.08 / 5.65. The targeted run combined all approval files and every previously failing file, including packaging and queue retirement; its JSON report records success with 165 passed and zero failed (`_scratch/test-results.pid-65410.json`).
- All seven canonical gates now passed under pinned Node v24.15.0, with exact exit codes recorded in `_scratch/browser-approval-replaced-chat/resume/results.json`. The full unfiltered run used two workers, exited 0, and reports 2,697 files / 34,388 passed / zero failed / seven existing skipped tests. Raw log: `_scratch/test-run.pid-98227.log`; structured report: matching `test-results` JSON. Earlier red/aborted evidence above remains historical, not a current passing claim for those attempts.
- The renewed independent review completed typechecks, lint, both builds, security/diff inspection and real-service smoke successfully; its full-suite run was interrupted without a final report or JSON (`_scratch/test-run.approval-fresh-review.log`). It is not a passing full-suite claim. That reviewer context could not be resumed. The subsequent fresh review completed successfully as recorded below.

## Final independent sign-off and as-built result

- Fresh independent verdict: **PASS**, with no unresolved actionable findings. Report: `_scratch/browser-approval-replaced-chat/resume/recovered-fresh-review.md`.
- The verifier independently reran all seven canonical gates and the four-case production approval IPC/service/SQLite/notifier smoke. Every command exited 0; exact commands and logs are in `resume/recovered-results.json` beneath the same scratch evidence directory.
- Its unfiltered full suite passed 2,697 files / 34,388 tests with zero failures and seven unchanged existing skips. Raw log: `_scratch/test-run.approval-recovered-review.log`; structured report: `_scratch/test-results.approval-recovered-review.json`, `success: true`. Both task source hashes matched the reviewed baseline afterward.
- As built, the shared trusted session resolver excludes both superseded status and replacement markers. The current eligible conversation receives consent notifications; hibernated owners remain eligible, genuine duplicate owners remain refused, and operator/item/origin/computer/purpose/lifetime controls are unchanged.
- No source, tests, test settings or dependencies were changed during final verification. Existing-install verification preserved the dirty checkout; it is not a clean dependency-install claim. No commit, push, branch/worktree creation, app installation/restart or real account submission occurred.
- Deferred installed-app validation: [pending live check](2026-10-21-browser-approval-replaced-chat_livetest.md). This closure certifies source implementation and agent-runnable verification only.
