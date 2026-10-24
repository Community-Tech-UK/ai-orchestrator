## Verifier findings (23 Oct, coordinator handoff)

1. High - LT-707 cost-history RESTORATION is not in this diff. The recovery flow is implemented on the July remediation
   follow-up's queue branch (`cost-entries-a0-restore.ts`, fixture tests, James-controlled `cost:history-restore-*`
   channels) - do NOT reimplement it here; once that item lands, reference it and re-verify.
2. Medium - Steps 7/8 still carry Phase B integration requirements (the checker pass-rate companion is not yet
   integrated into `scripts/codex-helper-trial-report.mjs`; the short-message policy vs code-index blocks check is
   open). Finish those integration checks.


# Oct-2 Phase A: safety and truth (small fixes that stop work being lost and numbers being wrong)

## Status

On main: no. Whole plan remains OPEN on `queue/2026-10-20-oct2-phasea-safety-d0099e`
(HEAD `665a250d6`; merge `599719575`). On 24 October the worker repaired the round-8
verifier's three findings (RED/GREEN): UI hints surfaces and records —
`SettingsCardComponent`'s `title` input renamed to `heading` at all five call sites,
the instance-row helper-count close wording made statically measurable (unreadable back
to its recorded 3) via a template `@let` count with unchanged rendered strings, the
removed hour copy retired and the once-once meaning line plus helper-close fragment
recorded; scheduled Codex runs keep `automationRunId` as `runId` and the usage log
measures every durable machine thread (durable chats stay silent); the architecture
inventory is regenerated and `verify:architecture` exits 0. Both builds, typechecks,
lint, LOC and IPC/contracts/exports pass; build:main refreshed the committed codex
protocol snapshot (installed CLI 0.164.0, matching the verifier's own build). One
broad-replay failure is a pre-existing install artifact (extraneous toml-eslint-parser
from the root checkout's uncommitted manifests), not source.

Next: obtain current independent acceptance (the assigned verifier owns clean-install/full-suite
canonical gates). Steps 7/8 await Phase B; Step 14's commit boundary, LT-707 restoration and
deferred live checks remain open. No commit, branch change, installation/restart or completion
rename was performed. Evidence: root
`_scratch/queue-resume-2026-10-24/phasea-round8-remediation/worker-report.md`;
historical context remains in [history](2026-10-20-oct2-phaseA-safety-and-truth_history.md).

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items K1, K2, L1, L3, T2 (steps 1-3), T3 step 1,
T4, T12, T15.1, H2, U5, U6 step 1, U4's phone label, K7, and from the fact-check (`_scratch/oct2-audit/_verify-3.md` S2)
K3.6's minimal usage line and K3.5's one-off credit check. **Programme:** A (this) ·
[B](2026-10-20-oct2-phaseB-land-built-work_plan.md) · [C](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md) ·
[D](2026-10-20-oct2-phaseD-tokens_plan.md) · [E](2026-10-20-oct2-phaseE-calm-screen_plan.md) ·
[F](2026-10-20-oct2-phaseF-tooltips_plan.md) · [housekeeping](2026-10-20-oct2-housekeeping_plan.md) ·
[later](2026-10-20-oct2-later_plan.md) · [decisions](2026-10-20-oct2-decisions-for-james_completed.md).

## In plain English

### Coordinator integration checkpoint

Resume the original item `5d4d9b4c-0ca5-482c-8929-fe1601d0099e` on retained branch
`queue/2026-10-20-oct2-phasea-safety-d0099e`; do not create a duplicate attempt.
This checkpoint prepares prerequisite code for integration, not whole-plan closure. Preserve every requirement
and unchecked item below. Step 7's original-report integration and Step 8's post-landing policy comparison
remain implementation work after Phase B; genuine live checks remain in the linked livetest.

Workers and assigned queue checkers: run commands in the foreground and wait for their actual exit status.
If a tool yields a running process/cell, keep polling until it finishes. Wait for every helper reviewer too.
Do not end your turn to wait, use a wakeup as a completion signal, or treat child SUCCESS as acceptance.
The installed queue does not yet contain this branch's Step 4 protections.

Before integration, independently verify the entire retained code diff after AIO's base synchronization,
using `task-completion-gate`, all canonical gates including the full suite, and fresh review of all touched
surfaces. Report any actionable defect as FAIL and fix it through this original item. The assigned checker
must follow the completion gate's broad-diff/security escalation with `repo-health-audit`; the scoped
Step 4 probe alone is not acceptance of the 138-file handoff. The assigned checker
must also supply the completion gate's clean-state, lockfile-exact installation evidence; the worker's
supplied/shared dependencies and old passing logs are not independent clean-install evidence. Keep any
installation inside the AIO-managed checkout and preserve the root checkout's supplied dependencies.
If that gate cannot be performed, report its precise limitation and do not certify it as passed.
The round-2 checker declined npm ci because the root postinstall also changes shared Git configuration
and the global ignore file. Source inspection confirms those side effects, but matching the existing
installed lockfile is not a clean install. Investigate a lockfile-exact `npm ci --ignore-scripts` inside
this AIO-managed checkout, followed by explicit required dependency/native initialization and ABI checks
per the native-packaging runbook, without running the shared Git-hook/global-ignore installers. Preserve
supplied dependencies for safe restoration; do not install into or rebuild the root dependency tree.
Document every disabled lifecycle step and actually run all required build/test initialization before the
canonical gates. This is a proposed isolation route to verify, not permission to report a failed or
incomplete install as passed. Do not alter repository manifests/locks or weaken checks to make it work.
Use the exact existing registered AIO checkout for that installation and its canonical gates; its real Git
index already satisfies index-dependent generators. Do not create an additional checkout/clone, Git worktree,
Git-init snapshot or manual snapshot commit for this gate. Standard automated specs may retain their isolated
Git fixtures. Preserve supplied dependencies separately, install fresh dependencies in the managed checkout,
run required lifecycle/native initialization there, then run and await the canonical gates on that same tree.
The assigned checker
must call `plan_queue_report_verdict` before ending its turn, including when checks fail. Only when this
code-integration checkpoint actually passes may it report `PASS` with `document_complete: false`.
That supported result permits integration without closing this plan; it does not certify the remaining
implementation or live requirements. Do not report whole-plan completion, rename documents, use Land anyway,
manually merge, or waive a failed/missing gate. Record exact evidence and remaining work in the root history.


**Round-1 finding — worker repair verified; independent queue acceptance pending.** A checker can reply to the
same-session verdict nudge by calling `plan_queue_report_verdict`, emitting tool events and no nonempty
assistant text, then completing. `beginTurn` resets `seenAssistantOutput`; tracker complete/idle handling
requires it; reportVerdict only stores the pending verdict. The completed report-only turn therefore does
not reach finishVerification and can remain verifying. Actual Codex completed-turn handling permits empty
content. The root-only cutoff continuation is not guaranteed for queue children.

Read the focused report at `_scratch/queue-resume-2026-10-21/phasea-nudge-output-review.md` in the root checkout.
Reproduce with a real tracker/nudge/flow regression, then fix the smallest complete lifecycle seam. Acceptance:
(1) a report-only nudged turn settles and consumes its pending verdict; (2) a genuine second completed turn
without a verdict is handled without stalling; (3) initial spawn-settling events still cannot finish an
unstarted turn; (4) background inhibitors and one-nudge bounds remain effective. Trace actual provider event
mapping and continuation behavior; do not require invented assistant prose or accept a pending verdict before
its turn has really finished. Preserve foreground execution, rerun affected/final gates and obtain another
fresh completion-gate review. The isolated probe is not a claim that a live incident was observed.

The assigned checker has now submitted a real round-1 FAIL with eight findings; the original item is fixing.
Read the exact preserved verdict at root `_scratch/queue-resume-2026-10-21/phasea-round1-actual-verdict.json`.
Use `receiving-code-review`: reproduce each concern, repair confirmed defects, and support any dispute with
concrete source and behavioral evidence. Preserve the Step 8 intent and investigate the prior rationale for
discarding all stale blocks; do not silently rewrite acceptance to obtain a PASS. The full-suite command exited
1 on a Local AI Guard timeout; that file's isolated passing rerun does not turn the full gate green. A current
successful full run remains necessary after corrections, without suppressing or weakening the unrelated test.

**Additional Step 4 finding — delayed completion crosses the nudge boundary (worker repair verified).** The first
report-only repair is necessary but not sufficient. A fresh source review found that InstanceCommunication
captures the old request count, then awaits output/evidence drain before publishing normalized complete.
Codex independently publishes idle after sendAppServer returns. That idle can settle the old turn, allowing
the verdict nudge to begin and publish new busy, before the old complete is released. The repaired tracker
accepts any complete after busy without a turn/request-count fence and can prematurely settle the new turn.
This is a source-proven admissible scheduling path, not a claimed live occurrence or end-to-end reproduction.

Read root `_scratch/queue-resume-2026-10-21/phasea-nudge-late-complete-review.md` and trace the actual provider,
communication and flow lifecycle before changing it. Add a failing regression with a held real communication
evidence drain, idle-first settlement, new nudge busy and release of the old completion. It must assert no
premature second outcome and then acceptance of the new turn's own completion/verdict. Fix completion ownership
or lifecycle serialization at the appropriate seam; do not merely ignore stale events before busy, because
the confirmed gap is after busy. Retain tool-only/empty completion, initial-spawn protection, background
inhibitors and one-nudge bounds. Recheck all original round-1 findings, rerun current gates and obtain a fresh
independent completion-gate review. Earlier green lifecycle tests do not cover this ordering.

**Prior repair: third assigned-verifier FAIL (dispositioned; latest FAIL below).** Resume this original retained item after its round-limit
park; do not create a duplicate. Read the complete machine verdict at root
`_scratch/queue-resume-2026-10-21/phasea-round3-full-verdict.json`; the queue detail lists only five of its six
findings. Apply `receiving-code-review`: reproduce confirmed behavior before fixing; support disputes with
source and behavioral evidence. Address all six; low confidence is neither proof nor permission to ignore.

1. Restore per-child SUCCESS/FAILED results in the visible all-children-completed transcript. Trace the actual
   formatter consuming `data.summaries`. Keep only newly included child IDs, delivery acknowledgement and the
   encoded payload bound; restoring the old unbounded array would regress Step 5. Add a real formatter/delivery
   regression and measure the whole payload if it now carries both message and structured summaries.
2. Trace `active-plan-documents.ts` through harvest/auto-integration and align its history/open-decisions rule
   with queue squash and the commit hook. Prove active files are refused on each affected surface and closed
   `_completed` variants remain allowed. Do not change the shared index or stage active lifecycle documents.
3. Reproduce identity mismatch versus operational Git failure (including timeout). Keep every failure safe:
   no commit/reset/spawn in an unproved checkout. Distinguish inability to inspect from a proved foreign folder;
   do not solve the wording concern by treating a failed probe as a valid checkout.
4. Check non-verifying Pause failure and restoreVerifier-throw paths for stale role IDs, snapshots and pending
   verdicts. Prove teardown and late-result behavior, then repair confirmed cleanup gaps without weakening guards.
5. Trace real loop/headless Codex invokers and persistent-loop usage delivery. Preserve actual job/run linkage
   where available and explicit unknown native metrics; never invent IDs/counts or substitute a trial key
   without proving it is the required identity. Add actual data-flow coverage for the intended Step 6 measurement.
6. Investigate the build-stamp dirty-flag concern against Step 2's intent. Preserve truthful detection of untracked
   production source/runtime assets. Do not hide source changes or rewrite acceptance just to remove a low-value
   docs-only label; a justified dispute is acceptable when the present behavior is the required truthful signal.

Rerun affected/static/build checks, obtain a genuinely fresh independent review of the entire updated retained
diff, and fix/review again until no actionable finding remains. The assigned queue verifier must then run its
current clean-state/full suite and report its actual tool verdict. Preserve every original open dependency.
Before any final verifier tool call, archive its raw command logs, actual exit receipts, review reports and seals
under the ROOT `_scratch/queue-resume-2026-10-21/` (evidence only), link them in the root history and record cleanup.
AIO removes the managed checkout after parking/landing. Exclude dependency trees and temporary source snapshots
from that archive; preserve the shared root dependencies and clean up only verifier-created temporary fixtures.
Do not use a stale gate file as proof of command progress or success; reconcile all command exits and locations.

**Prior repair: actual FAIL after the `verifier-r5` clean gate.** The original item is already fixing
through AIO; do not create another job. Read all four findings and actual gate exits in root
`_scratch/queue-resume-2026-10-21/phasea-round5-full-verdict.json`. Prior clean/static/full commands all passed;
new defects still require reproduction and repair, or a substantiated dispute under receiving-code-review.

1. Exercise spawnVerifier's StoppedByUser catch with restoreVerifier throwing a checkout/inspection error.
   It must reach a safe recoverable state with stopped IDs/roles cleared and the verification slot released,
   not remain verifying without a tracked checker. Cover the real item-flow transition/slot behavior.
2. Exercise a boot-recovery item's park failure. Recovery must continue for later items and report the first
   failure observably; it must not claim that the failed item recovered or silently abort the outer loop.
3. Reproduce overlapping all-children builds while the first delivery is pending. Keep pending delivery
   ownership separate from confirmed acknowledgement so successful overlapping prompts do not duplicate a
   child. Trace actual held/suppressed/redelivery/failure outcomes and parent cleanup; failed or discarded
   delivery must not permanently lose eligibility. Preserve new-only results and the whole encoded bound.
4. Exercise a transient inspection failure during verifier rollback with deliberately changed verifier fixture
   files, then Resume/recovery. Preserve a guarded rollback obligation until restoration succeeds, before any
   worker checkpoint can adopt unreverted checker edits. Clearing stopped roles is still required; neither
   a stale forever-owned snapshot nor deleting the only rollback anchor is a safe solution. Trace the actual
   checkpoint/reattach/persistence lifecycle before choosing a minimal design and test the resumed path.
   Cover both ordinary uncommitted checker edits and an improper checker commit, in the same process and a
   fresh/restarted flow. Include the negative case: legitimate uncommitted worker work without a pending
   verifier rollback must remain intact and must not be mistaken for unrestored checker data.

Keep existing safety and dispatch/native-write regressions. Freeze the corrected source, rerun affected and
static/build checks, obtain another genuinely fresh whole-retained-diff review, then let the assigned AIO
checker perform current clean/full gates and call its verdict tool. Use the registered checkout, preserve
root dependencies, archive all raw evidence in root before the tool call, and keep document_complete false.

**Prior repair: assigned-verifier FAIL at `8522d97b8` (repaired; latest findings below).**
Reproduction/raw evidence is in root `_scratch/queue-resume-2026-10-21/phasea-round6-verifier-evidence/`;
repairs and historical review results are in `phasea-round2-rollback-evidence/`.

1. Reproduce ordinary Git restoration errors, including index-lock failure, through actual verifier outcome,
   parking and run-hold paths. Every restoration failure must release stopped roles/verification slots and
   reach a safe recoverable state without checkpointing checker edits. Preserve both the in-memory baseline
   and a durable rollback obligation until restoration succeeds. Cover same-flow and JSON-persisted fresh-flow
   Resume with committed and uncommitted checker edits, and preserve legitimate worker edits without an obligation.
2. Reproduce a parked detail exceeding 8,000 characters. The persisted rollback obligation must survive the
   bound and restart; Resume must restore before reattachment/checkpoint. Do not merely weaken the length bound.
3. The fresh remediation review returned FAIL for a disappearing checker checkout. Read
   `phasea-round2-rollback-evidence/fresh-review.md` and its independent runnable probe. Preserve the worker
   baseline/obligation when the folder is absent; a null path is not successful restoration. Recover an
   identity-proven item checkout and restore before ordinary reattachment can advance checkpointCommit, or
   refuse safely. Cover parking, hold and recovery, same/fresh flow, improper checker commits and legitimate
   worker changes. Do not solve it by resetting or removing unrelated work.
   A different fresh review also returned FAIL: `phasea-round2-rollback-evidence/fresh-final-review.md`.
   A locked missing-checkout registration makes its release throw before restoration handling. Cover actual
   Git lock failure for Hold/Park and boot recovery, durable state after restart and Resume after operator
   unlock. Preserve the deliberate lock; do not force-remove it. Park safely, clear stopped IDs/slots and
   retain rollback before any reattachment/checkpoint.
4. Investigate the meaningful-stop native-process full-suite failure. Preserve the original failure and
   three isolated passing reruns plus the passing full rerun; substantiate a flake disposition or repair its
   cause without weakening production behavior or test expectations. The next fixed-tree verifier still owns
   current lockfile-exact clean installation, required initialization and all seven canonical gates.

The supplementary independent matrix at `rollback-matrix-independent/report.md` passed six inspection-error
and legitimate-worker cases. It is scoped evidence only, not coverage of ordinary Git errors or long details.
Obtain another genuinely fresh retained-diff review after fixes, then an actual assigned checker verdict.
Archive evidence in root before its verdict; keep all original requirements and document_complete false.

**Latest assigned-verifier FAIL at `10ae5af5b` (worker repairs below; independent acceptance pending).** Resume the original retained item after its
round-limit park. Read all five findings in root `_scratch/queue-resume-2026-10-21/phasea-round7-full-verdict.json`
and `phasea-round7-verifier-evidence/README.md`. Use receiving-code-review: reproduce, repair confirmed
behavior, or support any dispute with source and behavioral evidence. All gates passed; that does not
waive these findings. No duplicate job, manual integration, Land anyway, renamed completion or real-data write.

1. Reproduce actual locked-registration failure for a vanished landed checkout through finishCleanup and
   the coordinator pump. A release failure must not leave stale session IDs/pending cleanup that silently
   skips the whole run forever. Respect the Git lock, retain required cleanup/recovery evidence and prove
   subsequent items can progress safely; do not force-remove the lock or lose branch/worktree custody.
2. Reproduce cost provenance across a queue parent summary followed by direct adapter sends from real
   orchestrator-response/lifecycle replay or mode-change paths. A completed queue turn must not label later
   unrelated work plan-queue-parent/plan-queue. Bind/consume provenance at its actual dispatch/completion
   boundary, preserving queued/native input, request-count fences, delayed completion and overlapping-send
   regressions. Do not merely clear whichever newer turn happens to be current when an old completion arrives.
3. Reproduce checkout refusal before any checker has actually started. Do not claim checker restoration is
   pending when no checker could have edited anything. Keep foreign-folder refusal safe, while preserving
   genuine rollback obligations for started checkers, including cancelled spawn before ID publication,
   missing/locked checkout, partial rollback and persisted fresh-flow recovery.
4. Reproduce persistent loop app-server re-initialization/resume with historical cumulative token usage.
   Seed/bound the usage baseline so pre-resume history is not booked as new input/request count. Trace actual
   notification/init/begin ordering; preserve new-thread accounting, deltas, unavailable metrics, max-request
   measurement and real loop/job identity. Do not invent historical request counts or turn unknowns into zero.
5. Reproduce the generic-install first Claude per-turn cost row booked just before its first purpose record.
   Protect already-correct per-turn rows at that boundary without masking a broad range of genuinely cumulative
   history. Preserve the fingerprinted-install protection, provider separation, transactional backup/idempotency
   and unchanged migration checksums. Support the selected boundary with source/fixture evidence; no scripts
   against James's real database/settings.

Rerun affected and all static/build checks, freeze source and obtain another genuinely fresh whole-retained-diff
completion-gate review with repo-health-audit escalation. Fix/review until no actionable finding remains, then
let the assigned checker perform current clean-install/full canonical gates and its actual verdict. Archive all
raw receipts/reviews/seals in root before the verdict; preserve dependencies and keep document_complete false.

**Current checker recovery at `a656f3b58`.** The original main-run item remains the only prerequisite
in scope. A supported Pause interrupted the replacement after the first installed Claude checker ended
without a verdict; this is not a failing code verdict or plan completion. Read root
`_scratch/queue-resume-2026-10-21/phasea-checker-foreground-incident.json`,
`phasea-r8-checker-missing-verdict-paused.json` and `phasea-checker-dependency-recovery.json`.
The original supplied node_modules was restored before alternate checker starts. The interrupted fresh
dependency tree was preserved ignored, then AIO removed that old managed checkout when Grok failed and
parked the item. The current checkout was recreated by supported resume-item from a656f3b58; use its
current AIO-supplied dependencies. Paused replacement evidence remains in root phasea-paused-r9-evidence/.
Never copy dependency/source trees into the evidence archive.

The initial alternate Antigravity checker failed before doing verification. AIO selected the static
Gemini 3.5 Flash (Medium), absent from the authenticated live agy model list. The legacy gemini route
actually selects agy, not the standalone gemini CLI; do not treat their installation/auth as interchangeable.
The run was paused again, preserving source and the first errored counter. No global catalog/settings edit.

The SuasMimo checker reached the provider but was limited before doing verification; its reported reset
is 22 October 23:59:59 UTC and the fresh monitor cache shows plan/monthly allowance at 100%. It was
paused without accepting it. The one ComTechSpare startup also reached a provider limit before verification and was paused.
The Grok route authenticated and selected live grok-4.7, but native inference repeatedly returned HTTP429
and the installed queue parked verifier-unreliable after the second errored attempt. Monthly 0% was not
proof of short-term capacity. Keep that failure; do not retry unchanged or reset counters manually.
Only this run's checker route is now Cursor, model claude-opus-5-5-high, through supported set-routing.
Supported resume-item reopened the original branch at the worker handoff stage. There is no new code
finding: confirm the retained source seal and hand off for assigned verification; do not invent changes
or repeat old failures as fresh work. Any actual source edit still needs current checks and a new fresh review.
Cursor-agent live models lists this exact Claude Opus 5.5 High ID; its included usage cache is about
93.67%, so preserve normal provider quota/credit policies. This is a separate backend from Claude CLI
and has a different model family from the Codex worker. Neither cache nor startup is acceptance.
Resume this parked original item with supported resume-item after route validation; no duplicate.
Preserve the CodexSUAS worker and all other runs. Resume the run through AIO;
do not resume-item from awaiting-slot,
create a duplicate, manually integrate, reset the errored counter, or report a verdict as the parent.

Assigned checker: inspect the entire retained diff/current acceptance and the fresh PASS at root
`phasea-round3-remediation-evidence/fresh-session-review/report.md`; independently execute current clean
install/required initialization and all seven canonical gates in this exact registered managed checkout.
Do not reuse interrupted r8/r9 attempts or earlier green runs as current acceptance. Preserve supplied
dependencies; skip only the documented shared hook/global-ignore installers and initialize required native
dependencies explicitly. No extra checkout, Git-init snapshot, manual commit or weakened gate.

The assigned checker is itself a genuinely fresh, independent context which did not implement the work.
Perform its entire retained-diff audit directly; do not spawn helper/subagents or parallel model fan-out.
This avoids the observed background-wait failure and further provider throttling. It does not waive the
worker's already-preserved fresh review, any audit surface, clean install, full suite or actual verdict.

The recreated checkout's focused native-worker tests need compiled dist/main/cli/spawn-worker assets.
After clean install/initialization, run build:main before those tests. The resumed worker demonstrated three
missing-module failures before build, then unchanged native file 20/20 and full selection 1,292/1,292 PASS.
Evidence: root phasea-resumed-worker-a656f3b58/worker-report.md. This is setup ordering, not a test waiver.

Run and await commands in the foreground. Do not use run_in_background, shell backgrounding, Monitor,
ScheduleWakeup or end a turn to wait. If the native tool yields a running command, poll its supported
foreground-wait mechanism until the actual exit. Wait for every reviewer before ending. The installed
queue still lacks this branch's Step 4 protections. Archive exact raw logs, exits, reviews/seals and cleanup
receipts under ROOT `phasea-cursor-bc8c0f404-verifier-evidence/` before calling plan_queue_report_verdict.
Preserve the prior a656 Cursor evidence; do not overwrite earlier reports/receipts as if current. A genuine
PASS may use document_complete:false for code integration; FAIL must report all actionable findings and
then the same original item repairs them. Do not claim whole-plan completion or waive missing/failed gates.

Fourteen fixes, most of them small, plus one tidy-up that makes room in two crowded files. Together they:

- stop the next restart cutting about a fifth off correctly recorded Claude cost figures (Step 1), then prove the October
  fixes are actually running (Step 2);
- stop the plan queue saving files into the main project by mistake, or ever running its "undo" in the main folder
  (Step 3);
- stop Claude checkers being written off for waiting on their own tests (Step 4);
- stop the queue waking the chat that started it after every job, about 5.3 billion Codex tokens in ten days (Step 5);
- keep Harness's own Codex work below the size where OpenAI's published price doubles (Step 6);
- fix five small things that mislead today: memory search on machine messages, an OpenCode row that never finishes, a
  dead tooltip, a close dialog that doesn't mention helper sessions, and "Allow once" lasting an hour (Steps 8-12).

**What James does:** answer the decisions (link above); restart Harness twice, when this plan says so and only when no
live sessions would be lost (after Step 1, then at the end).

## Ground rules

1. **Read first.** Line numbers are from the 20 Oct working tree (main `0190f9133` plus about 180 uncommitted paths from
   other sessions); trust function names. Read the whole file, its callers and specs before editing.
2. **Prove it first.** Write the named failing test, see it fail on today's code, then change code.
3. **Current checkout only.** No branch or worktree. Files already modified when you start belong to other sessions:
   never stage, revert, reformat or `git stash` them. In particular `orchestration-handler.ts` has another session's
   uncommitted child-completion redelivery edit (`trackSuppressedChildCompletion`): Step 5 works around it and never
   rewrites it. Commit only when James asks.
4. **File size** (`npm run check:ts-max-loc`): non-allowlisted files cap at 700 lines with no slack; allowlisted files
   at ceiling + 50. Tight here: `plan-queue-item-flow.ts` 697/700 and `plan-queue-coordinator.ts` 700/700 (Step 0 makes
   room), `orchestration-handler.ts` 1,360/1,361, `instance-lifecycle.ts` 3,641/3,641 and `instance-communication.ts`
   2,545/2,546 (edits must be net zero), `instance-manager.ts` 2,472/2,522, `permission-manager.ts` 1,206/1,260,
   `instance-list.component.ts` 1,483/1,485, `instance-handlers.ts` 1,301/1,301 (Step 11: net zero),
   `adapter-factory.ts` 795/798 and `codex-app-server-adapter.ts` 753/754 (Step 6: a line or two at most, otherwise a new
   module), `settings.types.ts` 885/889 (new settings keys go in a new settings-types module that the main type extends).
   New logic goes in new modules. Never raise a ceiling.
5. **Never restart or reinstall Harness yourself, and never with live sessions.** James normally runs the installed app,
   which does not read `dist/`. So "ready to restart" means: build the packaged app from this (main) checkout with
   `npm run localbuild` (never from a worktree) and tell James it is ready to install. Do not start the packaged app on
   the Mac to check it: a packaged build ignores the dev data-folder override, so it would run the migrations and the cost
   repair on James's real data. Checks before handing over are headless (specs, the build succeeding, migration names
   asserted in tests); a start-up smoke test (`npm run smoke:packaged`) runs only on the Windows PC, or on the Mac with
   James's OK. If he runs a dev checkout instead, `npm run build:main` and `build:renderer` are enough.
   Either build compiles the whole working tree, including other sessions' uncommitted files: say so when asking, and ask
   whether to wait for them.
6. **Never write to James's databases or settings from a script;** read-only queries use `?mode=ro`.
7. **No browser or desktop app on the Mac.** Renderer behaviour is tested headless in Vitest; eyes-on checks go to the
   live-test document and run on the Windows PC. If the Windows PC is down, stop and tell James; never fall back to the Mac.
8. **Words on screen:** plain English, "Harness", `appTooltip` not `title=`. Angular: standalone, `OnPush`, `inject()`,
   signals, `input()`/`output()`.
9. Keep the Status block under about 1,500 characters; rewrite it in place. The history file is guarded by Step 0's rule.

## Order of work

| Step | Item | Size | Waits on | Main files |
|---|---|---|---|---|
| 1 | K1 cost-history repair cutoff | XS-S | nothing; **first** | `cost-entries-a0-repair.ts` |
| 0 | Make room in two queue files; guard `_history` files | S | after Step 1; before Steps 3-5 | `plan-queue-coordinator.ts`, `plan-queue-item-flow.ts`, new modules, `plan-queue-squash.ts` |
| 2 | K2 restart and prove October fixes run | S | Step 1 built, gated and reviewed; James restarts | read-only queries; Settings > About |
| 3 | L1 queue identity guard | S | nothing | *`plan-queue-checkout-guard.ts`*, `plan-queue-worktree.ts`, `plan-queue-git.ts`, `plan-queue-landing.ts`, `plan-queue-run-hold.ts`, `git-env.ts` |
| 4 | L3 checkers wait for their background work | S-M | nothing | `plan-queue-instance-tracker.ts`, *`plan-queue-verdict-nudge.ts`*, `plan-queue-prompts.ts` |
| 5 | T4 queue stops waking the parent chat | S-M | fix 3: Decision 6 | `instance-child-completion-handler.ts`, `orchestration-handler.ts`, `plan-queue-parent-messenger.ts` |
| 6 | T2 Codex machine work under 272K, plus measurement | S | Decision 3 | `codex-thread-policy.ts`, `codex-thread-requests.ts`, *`codex-ephemeral-usage-log.ts`* |
| 7 | T3 step 1: pass rates in the helper trial | XS | Decision 13; the report part waits for Phase 1 to land (Phase B Step 8) | `codex-helper-trial-report.mjs` (Phase 1 branch only today) |
| 8 | T12 no retrieval for machine messages; drop late blocks | XS | nothing | `instance-manager.ts`, `instance-input-contexts.ts` |
| 9 | T15.1 OpenCode cancelled compaction | XS | nothing | `opencode-acp-updates.ts` |
| 10 | H2 dead tooltip | XS | nothing | `instance-list.component.ts` |
| 11 | U5 closing a session with helpers | S | nothing | `terminate-confirm-dialog.component.ts`, `instance-termination.ts`, IPC schema |
| 12 | U6 step 1: "Allow once" means once | XS-S | Decision 8 | `permission-manager.ts`, `user-action-request.rules.ts`, `tooltip-copy.ts` |
| 13 | U4 phone label (desktop half) | XS | nothing | `mobile-gateway-push.ts` |
| 14 | K7 stop tracking the mistakenly committed plans | XS | Decision 2 | git index only |

Steps 3 and 4 both edit the queue's item-flow and coordinator and share Step 0's room: do 3, then 4. Steps 8 and 11 both
touch `instance-manager.ts`: do 8, then 11. The other steps share no files, so they can run in any order after Steps 1
and 0.

---

## Step 1. K1: give the Claude half of the cost-history repair its own cutoff

**What's wrong.** Migration 077 stamps the cutoff `a0-per-turn-booking-live` as the moment it runs
(`rlm-migrations-076-080.ts:18-35`). The repair (`cost-entries-a0-repair.ts:21-47`) treats every Claude-alias row older
than that as a running total and subtracts the previous value per session. Per-turn booking has run in James's app since
his 17 Oct 08:31:19 restart, so the first start on current `main` would cut those correct rows by about 20% (613 rows,
$2,203 → $1,751 by late on 19 Oct, growing daily). It runs at every start until the `a0-cost-deltas` marker exists
(`cost-handlers.ts:67`). The built files in `dist/main` (last rebuilt 20 Oct 01:08) already contain it, so even a normal reopen from
the project folder would run it. Originals are backed up first, so nothing is lost for good.

**Constraints.** Do not edit migration 077: an applied migration whose text changed stops the app starting
(`rlm-schema.ts` checksum check), and other builds may already have applied it. Do not add migration 078-081: the Phase 1
and follow-ups branches use them. Do not add a column to `cost_entries`: the backup insert is `SELECT *` into a 12-column
snapshot table (`:31`), so a 13th column would make the repair fail and retry on every start.

**Change.**
1. In `repairCostEntriesA0`, compute the cutoff per provider: Copilot and Cursor keep the migration-time marker (their
   rows are still cumulative until A0's Copilot fix runs). Claude uses the earlier of the marker and the first per-turn
   Claude booking time for this install. `cost_entries` rows cannot tell the two booking paths apart, so derive the time
   from what the per-turn build (`06201b4b0`) added: it is the first build whose cost-attribution records carry a
   `purpose` field, and the repair already reads those files (`cost-entries-a0-repair.ts:70-92`). Before relying on it,
   check read-only against James's data that the first such record matches his 17 Oct 08:31:19 start (a dev checkout or
   queue-worktree build sharing the data folder could have written one earlier; if so, take the first `purpose` record at or
   after an `app.log*` start line of the installed app). If neither source is trustworthy, use a documented constant for
   this install as the last resort. Log which source was used. The test fixture pins James's value.
2. A "stop at the first falling pair per session" rule is not enough on its own (a per-turn row that happens to be larger
   than the previous one would still be differenced), so use it only as an extra guard, never as the cutoff.

**Tests (fail today).** `cost-entries-a0-repair.spec.ts`: add Claude rows before and after a Claude cutoff, and Copilot
and Cursor rows after it; assert Claude rows on or after the Claude cutoff are untouched and absent from
`cost_entries_a0_backup`, while the Copilot and Cursor rows are repaired. Keep `cost-purpose-history.spec.ts` passing.

**Done when:** the spec passes; after the rebuild and restart (Step 2), a read-only query shows no row dated on or after
the Claude cutoff in `cost_entries_a0_backup`, those rows' summed cost is unchanged by the restart, and Copilot and Cursor
rows in that window were repaired.

**Before asking for the restart (fact-check of this plan, S1):** run `npx tsc --noEmit`, `npm run lint`, the two cost
specs and the build in rule 5, then a fresh-eyes review of Step 1's diff alone by a new agent using the
`task-completion-gate` skill, repeated until `VERDICT: PASS`. The repair changes real cost history (with a backup), so it
does not wait for the rest of the plan, but it does not skip review either.

## Step 0. Make room in two crowded queue files, and guard `_history` files

Runs right after Step 1, before Steps 3-5.

1. **Make room.** `plan-queue-coordinator.ts` is 700/700 and `plan-queue-item-flow.ts` 697/700, and neither is on the size
   allowlist, so no slack applies. Steps 3-5 here and Phase C Steps 1-4 all add call sites to them. Move cohesive blocks
   into new modules with no behaviour change, for at least 40 lines of room in each: for example the verdict mapping and
   triage wiring out of the coordinator, and the park/resume helpers out of item-flow. Each moved block keeps its spec
   coverage (move or extend the specs); the full queue spec set must pass before and after with the same test count.
2. **Guard history files.** Add `_history` to `ACTIVE_DOCUMENT_RE` (`plan-queue-squash.ts:30`) with a spec, so an active
   `<stem>_history.md` can never be landed by the queue; `_history_completed.md` stays landable. James's global commit
   guard (`~/.config/git/hooks/plan-spec-guard.sh`, called from `.githooks/pre-commit:6-7`, pattern at its line 16) serves
   every project: change it the same way (Decision 18, answered yes on 20 Oct: add `_history` and open
   `-decisions-for-james.md` pages; a `_completed` decisions page stays committable), and keep the "same rule" comment at
   `plan-queue-squash.ts:29` true either way.

## Step 2. K2: restart on current `main`, then prove the October fixes are running

**Why.** James's running app predates the 18 Oct Phase 0 merge, so A0 (purpose recorder, Copilot correction, helper
records, Costs page panel), A10, A14, A1, A2, A3, C3a and D1 are on `main` but not running. Evidence: no
`cross-model-review` or `fresh-eyes-review` purpose in the cost log since 10 Oct, and 2,297 helper fallbacks with no
provider.

**Change.**
1. After Step 1 has passed its review and the build in rule 5 is ready: ask James to install it (or restart his dev
   checkout) when no live session would be lost, telling him the build also contains other sessions' uncommitted work. Take a read-only snapshot of `cost_entries` totals per provider
   just before.
2. A day later, re-run read-only checks and paste the results into the history file:
   - review purposes appear in the cost-attribution log;
   - helper fallbacks name a provider: `SELECT COUNT(*) FROM local_ai_routing_events WHERE created_at > <restart> AND
     actual_route='frontier' AND provider IS NULL` is 0;
   - Copilot rows are per turn;
   - Step 1's "Done when".
3. Settings > About shows the build commit and the RLM and loop-database migration levels, so "is the fix running?" has a
   one-glance answer. (Read the existing About section first; add two rows.)
4. `showCost`: Decision 15(a) is answered yes. Implemented a one-shot settings migration; subsequent user opt-outs survive. No script writes to the real settings store.

**Done when:** every check in item 2 passes, or each failure is filed as its own defect with evidence.

## Step 3. L1: the queue proves it is in the job's own work folder before any git write

**What's wrong.** Commit `3be08c73a` (15 Oct) put 152 files from the root checkout onto `main`, including 71 active plans
and live-check documents. `parkUnlocked` checkpoints whenever `existsSync(item.worktreePath)`
(`plan-queue-item-flow.ts:591-593`); `checkpoint()` runs `git add -A` with no pathspec when the provisioned-paths file is
missing, then `git commit --no-verify` (`plan-queue-worktree.ts:160-179`, `:299-303`). A plain directory under
`.worktrees/queue/` resolves to the root repository. The same unchecked path feeds boot recovery (item-flow `:147-151`),
Pause (`plan-queue-run-hold.ts:32-33`), landing and base sync (`plan-queue-landing.ts:72-98`,
`plan-queue-item-landing.ts:95-129`), and worst, `restoreCheckpointAfterVerification` → `revertToSnapshot`
(`run-hold.ts:46-55`, `plan-queue-git.ts:56-90`), which in the root would `reset --soft`, `restore` and `clean -f`
James's untracked plans. The only identity check, `assertQueueCheckout` (`plan-queue-orphan-checkout.ts:16`, signature
`(worktreePath, branchName, repoRoot)`), is used only by `reattach` and the reconciler. Neither the checkout-timeout plan
nor the completed orphan-checkout plan covers this.

**Change.**
1. `plan-queue-checkout-guard.ts`:
   - `assertItemCheckout(item, repoRoot)`: the existing four checks (`.git` is a regular file, top level equals the
     worktree, HEAD is the item's branch, common dir equals the root's), throwing a typed `NotQueueCheckoutError` with the
     plain message "The saved work folder isn't this job's own folder; nothing was committed." Keep the existing orphan
     wording for `reattach`.
   - `assertItemCheckoutDetachedOk(item, repoRoot)`: the same without the branch check, for landing, because the squash
     builds on a detached HEAD by design and `restoreItemCheckout` (`plan-queue-squash.ts:56-70`) repairs a crash there.
   - `isItemCheckout(item, repoRoot): Promise<boolean>` to replace each bare `existsSync(worktreePath)`.
2. Call the guard at the top of `checkpoint()`, `restoreCheckpointAfterVerification` (also reached from
   `plan-queue-recovery.ts:82`), every `revertToSnapshot` call (item-flow `:176`, `:442`, `:482`, `:584`),
   `syncItemWithBase` and before spawning a worker, checker or triage session in the worktree. `checkpoint(item, label)`
   and `syncItemWithBase(item, baseBranch)` have no repo root today: add it through `PlanQueueWorktreeDeps` (constructed in
   `plan-queue-bootstrap.ts`) rather than at every call site. On failure, park as `worktree-error` with the plain message.
   Prefer guarding inside the callee (checkpoint, revert, sync) so item-flow call sites do not grow; Step 0 made room for
   the rest.
3. Defence in depth: when a git call's `cwd` contains `/.worktrees/`, set `GIT_CEILING_DIRECTORIES` to the path up to and
   including `.worktrees` for that call only. Git is spawned in four places (`git-exec.ts:12`, `plan-queue-git.ts:30`,
   `plan-queue-doc-merge.ts:33`, `plan-queue-squash.ts:97-99`), all through `hermeticGitEnv` (`git-env.ts:34`), which
   non-queue code also uses: add an optional `cwd` argument to `hermeticGitEnv` that applies the rule, and pass it from
   those four places.
4. When worktree creation fails, remove the half-made directory or its stray `.git` link (only if it holds nothing but
   that link and provisioned files), and record "folder left behind" on the job otherwise. The existing
   `.worktrees/queue/2026-10-10-oct-phase4-tooltips-78d48c` is the safe variant (its `.git` points at a deleted
   registration); list it in the history file and leave it for James or the housekeeping card.

**Tests (fail today).** With a plain directory (no gitfile) at the saved path inside a temporary repo:
`plan-queue-worktree.spec.ts` checkpoint refuses and the temp root's `git status` is unchanged;
`plan-queue-run-hold.spec.ts` revert refuses; `plan-queue-landing.spec.ts` sync refuses; landing on a detached HEAD of the
right worktree still passes. A git spec: with the ceiling set, `git rev-parse` in a plain `.worktrees/x` directory fails
instead of finding the root.

**Done when:** those tests pass, and a forced worktree-creation failure in a temp repo leaves the root's `git status`
unchanged.

## Step 4. L3: checkers that wait for their own background work

**What's wrong.** 39 of 62 Claude checker sessions since 10 Oct never reported a verdict; in 30 the checker had started
a background command and ended its turn to wait. The tracker settles at the first `complete` or `idle` after assistant
output (`plan-queue-instance-tracker.ts:141-142`, `:195-196`); `finishVerification` stops the checker (`:468`) and counts an
errored round; two park the job as `verifier-unreliable` (`MAX_ERRORED_ROUNDS = 2`, `:52`). The async-work registry
already tracks background shells and helper agents (`getInstanceAsyncWorkRegistry().hasInhibitor(id)`,
`instance-async-work-registry.ts:94-97`, `:170`), and the existing 10-minute stalled-work check-in
(`instance-async-work-continuation.ts:22`, `:157-188`) already applies to queue sessions.

**Change.**
1. Inject `isBusyWithBackgroundWork(id)` into the tracker (built in `plan-queue-coordinator.ts:154-157` from the registry).
   While it is true, do not settle on `idle` or `complete`; the provider's next busy → idle after the background work ends
   settles normally, and the existing check-in covers a stall.
2. `plan-queue-verdict-nudge.ts`: a turn that ends without a verdict gets one nudge in the same session before it counts:
   `tracker.beginTurn(id)` then `sendInput(id, "Call plan_queue_report_verdict now with what you found. If a check is
   still running, wait for it in the foreground first.", …, { automatedInput: true, internalSource: 'plan-queue' })`, the
   pattern at item-flow `:256-258`. It must run before the stop at `:468`. Only a second empty turn counts as errored.
3. One rule line in `buildWorkerPrompt` (rules at `plan-queue-prompts.ts:76-83`) and `buildVerifierPrompt`: "Run checks in
   the foreground. Your turn ending is the signal that you are done, so do not end it while a command is running."
4. For Claude queue roles, set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and add `ScheduleWakeup` to the denied tools
   (whole tool names only). Check the env pack's machine-session branch for the right place; confirm the variable name
   against the installed CLI's changelog before relying on it.

**Tests (fail today).** `plan-queue-instance-tracker.spec.ts`: idle with an inhibitor does not settle; settles on the next
idle without one. Flow spec: a first empty turn sends one nudge and does not count; a second counts. Prompts spec: both
prompts contain the foreground rule.

**Done when:** the specs pass; after the restart, a week's read-only count shows under 5% of Claude checker sessions
without a verdict (history file).

## Step 5. T4: stop the plan queue waking the chat that started it

**What's wrong.** Queue sessions are children of the chat that started the run (`parentId` at item-flow `:212`, `:407`,
`plan-queue-triage.ts:133`). When one exits, `instance-child-completion-handler.ts:85-148` calls
`notifyChildTerminated` (`orchestration-handler.ts:1077-1123`), which injects a `child_completed` turn, and, because queue
jobs never enter the handler's own child list (`addChild` only at `:1038`), counts zero remaining children and also sends
"All N child instances have completed … synthesize … a comprehensive report" (`:1129-1156`) listing every child the chat
ever had (`completedChildrenIds` cleared only on unregister, `:96`, `:174`). The queue's own notices go through
`sendInput` too (`plan-queue-parent-messenger.ts:78-97`). Measured: about 5.3B Codex tokens in 9.9 days, against the
queue's design note that the parent "gets one summary when the run ends" (`plan-queue-messages.ts:1-8`).

**Change.**
1. **No child-result turns for queue sessions.** In the child-completion handler, when the child has
   `metadata.planQueueRole` (set at item-flow `:218`, `:422`, triage `:140`), skip `notifyChildTerminated` and
   `notifyAllChildrenCompleted` only. Keep `addParentNotification` (the visible "Child completed" line, which starts no
   turn), result storage, task cleanup, the completion hook and child termination. Do not touch the other session's
   redelivery edit in `orchestration-handler.ts`; the skip lives in the handler file, which has room.
2. **Only what is new for other children.** In `notifyAllChildrenCompleted`, list only children finished since the last
   "all completed" prompt, include each summary once, and cap the prompt at about 8,000 characters with "N more results are
   stored" for the rest. `orchestration-handler.ts` has 1 line of room: put the formatting in a new
   `child-completion-summary.ts` and make the call site net zero or negative.
3. **Queue notices as quiet notes (Decision 6).** Post adoption, routing changes and replays as visible status messages
   that do not start a turn: give `PlanQueueParentMessenger` a second port, `postNote(parentId, text)`, wired in
   `plan-queue-bootstrap.ts` to the same visible-output path the child-completion handler's `addParentNotification` uses
   (`instance-child-completion-handler.ts:195`). The run-end summary stays the one model-visible message per run, as the design note says,
   so the chat can act on the result. Questions keep `sendInput` only when the new setting "Send queue questions to: the
   queue page / the chat that started the run" says so; default the queue page. `notify()` already batches questions
   (`:53-64`). Settings follow the seven-place rule in Phase C's ground rules, plus no migration (a new key takes its
   default).
4. Any turn that still happens is tagged purpose `plan-queue-parent`, with `internalSource` on the cost row.

**Tests (fail today).** `instance-child-completion-handler.spec.ts`: a child with `planQueueRole` produces the visible line
and no injection, and no "all completed" prompt. A new summary spec: the second prompt lists only new children and stays
under 8,000 characters. Messenger spec (create beside it): with the default setting a question is not sent as input.

**Done when:** the specs pass; a day after the restart, read-only counts show zero `child_completed` deliveries for "Queue …"
sessions.

## Step 6. T2: keep Harness-started Codex work under 272K tokens, and make it measurable

**What's wrong.** About 11 Oct, Codex's server-fetched model catalogue raised gpt-6.1-sol's window from 272K to 500K.
AIO sends only percentages (`codex-thread-policy.ts:19-22`: compact after a step at 60% for Harness work, 70% for chats),
which now mean about 285K and 332K. Requests above 272K are billed at a higher rate for the whole request per OpenAI's
published prices (whether plan allowances count it the same way is unverified). Queue, loop and scheduled Codex threads are
ephemeral and leave no record (`adapter-factory.ts:291`; `provider-session-durability.ts:6-12`), so the effect on machine
work cannot be measured today.

**Change.**
1. **Measurement first (K3.6, minimal).** `codex-ephemeral-usage-log.ts`: when an ephemeral Codex thread ends, append one
   JSONL line (thread id, job or run id, session kind, request count, input/cached/output tokens, max request input,
   compactions) to the data folder's existing cost-attribution directory. Numbers only. Phase C Step 13 extends it.
2. **One-off credit check (K3.5).** A read-only script calls Codex's `account/usage/read {threadId}` (present only in the
   generated protocol snapshot today) for about 10 finished threads, half with a request above 272K. Result into the
   history file; it settles whether the premium reaches plan credits and is the input for Decision 3.
3. **The cap (Decision 3).** In `resolveCodexThreadPolicy`, for every non-`chat` kind add
   `model_context_window: 272000` (Codex clamps it to the model's maximum, so a wrong value cannot break a thread). Honour
   `codexContextTuning === 'codex'` (no Harness overrides) the same way the other keys do.
   - Add `model_context_window` to the `unsupportedConfig` key alternation (`codex-thread-requests.ts:10-14`). Today a
     rejection retries with no config at all, silently dropping every override; change the retry to drop only the
     rejected key when the error names it, and log `applied: false` with the key.
   - Exempt jobs whose plan is over about 100 KB until Phase B's one-off diet has run, then only plans over 200 KB, which
     Phase B refuses for new runs anyway (fact-check S2): a worker reading
     a 147K-token plan plus diff would compact over and over at 272K. `resolveCodexThreadPolicy` sees only the session
     kind, so carry the fact: the queue sets `metadata.planQueueLargeDocument = true` when it spawns a worker or checker
     for such a document (the spawn sites in item-flow and triage), the route preflight that already stamps `sessionKind`
     (`provider-route-preflight.ts:23`) also stamps it, `adapter-factory.ts` passes it on `CodexCliConfig`, and the policy
     skips the key when it is set. Log each exempt thread in the usage log.
4. **Own chats keep the larger window** (Decision 3(a)). This deliberately replaces the backlog's T2 item 2 ("500K as an
   opt-in for own chats"), following the fact-check's wording note that the cap was only ever meant for Harness's own
   work. If James chooses 3(c), cap chats too through a settings migration, not a default change.
5. The context diagnostics show the effective window.

**Tests (fail today).** `codex-thread-policy.spec.ts` (uses `toEqual` on the whole config at `:22`, `:38`, `:50`; update on
purpose): non-chat kinds carry the key, chat does not, `codex` tuning carries none. `codex-thread-requests.spec.ts`: a
rejection naming the key retries without that key only.

**Done when:** after the restart, the new usage log shows no request above 272K from a non-exempt machine-started thread,
and average input per request for those threads near the 10 Oct level (about 124K). The price-table premium is Phase D
(K3.4).

## Step 7. T3 step 1: pass rates in the Codex helper trial (Decision 13)

The trial James approved on 10 Oct is running (`codexHelperAgentsHarnessWork: 'trial'`). Its report script
(`scripts/codex-helper-trial-report.mjs`) exists only on the Phase 1 branch, so the report part of this step waits for
Phase 1 to land (Phase B Step 8 item 1); only a 13(b) answer can be acted on before then. Add each arm's checker pass rate
(from Phase C's verdict history once it exists; until then from `loop-mode.db` item outcomes joined to the session-policy
log) to the trial report, and run it about a week. If "off" is no worse, default Harness work to `off` **with a settings
migration** (James's stored value is `trial`). If James answers 13(b), make that migration now without the week; if
13(c), change nothing in the trial settings (the report still gains the pass rates). Steps 2-6 of T3 are Phase D.

## Step 8. T12: machine-written messages skip memory and code search; late results are dropped

**What's wrong.** `instance-manager.ts:1672` calls `buildInputContexts` without options, so every `sendInput`, including
plan-queue fix prompts with `automatedInput: true`, runs retrieval. 96% of injections were code-index blocks of about 950
tokens. Late blocks are parked and attached to whatever message comes next (`instance-input-contexts.ts:166-185`, queued at
`instance-manager.ts:1689`, `:1870`). Keyword reminders (`getLaterTurnReminderIfRelevant`, `:1840-1846`) also run for
internal input.

**Change.**
1. Pass `{ automatedInput, internalSource }` (both in scope at `:1543`, `:1441`) into `buildInputContexts`, and skip
   retrieval and the later-turn reminder when either is set. `instance-manager.ts` has 50 lines of room; keep it to the
   argument plus one condition.
2. Drop a late block instead of parking it, unless the next message is James's own. Update the two specs that assert
   parking (`src/main/instance/__tests__/instance-manager-context-deadline.spec.ts:733`, `:769`) on purpose, with a
   comment saying why.
3. The backlog's third fix (skip the code block for messages under about four words, with an 8K cap and de-duplication)
   is already built on the Phase 3 branch (`turn-injection-policy.ts`) and arrives with Phase B. After that landing, check
   its rules against code-index blocks, which are the real carrier (96% of injections), and record the result here.

**Tests (fail today).** A new `instance-input-contexts.spec.ts`: automated input → no retrieval call. The deadline spec:
a late block is not attached to a following automated message.

## Step 9. T15.1: a cancelled OpenCode compaction finishes its row

`opencode-acp-updates.ts:52` allows only `started | in_progress | completed | failed`, so `cancelled` returns
`undefined` and "Compacting the session…" never ends. Add `cancelled` to the allow-list and map it to a finished,
non-streaming row ("Compaction cancelled") at `:57-59`. Test: add `cancelled` to the `it.each` in
`instance-communication.status-merge.spec.ts:47-63`.

## Step 10. H2: the dead tooltip in the session list

`instance-list.component.html:472` uses `appTooltip`, but `InstanceListComponent`'s imports (`instance-list.component.ts:85`)
lack the directive, so the hover never shows. Add `AioTooltipDirective` from `'../../shared/tooltip/aio-tooltip.directive'`.
The file is 1,483 lines against a 1,485 limit: the import line and array entry must fit (merge into the existing import
statement block if needed). Test: a small spec that renders the unread dot and asserts the directive is attached.

## Step 11. U5: closing a session says what happens to its helper sessions

**What's wrong.** New sessions default to `terminationPolicy: 'terminate-children'` (`instance-create-builder.ts:77`), so
closing a parent ends every child (`instance-termination.ts:341-384`). The single-session confirm dialog says nothing about
helpers (`terminate-confirm-dialog.component.ts:47-79`); only Close-all mentions them, and only about history.

**Change.**
1. The dialog shows "This session has N running helper sessions." when `childrenIds` has running children (computed in
   `terminate-confirm.store.ts`).
2. Two buttons: "Close this session and its N helpers" and "Close only this session (helpers keep running)". The second
   passes `childPolicy: 'orphan-children'` through `InstanceTerminatePayloadSchema`
   (`packages/contracts/src/schemas/instance.schemas.ts:313-316`), the handler (`instance-handlers.ts:300-331`),
   `instanceManager.terminateInstance` (`instance-manager.ts:1182`), `instance-lifecycle.ts:1925-1931` and
   `TerminateInstanceOptions` (`instance-termination.ts:39-47`), used in place of `instance.terminationPolicy` at `:351`.
   `instance-lifecycle.ts` has no room (3,641/3,641): its edit must be net zero, for example by collapsing the multi-line
   `terminateInstance` signature onto one line as it gains the options argument.
   Also update `thin-client-instance-commands.ts:75`. Follow the IPC rule (no new channel; schema change only).
3. The close button's tooltip carries the count.
4. Skip the dialog for a session with no messages and no unsent draft.

**Tests (fail today).** Dialog/store spec: with two running children, both buttons show and the second sends
`orphan-children`. Termination spec: the per-call policy overrides the stored one.

## Step 12. U6 step 1: "Allow once" means once (Decision 8)

**What's wrong.** `recordUserDecision` caches a `once` decision under `instanceId:scope:resource` for the manager's one-hour
lifetime (`permission-manager.ts:221`, `:651-668`), served by `checkPermission` (`:587-596`); the card admits "Also allows
the same command for the next hour" (`user-action-request.rules.ts:106`).

**Change (if Decision 8 is (a)).** Make a `once` entry single-use: mark it `consumeOnHit` in `cacheDecision` and delete it
on its first cache hit in `checkPermission`. Bind that entry to the approved request ID as well as instance/scope/resource:
the deferred IPC path has already resumed the held tool call before recording the decision, so a later identical command
must not consume it. Distinct batch entries need separate grants even when their resources match. Do not drop the cache entry outright: the batch and request-id decision paths
(`permission-manager-extensions.ts:183-257`) record through the same function and may rely on one re-check. A once-deny
for Claude-held asks carries no scope and is unaffected. Remove the "next hour" hint and fix `tooltip-copy.ts:304`.
If Decision 8 is (b), relabel the button "Allow for the next hour" instead and keep the cache.

**Tests (fail today).** Permission-manager spec: a `once` decision serves exactly one cache hit for its original request;
distinct identical requests ask again and duplicate-resource batch entries each retain their one recheck. An IPC/flow
regression approves a held command once, then verifies a different tool call for the same command reaches the approval card. Update
`user-action-request.component.spec.ts:384` on purpose.

## Step 13. U4: the phone stops calling "waiting for your answer" "needs approval" (desktop half)

`liveActivityStatusLabel` (`mobile-gateway-push.ts:89-104`) returns "needs approval" for both waiting kinds. Send
"waiting" for `waiting_for_input`; the installed Swift widget already colours "waiting" orange
(`HarnessLiveActivity.swift:98-109`), so this works without a phone build (its compact symbol shows "…" instead of "?",
which is acceptable). The phone app's own copy (`apps/mobile/src/app/core/status.ts:127-132`, pinned by
`status.spec.ts:66`) and the Swift compact text need a phone build: they go to Phase E with U4's shared presenter. Test:
a label spec in `mobile-gateway-push.spec.ts`.

## Step 14. K7: stop tracking the plans the queue committed by mistake (Decision 2)

James answered (a) on 20 Oct. Commit `3be08c73a` added 71 lifecycle documents (14 plans, 57 live-check documents, no specs)
and `claude_oct-todo.md`; 69 of the 71 are still tracked. List them with
`git show --name-only --diff-filter=AM 3be08c73a -- '*_plan.md' '*_livetest.md' claude_oct-todo.md`, keep only paths that
are still tracked, still exist on disk (some have since been renamed `_completed` or deleted by other sessions; leave those
alone) and are still active, and show James the list. Run `git rm --cached` on exactly those paths only at the moment James
asks for the commit, together with that commit, so the staged change never sits in the shared index where another
session's commit could pick it up. The
files stay on disk and history is not rewritten. The rest of that commit (about 45 code files and 35 other documents)
stays. The index change is committed only when James asks for a commit.

---

## As-built checklist (worker handoff)

- [x] Step 1: separate Claude cutoff, provider boundaries and backup exclusion; focused independent safety review PASS. Existing-history damage is LT-707, not claimed restored.
- [x] Step 0 code: cohesive queue extraction, coordinator/flow now at 658/682 lines after the safety follow-ups; active history/decision rules agree across commit hook, queue squash and harvest/auto-integration. Real Git finalization/reconciliation regressions pass.
- [x] Step 2 code: captured build stamp, actual migration rows, one-shot showCost migration. Restart/day observation is in the live-test document.
- [x] Step 3 code: shared identity checks, per-call Git ceiling, conservative failed-folder cleanup and guarded spawn/restore/sync/landing. Operational inspection failure stays distinct from proved mismatch; both refuse writes/spawn. Pause/park/landing cleanup clears stopped roles and pending verdicts. Transient restoration failures retain their snapshot and a persisted retry marker; Resume restores before reattachment can advance the checkpoint.
- [x] Step 4 code: tool-only/empty turn settlement and request-count ownership fence; nudge delivery releases the item lock and routes failed sends through normal outcomes; inhibitor clearance rechecks a held completion without another idle event. Assigned-verifier full acceptance and live measurement remain pending.
- [x] Step 5 code: quiet notices, queue-page question default, one model-visible run summary, new-only bounded child synthesis including visible SUCCESS/FAILED results. Full encoded envelope stays under 8,000 characters; delivery reserves included IDs while pending, acknowledges only delivered results, and releases permanent failures/expiry. Cost provenance observes actual provider dispatch independently of receipt/context/watchdog commit timing.
- [x] Step 6 code: app-server/exec cap, exemptions, selective retry, effective-window diagnostics for both transports (exec fallback records the spawned cap since the round-9 repair) and attempted read-only credit probe. Real loop/headless job/run IDs reach usage JSONL; persistent loops flush on termination and unavailable native metrics stay null. Separate helper-policy records preserve valid trial exposure. Billing data remains unavailable; live usage comparison and credit-premium conclusion stay open.
- [ ] Step 7: tested companion report ships now; integration into original Phase-1 report awaits Phase B. Week-long comparison remains pending and no premature settings migration was made.
- [x] Step 8: machine retrieval/reminders skipped; a late result may serve only the immediately following human input, and any machine input invalidates even unresolved retrieval. Phase B's separate short-message/code-index policy check awaits that code landing.
- [x] Step 9: cancelled OpenCode compaction finishes its row.
- [x] Step 10: real unread-dot tooltip directive rendered and verified.
- [x] Step 11: helper-aware choices, per-call child policy, loaded-idle-empty-session bypass with restored/active/loop/queue protection and a rewritten source guard; retained helper visibility and tooltip counts.
- [x] Step 12 code: once grants keyed to the approved request and consumed on one recheck; distinct identical calls ask again; duplicate-resource batch grants and session rules retained; misleading hour copy removed. Resume correction passed a different fresh code-handoff review.
- [x] Step 13: desktop push labels distinguish waiting for input from permission.
- [x] Step 14 preparation: 70 active tracked paths listed in history; no index writes. Actual untracking remains tied to James asking for the commit.
- [x] Resumed `a656f3b58` handoff revalidated without source changes: all 170 reviewed hashes match; fresh post-build 105-file/1,292-test replay and all static/build/generator/contract gates pass. Native-worker tests require `build:main` after runtime cleanup. Initial failures remain archived. Report/seal/receipts precede cleanup; supplied dependencies and two baseline caches retained. Exact statuses for every step are in the [current report](../../_scratch/queue-resume-2026-10-21/phasea-resumed-worker-a656f3b58/worker-report.md). This does not close the pending assigned verification or requirements below.

No standalone spec was linked. The root history records implementation decisions, RED/GREEN evidence, command receipts,
trial/credit aggregates, the candidate-path list and the reproduced LT-707 defect. All live-only checks are owned by the
[separate live-test document](2026-10-20-oct2-phaseA-safety-and-truth_livetest.md). The Step 7/Phase B integration is a real
implementation dependency and stays open here; it is not reclassified as a passed live test.

## Verifier follow-up repairs (21 October, worker handoff)

- [x] Finding 1: stopped-verifier spawn restoration failures park as `worktree-error` instead of escaping with a reserved verification slot. Parking restores even when no verifier ID was published; roles and pending verdicts are cleared and late outcomes are inert.
- [x] Finding 2: boot recovery logs both the original inspection failure and a subsequent park/save failure, then continues with later items.
- [x] Finding 3: child-summary construction reserves only included IDs before delivery. Overlapping batches omit reserved children; confirmed delivery acknowledges them. Permanent send failure, synchronous initial/redelivery exceptions, and admission expiry/removal release the affected reservation; live suppressed/held redelivery retains it.
- [x] Finding 4: transient inspection failures retain the in-memory baseline and persist a restoration-pending marker in the existing item detail. Resume and landing controls restore before reattachment; after restart the original recorded checkpoint provides the baseline. Real temporary-Git tests preserve checker edits/commits while inspection fails, then remove them before work resumes. Resume rejects non-parked items before touching Git; successful Discard releases retained state.

The first fresh review returned FAIL for synchronous-redelivery and admission-eviction reservation leaks.
Both have RED/GREEN regressions, including the actual admission service with mocked persistence only.
The callback registry was extracted into `session-redelivery-handlers.ts` to keep admission service at
695 lines without raising a ceiling. No schema migration, dependency, manifest, test-runner, or lint-config change.

Current evidence lives under root `_scratch/queue-resume-2026-10-21/phasea-round1-followup-evidence/`.
Final worker domain replay: **49 files / 700 tests**, uncached, exit 0 (88.05 s). Both typechecks, lint, LOC, both builds and generator/IPC/contracts/exports checks exit 0; renderer retains its existing bundle-budget warning. Separate runtime consumer/child replay: **2 files / 11 tests**, exit 0. Second fresh scoped review: **VERDICT PASS**, no unresolved actionable findings, independently **6 files / 88 tests** and **2 files / 30 tests**, exit 0. All 12 reviewed follow-up paths and 167 retained/current seal paths match. Report: `report.md`; review: `fresh-review-final.md`; final receipts: `handoff-targeted-receipt.json`, `frozen-gate-receipts.json`, `handoff-static-receipts.json`; fingerprint evidence: `source-seal.json` and `review-source-match.json`. Historical RED and intermediate failures remain archived. Cleanup is recorded in `cleanup-receipt.json`. The assigned AIO verifier
still owns clean-install/full-suite acceptance; no worker full-suite run or whole-plan completion is claimed.

## Round-2 verifier remediation (21 October, worker handoff)

Scope: all three findings against retained checkpoint `8522d97b8`. No standalone spec is linked.

- [x] Finding 1: plain Git rollback failures retain the baseline and persisted retry marker, invalidate the
  stopped checker verdict, clear stopped IDs/roles and park `worktree-error` without checkpointing. Covers
  completion, Pause, direct parking and cancelled checker spawn. The equivalent boot-recovery bypass also
  parks ordinary rollback failures. Real index-lock tests cover committed/uncommitted checker changes,
  same-process/restarted Resume, continued refusal while locked and restoration once the lock clears.
  Legitimate worker edits without a pending checker rollback remain intact.
- [x] Finding 2: marker/error comes first in bounded parked detail. An oversized-detail regression rebuilds
  the flow and verifies actual restoration before Resume queues the item; the marker survives truncation.
- [x] Finding 3: native meaningful-stop readiness now follows SIGINT-handler installation. Five additional
  complete native-file runs pass 7/7 each; outcome assertions remain and clean exit also requires no signal.
  No adapter runtime, timeout, runner, dependency or suppression change.
- [x] Frozen worker verification: 47 files / 663 tests, uncached, exit 0 (97.04 s). Both typechecks, lint,
  LOC and both builds pass, as do alias/IPC generators and IPC/contracts/exports checks. Generated output
  is unchanged; renderer retains its existing 1.35 MB initial-bundle budget warning. Focused 3-file/81-test
  evidence overlaps the domain replay. Initial RED, Git-backoff fixture timeout, old Pause-state expectation
  failure and boot RED remain archived separately, not counted as passes.
- [x] Fresh-review finding F1: missing checkout no longer means restoration success. Parking/Hold retain
  the baseline/marker. Resume recreates the registered item checkout with `preserveCheckpoint: true`, then
  restores before work queues. Every intermediate persisted row keeps the original checkpoint, including
  after recreation and interrupted restoration. Boot recovery rejects a null saved path as well. Four
  missing-checkout cases and the null-path boot case reproduced before fixes; the original independent
  real-Git probe now passes. Same-process/restarted and interrupted restoration paths are tested.
- [x] Second fresh-review finding F1: missing-registration release is inside the verifier restoration
  error/finally boundary. A locked missing checkout now parks with its baseline/marker and clears stopped
  IDs/verdicts instead of escaping in `verifying`. Git locks are never overridden; Resume remains refused
  until the fixture owner releases its lock. Hold/Park refresh the persisted path after release. Ordinary
  worker release failures park without a false checker marker. Boot recovery and both checkpoint-recreation
  restart paths are covered. Four new locked-release cases reproduced RED before the correction; the focused
  queue replay passes 81 tests. Pause error details are also bounded to the IPC's 8,000-character limit,
  preserving the leading restart marker (separate RED/GREEN regression).
- [x] Third genuinely fresh completion-gate review: PASS for code handoff, no unresolved actionable findings. Independently 60 files / 730 tests, 2 new partial-rollback Git probes, both typechecks/lint/LOC/IPC/contracts/exports and both builds pass. All 168 source hashes match. Report: `handoff-fresh-review.md`. Both original independent probes also pass. Clean-install/full-suite
  acceptance remains reserved to the assigned AIO verifier and is not claimed by this worker.
- [x] Report/source seal/receipts written before cleanup. Removed 21,768 regenerated output/cache files and 50 already-archived runner originals; supplied dependencies and untouched pre-existing output remain. All 168 source hashes still match and diff-check exits 0. Receipt: `cleanup-receipt.json`.

Current evidence: ROOT `_scratch/queue-resume-2026-10-21/phasea-round2-rollback-evidence/`, including
`worker-report.md`, `source-seal.json`, `handoff-static-build-receipts.json`, `handoff-test-receipts.json`,
raw runner logs/JSON and historical failures. Source seal: 168 retained/current paths, aggregate SHA-256
`44042e2369b5ea86f93a40ab4ad8cde9189cd862c44cf44580c457d1504ed925`.

## Round-7 finding repairs (21 October, current worker handoff)

- [x] Finding 1: real locked missing-registration release reproduced the landed-cleanup throw. Cleanup now
  retains Git ownership and a visible refusal while clearing stopped session IDs; the real pump starts the
  next item. Writer-stop failures still retain live IDs. Fixture-owner unlock permits proof cleanup; the
  queue never overrides Git locks.
- [x] Finding 2: provenance is captured and consumed synchronously at provider completion before evidence
  drains. Delayed booking uses the frozen identity and cannot clear a newer dispatch. Interim usage peeks
  without consuming. Real manager/Codex/native-stdin/communication regressions cover later direct orchestration
  and lifecycle sends, overlapping queue sends and a held old completion crossing a new native write.
  Fresh review also reproduced terminal rejection without completion. The native-send wrapper now releases
  only its dispatched tag on rejection (including swallowed recovery paths), preserving newer tags and
  resident early-return sends. A second fresh review found direct overflow retries bypassing that wrapper;
  the retained dispatch now wraps its existing runInputRetry scope too, preserving guards/retry reasons.
  Third review then reproduced a late original rejection clearing a live event-owned retry's shared token,
  including lost attribution for its real successful usage. AsyncLocalStorage now scopes each attempt's capture;
  original/retry failure orders and actual Gemini success/failure are covered. All independent failures and
  repository REDs are retained. Fourth review found acknowledged Claude exit and ACP event-only failure;
  owned native error and resident exit now retire their token, while generation/restart changes invalidate
  stale tags. Paid failed completion identity and stateless per-turn exit ordering remain covered.
  Fifth review reproduced a lazy channel exit inheriting an earlier completed attempt's context; session
  exit now retires after current-adapter fencing independently of attempt context. Accepted ACP cancellation
  reproduced separately; terminal-idle acknowledgment releases only its own tag. Busy resident sends retain
  attribution. All REDs are preserved. Final worker replay and sixth fresh review PASS; no unresolved actionable finding.
- [x] Finding 3: reserving a verification slot does not itself create a rollback obligation. A new verification
  clears its previous verified-base receipt before guards; rollback still recognizes actual snapshots, checker
  IDs, the persisted pre-create baseline and pending restoration markers. Both pre-spawn refusals preserve
  legitimate worker files without claiming checker edits; real rollback/restart/lock regressions remain green.
- [x] Finding 4: initialization retains a bounded set of valid thread totals, then selects the actual resumed
  thread's baseline. Without a baseline, its first valid snapshot defines an unknown measurement boundary;
  historical tokens/counts/maxima are never booked. Real initializer RPC/notification tests cover reconnect,
  duplicates, unrelated threads, unavailable metrics and post-resume deltas. Fresh-thread/exec behavior remains.
- [x] Finding 5: generic Claude purpose evidence allows a bounded 1,000 ms booking-to-receipt gap (the audited
  first pair was 2 ms apart; DB booking precedes the synchronous attribution append). The fingerprinted start
  cutoff is unchanged. Fixtures protect the first per-turn row, still difference older cumulative rows and
  retain Copilot/Cursor separation, transactional backup and idempotency. No real-data write or checksum change.
- [x] Worker gates after all five fresh-review fixes and accepted-cancellation correction: uncached
  105 files / 1,292 tests, exit 0 (261.84 s); all eight native probe replays pass. Both typechecks, lint, LOC, both builds,
  alias/IPC generators and IPC/contracts/exports checks exit 0. Generated tracked output is unchanged; the
  existing renderer bundle-budget warning remains. First broad replay failed an unchanged retirement test's
  one-second checker-spawn wait before cleanup; its entire isolated file then passed 26/26 and the complete
  final selection passed with the documented two-fork cap and no concurrent builds. No timeout/assertion edit.
- [x] Sixth genuinely fresh retained-diff completion review with broad/security repo-health-audit escalation:
  PASS for code handoff only, no unresolved actionable findings. Independent 105 files / 1,292 tests, all eight
  prior native probes plus a new real busy-resident paid-turn/evidence-drain probe, all 11 gates and both
  post-probe builds exit 0. Every process exited; all 170 source hashes and HEAD/status match before/after.
  The extra probe's initial cumulative-cost fixture error is preserved and dispositioned; no assertion was
  weakened. Report: `fresh-session-review/report.md`. Assigned clean-install/full-suite acceptance remains open.
- [x] Report/seal/receipts finalized before cleanup: 21,775 generated files and 98 archived runner originals
  removed; supplied dependencies and two baseline cache files retained. All 170 source hashes match,
  diff-check exits 0, HEAD/branch unchanged and index empty. Exact paths: `cleanup-receipt.json`.

Evidence is at ROOT `_scratch/queue-resume-2026-10-21/phasea-round3-remediation-evidence/`: `worker-report.md`,
`source-seal.json`, `session-final-static-receipts.json`, `session-final-targeted-receipts.json`, raw logs/JSON and RED evidence.
The current seal covers 170 retained/current paths. No standalone spec exists. This section never closes Step 7's
original-report integration, Step 8's Phase B comparison, Step 14's explicit commit boundary, LT-707 restoration
or the existing live checks. No full worker suite, dependency installation, manual integration or rename.

## Post-merge retirement-control hook repair (21 October, worker handoff)

- [x] Investigated the resumed branch/log and inherited as-built notes; no standalone spec exists.
  Scope is the reported post-merge hook failure, not closure of the original pending requirements.
- [x] Reproduced the exact `entering` assertion failure by holding pre-promotion entry for 1,250 ms.
  The isolated original file passes 26/26, confirming that its default one-second `vi.waitFor` wait
  introduces a load-dependent setup deadline across real checkpoint/checker/landing Git operations.
- [x] Replaced the mock's boolean/poll with the existing deferred-promise pattern. Cancellation still
  begins only after promotion entry, while the promotion-release latch remains held. All assertions
  about paused state, failed worker stop, retained ownership, successful retry and unchanged landed
  commit remain. The diagnostic delay is removed from the handoff; no timeout or runtime change.
- [x] Controlled-delay RED/GREEN, normal focused file 26/26, both typechecks, lint and strict LOC pass.
  Read-only replay uses the existing `runHook('pre-commit')` commands and `runStagedTests` selector
  over `main...HEAD` plus the working repair: 1,037 files / 15,800 tests pass, 3 existing skips,
  exit 0 (220.43 s test duration). Only `git add` is omitted; no staging or commit is performed.
  This is the hook's related selection, not the assigned verifier's clean-install/full-suite gate.
- [x] Required alias/IPC/architecture generators run. Alias/IPC output is unchanged; architecture
  inventory now includes the inherited runtime-info channel and current source line counts.
  Its read-only `--check` passes. No manifest, lockfile, test runner, lint configuration or skip change.
- [x] Genuinely fresh scoped `task-completion-gate`: VERDICT PASS, no actionable findings;
  independently 26/26 affected tests and architecture consistency pass. This covers the repair and
  generated refresh only; it does not certify the inherited branch. Report/seal/receipts were written
  before cleanup; five archived runner originals removed. All 172 fingerprints still match, index
  empty, branch/HEAD unchanged and root plan still untracked. Supplied runtime/dependencies preserved.

Report, independent scoped review, 172-path source seal, raw RED/GREEN/hook logs, exit receipts and
cleanup receipt live at ROOT `_scratch/queue-resume-2026-10-21/phasea-postmerge-retirement-repair/`.
All original open dependencies and deferred live checks remain open. The coordinator owns any commit,
integration and completion rename; the assigned verifier still owns whole-retained-diff acceptance.

## Round-8 verifier remediation (24 October, worker handoff)

Scope: the assigned verifier's three round-8 findings against the retained branch. No standalone
spec is linked. The corrected once semantics (Step 12's "Once: this command once. …" meaning line)
were preserved throughout; only UI surfaces, registry records and the scheduled-usage seam changed.

- [x] Finding 1 (UI hints surfaces and records): reproduced all four check failures first. H2c —
  the Step 2 About card's second `title="…"` on `<app-settings-card>` is gone by renaming
  `SettingsCardComponent`'s `title` input to `heading` (the rule's prescribed remedy; doc comment
  records why it is never `title`) and updating all five call sites. Unreadable — the instance-row
  helper-count close wording is now statically measurable: `closeTooltip(helperCount)` carries only
  literals and its parameter (template `@let helperCount = closeHelperCount();` supplies the live
  count, the alias idiom `composer-toolbar.component.ts` already uses) and the count computation
  moved to `closeHelperCount`; rendered strings and the real-render spec are unchanged and the file
  is back to its recorded 3 unreadable hovers. Registry — `--tighten` dropped the four emptied H2c
  entries (decrease only), `--retire 5efd3e282d9ef9f9` retired the removed hour-allowance copy with
  a unique reason, and `--record-wording` recorded the replacement meaning line and the
  ". Choose whether to close its " helper fragment. `check:ui-hints` exits 0 (204 entries,
  4 retired) and `scripts/__tests__/ui-hints-baseline.spec.ts` passes (2/2; the pinned Close-session
  entries are untouched).
- [x] Finding 2 (scheduled Codex measurement): three probe-shaped tests went RED first —
  `applyInstanceSpawnPolicy` dropped `automationRunId`, and `CodexEphemeralUsageLog.begin()`'s
  `ephemeral || sessionKind === 'loop'` gate rejected durable automation sessions (they become
  `ephemeral: false` via `provider-session-durability.ts`). The policy's `runId` chain now forwards
  `metadata.automationRunId` after queue/loop ids (record "job or run id" requirement met by the run
  id; `jobId` stays the queue item), and the gate is "durable personal chats stay out; every machine
  thread is measured" — the existing `stays silent for durable chats` test is unchanged and passes,
  and loops/scheduled/queue/review threads keep or gain measurement rows with the existing
  resume-baseline handling. GREEN: 19/19 in the two touched specs; 64 files / 729 tests across the
  codex adapter directory, `codex-machine-usage-flow.spec.ts` and `adapter-factory-codex.spec.ts`;
  300 files / 3674 tests in `src/main/orchestration` + `src/main/automations`.
- [x] Finding 3 (architecture inventory): regenerated with `npm run generate:architecture` (the
  verifier's `settings.types.ts` 888→889 and `settings-control-policy.ts` 871→872 drift is exactly
  what the write updates); `npm run verify:architecture` exits 0. Alias/IPC generators leave no
  tracked change.
- [x] Gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
  `npm run build:main`, `npm run build:renderer`, `check:ui-hints`, `verify:architecture`,
  `verify:ipc`, `check:contracts`, `verify:exports` all exit 0 (renderer keeps its existing 1.47 MB
  initial-bundle budget warning). `build:main` refreshed the committed codex protocol snapshot for
  the installed codex-cli 0.164.0 — the generator's designed behaviour, identical to the round-8
  verifier's own `build-main.log` regeneration. Targeted replays also green: settings + instance-list
  51 files / 552 tests, instance-row + app-update-settings 36, user-action-request 25,
  ui-hints-baseline 2. Full suite and clean lockfile-exact install remain the assigned verifier's
  gates and are not claimed here.
- [x] Dispositioned, not mine: one broad-replay failure (`scripts/__tests__/dependency-compatibility.spec.ts`,
  `extraneous: toml-eslint-parser@1.0.3`) is a pre-existing install-tree artifact — the supplied
  `node_modules` comes from the root checkout whose uncommitted manifests add that package, while
  this branch's committed manifests do not (`npm ls` shows extraneous here, valid there; package
  files predate this session). No manifest, lock or dependency change was made; the assigned clean
  install gate produces a tree without it.

Report, source seal, command receipts and raw logs: ROOT
`_scratch/queue-resume-2026-10-24/phasea-round8-remediation/` (probe analysis in
`_scratch/queue-resume-2026-10-24/phasea-round8-fixes/`). This handoff claims no whole-plan
completion: Step 7's Phase B integration, Step 8's comparison, Step 14's commit boundary, LT-707
restoration and the deferred live checks all remain open.

## Round-9 verifier remediation (24 October, worker handoff)

Scope: the assigned verifier's one round-2 finding — Codex exec fallback published the catalogue
window instead of the configured 272,000-token machine cap (`codex-thread-policy.ts:41` emits the
cap without updating `effectiveContextWindow`, so `resolveContextWindow` at
`codex-cli-adapter.ts:95-98` fell back to the catalogue and `codex-exec-adapter.ts:398-403`
published it). No standalone spec is linked.

- [x] Reproduced first with probe-shaped tests driving a successful synthetic native exec through
  `execSendMessage` — the exact path of the verifier's `exec-window-probe.cjs`. RED: the exec
  `context` event reported `total: 200000` (unmodified registry), `cliConfig.effectiveContextWindow`
  stayed unset and `getCapabilities().contextWindow` showed the catalogue. Both the flow-level and
  the policy-level regressions failed before any source change; logs retained.
- [x] Fix: `codexExecContextWindowArgs` now records the emitted `model_context_window` cap as
  `config.effectiveContextWindow` — the same seam `logPolicy` fills after an accepted app-server
  thread request — and clears it when the session runs uncapped (chat, `planQueueLargeDocument`,
  `codexContextTuning: 'codex'`, or no cap resolved), so `resolveContextWindow` stops falling back
  to the stale catalogue and exec context diagnostics publish the effective machine window. The
  `CodexCliConfig.effectiveContextWindow` doc comment now covers both transports. No resolver,
  argv, policy-key, usage-log or app-server behaviour change.
- [x] Tests: new `codex-exec-context-window.spec.ts` pins argv, exec `context` totals,
  `getCapabilities().contextWindow` and `cliConfig.effectiveContextWindow` to 272,000 for a machine
  exec turn, and keeps a chat control on the catalogue window recording nothing.
  `codex-thread-policy.spec.ts` gains the recording contract for capped, chat, large-document and
  Codex-tuning cases. GREEN: 2 files / 16 tests.
- [x] Targeted replay: 57 files / 710 tests across `src/main/cli/adapters/codex/`,
  `codex-cli-adapter*.spec.ts`, `codex-exec-*.spec.ts`, `adapter-factory-codex.spec.ts` and
  `codex-machine-usage-flow.spec.ts`, exit 0. Gates `npx tsc --noEmit`, `npm run typecheck:spec`,
  `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run verify:ipc`,
  `npm run check:contracts`, `npm run verify:exports`, `npm run build:main` and
  `npm run build:renderer` all exit 0. No
  manifest, lockfile, generator, runtime, timeout or suppression change. Full suite and clean
  lockfile-exact install remain the assigned verifier's gates and are not claimed here.
- [x] Compiled verification with the verifier's own probe shape on `dist/main`: the corrected
  equality variant exits 0 reporting
  `{"argv":["-c","model_context_window=272000",...],"capabilities":272000,"contextTotals":[272000],"effectiveContextWindow":272000}`,
  and the verifier's original probe now exits 1 at its `assert.notEqual(contexts.at(-1).total, 272000)`
  bug assertion — the reproduced defect is gone.

Report, RED/GREEN logs, both probe variants with logs and command receipts: ROOT
`_scratch/queue-resume-2026-10-24/phasea-round9-exec-window-repair/`. This handoff claims no
whole-plan completion: Step 7's Phase B integration, Step 8's comparison, Step 14's commit boundary,
LT-707 restoration and the deferred live checks all remain open.

## Final verification

```bash
npx tsc --noEmit
npm run typecheck:spec
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run build:renderer
# Full repository suite: independent verifier only under queue-worker instructions
npm run test:quiet
```

Historical round-4 frozen worker results: uncached **65 files / 816 tests**, exit 0, 125.16 seconds, zero failed/pending/todo.
Separate queue-domain replay: **41 files / 596 tests**, exit 0; selections overlap and are not added together.
Both typechecks, lint, LOC, both builds, generators and IPC/contracts/exports checks all exit 0. Renderer
retains the existing bundle-budget warning. Earlier type-only and pre-freeze landing-regression failures,
plus an evidence-archival parser error, are preserved separately rather than represented as passing gates.

Historical round-4 independent `task-completion-gate` review, including broad/security `repo-health-audit` escalation:
**VERDICT: PASS for code handoff only**, no unresolved actionable findings. Independently replayed **57 files /
658 tests**, both typechecks, lint, LOC and both builds, all exit 0. All **163** retained/working/new-source
fingerprints match aggregate SHA-256 `424ea9585d913898ca6642d193473b44d3f5b4f34c06ada77643b7ff203facdb`.
Exact report, raw logs/JSON, exit receipts and seals are archived under root
`_scratch/queue-resume-2026-10-21/phasea-round4-remediation-evidence/` and described in
[history](2026-10-20-oct2-phaseA-safety-and-truth_history.md).

This scoped PASS does not certify clean installation, full-suite/current assigned-verifier acceptance,
installed behavior, LT-707 restoration or whole-plan completion. No restart requested. The assigned verifier
must perform the current canonical/full/clean-install gates in this exact registered checkout as instructed above.

## Live checks

Pending checks and exact steps are in [the live-test document](2026-10-20-oct2-phaseA-safety-and-truth_livetest.md):
installed build and LT-707 recovery; one-day accounting/parent delivery; one-week checker/trial outcomes; provider usage
and billing availability; Windows close-dialog verification. None is claimed passed by headless builds.

## Finishing

Queue-worker instruction overrides the original finish procedure: leave this plan and history under their active names,
untracked in the root checkout. Do not commit, stage, install/restart, manually integrate branches, or rename `_completed`.
AIO's independent verifier owns the full repository suite and final completion gate; the coordinator owns integration and
completion renames. Step 7's Phase B dependency and LT-707 existing-history recovery remain explicit open requirements.

> Plan Queue history: `queue/2026-10-20-oct2-phasea-safety-d0099e` — retained checkpoint `2300ada43`, previously parked as verifier-unreliable; resumed 21 October without a new branch or worktree.



## Coordinator: verified checkpoint blocked by overlapping root edits (21 October)

The actual assigned Cursor checker recorded **PASS**, no findings, `documentComplete: false`,
for retained checkpoint `bc8c0f40431014cc95d7c7db3afadda601b02034` after the hook-test synchronization repair.
Its tool verdict records exit 0 for lockfile-exact clean installation, native initialization and
all seven canonical gates. Full suite: **2,724 files / 34,621 passed / 0 failed / 8 unchanged skips**.
Current full raw runner output/JSON and native terminal exit 0 are retained separately from the old
`a656f3b58` evidence. Separate current install/static raw logs were not located; the actual assigned
verdict retains their exit receipts. Do not substitute the older archive for current raw evidence.

AIO subsequently parked the item as **land-blocked**, retaining the PASS. Its exact refusal:
`Couldn't merge src/main/instance/instance-manager.ts: only Markdown documents can be merged with your edits. Overlapping paths: docs/plans/livetest-remediation-register.md, src/main/instance/instance-manager.ts.`
Main remains `86970a6b97c11fe0b9aeb462fa18063c0332cd01`; nothing landed. The seven concurrent
account-handoff source/test files match the original custody hashes. Their ownership/scope remains
with James to resolve; no stash, reset, manual commit/merge, force landing or unchanged retry.
The supported control inventory includes retry-landing but provides no safe overlap-resolution action.

Evidence: root `_scratch/queue-resume-2026-10-21/phasea-hookrepair-cursor-full-verdict.json`,
`phasea-bc8-final-landing-status.json`, `phasea-cursor-bc8c0f404-verifier-evidence/`, and
`coordinator-current-state.json`. The queue run ended with 0 landed, 15 parked and 5 skipped;
that run status does not complete the plans. Phase B integration, packaging/restart and dependent
original work remain pending. Keep this plan/history active and untracked.

## Coordinator merge conflict resolution (23 October, worker handoff)

- [x] Read the retained as-built notes, branch history, base diff and both parent inventories.
  No standalone spec is linked. Scope is the reported inventory conflict only.
- [x] Reproduced the failing inventory consistency check. Regenerated the inventory with the
  existing generator against the merged index and staged only that resolved artifact. Both
  conflict regions and duplicate rows from the text merge are gone. All 1,203 parent channels
  survive; an independent calculation over 7,621 indexed files matches all 331 large-file rows.
- [x] Alias/IPC regeneration produces no further tracked changes. Three focused files / 39 tests,
  architecture verification, application/Electron typechecks, lint and strict LOC exit 0.
  Both working/index diff checks pass; no unmerged entries remain. HEAD and MERGE_HEAD are
  unchanged, and every index entry outside the inventory matches the pre-resolution snapshot.
- [x] Spec typecheck TS2493 (fixed 24 October, see the repair section below): the mocks in
  `src/main/storage/low-disk-space-watcher.spec.ts` and `src/main/storage/scratch-sweep-scheduler.spec.ts`
  now declare typed `NotificationInput` parameters (the same fix main carries via oct2-housekeeping;
  both files are byte-identical to main's tip blobs) and `npm run typecheck:spec` exits 0.
- [x] Report, semantic seal, raw logs/JSON and actual exit receipts retained at ROOT
  `_scratch/queue-resume-2026-10-23/phasea-inventory-merge-resolution/` before cleanup.
  Removed the two archived runner originals. No runtime/dependency install, compile tree,
  source copy, full-suite run or browser step was created. Supplied dependencies and the
  pre-existing Vitest cache remain. No fresh whole-branch independent acceptance is claimed.

The merge remains open for the coordinator. This handoff neither commits/aborts it nor closes
the plan, Phase B dependencies, LT-707 restoration or existing deferred live checks.

## Spec-typecheck and flaky-wait repair (24 October, worker handoff)

The coordinator's merge is now finished on the branch as merge commit `599719575`
("Plan queue checkpoint: round 3 work", parents `bc8c0f404` + `1ee52cbd8`); the 23 October
"merge remains open" note above is the historical record of that handoff.

- [x] Reproduced the three TS2493 sites first (`npm run typecheck:spec` exit 2:
  `low-disk-space-watcher.spec.ts:64`, `:70`, `scratch-sweep-scheduler.spec.ts:111`), root cause
  zero-parameter `vi.fn` mocks indexed as `mock.calls[n]![0]`. The mocks now declare typed
  `NotificationInput` parameters — the same fix the aio-tidies plan records and main carries via
  oct2-housekeeping; both files are byte-identical to main's tip blobs. No assertion changed and
  `npm run typecheck:spec` exits 0.
- [x] Reproduced the round-3 flaky wait's source and repaired it the same way as the sibling wait
  at `plan-queue-retirement-control.spec.ts:506-524`: `normalPassLanding` no longer polls
  `verifierInstanceId` through `vi.waitFor`'s default one-second deadline across real Git
  checkpoint/spawn work. A passthrough `store.upsertItem` spy releases a deferred at the verifier
  publication write (the save at `plan-queue-item-flow.ts:431`, synchronously visible to
  `store.getItem`), then the original assertion runs unconditionally. No production timing,
  assertion semantics or test timeout changed; the shared helper's six call sites (nine tests) all pass.
- [x] Targeted tests and fast static checks: storage specs 13/13, retirement-control 26/26 twice
  (64.8 s and 26.1 s — the spread shows the load sensitivity the one-second deadline was exposed
  to), `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint` and `npm run check:ts-max-loc`
  exit 0; alias/IPC/architecture generators leave no tracked change. Full suite, clean-install
  and build gates remain the assigned verifier's acceptance and are not claimed here. No commit,
  staging, branch change, install/restart or completion rename.

Evidence: ROOT `_scratch/queue-resume-2026-10-24/phasea-ts2493-flake-repair/` — `worker-report.md`,
`command-receipts.json`, raw gate/test logs, `source-seal.txt` and `blob-match-vs-main.txt`.
No standalone spec is linked. Steps 7/8's Phase B dependencies, Step 14's commit boundary,
LT-707 restoration and the deferred live checks remain open.

> Plan Queue parked work: `queue/2026-10-20-oct2-phasea-safety-d0099e` — 12 commit(s), reason: round-limit.
