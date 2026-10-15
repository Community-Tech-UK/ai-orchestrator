# Outstanding AIO plans: historical implementation checkpoints

**Status reconciliation — 2026-09-24:** the intermediate checkpoints below are superseded by
the [final code and review result](#2026-09-23-final-code-and-review-result), which records the
September 23 final canonical gates and fresh `VERDICT: PASS`. Earlier statements such as
"pending", "unimplemented", "untracked", "do not rename" and "ahead by four commits" describe
their checkpoint only. They are not current instructions or today's Git/runtime status.

The as-built records are the
[completed live-test remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md),
[completed GitHub Actions plan](../superpowers/plans/2026-08-03-github-actions-remediation_plan_completed.md)
and [completed GitHub Actions spec](../superpowers/specs/2026-08-03-github-actions-remediation_spec_completed.md).
Their linked live-check documents own outstanding rebuilt-app, privileged and external evidence;
the historical PASS does not close those checks or certify later source changes. Scratch logs,
agent/session identifiers and concurrent-edit observations below are historical evidence references,
not durable runtime inventory. No implementation gates were rerun for this documentation correction.

Date of recorded work: 2026-09-23. Final recorded outcome: implementation code complete and
verified, with genuine live checks deferred. The session's "uncommitted" status described that
session, not the present checkout.

## Historical scope and repository-state snapshots

- Early checkout observation: `main`, then ahead of `origin/main` by four commits. Later checkpoints supersede that observation; it is not today's branch status. No agent-created branch or worktree, commit, or push was recorded for that pass.
- Plans found active at the start of this pass, now completed: `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md` and `docs/superpowers/plans/2026-08-03-github-actions-remediation_plan_completed.md`. The linked GitHub Actions spec is `docs/superpowers/specs/2026-08-03-github-actions-remediation_spec_completed.md`. The separate `ai-orchestrator-plans` directory had no active plans in the earlier inventory.
- The remediation register already had a substantial unrelated working-tree diff before that pass and was preserved. Completed plans and the GitHub Actions spec were then untracked; the instruction not to stage or commit them without James's authority applied to that session.

## Verified changes in this pass

| Item | What changed | Evidence |
| --- | --- | --- |
| LT-549 | The secret-card password input is controlled by the draft state so a rejected save clears its value and allows a fresh retry. | Regression reproduced red, then 21 focused tests passed (`_scratch/test-run.pid-30013.log`); `rtk npx tsc --noEmit` passed at that point. |
| LT-550 | Workspace Secrets shows the slug, timestamps, and recent audit metadata. A workspace change clears old metadata; refresh generations ignore stale responses; an audit failure leaves the secret list usable. | The audit-failure test reproduced red, then four focused tests passed (`_scratch/test-run.pid-93623.log`). Renderer build still needs a final pass after concurrent edits settle. |
| LT-599 | The display processor now chooses monotonic streaming text from canonical `content` and `metadata.accumulatedContent`, including duplicate frames, so the transcript cannot render a shorter metadata rewind over longer committed text. | Regression reproduced red, then 47 focused processor tests passed (`_scratch/test-run.pid-44699.log`). |
| LT-548 | Claude and Copilot inline MCP JSON containing a materialised secret is written to private temporary files rather than passed as command-line JSON. | Implementing agent reports red reproduction followed by 111 focused tests and `build:main` passing. Independent review and final repository gates remain pending. |
| LT-545–547 | IPC preload payloads and unactivated skill controls were implemented. LT-547 now records a structured budget skip, emits an event, and logs safe metadata; it does not yet show per-turn skip history in the Skill Health UI or change the injection budget. | Agent reports 82 focused tests, main/spec typechecks, lint, and renderer build passing for its area. LT-547 acceptance and final integration gates still need review. |
| LT-570/575/590–592/605/610 | Assigned UI agent reports focus, theme, diagnosis, dashboard, and approval routing changes in place. | Agent reports 100 loop tests, five browser/dashboard/focus tests, 66 settings tests, main typecheck, renderer build, and LOC check passing. Final integration gates remain pending. |
| LT-604 | The startup path now wires the RPC event router and node listeners even when the server is initially disabled; both later server-start paths start the existing Tailscale watcher. | The assigned agent reports red reproduction, then 20 focused tests, main typecheck, and spec typecheck passing. |
| LT-551 | The agent-reachable `request_user_action` protocol now accepts a `secret_required` request, checks both operator switches, emits the existing card shape, and resolves the pending request through dedicated secret-card IPC with an opaque `secret://` reference on the intended path. | The implementing agent reports red reproduction (one handler and three IPC failures), then 43 focused tests, main/spec typechecks, main/renderer builds, and diff check passing. The bypass risks listed below, lint, full suite, and independent review remain pending. |

The red/green claims above are from local focused test runs or the named implementing agent; the full suite and independent completion gate have not yet run on the combined tree. No current item should be relabelled `_completed` on this evidence alone.

## 2026-09-23 continuation

- LT-598 now records adapter guidance in the context manifest after adapter creation for both direct and worker proxy paths. A regression test first failed on the missing `adapter-browser-gateway` entry; after the change, 14 focused tests passed. Four adapter block kinds were added to the shared manifest type, and the UI agent has added their display labels. The final combined typecheck and repository gates are pending.
- LT-603 now holds respawning child-completion admission across the recovery ready edge until fallback-history reconciliation finishes. The assigned agent reports 34 admission and 15 recovery tests passing after red reproduction; LT-602 is in progress.
- LT-551's three identified bypasses are fixed by the secret CLI agent, which reports 106 focused tests and main typecheck passing. It is working on LT-593/600/601.
- LT-594 has a red reproduction and a 29-test green component run; the UI agent is finishing LT-595 and typecheck. A combined `rtk npx tsc --noEmit` run after the manifest labels were added found only two in-flight LT-595 provider-type errors in `composer-toolbar.component.ts` and `history-preview-session.service.ts`. The UI agent owns those files and has been told.
- LT-596/597 remain the current root work. The retained live evidence confirms the child has a separate rollout with `parent_thread_id` and 21,830 uncharged tokens, while the interrupted root turn had streamed prose but no fresh provider usage record. No fix has been claimed for either. The code path under investigation is Codex app-server notification routing and usage accounting.

## 2026-09-23 resumed checkout

- On resumption, `rtk git status --short --branch` showed the code changes from the prior pass staged on `main`, the large pre-existing remediation-register edit unstaged, and both active plans plus the planned GitHub Actions spec untracked. Their staged state was already present at resumption; no stage, commit, branch, worktree, or push action was taken in this continuation.
- The previous workers were no longer live after interruption. New owners were assigned only to the known unfinished paths: LT-596/597 Codex accounting, LT-603 recovery admission verification, and LT-594/595 plus LT-598 renderer verification. LT-602 was clarified to be the spawn-time reasoning-effort header chip and routed to the UI owner after its current items. No completion result from these owners has been received yet.
- The staged LT-598 diff was inspected. It records four adapter guidance kinds after adapter creation and uses the same block selector for prompt append and manifest attribution. The earlier 14 focused tests are retained evidence; the combined gates and independent review remain pending.

## 2026-09-23 latest continuation

- The checkout remains `main` with the earlier code edits staged, the pre-existing register edit unstaged, and both active plans plus the planned GitHub Actions spec untracked. No agent-created branch, worktree, commit, or push was made. The current workers own LT-596/597, LT-547, and LT-594/595/602; LT-603 was verified with 49 focused tests and main typecheck passing, with rebuilt-app validation still pending.
- The LT-602 worker traced the missing reasoning-effort header chip to the instance creation event firing before `reasoningEffort` assignment in `instance-lifecycle.ts`; it has explicit ownership of the fix and focused regression tests. The LT-547 worker traced the skip-visibility gap through the loader, controller, attribution store, IPC, and Skill Health panel and is implementing a persistent skip record.
- LT-100 and LT-196 have stale individual OPEN headings in the remediation plan. Its newer 2026-09-23 sweep explicitly records LT-100 as fixed and live-verified and LT-196 as fixed on 2026-09-13. Do not reimplement either from the older headings; verify their executing paths when reconciling the plan. The newer sweep identifies LT-029 and LT-441 as genuinely unresolved and requiring, respectively, a security policy choice and privileged live diagnosis.

Final checkpoint command: `rtk proxy git diff --check` exits 2 solely for a new blank line at EOF in the pre-existing `docs/plans/livetest-remediation-register.md` working-tree diff (line 9254). The register change predates this pass and was preserved; do not mistake the exit code for a clean combined diff.

## Work already in flight when exploration stopped

- LT-551: the secret CLI agent stopped after its core implementation and focused checks. It identified three unreviewed risks that must be resolved before calling the secret path secure: the generic `USER_ACTION_RESPOND` route may resolve a secret request without the dedicated secret-card IPC; agent-supplied `context.suppressInjectResponse` may suppress the safe reference; and a name that normalizes to empty may pass protocol validation. Existing renderer secret-card edits are the completed LT-549 change and must be preserved.
- LT-602 and LT-603 were assigned but no edits were started. The IPC/skills agent finished LT-604 before stopping expansion.
- The UI agent finished its first cluster and stopped before LT-594/595 edits after a context-policy `steer-turn` ("wrap up broad exploration…") was read as a stop instruction. It did not run the live Windows focus/contrast checks. *(Attribution corrected 2026-09-24 under LT-653: the steer is an automated policy action, not a request from James. Session `xecsi91o3` shows the same misattribution.)*

## Superseded checkpoint — code work still outstanding at that point

These were not verified fixes at that checkpoint. The final result below and the linked as-built
records supersede this remaining-work list; it is retained to explain the verification sequence.

- LT-593, LT-600, LT-601: interrupt/Stop lifecycle across Claude and ACP sessions.
- LT-594, LT-595: terminal causal timeline reachability and composer model after closed-session continuation. Source tracing confirmed terminal `LoopStore.applyState` clears the active state while the timeline is mounted only beneath `active()`; the `raise-cap` recovery also maps to `resume` even though the terminal component's control ID becomes null. No code was changed for these items.
- LT-596, LT-597, LT-598: Codex native sub-agent spend, interrupted-turn spend, and adapter-appended context manifest blocks. LT-598 investigation confirmed `assembleInstanceSystemPrompt` records the manifest before `createCliAdapter` calls `withBrowserGatewaySystemPrompt`; no code was changed. Do not implement a manifest patch without preserving the locked prompt order and verifying the full spawn path.
- LT-602/603 remain unimplemented; LT-551's bypass risks remain open. LT-604 needs final integration gates and independent review.

The remediation plan has older headings still saying `NOT STARTED` for some fixes already present in source. Its status text and `docs/plans/livetest-remediation-register.md` need careful reconciliation after code verification, preserving the register's pre-existing edits. Earlier audit identified LT-539/540/543/544/571–574/606/611–613 as source-fixed but requiring status/evidence review.

## GitHub Actions plan

The code/workflow audit found provider parity and focused loop-control checks passing, and a recent mytrademail production deployment passed. The remaining checks are external or live: Bitwarden vault storage of the four named deployment secrets, distinct Sentry projects, Firebase least privilege, and byte equality of the server wrapper. No secret values were examined. An old failed deployment run belongs to an older SHA and must not be rerun merely to make the plan green because it could roll back production. Keep the plan and linked spec active until these are verified or their genuinely live-only steps are moved to a `_livetest.md` under the repository's deferral rules.

## Completion gates required during the recorded implementation

After the in-flight edits settle: focused tests for each affected path, `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`, `rtk npm run check:ts-max-loc`, `rtk npm run build:main`, `rtk npm run build:renderer`, and `rtk npm run test:quiet`. Then use a fresh agent with `task-completion-gate` for independent review; fix findings and repeat until `VERDICT: PASS`. Only after all code is complete and verified may the active plan/spec lifecycle move to `_completed`, with genuine live-only checks placed in a linked `_livetest.md` first.

## 2026-09-23 historical gate checkpoint

- Current checkout is `main...origin/main`, with staged code and untracked active plans; no branch, worktree, commit, or push was created in this pass. The older “ahead by four commits” line above is stale.
- LT-547 now persists per-turn budget skips and shows them in Skill Health. Its owner reported 64 focused tests, main typecheck, lint, and both builds passing. The previous spec typecheck error came from concurrent Codex edits; the combined spec typecheck has since passed.
- LT-596/597 Codex accounting is still under its original owner's final edge-case review. LT-602/603 fixes and their focused tests were reported complete by their owners. Do not run the final full suite until those edits settle.
- I extracted the four unchanged adapter guidance prompt constants into `src/main/cli/adapters/adapter-guidance-prompts.ts`, reducing `adapter-spawn-helpers.ts` from 715 to 677 lines. Its nine focused tests and main typecheck passed. The current combined `typecheck:spec`, lint, main build, and renderer build passed.
- The LOC gate still fails only for `instance-communication.ts` (2552 versus 2546 tolerated) and `runtime-reconciler.ts` (774 versus 755 tolerated). Their previous owners are reducing those files. The adapter helper no longer fails the gate.
- I removed one extra final blank line in the pre-existing remediation-register working diff; `rtk proxy git diff --check` now exits zero.
- The targeted remediation audit found no additional confirmed agent-runnable code gap beyond the assigned LT items. LT-029 still needs a Keychain sandbox policy choice and live token-refresh proof. LT-441 still needs privileged resident-mode tracing before a safe code change is knowable. Older OPEN headings for LT-100/196/189/612/613 are stale and need documentation reconciliation only.
- The GitHub Actions plan remains active: the four production secret names exist in GitHub; the three Sentry DSN fields exist in Bitwarden; no Firebase/FCM item was found by targeted vault-name searches. Secret values, distinct Sentry project ownership, Firebase least privilege, and exact production wrapper bytes have not been verified. A 2026-09-23 production deploy succeeded; do not rerun the older failed workflow against its old SHA.

## 2026-09-23 final combined verification in progress

- LT-596/597 owner completed Codex child-rollout attribution and interrupted-turn cost reconciliation, with 46 focused tests and both TypeScript checks passing. Live app verification remains pending.
- The recovery reconciler's shared resume-health retry policy moved to a 33-line helper, shrinking its main file to 743 lines; 37 focused tests passed. The instance communication turn-outcome decision moved to a pure helper, shrinking its main file to 2544 lines; 137 focused tests passed. Both are now within the ratchet.
- On the combined tree after those edits, `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`, `rtk npm run check:ts-max-loc`, `rtk npm run build:main`, and `rtk npm run build:renderer` all exited zero. The full `rtk npm run test:quiet` suite is running; its result and independent completion-gate verdict are still pending.
- Active plan/spec files remain untracked. Do not rename them while LT-029, LT-441, and GitHub Actions external requirements remain unresolved.

## 2026-09-23 full-suite result and independent gate

- The first combined full suite ran 26,326 tests and failed one `campaign-worktree-landing.spec.ts` case during `afterEach` temporary-directory removal with `ENOTEMPTY`; all assertions in that case had passed. The file passed all 15 tests alone. A bounded `rmSync` cleanup retry was added, then the focused file (15/15), spec typecheck, lint, and whitespace check passed.
- The second full `rtk npm run test:quiet` suite exited zero: **2,211 files and 26,325 tests passed in 704.8 seconds**. Full log: `_scratch/test-run.pid-68618.log`.
- A fresh `task-completion-gate` agent has started reviewing the combined uncommitted code and tests. Its verdict is pending; do not call the code complete or close an active plan until actionable findings are resolved.

## 2026-09-23 fresh-review finding in progress

- The independent reviewer found a blocking LT-596 mismatch: the new child-rollout fallback accepts `token_usage_record` with `thread_token_usage` and `root_turn_id`, while a read-only probe of the local Codex rollout store found real child usage under `event_msg` / `token_count` with `info.total_token_usage` or `last_token_usage` and no `root_turn_id`. The fixture asserted a shape absent from the sampled real files. The implementing agent is correcting this and will rerun focused checks. Prior green gates predate this finding and cannot close the task.
- The first independent gate returned `VERDICT: FAIL` on that original LT-596 snapshot and reported no other actionable finding in its inspected paths. The implementer later found both record formats in another real private-store sample and is adding event-only, mixed-format duplicate, baseline, foreign-child, and time-window cases. This requires fresh post-fix verification and a different fresh reviewer.
- A separate concurrent session introduced unstaged `PQ_DEBUG` edits in plan-queue files (and an auxiliary LLM utility) after the passing full suite. They are unrelated to this task, are being preserved, and temporarily produce TS4111 errors. Do not attribute those edits to the AIO plans work or “fix” them without coordinating ownership.

## 2026-09-23 second fresh review: Codex accounting still active

- The first LT-596 follow-up now reads both real `event_msg/token_count` and `token_usage_record` rollout forms and passes 46 focused tests. Its fresh reviewer independently confirmed both record forms in private rollout metadata; review remains open for turn-boundary behavior.
- The second reviewer found two actionable LT-597 cases: (1) if an interrupted turn has one reported call and then a streamed final call without usage, the estimator skips the unreported output because any prior usage suppresses it; (2) after an estimated interrupted turn is reconciled into a later cumulative provider total, a late exact usage event for the interrupted turn adds the same spend again. The reviewer reproduced the latter by direct `CodexUsageAccounting` execution: baseline 120, estimate 10, next cumulative 220 with last 60 gives ledger 100, then a late exact 40 raises it to 140. The implementing agent is writing red regressions and fixing both; a further fresh gate is mandatory.
- Current combined TypeScript/LOC checks are blocked by the other session's active plan-queue debug work. It has continued editing those files; preserve them until ownership or completion is clear.
- The second fresh reviewer returned `VERDICT: FAIL` on the Codex slice. In addition to the two reproduced LT-597 defects, it flagged a rollout-only child receipt written after the one-time root-boundary scan: absent a child notification or later root turn, that receipt is never revisited. The implementer is assessing a bounded reconciliation path. Do not mark LT-596/597 complete on the 46-test result.
- The implementer reports both LT-597 cases reproduced red and passing after fixes, plus a red/green late-child-receipt case. The latter uses three bounded post-turn retries (250 ms, 750 ms, 2 s), per-thread deduplication, and timer cleanup on terminate. Focused tests currently report 49/49 passing. His final checks and another fresh gate are pending; this is an implementer report, not independent acceptance.

## 2026-09-23 third gate in progress

- Codex LT-596/597 follow-up now reports 49 focused tests and both TypeScript checks, lint, LOC, and whitespace gates passing. The earlier concurrent plan-queue TypeScript/LOC errors have cleared; no plan-queue file was changed by this task's agent.
- On the current combined tree, `rtk npm run build:main` and `rtk npm run build:renderer` both exited zero; `rtk proxy git diff --check` exited zero. A new full `rtk npm run test:quiet` suite is running after the Codex fixes. Fresh independent review must follow.
- The bounded child-receipt retries stop after about three seconds; receipts later than that need a later root turn to be observed. This limitation requires independent acceptance review against LT-596 rather than a completion claim from the implementer.

## 2026-09-23 latest continuation checkpoint

- The only active plan filenames remain the 2026-07-19 live-test remediation plan and the 2026-08-03 GitHub Actions remediation plan. Both remain untracked. No branch, worktree, commit, or push was created.
- LT-029 now keeps the Keychain root excluded and routes credential failures to profile-correct sign-in/retry guidance; LT-441 rejects ungranted Claude config directories on hardened spawn and grants only derived account-profile homes. The original resident Claude OS write escape still requires privileged live tracing. Both have focused passing tests and linked live checks.
- LT-543 now passes a persistent user-data log directory to the browser forwarder and bounds inactive log retention, with a startup grace period. LT-050 now waits for a Codex turn to release before delivering a child-ID confirmation and marks admission/audit complete only after successful send. Focused tests, TypeScript checks, lint, LOC, and both builds passed on the settled code.
- The remediation plan/register gained 40 missing LT-539–613 records and corrected stale headings; LT-189's fallback banner was verified present. The seven explicitly excluded historical follow-ups remain outside the current plan acceptance unless James broadens scope.
- GitHub Actions Task 3 is now evidenced: current production deploy passed; four production secrets and vault fields exist; installed wrapper bytes match source; deployed Sentry DSNs match three Community Tech projects; FCM key/project/account and direct sender role match. Synthetic event/alert delivery and inherited IAM are in the linked `_livetest.md`.
- An interim combined full suite passed 2,214 files / 26,372 tests before LT-543/LT-050. The first post-fix full suite exited 1 with 30 `standaloneDocumentPathTitle is not a function` failures in unrelated title files changed concurrently during the run. Current focused title/auto-title specs then passed 2 files / 61 tests. A second post-fix full suite is running as session 67297; it is not yet completion evidence. Fresh completion-gate review, final as-built notes, and plan/spec renames remain pending.

## 2026-09-23 verified gate and handoff state

- The second post-fix full suite **exited zero**: 2,218 files and 26,397 tests passed; complete log `_scratch/test-run.pid-19931.log`. The separate title/auto-title focused rerun passed 2 files / 61 tests. The earlier 30-failure full run remains recorded as a concurrent-edit race, not discarded.
- On the current shared tree after the title edit, `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`, `rtk npm run check:ts-max-loc`, `rtk npm run build:main`, `rtk npm run build:renderer`, and `rtk proxy git diff --check` all exited zero.
- A genuinely fresh `task-completion-gate` agent (`/root/final_completion_gate`) is reviewing the existing diff and acceptance evidence. No verdict has been received. A context-policy `steer-turn` had asked the running agent to wrap up broad exploration *(not a James instruction — attribution corrected 2026-09-24 under LT-653)*, so this gate is confined to identified changed paths and evidence; no new research thread should be opened.
- The two active plan files and the linked planned spec remain untracked and unrenamed. Do not call them complete until the fresh gate returns `VERDICT: PASS` with no actionable finding. If it passes, update final as-built/status and the spec's plan link, then rename the two plans and linked spec to `_completed.md`; update existing link targets that would otherwise break. The GitHub Actions live checks and LT-029/LT-441 live/privileged checks remain in their `_livetest.md` files, not claimed as passed.
- Preserve unrelated concurrent Windows-worker and title edits. No commit, push, branch, or worktree was created for this task.

## 2026-09-23 fresh completion-gate finding

- The fresh reviewer returned `VERDICT: FAIL` on one actionable LT-543 edge: a forwarder owner marker older than one hour can be treated as dead even while its PID is alive, so a sweep after system sleep may delete active logs. Its independent focused run passed 65 tests and found no other actionable issue in the scoped review. The LT-543 owner is fixing this with a failing-first live-PID/old-marker regression. Focused and final verification plus a **new** fresh reviewer are required afterward. No plan/spec has been renamed.

## 2026-09-23 post-fix verification and second gate

- LT-543 now preserves a log directory whenever the owner PID is confirmed live, regardless of marker age; a sleep/old-marker regression failed before the fix and passes after it. The conservative tradeoff is that a reused PID can retain an inactive directory longer. The implementer reported 64 focused tests and both typechecks, lint, LOC, main build and whitespace gate passing; root also reran the renderer build successfully.
- The final post-fix `rtk npm run test:quiet` exited zero: **2,218 files / 26,397 tests passed** in 233.2 seconds, full log `_scratch/test-run.pid-17614.log`.
- A different fresh `task-completion-gate` reviewer (`/root/post_fix_completion_gate`) is reviewing the repaired edge and existing acceptance evidence while broad exploration is wrapped up per a context-policy `steer-turn` *(not a James instruction — attribution corrected 2026-09-24 under LT-653)*. Verdict pending. Both plans and the linked planned spec remain untracked and unrenamed; no completion claim yet.

## 2026-09-23 final code and review result

- The second genuinely fresh completion-gate reviewer returned `VERDICT: PASS` with no actionable findings. Its independent LT-543 retention check passed 7/7. No code changes followed that verdict.
- Final canonical checks all exited zero: both TypeScript checks, lint, LOC, main and renderer builds, and `test:quiet` (2,218 files / 26,397 tests; `_scratch/test-run.pid-17614.log`).
- Both active plans and the linked GitHub Actions spec were updated as built and closed with `_completed.md` filenames. Remaining rebuilt-app, privileged, and external checks stay in their linked `_livetest.md` documents. No live check was silently marked passed. No commit, push, branch, or worktree was created.
