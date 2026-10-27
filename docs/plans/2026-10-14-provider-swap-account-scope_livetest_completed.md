# Provider swap account scope: live checks

Status: all three live checks pass in the isolated rebuilt dev app as of 2026-10-27. The follow-up below verifies check 1 through the actual composer model picker and rendered account control. No human observation remains required for these checks. Independent queue verification and document closure remain with the coordinator; do not rename this document or interrupt active sessions.

Plan: [provider swap account scope](2026-10-14-provider-swap-account-scope_plan_completed.md).

Remediation flow: [live-test campaign runbook](livetest-campaign-runbook.md). Record a reproduced defect in [remediation register](livetest-remediation-register.md), with a matching implementation-status section in `2026-07-19-livetest-failure-remediation-followup_plan.md`. Keep per-check evidence here and rename this document `_livetest_completed.md` only when every check passes.

## 1. Switch the reported MiMo chat to Codex

1. After safely restarting Harness with the rebuilt code, reopen the affected chat or a MiMo chat with an existing user message.
2. In the composer model picker, choose a Codex model from the available list. Use the normal permission settings; no new flags are needed.
3. Check that the composer changes to Codex and displays a Codex account, the transcript reports the provider change, and the existing conversation remains visible.
4. Send a short continuation and check that Codex responds with access to the prior conversation.

Expected: no removed-Codex-account error caused by a MiMo profile; no stale MiMo account displayed for the Codex runtime. A genuinely missing or signed-out destination account still receives its normal routing error.

Current result: verified in the isolated rebuilt dev app, including the composer picker, displayed Codex account, provider-change notice, retained transcript and real contextual continuation. See the follow-up evidence below. The installed affected conversation was preserved; observing that specific conversation is not required by the alternative MiMo-chat procedure above.

## 2. Confirm selection survives restart

1. Let the Codex turn finish, then safely restart Harness.
2. Resume the same conversation and send another short continuation.

Expected: the conversation resumes on its selected Codex account, with no reference to the former MiMo profile.

Current result: verified with an actual stop/relaunch of the isolated rebuilt dev app and a real signed-in Codex continuation. See the first dated run below.

## 3. Confirm the existing OpenCode capacity correction is loaded

1. In the rebuilt Harness, with six idle OpenCode/MiMo sessions present and enough machine capacity, start another MiMo session.
2. Check that it starts without the earlier 60-second OpenCode concurrency-slot failure caused by a six-session ceiling.

Expected: the seventh session is admitted under the existing 20-session cap. This does not claim unlimited sessions; the remaining cap is intentional.

Current result: seven real OpenCode/MiMo runtimes reached idle simultaneously in the isolated rebuilt dev app. The seventh was admitted without the old six-session ceiling. See the first dated run below; the configured cap remains 20.

## Evidence

See the dated evidence runs below. Never record credentials, provider keys, or conversation text here.

## Evidence run — 2026-10-27

All three open checks were exercised in the assigned worktree. No production source or tests changed. No commit, stash, branch/worktree creation or document rename was performed.

Evidence: [report and method](evidence/2026-10-27-provider-swap-account-scope/report.md), [command receipts](evidence/2026-10-27-provider-swap-account-scope/command-receipts.ndjson), [seal](evidence/2026-10-27-provider-swap-account-scope/seal.json), [cleanup receipt](evidence/2026-10-27-provider-swap-account-scope/cleanup-receipt.json).

| Check | Actual status | Dated runtime evidence |
| --- | --- | --- |
| 1. MiMo → Codex | **PARTIAL: backend passed; installed composer observation open** | At 13:57:22 UTC, a real MiMo runtime stamped `comtechspare-f7a6` switched to Codex account `legacy`; user-message IDs survived, the provider notice existed, and no removed-account error occurred. At 13:58:10 UTC, Codex replied successfully with the prior user fact. See [swap](evidence/2026-10-27-provider-swap-account-scope/named-mimo-to-codex.json) and [continuation](evidence/2026-10-27-provider-swap-account-scope/named-codex-continuation.json). This tests differing real source/destination account IDs. It does not assert that the normal composer displayed the right account label. |
| 2. Selection survives restart | **PASS in isolated rebuilt app** | Saved state at 13:58:51 UTC contained Codex, `gpt-6-astra`, account `legacy`, and no retained MiMo account. After an actual stop/relaunch, native history resume at 14:00:54 UTC restored that account and prior user fact without an explicit account override. At 14:01:07 UTC, a fresh Codex continuation recalled that fact. See [persisted state metadata](evidence/2026-10-27-provider-swap-account-scope/named-account-persisted.json), [native restore](evidence/2026-10-27-provider-swap-account-scope/named-account-restore-after-restart.json), and [post-restart reply](evidence/2026-10-27-provider-swap-account-scope/named-account-post-restart-continuation.json). |
| 3. Seventh OpenCode/MiMo session | **PASS in isolated rebuilt app** | At 13:49:22 UTC all seven real sessions were idle simultaneously. The seventh reached idle in 6016 ms with no concurrency-slot timeout or error. See [seven-session receipt](evidence/2026-10-27-provider-swap-account-scope/seven-mimo-sessions.json). All seven were then terminated. Admission above six is proved; unlimited capacity is not claimed. |

### Environment and interpretation

The app was rebuilt and launched from the assigned worktree with `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-c260c2ee` and `--remote-debugging-port=9832`. The automated test window was hidden/offscreen, loaded the built renderer and real preload, and executed the real app's main-process IPC, routing, adapters and persistence. Focus emulation ran before evaluation; the window reported `document.hidden: false`. A hidden test window is not evidence for the normal installed composer. Successful launches used `--no-sandbox` after the initial launch reported sandbox initialization failures. `Emulation.setPageVisibilityOverride` was unsupported, but focus/visibility were confirmed. The Windows browser gateway preflight responded; no local desktop UI was controlled.

Existing sign-ins were used. For the named-account run, existing account metadata/policies were mirrored only into disposable settings, and the named Codex sign-in file was linked from its existing location without copying secret values. The router actually selected the Codex **legacy** account; the run does not claim that it selected the named Codex account. The source MiMo account ID and selected destination ID were distinct, and the destination stamp was verified both live and on disk. The affected production chat, production settings and active sessions were untouched by this worker.

Initial MiMo legacy turns returned quota exhausted. Two generic app-listed Codex models were rejected by this ChatGPT account; the successful real turns used `gpt-6-astra`, confirmed by the CLI's native model list. These failed attempts are retained, not counted as passes, and are not evidence of an account-scope defect. The first history-restore probe ran before the test page existed and failed; a recovery-candidate probe found no unarchived candidates after shutdown archived the conversation. Corrected normal history restore provides the accepted restart evidence.

The installed on-disk app archive [contains the fix and cap 20](evidence/2026-10-27-provider-swap-account-scope/installed-code-prerequisites.json). That read-only check does not establish which bytes the running installed process loaded, so the earlier pre-change-process claim is not treated as current fact.

### Remaining human observation

Only check 1's installed-app presentation remains open: when safe, observe a MiMo chat with an existing message, choose an account-supported Codex model in the normal composer, confirm the displayed provider/account, provider-change notice and existing transcript, then send a contextual continuation. The installed Harness is a hard-denied desktop automation target, so this worker cannot provide that visual observation. No credential lookup, product choice or new permission decision is outstanding. Restart only if needed to load the fix and when active sessions can be preserved; this run did not restart the installed app.

### Verification and cleanup

Main build, renderer build, aio-mcp build, both typechecks, lint and focused quiet tests all exited 0; the focused result was 65 passed across the reconciler account-swap, account-routing and provider-limiter files. No tests or expectations were changed. A full suite was not run for this documentation/evidence-only task on the shared host after the observed overload. No new application defect was reproduced, so no remediation entry was added. The historical backlog's explicit “Do not add current status here” instruction was followed; this owning document is the current record.

All test instances were terminated and no automations remained. Earlier isolated app shutdowns required the runner's bounded force-stop; the final app exited normally with code 0 after explicit instance cleanup. Both outcomes are retained in the runtime receipts. Runtime deletion, owned PID/listener checks and final Git state are recorded in the cleanup receipt. Pre-existing shared dependency links are preserved. The document stays open and unchanged in name for independent queue verification.

## Evidence run — 2026-10-27, verifier follow-up

### As-built status

**3 of 3 live checks pass in the isolated rebuilt app.** This section supersedes the first run's remaining-human-observation paragraph. The composer check is agent-runnable and is now observed; the installed Harness restriction does not require handing an equivalent dev-app check to James. The affected production conversation and active sessions were preserved.

| Check | Actual status | Evidence |
| --- | --- | --- |
| 1. MiMo → Codex, including composer | **PASS** | At 14:20:36 UTC the real composer displayed OpenCode/MiMo with `ComTechSpare` (`comtechspare-f7a6`) and the existing user message. The test opened that composer's model picker, selected the Codex tab and available `gpt-6-astra` model. At 14:20:43 UTC the executing runtime was Codex on account `legacy`; the composer displayed **Codex · GPT-6 Astra** and **CodexSUAS**, its account select read `legacy`, and its options contained the Codex accounts. The provider-change notice and original user message were rendered, user-message IDs survived and no removed-Codex-account error was visible. At 14:20:47 UTC a real Codex continuation recalled the prior fact. See [rendered composer and runtime receipt](evidence/2026-10-27-provider-swap-account-scope/recheck/composer-runtime.json) ([working copy](/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-provider-swap-accou-60c2ee/docs/plans/evidence/2026-10-27-provider-swap-account-scope/recheck/composer-runtime.json)). |
| 2. Selection survives restart | **PASS, accepted earlier evidence retained** | The original actual stop/relaunch, native history resume and successful Codex continuation remain accepted. [Restore receipt](evidence/2026-10-27-provider-swap-account-scope/named-account-restore-after-restart.json) ([working copy](/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-provider-swap-accou-60c2ee/docs/plans/evidence/2026-10-27-provider-swap-account-scope/named-account-restore-after-restart.json)), [continuation receipt](evidence/2026-10-27-provider-swap-account-scope/named-account-post-restart-continuation.json) ([working copy](/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-provider-swap-accou-60c2ee/docs/plans/evidence/2026-10-27-provider-swap-account-scope/named-account-post-restart-continuation.json)). No repeat provider turn was needed for the display-only finding. |
| 3. Seventh OpenCode/MiMo session | **PASS, accepted earlier evidence retained** | [Seven real idle sessions](evidence/2026-10-27-provider-swap-account-scope/seven-mimo-sessions.json) ([working copy](/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-provider-swap-accou-60c2ee/docs/plans/evidence/2026-10-27-provider-swap-account-scope/seven-mimo-sessions.json)). This follow-up verified the original evidence seal and every relevant source fingerprint without mismatch; neither the limiter nor provider routing changed. |

### Method, failed attempts and verification

The app was rebuilt in the assigned worktree with the required isolated profile and debugging port. An automated offscreen Electron test window loaded the **real production-built renderer and real preload**; only window creation was replaced to keep all local desktop interaction hidden. WindowManager's real event transport, main-process services, account router, provider adapters and persistence remained active. This is DOM evidence for the actual composer components, not a claim about the installed app's window or visual styling. No renderer state, account-chip value or model-picker result was injected or mocked. Focus emulation was enabled before DOM assertions and retained for the test connection; `document.hidden` was false and visibility was visible before and after the swap. The visibility-override command was unsupported. Browser Gateway health confirmed the Windows worker channel was fresh and deliverable; no everyday Chrome tab or visible desktop window was controlled.

The first test harness used a numeric loopback page origin, which the real trusted-sender check rejects; it was corrected to the app's normal `localhost` origin. The next attempt stopped before the composer because the disposable profile had no computer role; selecting the coordinator role in that disposable app exposed the normal dashboard. Those failed probe receipts are retained. `sendInput` waited for the source turn, so an explicit interrupt was sent only to the disposable instance to settle it; the later duplicate interrupt returned false because it was already idle. The successful model change and contextual response came from the ordinary composer and real Codex runtime. These are harness/setup corrections, not reproduced application defects.

The aio-mcp executable build initially rejected the machine's Homebrew Node binary because it lacks the required executable fuse. Rebuilding with the repository-pinned Node version succeeded. Main build, renderer build, both typechecks, lint and the focused tests have current command receipts. The focused set includes account-swap, routing, limiter, composer-toolbar and provider-account-chip coverage. No source or test expectation changed. The full suite and slow tier were not rerun for this documentation/evidence-only follow-up on the shared host. No new product defect was reproduced, so no remediation-register entry was added.

### Document and evidence handover

Per the explicit queue instructions and runbook section 5, this owning document stays **only at its supplied root-checkout path**. It must not be copied into the queue worktree, committed by the worker or renamed by the worker. The evidence stays on the queue branch. The root-relative evidence links describe their portable landing location; the adjacent **working copy** links in this follow-up are usable **before landing**. The working-copy links make each receipt readable now, with no dependency on a merge for review; the primary links remain portable after landing. The [follow-up report](evidence/2026-10-27-provider-swap-account-scope/recheck/report.md) ([working copy](/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-provider-swap-accou-60c2ee/docs/plans/evidence/2026-10-27-provider-swap-account-scope/recheck/report.md)), [command receipts](evidence/2026-10-27-provider-swap-account-scope/recheck/command-receipts.ndjson) ([working copy](/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-provider-swap-accou-60c2ee/docs/plans/evidence/2026-10-27-provider-swap-account-scope/recheck/command-receipts.ndjson)) and [handover manifest](evidence/2026-10-27-provider-swap-account-scope/recheck/handover.json) ([working copy](/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-provider-swap-accou-60c2ee/docs/plans/evidence/2026-10-27-provider-swap-account-scope/recheck/handover.json)) identify both pieces explicitly. The manifest records the owning document's current digest, evidence paths and the coordinator's existing root-document harvest path. The coordinator must harvest the updated root document together with this branch's evidence before removing its managed worktree. Final root-relative destinations are recorded in the manifest and already supplied as the primary links above; no link rewriting is required for landing. The explicitly temporary working-copy alternatives can be discarded after review.

The [seal](evidence/2026-10-27-provider-swap-account-scope/recheck/seal.json) ([working copy](/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-provider-swap-accou-60c2ee/docs/plans/evidence/2026-10-27-provider-swap-account-scope/recheck/seal.json)) covers the current report, command receipts, runtime evidence and owning document. [Cleanup receipt](evidence/2026-10-27-provider-swap-account-scope/recheck/cleanup-receipt.json) ([working copy](/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-14-provider-swap-accou-60c2ee/docs/plans/evidence/2026-10-27-provider-swap-account-scope/recheck/cleanup-receipt.json)) records stopped processes, closed listeners and deletion of runtime, profile and compile artifacts while preserving the pre-existing shared dependency links. Independent verifier review remains pending. The historical backlog was left unchanged under its explicit no-current-additions instruction.
