# October follow-ups: pending checks in rebuilt applications

**Status:** open. This document records only live checks for implemented changes; it does not defer missing implementation, choices, or agent-runnable gates.

**Prerequisites:** coordinator integration and rebuild of the desktop app and phone app, then restart those instances. Browser and desktop interaction must target `windows-pc` through the AIO gateway. Mac-only real-data steps below require James's explicit Mac authorization for that campaign; this document grants none. Use a disposable project and scratch sessions, with ask-first approval enabled for permission checks. No real archive batch, data deletion, deployment, or external publication is authorized by this document.

**Owning plan:** [October follow-ups](2026-10-11-oct-followups_plan.md).

**Remediation flow:** before a campaign, read [live-test campaign runbook](livetest-campaign-runbook.md). A reproduced defect gets a new `LT-NNN` entry and implementation-status section in [remediation register](livetest-remediation-register.md). The previous [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md) is closed historical evidence; do not add work to it. Keep per-check evidence here and rename this file `_livetest_completed.md` only after all checks pass.

## 1. Desktop permission answers (3a / 6c)

- [ ] In a scratch ask-first Claude session, trigger a harmless denied Read or Write tool request in a temporary project. Refuse it and then Allow a separate harmless request. Expected: genuine refusals still raise the appropriate permission card, refusal clears the waiting prompt, explicit Allow works, and neither refusal nor an omitted-decision transport request enables Auto-approve. The omitted-decision IPC and thin-client cases are already covered by worker tests.
- [ ] Produce an ordinary tool error in the same scratch session. Expected: it appears as an error without a permission card.

Why pending: installed-CLI denial strings were source-checked and measured, and adapter/handler tests pass, but this checkout's app has not been integrated into a running desktop instance.

## 2. Startup worktree preservation (3c)

- [ ] In a disposable repository only, create an AIO-managed cancelled/failed loop with an unsaved file in its worktree, then restart the rebuilt app. Expected: the file and worktree pointer remain, branch tip does not change, and lifecycle reports `Work folder has unsaved changes; left in place`. A clean cancelled run may remove its managed directory while retaining its branch.

Why pending: real temporary-repository reconciliation tests pass; this check additionally exercises restart and persistence in the rebuilt application. Disk-card changes have now been recovered into the worker checkout; their real-data checks remain separate below.

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

## 7. Project-note counting, suggestions and Undo (7b)

- [ ] Record a note's count, press Rebuild twice, and recover a scratch session from compaction. Expected: count unchanged. Start two new scratch sessions with the same cached notes. Expected: each cold-start build request increments once. Restoring/resuming an existing session does not increment it.

Known limit: counting follows cold-start build requests, not confirmed provider delivery. A worker result discarded after the parent's deadline, or an aborted start, can still increment the count. Do not claim an exact count of delivered sessions.

- [ ] In a disposable project, use a note produced from a project file by project-knowledge mining. Start ten new scratch sessions whose starting notes include that note, then change its recorded source file. Open Knowledge → Project notes, then expand "Suggested for removal". Expected: the note shows "source changed", its lifetime "Shown N times" count and ten showings in the last 30 days. A note without a recorded source must not claim that its source changed. The no-show alternative requires 60 observed days; those date boundaries are already exercised with a controlled clock in worker tests and do not require waiting 60 days in this campaign.
- [ ] Press "Remove note" on that disposable suggestion, then "Undo" within five seconds. Expected: no delete occurs, the note returns with its original count, added date and provenance, and the pending-removal message clears. Repeat while hovering or focusing the Undo notice for more than five seconds: removal remains pending. Move both pointer and focus away and let the remaining five-second window expire only for the disposable note; expected: it is removed once. Rebuilds and this review never remove anything automatically.

Why pending: SQLite-driver-backed builder/lifecycle, source-snapshot and rolling-history tests plus seeded Angular component/store tests exercise the code paths. Observing the integrated page, actual provider starts and compaction in the installed app requires the coordinator's rebuilt and restarted instance. No missing implementation is deferred here.

## 8. Keyboard dismissal and Tab order (7e)

- [ ] In compact Settings, open the category chooser, Tab through it, and press Escape. Repeat for Help and for the header, node picker, progress and artifact menus. Expected: invisible backdrop buttons never receive focus; visible controls remain reachable; Escape dismisses the open overlay without invoking the global session-stop action.

Why pending: all eight backdrop templates and Escape behavior have regression coverage and the renderer builds. On 13 Oct, Browser Gateway health showed `windows-pc` ready and deliverable. Two preview attempts at this checkout's renderer over Tailscale returned `page_text_read_failed`; the preview answered HTTP 200 through local loopback but its Tailscale route returned an empty reply. The preview servers were stopped; no Mac browser was used. This is a preview connectivity blocker, not an offline worker or missing shared tab.

## Campaign and authority boundaries

The plan remains active for coordinator acceptance; its current worker ledger tracks every part. The approved archive moves and retention/card implementations are recovered as uncommitted source changes. Real scratch deletion and disk-card removals still require their own preview and explicit yes; nothing in this campaign grants that authority. Step 8's trigger-dependent ideas remain parked rather than deferred tests. The installed-Claude probe and production-adapter subprocess tests verify Cancel handling; a rebuilt installed-CLI integration check remains below. Part 7j uses the existing Workboard Needs You lane; no separate Phase 3 desktop aggregator is claimed restored.


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

## 13. Memory review and repository-job push paths (7j)

- [ ] In the rebuilt app, create and decide a disposable governed proposal, then create/finish/cancel a harmless disposable repository job. Expected: the existing Memory Review and Jobs/Workboard lists refresh within the one-second event throttle, without waiting for the page poll or refocusing the window. A slow older response must not overwrite the newer list.
- [ ] With the Workboard open, confirm that the same pending memory review appears in its Needs You lane and moves to Done when decided; see check 26. Do not treat this as evidence for the separate parked phone/desktop-aggregator work in Step 8.

Why pending: main forwarding, validation, preload, store races and teardown tests pass. Combined displayed-list timing requires the restarted app; the missing aggregator remains open in the plan.

## 14. Held campaign steps pause the campaign (3f)

- [ ] On the rebuilt desktop, run a disposable scripted campaign whose middle step's loop ends `completed-needs-review` with skipped checks (the merge hold), with the needs-review policy set to Continue. Expected: the campaign pauses at that step with the reason "Step … finished with skipped checks and its work was not merged (it is kept on branch …)", the next step does not start, and the step's work stays on its branch. The campaign editor's Continue option shows the sentence "A step whose checks were skipped still pauses the campaign."
- [ ] Repeat without the hold. Expected: the campaign advances as today.

Why pending: the decision function, coordinator pause path, landing preserve path and restart recovery are covered by unit tests; a scripted campaign with a forced held step needs the integrated app.

## 15. Paused loops free their automations (4a)

- [ ] In the rebuilt desktop, start a disposable scheduled automation whose loop is forced to pause (for example a blocked file or no progress). Expected: the automation's run ends showing `needs-attention` with the pause reason, the next scheduled fire is not skipped, the loop itself stays resumable, and exactly one quiet desktop notice names the loop and the reason. Pause the same loop again within the hour. Expected: no second notice.
- [ ] Confirm a paused-loop outcome never counts towards the automation's auto-disable streak.
- [ ] Focus-aware notice (4a change 3): with the forced pause ready, open Settings (or another session's chat) in the focused window and trigger the pause. Expected: the desktop notice appears at once naming the loop and the reason — a focused unrelated view must not swallow it.
- [ ] Repeat with the pausing loop's own Loop HUD on screen when it pauses. Expected: no notice at that moment; navigate to another view (or click out of the app) and the deferred notice appears once, still inside the hour throttle.
- [ ] Pause a loop while its HUD is on screen, then Resume it before leaving the view. Expected: no notice at any point (the run is no longer paused when the deferred entry would flush).

Why pending: dispatcher, store, notice-throttle and view-focus unit tests cover the mapping and the focus/defer rules; the visible run status, the next fire and the desktop notice need the rebuilt app.

## 16. Disk-space card: old data folder and pasted attachments (5d / 5g)

- [ ] On the Mac, open the disk space card with the old `claude-orchestrator` folder present. Expected: an "Older Harness data folder" row shows its size; Review shows the Bin-move window (heading "Move the older Harness data folder to the Bin?", buttons "Keep it" and "Move to the Bin"); pressing "Keep it" leaves the folder unchanged. **Never press "Move to the Bin" against James's real folder.** To verify the move itself, use a disposable copy under a scratch appData path and put it back from the Bin afterwards.
- [ ] In a disposable project that has old `.claude-attachments` copies, open the card. Expected: the "Pasted attachments" row lists folders with session counts, sizes and ages, and offers only copies last changed more than 30 days ago. In a fresh scratch project, attach a file to a chat and run `git status`. Expected: the project stays clean because the local exclude line was added.

Why pending: listing, preview tickets, Bin-move failure behaviour and removal are covered by unit tests; the rendered window, the real Bin and the git-exclude behaviour need the rebuilt app.

## 17. Stalled and final-audit-blocked loops keep their work (3g)

- [ ] On the rebuilt desktop, run a disposable scratch loop that is forced to stall (for example repeated CRITICAL no-progress with no file changes). Expected: it ends "Ended · see notes" with the sentence "Nothing was merged because the loop stalled. Merge it when you have looked. The work is on branch …", the branch still exists, and nothing reaches `integration/*`.
- [ ] Force a final-audit-blocked end (final audit needs operator review in gate mode). Expected: the end sentence is "Nothing was merged because the final check needs your sign-off." and the branch is likewise kept.
- [ ] Accept such an ended run by hand (operator Accept) or merge it yourself. Expected: an accepted run still merges; the hold only protects the automatic merge.

Why pending: the staging points, both stall endings, the finalize and restart-recovery preserve paths and the wording are covered by unit and real-coordinator tests; observing the end card and the branch outcome needs the rebuilt app. Loops are rarely used, so this can batch with Phase 2's live checks.

## 18. Disk-space card: Codex safety copies (5a)

- [ ] On the Mac, open the disk space card. Expected: a "Codex safety copies" row shows the backups folder size and count, and a "Codex session files" row shows size only with the line "Harness needs these to resume Codex chats" and no button. Review shows the two groups (older reconcile copies; smaller clean-up/archive copies) with name, date, size and per-group totals, and never lists a `state_5-auto-reconcile-*` copy or the newest 3 older copies.
- [ ] Press Cancel. Expected: a listing of `~/.ai-orchestrator/codex/backups` is byte-for-byte unchanged.
- [ ] Only with James's explicit yes at the window: press "Delete the older copies". Expected: exactly the previewed files are gone, the newest 3 older reconcile copies and every automatic copy remain, and a Codex chat still resumes.
- [ ] After the first start-up that needs a new safety copy: exactly one `state_5-auto-reconcile-*` file appears and nothing else changes; after enough starts to exceed 3, only the newest 3 automatic copies remain.

Why pending: selectors, the keep-3 rule, the tripwire and the ticketed removal are covered by unit tests; the rendered rows/window, the real Bin-less deletion and the start-up behaviour need the rebuilt app and real data. **The deletion stays behind James's yes.**

## 19. Disk-space card: RTK command history trim (5b)

- [ ] On the Mac, open the disk space card. Expected: the "RTK command history" row shows the file size and the date range, with the note that RTK removes entries after 90 days by itself. Review shows the number of entries older than 30 days and the rough database space made reusable. The file keeps its allocated disk size.
- [ ] Press Cancel. Expected: `~/Library/Application Support/rtk/history.db` is byte-for-byte unchanged (`ls -l` before and after).
- [ ] Only with James's explicit yes: press "Trim the history" while an agent is running `rtk` commands. Expected: no `rtk` command fails and `rtk gain` still prints totals. A full trim reports the actual removed-row count; a bounded stop reports an interruption and its actual count visibly, including zero when nothing was removed. The result claims no physical disk bytes freed. A read-only count shows no old rows after a full trim; a partial trim can leave rows. Any retry starts with a fresh Review and another explicit confirmation.

Why pending: preview counts, the batched trim, the busy stop and the no-VACUUM behaviour are covered by unit tests; the real shared file, concurrent RTK writers and the window need the Mac and James's yes. **The trim stays behind his yes.**

## 20. Trace files cap and the set-aside record (5c)

- [ ] On a machine with real use, after a working hour list `~/Library/Application Support/harness/logs`. Expected: `traces.ndjson` stays under its 50 MB cap with at most `.1`-`.3` older pieces, `traces.ndjson.legacy` holds the pre-update record (created once), and a `provider-events.ndjson` file appears beside them with its own `.1`-`.3` pieces at 30 MB.
- [ ] Stat `$TMPDIR/ai-orchestrator/logs` twice a minute apart. Expected: it has stopped growing (the worker no longer writes there).
- [ ] On the Mac, open the disk space card. Expected: the "Old trace record" row offers only `traces.ndjson.legacy`; the numbered pieces are never listed. Cancel leaves the file unchanged; only with James's yes may "Delete the old record" be pressed.

Why pending: rotation, the set-aside rename and the worker path are covered by unit and real worker-thread tests; the on-disk state after real use needs the rebuilt app. **The legacy deletion stays behind James's yes.**

## 21. RTK binaries fetched by the build (5e)

- [ ] In a scratch clone of the integrated branch: `git ls-files resources/rtk` prints nothing; `npm run fetch:rtk` restores all five files and `git status` stays clean; `npm run electron:build` produces the app with `Contents/Resources/rtk/darwin-arm64/rtk` present and executable.
- [ ] On the Windows PC, with and without network: `npm run dev` starts (with no network it prints one warning and still starts).
- [ ] The first normal CI run after the commit: the "Fetch bundled RTK" step runs before packaging and the packaged-startup smoke passes.

Why pending: selection, exit policy and workflow ordering are covered by unit tests; a real download, the packaged app and CI need the network, the scratch clone and the coordinator's commit (which is the recorded yes for choice 8).

## 22. Disposable-folder sweep (1f)

- [ ] After coordinator integration and James's Mac authorization, run `npm run docs:retire -- --scratch` in the root checkout. Preserve both the printed Review and Manifest paths from that invocation and read that exact review. Expected: only `_scratch/` entries untouched for more than 30 days and `.aio-review/` pages older than 14 days are listed; `oct-phases`, `oct-audit` and any entry an open plan names are absent. The unique repository-bound manifest is in the private OS-temp review directory.
- [ ] Only with James's explicit yes after reading that list, use the exact printed apply command: `npm run docs:retire -- --scratch --apply --manifest '<that approved dry run’s exact Manifest path>'`. Expected: only unchanged approved entries disappear; later/newly eligible entries stay. Changed, replaced, missing, linked, protected, tracked, nonignored or recent entries refuse with a nonzero exit and require fresh review. Directory ages include empty descendants, and both namespace ancestors must still be the reviewed real directories. Bare apply and substituted/latest manifests are refused. This cannot be undone: git does not hold these folders.

Why pending: listing, protection and the apply/refuse rules are covered by unit tests; the destructive apply must show James the real list first. **Nothing is deleted without that yes.**

## 23. Helper announcements say "not measured" (6a)

- [ ] On the rebuilt desktop, run one scratch parent session that starts a Claude helper. Expected: the helper's finishing note shows its recorded spend when the adapter reports one, and shows "not measured" instead of a conversation-size figure when it does not — the number must never be Claude's context occupancy. A Codex helper (which reports cumulative spend) shows that spend.
- [ ] When Phase 0 step 7b's per-turn ledger has landed, compare a Claude helper's announced total with `npm run audit:claude-cost` for the same session.

Why pending: the spend-or-"not measured" selection and the wording are covered by unit tests; seeing a real announcement needs the rebuilt app. The ledger-backed figure is the documented extension in `childSpendTokens`, not a deferral of the delivered behavior.

## 24. Screen-reader names on form fields (7f)

- [ ] Optional, on the Windows PC: with a screen reader running, focus a verification-config field (for example the CLI path or Default model control). Expected: the field announces its name, not just "edit text" or "combo box".
- [ ] The zero-unnamed-fields rule is enforced by `form-field-accessible-names.spec.ts` in every test run; no live step is required to hold it.

Why pending: only the human read-out needs a person and the rebuilt app; the guard itself is a code gate.

## 25. Money in cents with exact hovers (7g)

- [ ] On the rebuilt desktop, open the Costs page. Expected: totals, averages, budget rows and table cells read in cents ("$0.73", or "under 1 cent"), never four or six decimals. Hovering a per-model, per-session or recent-entry amount shows "Exact amount: $…" with the unrounded figure; the Total Spend card's hover explains any estimated portion with its exact figure.

Why pending: the formatting and the no-`toFixed(4|6)` guard are covered by unit tests and the production build; seeing the rendered page and its hovers needs the rebuilt app.

## 26. Memory reviews reach Needs You at once (7j)

- [ ] On the rebuilt desktop, create a disposable memory review (a governed proposal) and open the Workboard without waiting for a poll. Expected: the review appears in the Needs You lane within about a second, labelled "Memory review"; approving or rejecting it moves the card to Done. The card's specialist button opens the Memory review page.

Why pending: the projection, lane mapping and the push-refresh path are covered by unit and store tests; observing the rendered lane timing needs the rebuilt app.

## 27. Helper-agents chip above the message box (7c)

- [ ] On the rebuilt desktop, start a scratch Claude session and have Claude start one native Agent/Task helper inside that session. Expected: a small chip appears above the message box reading "1 helper agent running", with the hover "Helper agents the AI started inside this session. They are not separate sessions." When a second native helper runs it reads "2 helper agents running"; completion reduces the count and the chip disappears when all finish.
- [ ] Start one native background helper. Expected: it remains counted after the main turn ends and disappears when its native task ends. A shell job or a separately spawned Harness child session contributes no native-helper count. Replacing, terminating or closing the owning session must clear old activity.
- [ ] After rebuilding the remote worker from the integrated source, repeat with a disposable remote Claude session. Expected: the same native counts reach the composer; reconnect/replay does not duplicate them. No live remote-worker observation is claimed by the in-process transport tests.
- [ ] When Phase 3 step 5's typed chip strip lands, re-check that the same descriptor sits in the strip (and in its overflow beyond Phase 5 step 16's limit).

Why pending: native lifecycle, direct/offloaded/remote transport, preload/event-bus/store and actual headless Angular composer behavior are covered by tests. Installed provider events and a rebuilt remote worker require the coordinator's integrated applications. The final typed-strip bullet waits for its host to exist. The old orchestration-child substitute and its old manual instruction are superseded by the R1.5 repair.

Part 7b's suggestion fold and five-second Undo are now implemented in the Project notes surface. Its remaining installed-app observations are recorded in check 7; source comparison, date boundaries, usage tracking and Undo/store behavior are agent-runnable tests, not deferred checks.

## 28. Claude one-shot transcript persistence (5f)

- [ ] After coordinator integration, rebuild and restart Harness on `windows-pc` with an available Claude account. In a disposable project, record the current file names and modification times under that worker's `~/.claude/projects/` and `~/.claude/session-env/` without reading their contents. Run one harmless Claude magic prompt in Harness. Expected: the answer succeeds and no transcript or session-env entry for that one-shot appears. Do not delete any existing provider file as preparation or cleanup.
- [ ] In the same disposable project, start an ordinary Claude chat, send one harmless message, close it normally, then resume it. Expected: its transcript remains available and the continuation succeeds. If a scratch fork is exercised, it likewise retains persistence. Do not use a real chat or loop for these controls.
- [ ] Read the Costs page after the one-shot. Expected: the call retains its existing purpose/budget and paid usage reporting despite having no saved Claude transcript. No retry or extra call is required after a budget stop.

Why pending: actual argv builders, caller admission and factory/provider/local-worker/remote-worker forwarding are covered by the 5f tests; the installed-CLI filesystem effect and combined app/provider behavior need the rebuilt instance and a working external account. The worker's Claude helper attempt returned the real account spend-limit error, so no successful native call is claimed. The previous skip is superseded by the current implementation. These checks require no login, credentials or Mac browser interaction by an agent; any account recovery remains a separate secure route.
