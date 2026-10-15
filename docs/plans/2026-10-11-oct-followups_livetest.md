# October follow-ups: pending checks in rebuilt applications

**Status:** open. This document records only live checks for implemented changes; it does not defer missing implementation, choices, or agent-runnable gates.

**Prerequisites:** coordinator integration and rebuild of the desktop app and phone app, then restart those instances. Browser and desktop interaction must target `windows-pc` through the AIO gateway. Do not use the local Mac browser or desktop. Use a disposable project and scratch sessions, with ask-first approval enabled for permission checks. No real archive batch, data deletion, deployment, or external publication is authorized by this document.

**Owning plan:** [October follow-ups](2026-10-11-oct-followups_plan.md).

**Remediation flow:** before a campaign, read [live-test campaign runbook](livetest-campaign-runbook.md). A reproduced defect gets a new `LT-NNN` entry and implementation-status section in [remediation register](livetest-remediation-register.md). The previous [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md) is closed historical evidence; do not add work to it. Keep per-check evidence here and rename this file `_livetest_completed.md` only after all checks pass.

## 1. Desktop permission answers (3a / 6c)

- [ ] In a scratch ask-first Claude session, trigger a harmless denied Read or Write tool request in a temporary project. Refuse it and then Allow a separate harmless request. Expected: genuine refusals still raise the appropriate permission card, refusal clears the waiting prompt, explicit Allow works, and neither refusal nor an omitted-decision transport request enables Auto-approve. The omitted-decision IPC and thin-client cases are already covered by worker tests.
- [ ] Produce an ordinary tool error in the same scratch session. Expected: it appears as an error without a permission card.

Why pending: installed-CLI denial strings were source-checked and measured, and adapter/handler tests pass, but this checkout's app has not been integrated into a running desktop instance.

## 2. Startup worktree preservation (3c)

- [ ] In a disposable repository only, create an AIO-managed cancelled/failed loop with an unsaved file in its worktree, then restart the rebuilt app. Expected: the file and worktree pointer remain, branch tip does not change, and lifecycle reports `Work folder has unsaved changes; left in place`. A clean cancelled run may remove its managed directory while retaining its branch.

Why pending: real temporary-repository reconciliation tests pass; this check additionally exercises restart and persistence in the rebuilt application. The storage-card requirement remains unimplemented, not deferred here.

## 3. Phone Stop and Cancel (3e)

- [ ] Open an active scratch loop in the rebuilt phone app. Tap Stop, then Keep going. Expected: no stop command or state change. Tap Stop and confirm. Expected: exactly one stop request.
- [ ] Repeat for an active plan queue run using Cancel. Expected: first tap only opens the confirmation, Keep going sends nothing, confirmed Cancel sends exactly one request.

Why pending: two Angular DOM behavior tests and phone typecheck, lint and production build pass; the rebuilt application has not been installed on a device. Do not stop a real queue run for this test.

## 4. Optional findings (4c)

- [ ] Run a disposable plan queue item whose verifier returns PASS with a low-severity suggestion. Expected: the item can proceed and the suggestion appears in the optional details. A FAIL containing both high and low findings sends only the high finding to the next fix prompt; the saved report retains both.

Why pending: orchestration-host and renderer tests cover these branches, but a rebuilt queue worker session is needed to observe the provider transcript and screen together.

## 5. Context occupancy (6b)

- [ ] Run a scratch Claude session with a helper. Compare the parent context ring before, during and after the helper's usage frame. Expected: helper usage does not replace parent occupancy; a subsequent parent assistant frame still refreshes occupancy and result cost still appears.

Why pending: frame-level regressions pass; the ring belongs to the restarted desktop app.

## 6. Attachment controls (7a)

- [ ] On the rebuilt composer, select Gemini, Antigravity and a local-model runtime in turn. Expected: Attach explains why it is unavailable, paste/drop sends no attachment, and the disabled state is preserved in an archived/local-model chat. Select a supported provider: ordinary attachment delivery remains available.

Why pending: provider/composer/drop-zone tests and Angular production build pass; the installed desktop runtime is not this checkout.

## 7. Wake-note counting (7b change 1 only)

- [ ] Record a note's count, press Rebuild twice, and recover a scratch session from compaction. Expected: count unchanged. Start two new scratch sessions with the same cached notes. Expected: each cold-start build request increments once. Restoring/resuming an existing session does not increment it.

Known limit: counting follows cold-start build requests, not confirmed provider delivery. A worker result discarded after the parent's deadline, or an aborted start, can still increment the count. Do not claim an exact count of delivered sessions. Removal suggestions and Undo remain dependent implementation, not live-test deferrals.

Why pending: SQLite-driver-backed builder/lifecycle and worker-port tests pass; Rebuild and compaction UI need the restarted app.

## 8. Keyboard dismissal and Tab order (7e)

- [ ] In compact Settings, open the category chooser, Tab through it, and press Escape. Repeat for Help and for the header, node picker, progress and artifact menus. Expected: invisible backdrop buttons never receive focus; visible controls remain reachable; Escape dismisses the open overlay without invoking the global session-stop action.

Why pending: all eight backdrop templates and Escape behavior have regression coverage and the renderer builds. On 13 Oct, Browser Gateway health showed `windows-pc` ready and deliverable. Two preview attempts at this checkout's renderer over Tailscale returned `page_text_read_failed`; the preview answered HTTP 200 through local loopback but its Tailscale route returned an empty reply. The preview servers were stopped; no Mac browser was used. This is a preview connectivity blocker, not an offline worker or missing shared tab.

## Separate open implementation and authority boundaries

The plan remains active. Its worker ledger tracks every part. In particular, actual retirement batch approval/commit, optional scratch deletion, storage retention/deletion choices, absent Phase 2/3/4/5/Housekeeping frameworks, and parked trigger-dependent features are not represented as completed or deferred tests here. The installed-Claude probe and production-adapter subprocess tests verify Cancel handling; a rebuilt installed-CLI integration check remains below. The missing Needs-you aggregator/count in 7j remains implementation work, not a deferred test.


## 9. Live question reminders (6d)

- [ ] In the coordinator-integrated rebuilt desktop app, start a disposable ask-first Claude session and leave a harmless input/permission question unanswered for six minutes. Expected: it appears in the approvals banner immediately and one existing quiet digest includes the session after five minutes. Provider output/activity must not reset the wait age.
- [ ] Resolve the question and check that the next digest omits it. A loop-owned/repository-job session and an Auto-approve session must not contribute a synthetic live row; durable approvals continue to be counted independently.

Why pending: shared state/clock/banner/watcher tests pass, but a real notification and installed provider question require the restarted application.

## 10. Claude connector cancellation (6e, first version)

- [ ] In a disposable rebuilt desktop Claude session, connect the mock eliciting MCP server used by the installed-CLI probe and trigger a harmless form request, then a harmless URL-mode request. No real sign-in or credentials are needed. Expected: Harness sends the correlated Cancel envelope, the connector receives `action: cancel`, the turn continues, and exactly one neutral system receipt appears. No form/URL/prompt body appears in that receipt or an approval card.
- [ ] Use the desktop `spawn`/`sendInput` runtime path. The existing utility one-shot `sendMessage`/`sendMessageStream` EOF behavior is outside this check.

Why pending: real subprocesses already exercise the production adapter/module, and the installed CLI probe establishes the envelope; combined rebuilt Harness/provider/display integration is not running yet. Never perform a real connector login for this test.

## 11. Saved-session identifier index (6g)

- [ ] After coordinator integration and desktop restart, with no active or paused loop, wait for `Continuity identifier backfill complete`. Expected: `<userData>/session-continuity/lookup-index.json` appears, containing identifiers/file generations only. Active/paused/provider-parked loops hold background backfill.
- [ ] Resume a disposable saved session by its history ID and native session ID. Expected: the correct transcript is loaded and the lookup reads only its state JSON. Resolve a deliberately missing identifier after completion. Expected: the log says `scanned: 0`; no full transcript scan occurs. Record elapsed time separately: complete misses still validate file generations, so strict constant-time real-folder latency is not claimed.
- [ ] If the log says backfill awaits unreadable records, preserve those files and investigate the stated condition. Do not delete or move a user's transcript to make the index complete.

Why pending: temp-directory persistence/reload/read-failure and actual compiled-coordinator checks cover the runtime logic; installed startup wiring, real-folder timing and a user-triggered resume require the integrated restarted app. No script writes to James's real data folders.

## 12. Mode receipts and Settings rows (7d / 7h)

- [ ] On the rebuilt Windows desktop, switch a disposable session from Plan to Build and back. Expected: one neutral grey system line follows each successful switch and accurately describes effective permissions. The line is display-only and never enters the model prompt.
- [ ] Open Advanced → Runtime. Expected: repository-map and experimental transcript-speed rows are present; the other three switches retain their existing surfaces. Toggle virtualization on a long disposable transcript: behavior changes immediately. Change repository-map and start a new disposable session: its starting prompt follows the switch; an existing session retains its map. No app restart is required for either setting.

Why pending: mode/permission and Settings/virtualizer DOM tests pass; visible installed-app behavior requires coordinator integration and restart.

## 13. Memory review and repository-job push paths (7j foundation only)

- [ ] In the rebuilt app, create and decide a disposable governed proposal, then create/finish/cancel a harmless disposable repository job. Expected: the existing Memory Review and Jobs/Workboard lists refresh within the one-second event throttle, without waiting for the page poll or refocusing the window. A slow older response must not overwrite the newer list.
- [ ] The Phase3 Needs-you aggregator/count is not implemented in this checkout. Do not count observing these existing lists as verification of that missing count.

Why pending: main forwarding, validation, preload, store races and teardown tests pass. Combined displayed-list timing requires the restarted app; the missing aggregator remains open in the plan.
