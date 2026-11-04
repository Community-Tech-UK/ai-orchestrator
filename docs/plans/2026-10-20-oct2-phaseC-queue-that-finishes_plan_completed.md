## Critical defect found 24 Oct (coordinator): a checkpoint in a broken worktree commits the ROOT repo

**What happened:** an item's queue worktree was half-removed (only `node_modules` left, no `.git` file). On its next
park, `PlanQueueWorktreeService.checkpoint` ran `git add -A` + `git commit --no-verify` with that directory as cwd; git
resolved the repository as the ROOT checkout (the directory is inside it), staged the root's ENTIRE working tree
(`git add -A` defaults to the whole tree since git 2.0) and committed it directly on `main`, bypassing the plan-spec
guard hook. Commit `2b949b0df` (70k lines) swept in every untracked planning document plus another session's
uncommitted work. Reflog: `main@{0}: commit: Plan queue checkpoint: parked: worktree-error`.

**Required fix (this plan's queue-hardening scope):**
1. `checkpoint` (and `removeWithProof`/`reattach`) must `assertQueueCheckout` FIRST: the directory must be a registered
   worktree of THIS repo whose checked-out branch is the item's branch; otherwise refuse and park with the
   `invalid-worktree` alert instead of running any git write.
2. A checkpoint must never use `--no-verify` against anything but a proven item branch; after the identity check, assert
   `git rev-parse --abbrev-ref HEAD` equals the item's branch before `add`/`commit`.
3. Regression: a fixture directory containing only `node_modules` must make `checkpoint` throw `worktree-error` (or the
   identity error) and leave the root HEAD unchanged.

# Oct-2 Phase C: a plan queue that finishes its work

## Status

4 November: Phase C is not landed. Earlier independent PASS and command receipts apply only to their frozen candidates; the last all-eight queue run at `a64a7633b01077be5af6763497473916a37d1f79` predates the later main changes. The current candidate must reconcile committed main, then receive current verification and a genuinely fresh independent review. No new PASS, installation or live-check result is claimed.

The root plan remains active and authoritative. [History snapshots](../plan-queue-history/phasec-585bd9ac8171/manifest.json) and [report snapshots](../plan-queue-history/phasec-cfa7455a-report-v1/manifest.json) preserve separate root, candidate and historical-base evidence. Root history, live checks and report stay unchanged. Installed observations, observation week and weekly campaign remain pending in the [live-check document](2026-10-20-oct2-phaseC-queue-that-finishes_livetest.md). Batched checks remain blocked until this prerequisite actually lands.

## Authorized integration handoff, 4 November

James approved continuing the bounded per-path preservation, temporary set-aside and restoration of overlapping local edits on 4 November. Preserve index and working-file contents separately, retain each current staged/unstaged boundary, and restore local changes uncommitted after supported promotion. The fresh preflight found the earlier staged queue changes already committed on main; do not replay them as local staged edits. No broad stash/reset, user commit/push, manual AIO integration, new branch/worktree or installed-app change is authorized. AIO alone owns supported checkpoint, merge, checker, squash, promotion and closure.

This handoff supersedes the older **document-packaging-only** worker restriction below. The next normal AIO conflict worker must reconcile current **committed** main `cfa7455a3ebbbeca621c6f5e57aa2cd7cf557edd` with Phase C through AIO's merge workflow. Retain the newer queue worktree exemption, maximum eight check slots, kept-folder cleanup, saved-worker-session closure and zero-as-unlimited settings alongside Phase C's gate receipts, identity protections, transient-error backoff and full original scope. Keep assertions, normal limits and configuration intact. Read the complete actual files/callers/tests; use `_scratch/phasec-dirty-root-integration-prep/resolved-proposal/report.md` and its files, plus `_scratch/phasec-authorized-integration/preflight/report.md`, `fresh.json` and `rebased-proposal/`, as reviewable resolution evidence, never blindly applied patches. Regenerate the inventory through the real generator against the intended final candidate index.

Do **not** import ROOT's currently **uncommitted** livetest-port changes or local version-31 port migration into the candidate. Those edits, including worker-session and untracked port-module companions, remain local. Preserve/set aside only actual overlaps at promotion and restore them afterward. Their settled compatibility design retains candidate migration 31 (history), 32 (spend), their historical SQL and any legacy port-31 ledger; the later local combination uses guarded port migration 33 and additive history repair 34, with the recorded upgrade/restart/data-preservation checks. That later local compatibility work does not block the candidate's committed-main synchronization/checking. Do not run migrations on a real database or change the app/provider/settings now.

Candidate active plan and evidence report are restored only to their exact historical committed main/base blobs; their final squash must have no active-plan/report delta. Never copy this current ROOT active plan into the candidate under its active name. The report variants are preserved byte-for-byte in the linked new candidate-only snapshot directory; do not mirror it into ROOT before promotion and create new untracked non-Markdown overlaps. Existing history/live packaging stays intact. AIO reads this authoritative ROOT plan into its completed-name copy and retires the matching active source only after promotion; any resulting tracked ROOT deletion stays uncommitted for later cleanup. Do not weaken the guard or mark a task document a standing register.

The next genuinely fresh independent AIO checker must apply `task-completion-gate` to the whole original Phase C scope, the actual committed-main reconciliation, all intervening repairs and this preservation packaging, then run all eight canonical gates including `check:ui-hints`. Preserve original failures and earlier evidence within their stated limits. Closure, history links and live deferrals remain pending until the supported lifecycle completes; no fresh acceptance or landing is asserted by this handoff.

## Active-history landing packaging, 3 November

The fresh queue checker passed all eight canonical checks at `a64a7633b01077be5af6763497473916a37d1f79`. Landing subsequently merged newer main into `585bd9ac817141e324198f60fc87f8c76ff92b54` (the startup-failure fix), then the real hook refused the changed active `_history.md`; no commit landed. Do not represent the earlier full suite as a full run on that later merge. AIO parked the item and removed its checkout, retaining the branch. `_scratch/phasec-history-landing-refusal/queue-status.json` and the saved history snapshots retain the exact refusal and source evidence. The running coordinator has not applied the candidate's new history snapshot preparation during this landing; do not weaken the hook or change accepted production code to conceal that packaging difference.

**Historical document-packaging-only scope, superseded by the 4 November integration handoff above.** Read the complete current root, candidate and base histories and their existing callers before changing anything. Preserve all three byte-for-byte in a new immutable subdirectory of `docs/plan-queue-history/phasec-585bd9ac8171/`, using clearly named `.txt` snapshot files plus a JSON manifest recording original paths, branch/base commits, SHA-256 hashes and byte counts. This path is deliberately outside the ignored `docs/plans/*evidence/` tree: the first worker created only ignored snapshots there and left the active-history delta unchanged, so that attempt was paused before review. Verify `git check-ignore` refuses the new paths and normal status/checkpoint includes them; do not change ignore rules or force-add ignored files. These are historical evidence, not completed live checks or a replacement for an active document. Keep the root active history and root live document byte-for-byte unchanged. Preserve the original failed verification evidence and historical uncertainty. Do not put secrets into new evidence.

Link that manifest from this ROOT active plan so AIO's normal completed-plan copy carries the reference. Put the exact same immutable evidence directory on the item branch through normal worker edits; do not stage or commit. Only after proving every candidate historical byte is preserved in that evidence, restore the candidate active history to the exact current base-branch contents, as was already done for the active live document. This removes the active-history delta from the landing commit without losing the candidate journal or any root edits. Preserve every production/test/configuration byte. Never delete or close the root history, copy it back onto the branch, mark it a standing register, skip hooks or manually merge. Do not rename the active plan: AIO owns its closure and integration. If an evidence name is occupied, verify exact identity or choose a new immutable name, never overwrite it.

After the supported checkpoint, the next genuinely fresh queue checker must inspect the evidence hashes, guard path, unchanged root history/live work, full original Phase C scope and intervening startup fix, then run all eight canonical checks (including `check:ui-hints`) before a PASS. A new full run is required for the newer main code; do not repeat an already passing full run solely for a documentation-only check. Independent review may use the retained original broad audit plus verified source identities, while independently checking all subsequent changes. Batching stays blocked until this prerequisite actually lands.

The exact root, candidate and base history snapshots are preserved with their provenance in the [history packaging manifest](../plan-queue-history/phasec-585bd9ac8171/manifest.json). They are historical data; root history and live checks remain active, and AIO owns closure and landing.

## Landing-document packaging handoff, 3 November

AIO's fresh checker accepted the main-synced candidate `42f2259667e389dc479ae00f96922f7e8bbd7ec8`, but landing correctly refused its changed active `_livetest.md`. The queue is paused. The corrected live procedures are now reconciled into the existing **root** live document, still pending and uncommitted; all unique local additions and dated cleanup observations survive. The candidate live document now exactly matches `main`, saved by AIO checkpoint `745d519cdafd8ca7c519d4efb1547343abe20449`. This is a document-packaging change only, with no production/test/configuration change. Snapshots and the explicit three-way conflict resolutions are retained in `_scratch/phasec-landing-doc-packaging/`.

Do not copy the root live document back onto the item branch, delete the root file, mark it complete, or weaken the landing guard. It was already tracked on `main`; restoring its base contents in the item checkout removes this item's active-document delta while preserving the root's pending work. A fresh independent gate on the corrected candidate is running in `_scratch/phasec-landing-packaging-gate/`; its actual verdict and evidence govern the next integration attempt. AIO still owns final plan/history closure and promotion. This handoff does not claim the prerequisite landed or the separate batching plan started.

## Socket-fixture verification follow-up, 3 November

The independent packaging gate returned FAIL: its full command exited 1 with an unhandled `ERR_STREAM_WRITE_AFTER_END` in the real gate concurrency fixture, despite all assertions passing. No production defect or host-load cause is claimed. `_scratch/phasec-socket-repair/` retains the exact real-TCP reproduction, unchanged passing focused baseline, minimal fixture patch and repaired passing focused run. The fixture now removes closed connections and waits for the cancelled connection to close before finishing only the survivor. Every original cancellation assertion and time limit remains; no error is swallowed. Parent verification in `_scratch/phasec-socket-canonical/` now records all fourteen commands passing at frozen `a64a7633b01077be5af6763497473916a37d1f79`, with an uncached complete one-fork suite, no unhandled-error footer, true exit 0 and unchanged clean source/index/HEAD. This is parent evidence, not a fresh independent acceptance verdict. The resumed queue must use its new independent checker context to apply `task-completion-gate`, review the original whole Phase C scope plus these packaging/fixture repairs, and run all eight canonical checks including `check:ui-hints` before reporting PASS. Preserve the original failed full run. The packaging repair and root pending live checks remain intact; never infer a passing full command from assertion-only JSON success or a narrow rerun. AIO owns checking and integration; no manual merge or guard bypass.

## Round-11 independent-review repair handoff, 3 November

**Independent acceptance, 3 November:** the genuinely fresh task-completion-gate and escalated broader audit return `VERDICT: PASS` with no unresolved actionable findings. Sealed report SHA-256: `f55ef360a025b1965c6690cfca097d45f036e54ffa72e30a94aa173eb1f9597f`. All 13 implementation groups and surviving changed tests are mapped in that gate's acceptance/source evidence. The historical review checkboxes below now record accepted repairs, not unresolved requirements. Their earlier failures, withdrawn concern, recovery-file limitations and timing evidence remain preserved. Installed/Windows/native observations, observation week and actual weekly campaign remain pending in the candidate live document; no such check is claimed executed. Auxiliary renderer-event baseline debt and cosmetic range warnings remain explicitly disclosed in the gate. AIO owns integration and completion-document closure without hook bypass or manual Git merge.

Current repair report: `_scratch/phasec-round12-repair/report.md`. Both diet writes reuse the existing preserved-original helper, which now publishes fully written outputs exclusively; document/history late-descriptor and active-path reproductions have RED/GREEN controls. The pause fixture now uses its own local hooks from initialization, after traces proved external user-hook execution; the actual local refusal hook and every test assertion/timeout remain intact. Stage/Git traces identify where reproduced deadlines elapsed, without a universal timing-cause claim. Supported AIO Pause checkpoints saved the repair and regenerated inventory. `_scratch/phasec-round12-canonical-rerun/` retains all 14 passing commands, full raw/JSON, source seal and recorded one-worker setting. This is parent verification, not fresh acceptance. Original recovery files remain deliberately preserved and previous live deferrals remain pending.

Read the sealed `_scratch/phasec-round11-final-gate/report.md`, its preservation/command evidence and complete production reproductions. One High code finding remains: `writeDietFiles` in checkpoint diet still overwrites/truncates original document and history inodes after final checks. Actual verification → SQLite history → checkpoint diet → accepted transformation → closure loses a concurrently appended requirement everywhere, then lands the completed plan. Separate already-open-descriptor probes prove document and history loss. Reproduce `diet-closure-concurrent-probe.cjs`, `diet-final-write-probe.cjs` and `diet-history-final-write-probe.cjs`, retaining unchanged and symlink controls. Reuse the existing non-destructive mutation/preserved-original mechanism at both diet writes; preserve exact input/output chaining, safe history accumulation, valid diet/closure behavior and ancestor/replacement protections. Unsafe changes must not become accepted transformations. Retained recovery files and late-descriptor limits remain explicit; no filesystem compare-and-swap claim is required.

- [x] Checkpoint document/history diet preserves late concurrent changes with executing regression/control evidence.
- [x] Diagnose the actual stage of the recurring real-hook Pause/Resume timeout with timing evidence where reproducible; preserve assertions/limits/configuration and obtain current full verification after repairs. A passing isolated rerun proves no cause. The independent raw full result has one timeout, no unhandled-error footer.
- [x] Run required gates and obtain another genuinely fresh scope-adequate PASS before AIO integration/closure.

The background-start stop suspicion in this review was explicitly **withdrawn** after the reviewer found omitted `retainFailedCreation → state-update → limits.observe` recovery wiring in its fixture. Do not change working production from that incomplete reproduction. Previous linked-spec, note/retirement, deadline, Setup, migration and live-deferral repairs remain implemented within their recorded limits. The entire plan stays active and existing live checks remain pending.

## Round-10 independent-review repair handoff, 3 November

Current repair evidence: `_scratch/phasec-round11-repair/report.md` covers all four findings; `_scratch/phasec-round11-followup/report.md` covers the subsequent real late-created-instance stop/usage regression and exact whole-coordinator recovery-file assertions. Original RED/runtime/GREEN receipts remain beside them. `_scratch/phasec-round11-canonical-rerun/finish.json`, command receipts and full raw/JSON record all 14 current gates exiting 0 with source preserved and checkout clean. These are parent checks, not an independent acceptance verdict.

Material as-built behavior: safe shared-document note updates and retirement retain original file identities as small hidden `.<document>.aio-retained-<UUID>` recovery files beside the document. They preserve writes made through an older open file, do not end in `.md` and are excluded by the normal queue document classifier. They remain visible to Git and are not automatically deleted or silently ignored. Recovery can require inspecting the retained original; no automatic reconciliation or cleanup guarantee is claimed. Both the helper and full coordinator tests assert exact preserved bytes and only the expected recovery paths. The weekly campaign procedure now exists in section 9 of the candidate live document and remains pending; the independently edited root live document has not been overwritten.

Read `_scratch/phasec-round10-final-gate/report.md`, acceptance/scope ledgers and all changed/unchanged executable probes. The gate preserves candidate source/index/HEAD and returns FAIL with the following current requirements. Earlier root/Setup/diet/stop/retry/migration repairs remain in scope to preserve, not repeat blindly.

- [x] **Every retired document is reviewed (F1, High):** bind linked specification content and presence/absence as well as the root plan to review-time identity. A changed or newly introduced spec after PASS must remain active for review through delayed landing, preparation, restart/recovery and final publication. The current real production verification/history/landing/closure probe completes a changed spec despite an unchanged root hash. Reproduce `linked-spec-probe.cjs` and controls; preserve existing valid coordinator transformations and immutable histories.
- [x] **Concurrent shared-document edits survive mutations and retirement (F2, High):** parked-note append/remove currently overwrite a requirement inserted after their async read, then record the lost-write output as accepted. Final `removeSources` can also delete a requirement inserted between its last check and unlink. Reproduce `park-note-concurrent-probe.cjs` (insert/remove) and `retirement-concurrent-probe.cjs`, with unchanged controls. Prove exact input/output and safe file/ancestor identity at these mutation boundaries, preserve changed/replacement/symlink inputs and unrelated targets, and record no acceptance for an unsafe/no-op transform. Preserve existing safe diet, retry, closure and concurrent root-history behavior. Service-boundary probes use real filesystem/SQLite/helpers with explicitly synthetic Git/host promotion; do not claim full real-Git proof from them.
- [x] **Expired work cannot reach provider creation (F3, High):** global-pause pending resume arms an already elapsed deadline with a zero-delay timer, then microtasks reach `createInstance` before expiry runs; direct retry also reproduces. Check elapsed saved deadlines before startup/input and after relevant awaited admission, preserving original startedAt, durable nonretryable expiry, stop ownership and no late provider starts. Use `surfaces/overdue-dispatch-probe.cjs` with expired resume/retry and unexpired controls; retain ordinary scheduler network/failed-stop coverage.
- [x] **Executable weekly-campaign deferral (F4, Medium):** Step 12.4 is pending, but neither live document contains the claimed weekly campaign procedure. Record exact prerequisites, Windows target, intended weekly schedule/campaign inputs, steps and expected scheduling/run observations, with reason it awaits integration. Preserve pending status; do not create an automation or claim a run occurred. Keep other live procedures and root concurrent edits intact.
- [x] **Current full verification:** fresh full suite exits 1 on the working checkpoint case at `plan-queue-pause-control.spec.ts:273`; unchanged isolated recheck passes, which proves no cause and waives nothing. Diagnose with actual stage/timing evidence if it recurs, keep assertions/limits/configuration intact, and obtain a current green full run after repairs. No unhandled-error footer occurred in this fresh run; retain earlier source-map failure evidence without claiming its cause fixed.

Canonical command/source seals and true limits are in that report. The complete required checks and another genuinely fresh independent PASS with no unresolved findings still precede AIO integration and document closure. No manual merge, hook bypass, active shared-history deletion or installed-app update is authorized.

## Round-9 independent-review repair handoff, 3 November

Repair/verification update: the native repair worker's complete RED/GREEN report is `_scratch/phasec-round10-repair/report.md`, including its meaningful size refactor; `_scratch/phasec-round10-migration-repair/report.md` records the subsequent actual SQLite runtime proof before changing the integration test. Supported AIO Pause checkpointed these changes without manual staging/commits. Current serial canonical receipts, raw output and original JSON are in `_scratch/phasec-round10-canonical-rerun/`; all 14 commands exit 0, source HEAD is preserved and status is clean. Earlier failed runs are retained separately. The original timeout/source-map cause remains unproven; it is not claimed fixed by a timeout/config change. The requirements below remain the fresh review's acceptance criteria, with implementation evidence now available rather than an outstanding request to repeat the fixes.

Read the full `_scratch/phasec-round9-gate/report.md`, both scope ledgers and executable evidence. It independently reviewed frozen `9cd6e071999d54968367c7eb7f7330ee5050e0e8` against merge-base `dccbc6e259385cf79559257ce413508eb0470cbe`, preserving source/index/HEAD. All six round-8 repairs now have executing/source evidence and must stay intact. Two new supported defects and one verification failure remain:

- [x] **Reviewed document identity through landing and closure (High):** a root plan can gain a genuinely new unchecked requirement after an actual recorded PASS while waiting behind another landing. The landing/closure path snapshots those later bytes and publishes a completed copy, removes the active source and marks the item landed without another review. Reproduce `_scratch/phasec-round9-gate/surfaces/post-verdict-closure-ignored-probe.cjs` and its changed/unchanged JSON controls. This uses real verification/landing/document-close/filesystem helpers with explicitly stubbed Git promotion/host boundaries; do not claim complete real-Git integration from it. Preserve and revalidate the reviewed document identity through serialized landing and final closure; new requirements must remain active for review. Cover delayed landing, the unchanged control, and edits at the final mutation boundary. Preserve valid coordinator journal transformations, source/history concurrency protection and shared-history closure; do not equate the unchanged item Git HEAD with unchanged root criteria.
- [x] **Displayed Setup run controls (Medium):** Set aside → Choose a checker → Setup renders the normal run-list Pause/Resume/Cancel/Skip actions without listening to their outputs. Actual rendered Angular clicks on a running run with another working document produce zero `store.control` calls from Setup; the same Pause button works in Now. Use `_scratch/phasec-round9-gate/surfaces/setup-control-probe.spec.ts`, `probe-result.json` and the successful command receipt. Connect displayed controls to the existing page handlers, or deliberately render an editor-only view. Add an actual page DOM regression, preserving confirmation semantics and existing Now behavior. Follow the screen/wording guide; no local browser is authorized.
- [x] **Current full verification remains red:** the uncached full suite timed out the real-hook Pause/Resume landing case in `plan-queue-pause-control.spec.ts:334` and recorded one unhandled source-map JSON conversion error. The exact unchanged case and complete file subsequently pass; this does not establish a cause or waive the full run. Inspect the full raw log, reproduce/diagnose supported failures, fix any genuine defect, and obtain a current green uncached full suite after all repairs. Do not widen timeouts, weaken assertions, suppress errors or infer host load from a single timeout. Preserve the original failure and narrower recheck evidence. The earlier spend-attribution failure is repaired.

The unchanged renderer-event baseline debt remains disclosed, as in the previous report. No new provider/native/installed observation was performed. Keep this plan active and preserve all existing live deferrals. After repair and canonical verification, freeze the candidate and obtain another genuinely fresh independent PASS with no unresolved findings before AIO integration or lifecycle closure. No manual merge, hook bypass, active shared-history deletion or installed-app update is authorized.

## Round-8 independent-review repair handoff, 3 November

Read the complete fresh `_scratch/phasec-round8-gate/report.md`, its scope ledger and executable probes. This gate independently reviewed `dccbc6e259385cf79559257ce413508eb0470cbe..dfa97b2eec0b1e8736089e161a18800b1639bf3e` and preserved the source/index/HEAD. Seven canonical commands pass; the uncached full suite fails one spend-attribution case. The earlier three High findings are repaired on the exercised scheduler/worker/controller boundaries; preserve those fixes. The older unchecked investigation lists below are historical requirements, not a request to undo or blindly repeat repaired work.

- [x] **Required full-suite failure:** `automation-spend-attribution.spec.ts` still constructs a direct retry-dispatch store without the now-required `getRun`. The full suite and independent focused Node 24/26 runs reproduce the TypeError before the attribution assertions. Supply the exact saved retry record in the fixture and retain every attribution assertion; do not make the production lookup optional or add a silent fallback. Evidence: `test-run.round8-gate-spend*.log`, original JSON and report finding 1.
- [x] **Checkpoint root-history identity:** the actual `dietAtCheckpoint` wrapper follows a sibling root history symlink and appends journal bytes into an unrelated target. Reproduce with `_scratch/phasec-round8-gate/diet-symlink-probe.cjs`; add a production checkpoint/root-history regression. Prove safe regular-file and ancestor identity at the mutation boundary and preserve both document and history/target on refusal, including changed identities. The item checkout's own Git proof does not prove the root history path. Fix the actual write boundary without weakening concurrent-edit preservation or closure safety.
- [x] **Successful unfamiliar gate summaries:** automatic receipt admission accepts exit-zero `not-recognised` output, but the emitted checker prompt still says unrecognised results remain failures and directs a finding. Align the executing prompt with the accepted policy; cover an unfamiliar successful receipt while retaining failure, timeout and empty-suite refusal. Probe: `unknown-summary-prompt-probe.cjs`; no real-model response was assumed.
- [x] **Live MCP slot description:** `src/main/mcp/plan-queue-tools.ts` still describes `verification_slots` as across all runs. Update the exact tool schema description to agree with per-run/per-project-folder admission and workload machine limits. Architecture/CLI changes alone did not repair this previous finding.
- [x] **Structured-result live procedure:** section 2 of the live document asks an existing-thread destination to call `automation_result`, but `recordResult` permits only an owned `newInstance` run and thread wakeup completes on prompt delivery. Correct the procedure to test structured reporting in a fresh owned agent run (and the owned loop path where relevant), separately checking existing-thread delivery. Preserve authority over human threads; do not change runtime ownership to satisfy stale live instructions. Evidence: `thread-result-probe.cjs` and executing endpoint/dispatcher traces in the fresh report.
- [x] **Final generated architecture inventory:** `verify:architecture` independently fails because the final index differs from `docs/generated/architecture-inventory.json` (runner spec line count and newly large runner module). Regenerate against the final indexed source through AIO's authorized lifecycle after all repairs. Do not weaken the generator/check or manually stage another session's work. Evidence: `architecture-delta.json`, `expected-architecture-inventory.json` and `gate-08.log`.

The supplemental renderer-event scan also fails, but the same unchanged scanner over merge-base Git objects produces the identical five uncovered channels and two dynamic sites. This inherited debt is disclosed, not claimed green or treated as a new Phase C defect. Actual installed lock versions/graph match; stale hidden-lock metadata alone was not treated as executable dependency drift. See the independent report for precise limits and baseline evidence.

Worker repair pass: all six items above have current implementation/check evidence in the round-9 report. The root plan stays active. The coordinator must freeze this repaired candidate and obtain another genuinely fresh full gate with no unresolved findings. No hook bypass, manual integration, installed-app update, deletion of shared active histories or completion rename is authorized by this handoff.

## Outstanding independent-review acceptance, 3 November

Read the complete fresh report and executable probes in `_scratch/phasec-final-gate/report.md`, not just its verdict. It independently ran all canonical checks and the required broader audit against `82cacc7bb4f8d5dc8363e773f1f83d843763e504`, then refused acceptance for the three High findings below. Compare the repaired candidate with that reviewed revision; retain repairs already made, reproduce any remaining executing defect before editing, and record evidence if a finding no longer applies. Do not weaken tests or suppress failures.

- [x] **Retry deadline before network waits:** scheduler `onRetryTimer` inserts a running retry and waits in the network gate before `dispatchRetryRun` arms its deadline. The production-module probe demonstrates a one-minute job still running at 61 seconds with no watchdog, then dispatching when the network returns. Arm the original run deadline before the wait, preserve nonretryable expiry and ensure no late provider start. Probe: `_scratch/phasec-final-gate/retry-network-probe.cjs`; add an executing scheduler/store regression.
- [x] **Retry admission respects failed-stop ownership:** normal fires and pending promotions consult `hasStoppingRun`, but `dispatchRetryRun` does not. The saved executing runner probe starts a paid session while the stopping predicate is true without consulting it. Preserve the same admission/ownership fence at every retry ingress, with a durable visible outcome and a regression for an older retry due after a newer same-job stop rejects. Probe: `_scratch/phasec-final-gate/retry-stop-fence-probe.cjs`.
- [x] **Pending worker cancellation does not falsely acknowledge stop:** the controller now waits for confirmed remote termination, but `LocalInstanceManager` swallows pending-adapter stop failures, drops the pending ownership and lets the RPC acknowledge success. The spanning controller/worker probe leaves the provider running with no owner after two failed stop attempts. Propagate the failure and retain ownership so later termination can still reach the same adapter; cover both sides of pending creation/cancellation. Probe: `_scratch/phasec-final-gate/pending-worker-stop-probe.cjs`. This is distinct from the round-7 controller-side reject-on-failed-RPC correction.
- [x] **Review wording and live expectations:** reconcile per-folder check-slot descriptions in the architecture/tools docs, and the existing remote Copilot usage live-check expectation with the implemented numeric telemetry. Preserve genuinely unavailable observations and existing pending live checks; do not change working source to satisfy stale wording.

The latest queue verdict is preserved verbatim as data in `_scratch/phasec-latest-findings/queue-verdict.json`. These nine findings require investigation on the current branch; a prior pass elsewhere is not rebuttal. Fix supported defects with behavioral regression evidence; explicitly document a source-backed rejection of any inaccurate finding. Do not treat these unverified allegations as already reproduced.

- [x] **Cron schedule after a failed dispatched restart retry:** prove the recurring timer is re-armed after the retry itself fails, not only when a retry is dropped before dispatch or succeeds.
- [x] **Catch-up versus deliberate monitor slowdown:** deliberately skipped nominal occurrences must not trigger immediate catch-up runs or false missed-run records under either `runOnce` or `notify`.
- [x] **Whole Markdown structure on close-small:** restrict journal slimming to the intended section, preserve later verification/live/finishing sections and complete lines/code fences; reproduce the budget-cut path.
- [x] **Human-form saves preserve slowdown:** confirm the executing IPC update path, including model-hint dismissal, preserves a current slowed next-fire time unless meaningful schedule/action changes require recalculation, as the MCP path already does.
- [x] **Restart continuation wording:** show an interrupted run's actual pending retry, without promising another run when no retry remains; meet Step 9's user-visible acceptance.
- [x] **Agent create-automation coverage:** restore meaningful authenticated-agent cases for explicit non-Claude provider choices if the two previously agent-scoped tests now exercise only the unrestricted human path. Preserve the authority ceiling.
- [x] **Standalone temporary-directory fixtures:** affected Copilot/remote Codex specs must create their own scratch parent and clean up rather than depending on the full quiet runner having created it.
- [x] **Exhaustive reason help and unused alerts component:** verify every persisted park reason has tested help/actions, remove the old alerts component only if its callers confirm it is unused, and preserve the replacement leftover-folders link.
- [x] **Ownership diagnostic causes:** retain safe refusal while distinguishing genuine identity mismatch from Git/I/O/transient failures; preserve the underlying cause for actionable diagnostics rather than hiding every failure as a foreign checkout.

Only a genuinely fresh final gate on the repaired, frozen candidate, with no unresolved actionable findings and all canonical checks passing, may complete coordinator acceptance or document closure.

## Worker acceptance, 2 November 2026

- [x] **Step 5 / Finishing, preserve history without staging an active history change:** landing is currently blocked by `docs/plans/2026-10-20-oct2-phaseC-queue-that-finishes_history.md`. The branch's `fix(docs): keep active queue history untracked` commit removed it, but the following coordinator checkpoint re-added all 493 lines. Repair the coordinator-owned closure/landing path so a verified plan's history is preserved in immutable completed evidence and its landing commit passes the existing active-document guard. Preserve both candidate and root history records, including concurrent root edits, and preserve a shared active history still needed by another open plan/livetest. Do not delete history, mark a task history as a standing register, weaken the guard, bypass hooks or rely on a worker `git rm --cached` that checkpointing reverses. Add a real-Git landing regression starting with a tracked and modified active shared history: coordinator checkpoint, closed-document preparation and the actual guard must succeed together, completed history contains all records, unrelated/root edits survive, and interrupted/retried closure remains safe. Keep document lifecycle completion with the coordinator after an independent PASS; workers must not rename this active root plan complete.

- [x] **Step 9.7, compare complete loop-monitor output:** `AutomationLoopRunLimits.output()` returns only `lastAssistantOutput`, and `AutomationLoopRunDispatcher.handleLoopStateChanged` passes that same final message as `monitorOutput`. The production-limits probe gives identical comparison output for `['Server healthy', 'Finished checking.']` and `['Server has an urgent warning', 'Finished checking.']` (`_scratch/phasec-fresh-gate/loop-monitor-reproduction.json`). This probe uses mocked timer/storage boundaries and is not a full dispatcher/store integration pass. Retain the final message for display summaries while comparing all assistant output, as the one-shot path already does. Add a real loop dispatcher/store regression where an earlier warning changes but the signoff stays identical, and verify unchanged-output backoff resets. Do not weaken or remove the existing one-shot complete-output regression.

- [x] **Step 6 implementation: prevent unrelated or ignored Markdown from hiding a selected document.** An exact selected path is discovered and deterministically queued regardless of unrelated/ignored Markdown before it, while preserving repository boundaries, ignore/copy exclusions, lifecycle/readiness checks and 16-KiB/40-line headers. Exact paths inspect only their ancestors; wildcard traversal retains finite entry/depth/candidate limits and explicitly refuses incomplete results. Coverage retains the 4,999 positive control, both 5,000 omission cases, exact-path queue wiring, and wildcard discovery with irrelevant/ignored entries. All affected specifications pass on the current source. Full-candidate gate acceptance remains assigned below, including all eight canonical checks and an independent PASS; implementation evidence does not replace it.

The five earlier follow-up criteria are implemented and included in the affected-specification run:

- [x] **Closure identity:** retirement checks the original input identity separately from the slimmed completed output and checks transformed/moved history evidence. Unchanged active roots retire; changed roots or histories remain untouched. Document-close/landing regressions cover both paths.
- [x] **Immutable histories:** each closure owns a history name derived from the full owning document and its source identity. Existing completed histories and accumulated active records survive; sequential plan/livetest closures, occupied names and concurrent changes are covered without replacing closed documents.
- [x] **Baseline identity:** baseline creation receives the resolved immutable commit, and receipts/cache keys identify the commit actually checked. Gate/worktree coverage retains capacity, identity and cleanup safeguards.
- [x] **Preparation streaks:** a successful worker start resets the cross-job failure streak through the actual start path; failures from different jobs only pause when consecutive within the same run. Interleaved jobs and separate runs remain isolated.
- [x] **Gate admission:** the waiting gate set rechecks current admission when it acquires the queue-wide slot. The executing guard is present after the wait; current gate tests cover serial execution, receipt reuse and waiting cancellation. No host-load experiment ran. *Superseded on 2 November 2026 by the item below.*
- [x] **Gate runs use the check slots, not a gate slot (James, 2 November 2026):** removed the queue-wide gate slot and its "Waiting to run checks" wait. Gate sets start under the pump's per-project-folder check admission and count as that job's check (Step 2.8). Tests cover simultaneous folders, two concurrent gates in one folder with two slots, Lightest/Light machine-wide limits, receipt reuse, independent cancellation, shared base comparisons and cancelled-owner recovery. Real command groups and the executing preparation/coordinator admission paths are covered. Final affected groups: 8 files, 198 tests passed; [receipts and review limits](2026-10-20-oct2-phaseC-queue-that-finishes_evidence/round4/report.md).
- [x] **Step 9.7, preserve the cron schedule when slowing monitors:** `automation-monitor.ts:recordMonitorOutcome` currently writes `now + (second - first) * multiplier`. A changed-output daily `0 9 * * *` UTC job completing at 09:10 is rescheduled for 09:10 tomorrow instead of the nominal 09:00. The independent production-module probe reproduces this in `_scratch/phasec-fresh-gate/cron-reproduction.json`. Use actual schedule occurrences for slowdown and return to the next nominal occurrence on change; preserve timezone/DST and irregular weekly/monthly schedules. Add regressions for changed output after an unaligned finish time and for unchanged-output backoff on irregular schedules. Do not preserve the drifting expectation merely because the existing test asserts it.
- [x] **Complete the 24 October checkout-identity requirement before mutation:** `PlanQueueWorktreeService.checkpoint` invokes root-document diet and landing recovery before its branch/top-level-only check; it does not establish the owning repository's common directory or worktree registration. A probe of the unchanged service with simulated foreign Git/filesystem boundaries requests `add -A` and `commit --no-verify` in a different repository on a same-named branch (`_scratch/phasec-fresh-gate/worktree-identity-reproduction.json`); this is a service-boundary reproduction, not a real-Git integration pass. `removeWithProof` also lacks the initial owning-checkout proof. Apply the existing owning-repository/registered-checkout requirement to checkpoint, reattach and removal before root-document, Git, recovery, process-cleanup or filesystem mutations. Preserve intentional detached-landing recovery only after an independent safe ownership proof, then require the item's branch before checkpointing. Prove refusal with real temporary Git fixtures for half-removed paths, a foreign repository on the same branch and invalid registration; verify root/foreign HEAD, index, files and root documents remain unchanged. Retain valid detached-recovery coverage; update all internal callers together without a compatibility shim.
- [x] **Coordinator/verifier acceptance (reserved by the worker assignment):** Run all eight canonical checks on the final provisioned candidate, including UI hints and the coordinator-owned full suite; run applicable migration, architecture, IPC and generated-output checks. Obtain a fresh independent completion pass with honest semantic coverage and required audit escalation, fixing any actionable findings before closure. Scoped review and whole-range pattern scans do not establish whole-plan acceptance. Preserve root work and existing live deferrals; no manual integration, guard bypass, provider setting or running-app update is authorized.

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items L4, L5, L6, L7, L9, L10, L12, T8, T9, K3.1, K3.2,
K3.6 (rest), and T1 items 2, 4 and 6. **Programme:** [Phase A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) ·
[B](2026-10-20-oct2-phaseB-land-built-work_plan.md) · C (this) · [D](2026-10-20-oct2-phaseD-tokens_plan.md) ·
[E](2026-10-20-oct2-phaseE-calm-screen_plan.md) · [F](2026-10-20-oct2-phaseF-tooltips_plan.md) ·
[housekeeping](2026-10-20-oct2-housekeeping_plan_completed.md) · [later](2026-10-20-oct2-later_plan.md) ·
[decisions](2026-10-20-oct2-decisions-for-james_completed.md).

## In plain English

The plan queue does the unattended work now. Its design is sound, but it loses work in the seams. After this plan:

- a checker's "pass" is checked against test results Harness ran itself, and the checker has to say what it did not check;
- one temporary problem (all work folders busy, a missing second model) pauses the run once instead of setting aside every job;
- the queue stops picking up hundreds of copies of plans from evidence folders, and remembers what it already decided;
- each new checker round sees what earlier rounds found, and an unchanged fix is not re-checked;
- the queue page shows three tabs instead of seven stacked sections, in plain words;
- scheduled jobs get a time limit, a token cap, a proper "nothing to do" result and one fair retry after a restart;
- second opinions that are already out of date are cancelled instead of finished and thrown away;
- queue spend shows real token counts and "not priced" instead of `$0.00`.

## Scope

In: the items listed above. Not in: the per-step job split and size gate (T1 item 5, Phase B), Codex and Claude token levers
(Phase D), the screen-wide error module (Phase E). L8 is T4 (Phase A).

## Ground rules

1. **Read first.** Line numbers below are from the 20 Oct working tree; several files have uncommitted edits from other
   sessions, so trust function names over numbers. Read the whole file, its callers and specs before editing.
2. **Prove it first.** Write the named failing test, run it, and see it fail on today's code before changing code.
3. **Current checkout only.** No branch or worktree (James's rule). Anything already modified when you start belongs to
   another session: never stage, revert, reformat or `git stash` it. Stage only your own hunks, and only when James asks
   for a commit.
4. **File size** (`npm run check:ts-max-loc`): files not on the allowlist are capped at 700 lines with no slack;
   allowlisted files at their ceiling plus 50. Tight files here: `plan-queue-item-flow.ts` and `plan-queue-coordinator.ts`
   (at the cap on 20 Oct; Phase A Step 0 frees about 40 lines in each, shared with Phase A's own steps, so count before
   every edit), `automation-store.ts` 930 (limit 934), `automation-runner.ts` 763 (limit 799),
   `cross-model-review-service.ts` 932 (limit 1,011), `codex-app-server-adapter.ts` 753/754 (Step 13: one line or a new
   module), `settings.types.ts` 885/889 (new keys in a separate settings-types module). New logic goes in new modules; call-site edits are a line or two.
   If a step cannot fit, extract more first; never raise a ceiling.
5. **Loop database migrations** live in `src/main/orchestration/loop-schema.ts` (`MIGRATIONS`, `runLoopMigrations`);
   `LOOP_SCHEMA_VERSION` is 23 and is asserted in `loop-schema.spec.ts`. Phase B Step 5 takes one first; Steps 1, 3 and
   7 here each need one: take the next
   free number when built, in step order, and update the version test. RLM migrations (scheduled jobs) are in
   `src/main/persistence/rlm/`; the next free RLM number after everything queued on the Phase 1 and follow-ups branches is
   082, so check both branches (Phase B lands them) before choosing one.
6. **IPC and tool schemas:** a plan-queue tool has two definitions that must change together: the JSON `inputSchema` in
   `src/main/mcp/plan-queue-tools.ts` and the Zod schema in `packages/contracts/src/schemas/plan-queue.schemas.ts`. New IPC
   channels follow AGENTS.md's IPC rule, then run `npm run generate:ipc`, `npm run verify:ipc` and
   `npm run verify:ipc-usage`.
7. **Settings** live in seven places (`settings.types.ts`, `settings-defaults.ts`, `settings-metadata-*.ts`,
   `settings-surfacing.ts`, `settings-control-policy.ts`, `settings-validators.ts`, `advanced-settings-sections.ts`). A
   changed default reaches James's install only through a settings migration (`settings-migrations.ts`, run at
   `settings-manager.ts:205`), because his `settings.json` stores every value.
8. **Words on screen:** plain English, "Harness", no internal codes; tooltips through `appTooltip`, never a new `title=`.
   Angular: standalone, `OnPush`, `inject()`, signals, `input()`/`output()`.
9. **No browser or desktop app on the Mac.** Renderer behaviour is tested headless in Vitest with seeded stores. Anything
   that needs eyes on the rebuilt app goes into this plan's live-test document and runs on the Windows PC. If the Windows
   PC is down, stop and tell James; never fall back to the Mac.
10. **Never write to James's databases or settings from a script.** Read-only queries use `?mode=ro`.
11. **Plan hygiene (T1):** keep the Status block above under about 1,500 characters and rewrite it in place.

## Order of work

| Step | Item | Size | Needs first | Main files (new in *italics*) |
|---|---|---|---|---|
| 1 | L7 part 1: event and verdict history tables; the shared progress fingerprint | S | Phase A | `loop-schema.ts`, `plan-queue-store.ts`, *`plan-queue-history-store.ts`*, *`plan-queue-progress.ts`* |
| 2 | L4: Harness runs the gates; receipts; `not_checked` | M | Step 1 | *`plan-queue-gate-receipts.ts`*, `plan-queue-landing.ts`, `plan-queue-process.ts`, `plan-queue-tools.ts`, `plan-queue.schemas.ts`, `verify-failure-keys.ts` |
| 3 | L5: transient errors wait; run-start preflight; worker retry; restart counter | S-M | Step 1 | *`plan-queue-error-class.ts`*, *`plan-queue-run-preflight.ts`*, `plan-queue-item-flow.ts`, `plan-queue-recovery.ts` |
| 4 | L7 part 2: earlier-rounds block, no-progress skip, same-finding step-back | M | Steps 1-3 | `plan-queue-progress.ts` (from Step 1), `plan-queue-prompts.ts` |
| 5 | T1 items 2, 4 and 6: coordinator plan diet, pinned criteria, close small | S-M | Step 4 | *`plan-queue-plan-diet.ts`*, `plan-queue-prompts.ts`, `plan-queue-squash.ts` |
| 6 | L6: discovery skips copies, remembers decisions, no triage for picked documents | S | Step 1 | `plan-queue-discovery.ts`, `plan-queue-triage.ts`, `plan-queue.schemas.ts` |
| 7 | K3.1, K3.2: honest queue spend | S | Step 1 | `plan-queue-spend.ts`, `plan-queue-spend-label.ts`, `loop-schema.ts` |
| 8 | L9: the queue page | M | Steps 2-7 | `plan-queue-page.component.*`, `plan-queue-item-list.component.ts`, *`plan-queue-park-reason-help.ts`* |
| 9 | L10: scheduled jobs | S-M each | Phase B (A15 pre-check from Phase 1) for item 4 only | *`automation-run-limits.ts`*, *`automation-restart-retry.ts`*, `automation-runner.ts`, `automation-tool-impl.ts`, `orchestrator-automation-tools.ts` |
| 10 | T9: second opinions | S | none | `cross-model-review-service.ts`, `reviewer-pool.ts`, *`review-staleness-abort.ts`* |
| 11 | T8: Copilot premium requests | S | none | model picker, *`copilot-events-tail.ts`*, CLI status page |
| 12 | L12: the live-check register | S | none | `livetest-remediation-register.md`, *`scripts/next-lt-id.mjs`*, `AGENTS.md`, `plan-queue-prompts.ts` |
| 13 | K3.6 (rest): one usage line per ephemeral Codex thread, full fields | XS | Phase A Step 6 | `codex-app-server-adapter.ts` |

Steps 10 and 11 share no files with 1-9 and may run alongside them. Step 12 edits `plan-queue-prompts.ts`, like Steps 2, 4
and 5: do it after them.

---

## Step 1. L7 part 1: keep every verdict and every state change

**What's wrong.** Only the last verdict survives: `startVerification` clears it (`plan-queue-item-flow.ts:353`,
`verdict: null`), `resume()` resets round, verdict and detail (`:563-567`), and the only copy of earlier findings is the
in-memory fix prompt (`:521-522`). No table records state changes, so park history, repeated findings and restart loops
cannot be measured.

**Change.**
1. New loop migration `NNN_plan_queue_history` with two tables:
   - `plan_queue_item_events(id, item_id, run_id, at, from_state, to_state, reason, detail_head, round, tokens)`;
     `detail_head` is at most 500 characters with absolute paths stripped.
   - `plan_queue_verdicts(id, item_id, run_id, round, at, verdict, findings_json, gates_json, not_checked_json,
     worktree_head, document_sha256)`. Each finding gets a stable id: SHA-256 of its normalised title and file.
2. A small `plan-queue-history-store.ts` (insert and read only), injected into the flow beside `PlanQueueStore`.
3. Write an event on every `transition(...)` in the flow (one helper call where `transition` is defined, not at each call
   site), and a verdict row in `finishVerification` before the item moves on.
4. Read API: `listVerdicts(itemId)`, `listEvents(itemId, limit)`, used by Steps 2-4 and 8.
5. `plan-queue-progress.ts`: one progress fingerprint `{worktreeHead, documentSha256, round}`, defined here once and used by
   Step 3's restart counter, Step 4's no-progress check and Step 5.

**Tests (fail today).** `plan-queue-store.spec.ts`: two FAIL rounds and a PASS leave three verdict rows; `resume()` keeps
them. `loop-schema.spec.ts`: version bumped, tables exist after migration.

**Done when:** every round of a test run leaves a verdict row and every state change an event row.

## Step 2. L4: Harness runs the gates; the checker gets receipts and says what it did not check

**What's wrong.** The checker runs the gates itself and reports exit codes; `reportVerdict` stores them as given
(`plan-queue-coordinator.ts:480-493`) and a PASS goes straight to landing (`plan-queue-item-flow.ts:509-513`). Nothing
compares PASS with the reported gates.

**Change.**
1. **Run the gates before the checker.** In `startVerification` (`plan-queue-item-flow.ts:352-379`), after the sync and
   checkpoint and before `selectAndSpawnVerifier`, run `run.config.verifierGates` in the worktree. Put the logic in
   `plan-queue-gate-receipts.ts`, built on `runInProcessGroup` (`plan-queue-process.ts:33-101`) rather than on
   `runPostMergeGate`, which stops at the first failure and keeps no per-gate record. Run every gate; record per gate:
   command, exit code, duration, a timed-out flag (today a timeout is only text in the output), a 2 KB tail, and worktree
   HEAD. Run under the item lock, before the tree snapshot at `spawnVerifier` (`:401`), so gate side effects do not count
   as "the checker changed files".
2. **Classify output** four ways: passed, failed, no tests found, not recognised (storybloq's `classifyEvidence` shape).
   A `test:quiet` run that prints its one-line summary is "passed"; exit 0 with no summary is "not recognised".
3. **Red goes straight back.** Any failed or timed-out receipt sends the item to `toFixing` with
   `buildGateFailurePrompt` (`plan-queue-prompts.ts:135`, already used by the post-merge gate) and the tail. No checker is
   spawned for that round.
4. **Base failures don't block.** Once per base commit, run the same gates on a clean checkout of the base (the queue's own
   throwaway worktree described below, not the root). Extract a state-free key diff from `extractVerifyFailureKeys`
   (`src/main/orchestration/verify-failure-keys.ts:28`): the loop's `classifyVerifyAgainstBaseline` is tied to `LoopState`
   and cannot be called as it is. The clean base checkout is a throwaway detached worktree created through the queue's
   own worktree service (`WorktreeManager`, counted against the worktree cap), removed after the run; never the root
   checkout, and never a hand-made `git worktree add`. Mark each failing receipt "also failing on base" or "new"; only "new" blocks. Cache base
   receipts by base commit SHA.
5. **Checker prompt** (`buildVerifierPrompt`, `plan-queue-prompts.ts:176-217`): replace "Run these gates … record each
   exit code" (`:202-204`) with the receipts table and "Do not re-run a green gate unless you change files."
6. **`not_checked: string[]`** becomes required on `plan_queue_report_verdict`, in the Zod args schema
   (`plan-queue.schemas.ts:298-305`), the JSON `inputSchema` (`plan-queue-tools.ts:209-245`), `PlanQueueVerdictSchema`
   (`:80-92`) and the coordinator mapping (`:485-491`). Empty is allowed; entries that are only "TODO", "n/a" or "not run"
   are refused. The handler already parses with Zod (`plan-queue-tools.ts:268`), so a refusal returns to the checker while
   its turn is open. Update the example call (`plan-queue-prompts.ts:208-215`); `plan-queue-prompts.spec.ts:84-96` parses it.
7. **A PASS must agree with the receipts.** In `finishVerification`, refuse a PASS while any receipt for the current HEAD is
   red and "new"; count it as a FAIL with the finding "Harness's own gate run failed: <command>".
8. **Load.** The canonical gates take up to 15 minutes each. A gate set runs inside the job's own check slot: it starts
   only when the pump's check admission (`plan-queue-pump.ts`, per-project-folder check slots, the workload level's
   minimums, the Lightest/Light machine-wide cap and the load-average gate) would start a check for that job, and
   counts as that check until its receipts are written and the checker is spawned or the job goes back to fixing.
   The checker retains that same check slot through its review; writing receipts does not release and reacquire a slot.
   There is no separate gate slot, queue-wide or per folder: James decided on 2 November 2026 that gate runs must not
   wait behind each other beyond the check slots, because a single slot recreated the shortage of checks that the
   per-folder check slots removed. Reuse a job's receipts when its worktree HEAD is unchanged since they were taken.
   Running several finished jobs' gates as one combined run is a separate follow-up:
   [batched queue checks](2026-11-02-plan-queue-batched-checks_spec_planned.md).

**Tests (fail today).** `plan-queue-coordinator.spec.ts`: a PASS with a red "new" receipt is not landed. A red receipt sends
the item to fixing without spawning a checker. `plan-queue.schemas.spec.ts`: missing `not_checked` and `["TODO"]` refused.
New `plan-queue-gate-receipts.spec.ts`: per-gate records, timeout flag, base classification.

**Done when:** a PASS with an unexplained red receipt is refused by code, and the job card can show "Passed. Not
checked: …" (Step 8 renders it).

## Step 3. L5: one failure no longer sets aside the whole queue

**What's wrong.** `startItem` parks on any preparation error (`plan-queue-item-flow.ts:120-127`; the same at `:158-161` on
resume), so one condition true for every job (worktree cap, missing second model, account fence) sets aside job after job.
The global cap (`worktree-manager.ts:110-121`, default 5 from `worktree.types.ts:181`) is invisible to the queue's per-run
count (`plan-queue-coordinator.ts:543`). Checker selection runs only at verification time (`selectAndSpawnVerifier`,
`:381-390`), after the worker has spent a round. A failed worker turn is parked at once (`:279`, `:305-307`). Nothing counts
restart resumes (`recoverItem`, `plan-queue-recovery.ts:60-96`).

**Change.**
1. `plan-queue-error-class.ts`: classify preparation and spawn errors as `transient-capacity` (worktree cap, resource
   governor, load gate, provider concurrency, provider at capacity) or `this-job`, by error type or code, with message
   matching only as a fallback that its spec pins. A transient error returns the item to `queued` with back-off
   (30 s, 2 min, 5 min) and the detail "Waiting for a free work folder (5 in use)".
2. The scheduler asks for free global capacity before starting a job: expose `availableWorktreeSlots()` on
   `PlanQueueWorktreeService` from the manager's `getAllSessions()` and `getConfig().maxConcurrent`. Remember `reattach()`
   creates no manager session (`plan-queue-worktree.ts:122+`), so count queue worktrees separately.
3. After two identical `this-job` errors in a row across different jobs, pause the run once: "Paused: every job fails with
   the same error: <plain reason>. Fix it, then press Resume."
4. `plan-queue-run-preflight.ts`: at run start and on any routing change, resolve the checker
   (`selectPlanQueueVerifier`, injectable through `VerifierSelectDeps`), worktree capacity and account fences once. On
   failure, refuse to start (or pause a running run) with the reason and a link to the setting.
5. Worker turn retry: on a transient failure (allow-list only: transport closed, provider 5xx, adapter not spawned,
   timed out waiting for the turn to accept), retry once after 15 s and once after 45 s in the same session with "Finish
   the item with a real result." Deterministic failures are parked as today.
6. Restart counter: a `restart_resumes` column (or derived from Step 1's events) incremented in `recoverItem`, reset when a
   round completes. Three in a row parks the item as `restart-loop` ("Restarted 3 times without progress") with Retry.
   Uses Step 1's progress fingerprint so "no progress" is defined once.

**Tests (fail today).** Coordinator spec: five items, cap reached → none parked, all wait. Two identical prep errors → run
paused once, third item untouched. Preflight with no diverse checker → run refused before any worker spawns. Recovery
spec: three restarts without a round → `restart-loop`.

**Done when:** a forced worktree-cap condition leaves every job queued, and a forced "no checker" refuses the run at start.

## Step 4. L7 part 2: memory between rounds

**Change.**
1. Uses Step 1's progress fingerprint.
2. Rounds 2 and later: `buildVerifierPrompt` gains an "Earlier rounds" block of at most 12,000 characters from Step 1's
   verdict rows: each earlier finding with the worker's claimed fix or dispute, marked "unconfirmed, re-check", plus
   `git diff <last checked commit>..HEAD --stat` and the instruction to read that diff. The whole-diff read stays.
3. If HEAD and document hash are both unchanged since the last FAIL, do not spawn a checker. Re-prompt the worker once:
   "Nothing changed since the last check failed. Fix each finding or explain with file:line evidence why it is wrong."
   Still unchanged: park as `no-progress`.
4. Same finding id failing twice: add a three-line step-back note to the fix prompt ("Reproduce it and find the cause; if
   the finding is wrong, say so with evidence"). Surviving a third round would park as `stuck-on-same-finding`. Ship this
   log-only for a week (an event row, no park), then switch it on.
5. A new run on a document that already has a set-aside branch offers "Resume the set-aside job" instead of a new item
   (coordinator `startRun`, item creation at `:343-352`).

**Tests (fail today).** Prompts spec: round-2 prompt contains earlier findings and stays under 12,000 characters for the
block. Flow spec: unchanged HEAD and hash → no checker spawned, worker re-prompted once.

## Step 5. T1 items 2, 4 and 6: the coordinator keeps plans small

**Change.**
1. **Diet at checkpoint (item 2).** `plan-queue-plan-diet.ts`: at each checkpoint, if the document grew by more than 8 KB
   since the job started or holds more than one status block, move every dated section under the as-built heading into
   `<stem>_history.md` beside the root checkout's copy (never on the job's branch; see Phase B Step 2), leave a one-line pointer, and log bytes moved. Move, never delete. Compare the root
   copy's hash just before writing and skip (and log) if it changed meanwhile, because James and other sessions edit the
   same file.
2. **Pinned criteria (item 4).** When the job starts, store the plan's SHA-256 and its unchecked `- [ ]` items. Give the
   checker "Document changes since this job started" (`git diff <start>..HEAD -- <plan>`), so a deleted or reworded
   unchecked item is visible.
3. **Close small (item 6).** At a `_completed` rename made by a queue job, move journal sections to
   `<stem>_history_completed.md` and keep an as-built summary of at most about 3 KB. This applies only to plans completed
   from now on; existing `_completed` files are closed and are never edited.
4. `_history` is added to `ACTIVE_DOCUMENT_RE` in Phase A Step 0; this step relies on it.

**Tests (fail today).** New diet spec: a plan with three dated as-built sections → sections moved, pointer left, bytes
equal across the two files; a concurrent hash change → no write.

## Step 6. L6: discovery finds only real plans and remembers what it decided

**What's wrong.** `SKIPPED_DIRS` is fixed names only (`plan-queue-discovery.ts:26-36`); discovery walks up to 5,000 `.md`
files and filters by glob afterwards (`:78-95`, `:145-152`); `readHeader` reads the whole file for 40 lines (`:97-104`).
The glob is never saved on the run (used once at `plan-queue-coordinator.ts:320`). Every run re-triages unchanged documents.

**Change.**
1. Skip directories whose names contain `snapshot`, `evidence`, `observation` or `receipts`, and any plan folder nested
   inside another plan folder. Honour a per-repository `.planqueueignore` (gitignore syntax).
2. `readHeader` reads only the first 16 KB.
3. Save the glob as an optional field of `PlanQueueRunConfigSchema` (stored in `config_json`; no migration). Show
   "N documents found (M look like copies, hidden)"; above 25 documents the start form asks for confirmation. Add "Skip all
   not started".
4. Remember triage decisions and answers by SHA-256 of the document plus its linked spec (a small table in Step 1's
   migration, or a column on the events table). Unchanged → reuse with "Already decided on 14 Oct". Items of a cancelled
   run are "not reached", not "skipped".
5. A run whose glob is one non-wildcard path skips model triage: run the deterministic readiness checks and queue it. The
   worker can still ask through the existing "needs James" path.

**Tests (fail today).** Discovery spec: an `evidence/2026-10-01/docs/plans/x_plan.md` copy is not found; `.planqueueignore`
honoured. Coordinator spec: a single-path run never calls triage.

## Step 7. K3.1 and K3.2: honest queue spend

**What's wrong.** `plan-queue-spend.ts:21` records `inputTokens + outputTokens` only (cache reads and writes missing, about
20 times low); `:24` turns an unpriced call into `0`; the role (`metadata.planQueueRole`, `:19`) is not stored.
`plan-queue-spend-label.ts` prints `$0.00` for that zero.

**Change.**
1. Store processed tokens (input + cache read + cache write) and output separately; keep `costUsd` null when unknown.
2. New `plan_queue_spend(item_id, run_id, role, round, provider, model, processed, output, cost_usd, cost_basis)` table,
   modelled on `loop_run_spend` (`loop-schema.ts:426-433`), in the next loop migration.
3. "Exact" only when `costSource` is `provider` or `free` (`model-call-recorder.ts:16-23`). Check first whether the Codex
   adapter reports its own estimate as `usage.cost`, which would make it look "provider"; if so, label it estimated.
4. Labels: "$379.93 known · 17.2M tokens not priced"; averages only over known costs; never `$0.00` for unknown.

**Tests (fail today).** `plan-queue-spend.spec.ts`: an unpriced call stays null and its tokens are counted; a new spec for
the label.

## Step 8. L9: a queue page James can read at a glance

**What's wrong.** Seven stacked sections, with "Reconciler alerts" always shown
(`plan-queue-page.component.html:6-99`); up to 50+ full run cards (`src/renderer/app/core/state/plan-queue.store.ts:134`); raw `item.detail` up to
about 3,000 characters with `/Users/` paths (`parked-list.component.html:16-18`); internal words ("Land anyway",
"Reconciler alerts", "livetests", "Glob", "(s)" plurals); labels that point the wrong way (`PARK_REASON_LABELS`,
`plan-queue-item-list.component.ts:25-36`); a missing document parked as `worker-error` (`plan-queue-readiness.ts:118`).

**Change.**
1. Three tabs: **Now** (questions, running and paused runs, Start a run), **Set aside** (grouped by document, newest attempt
   first, older ones folded as "2 earlier tries"; Phase B's "Ready to review and merge" group stays at the top of this
   tab), **Setup** (providers and accounts). Finished runs fold into "History (N)", one line each.
2. `plan-queue-park-reason-help.ts`: `PARK_REASON_HELP: Record<PlanQueueParkReason, {label, meaning, next, actions}>`,
   replacing `PARK_REASON_LABELS`; the `Record` type keeps it exhaustive. Show meaning and next step under the label and
   only the buttons that apply ("Choose a checker" for an account conflict; "See what the checker found" before Resume on
   a round limit). Correct labels: `verifier-unreliable` → "The checker stopped without giving a verdict";
   `no-diverse-verifier` → "No second model is allowed to check this" plus the reason; `round-limit` → "Ran out of rounds
   (3 of 3)" plus the last finding.
3. New reasons from this plan (`no-progress`, `restart-loop`, `stuck-on-same-finding`, `missing-document`; plus help text
   for `stopped-by-harness`, which Phase B Step 5 creates) are added to the enum (`plan-queue.schemas.ts:33-44`) with their help entries.
   `park_reason` is plain text, so no migration.
4. Fold `detail` behind "Details" and strip absolute paths. Relabel the 355 historical triage rows "Couldn't check
   readiness (old classification step)" by matching their stored detail in the presenter, not by rewriting data.
5. Words: Parked → "Set aside"; Land anyway → "Merge without checks"; Glob → "Which files (pattern)"; real plurals.
6. Bulk actions only through a preview: "Resume all N set aside for this reason" lists will change / left alone (with
   reason) / not applicable, then one confirm. No bulk "Merge without checks" or Discard.
7. Hide the alerts section when empty; link the housekeeping "Leftover work folders" card instead of a second list.
8. Show Step 2's "Passed. Not checked: …" and receipts on the item card.

**Tests.** Page, parked-list, item-list and store specs: tabs render; empty alerts hidden; a 3,000-character detail with a
`/Users/` path is folded and stripped; every park reason has help text (a spec iterating the enum).

**Live check (deferred):** the rebuilt page on the Windows PC, with a seeded queue store shaped like James's history
(runs, set-aside jobs, long details); never by scripting against his real data.

## Step 9. L10: scheduled jobs

**What's wrong.** No run time limit anywhere in `src/main/automations`. A restart marks every running run failed and
clears a one-time job's next run (`automation-runner.ts:128-136`, `automation-store.ts:686-724`), with no retry. A run
"succeeds" at the first idle after any output (`automation-runner.ts:413-415`). `update_automation` accepts effort up to
`ultra`/`workflow` and auto-approve from any session (`orchestrator-automation-tools.ts:203-208`,
`automation-tool-impl.ts:327-346`), and its handler does not even receive the caller (`:494-502`).

**Change.** Each part is independent; build in this order.
1. **Time limit (Decision 17).** Per-job `maxRunMinutes` in `AutomationAction` (rides in `action_json`; Zod in
   `automation.schemas.ts`). New jobs default to 90 minutes; existing jobs get 1.5 times their longest successful run
   (minimum 30), set by a one-off RLM data migration. On expiry, cancel the session and its children, keep the output so
   far, and finish the run as failed with `{retryable: false}` and "Stopped after N minutes". Timer logic in
   `automation-run-limits.ts`, armed in `trackInstance` (`automation-runner.ts:326`).
2. **Token cap (Decision 17).** Stop a run past N processed tokens (30M recurring, 100M one-time by default), recorded as
   "Stopped: token cap", using the same tracker.
3. **Restart.** Replace the bare `failRunningRuns` call with `automation-restart-retry.ts`: mark the run "Interrupted by an
   app restart" (reuse `output_summary` or a new column; the status `CHECK` constraint lists only six values, so a new
   status needs a table rebuild: avoid it). For enabled, unchanged jobs whose action is an agent prompt: one fresh retry
   with "The previous run was cut off by a restart; check what it already did before continuing." Restore a one-time job's
   next run for that retry. Do not count it towards the failure streak (`automation-store-outcome-ops.ts:34-57`). Never
   replay system actions or anything that already delivered.
4. **Quiet result.** After Phase B lands A15, register an `automation_result` tool (`{outcome: no_change | done |
   needs_attention, notify}`) from the first turn of every automation session. A run ending with neither a result nor any
   text is a failure. Never decide failure from prose. The Automations page greys out quiet runs.
5. **No escalation by agents.** Thread `callerInstanceId` into `update_automation` as `create_automation` already does
   (`:367-369`). An agent caller may not raise model tier, effort or auto-approve above its own session's; return a
   teaching refusal. Clamp agent-set effort at `max`. The human form is unrestricted.
6. **Cheaper models where they fit.** New "check"-style jobs default to Sonnet at low effort; suggest it on monitors whose
   last 10 runs were quiet (a dismissible hint, not an automatic change).
7. **Slow down while nothing changes** (opt-in per job): double the interval while normalised output is unchanged (times,
   dates, durations and ids stripped), cap at 4 times nominal, snap back on change. Show "Next check in 40 min (no change
   for 3 checks)".

**Tests (fail today).** `automation-runner.spec.ts`: a run past its limit is stopped and not retried; a restart leaves an
"interrupted" run with one retry scheduled and a restored one-time next run. `automation-tool-impl.spec.ts`: an agent
raising effort above its own is refused.

**Done when:** no run can pass its limit, a restart leaves "interrupted, will run again" rows, and quiet runs are greyed.

## Step 10. T9: second opinions

**What's wrong.** Stale reviews are discarded only after both reviewers finish (`cross-model-review-service.ts:347-368`);
`cancelPendingReviews` (`:880-900`) also clears history and buffers, so it is not a drop-in. A reply that fails schema
validation twice returns null (`:628-631`) without `recordFailure`, so `reviewer-pool.ts` never retires a reviewer that
keeps failing that way.

**Change.**
1. `review-staleness-abort.ts`: when a newer user turn arrives for an instance (subscribe to the busy transition in
   `instance-event-forwarding.ts:440-479`, because `bufferMessage` ignores user messages), abort only that instance's
   pending review controllers.
2. Count schema-validation failures per reviewer per local day; after two, skip that reviewer for the rest of the day.
3. The daily count already shows in review settings ("Used today: N of 20", `review-settings-tab.component.ts:61-63`).
   Add it to the indicator tooltip as "Second opinions today: N of 20".
4. After K2's restart, measure Copilot premium requests per review (one read-only query; result into the history file).

**Tests (fail today).** Service spec: a newer user turn aborts the pending review before reviewers finish. Pool or service
spec: two validation failures retire the reviewer for the day.

## Step 11. T8: Copilot premium requests (Decision 5)

**Change.**
1. Wherever Opus can be picked for Copilot (chat model picker, account defaults), the option reads "Opus 5.5 · 15 premium
   requests each", and a Copilot chat shows "Premium requests used: N". Harness-started Copilot work keeps the 1-unit
   models it already uses; add a spec that pins that default.
2. `copilot-events-tail.ts`: a read-only tail of the session's `events.jsonl` for exactly `session.usage_record` /
   `session.usage_checkpoint`, `session.compaction_complete` and `session.shutdown`, keeping numbers only. Recycle a loop
   or queue session when a compaction leaves it above 90% of its limit.
3. CLI status page and loop preflight: "Copilot below 1.0.100 may stall for minutes on a hung tool server."

**Tests.** Picker spec for the label; tail spec on a fixture file (numbers only, no message text retained).

## Step 12. L12: the live-check backlog and its 1 MB register

**What's wrong.** `docs/plans/livetest-remediation-register.md` is 1,058,876 bytes and 13,260 lines; the index runs from
line 116 to about 323 and detail sections are not in numeric order. AGENTS.md (line 101) points at
`2026-07-19-livetest-failure-remediation-followup_plan.md`, a name that no longer exists (the file is `_completed`, closed).

**Change.**
0. Preserve any other session's work. The 20 October ownership warning was historical: this repair starts from the
   coordinator-checkpointed queue branch with a clean worktree and restructures only its tracked register. The root
   register and its owner's uncommitted changes stay untouched; AIO owns later integration.
1. Move closed entries' detail sections to `livetest-remediation-register-archive-2026.md`, keeping every index row. Add
   one line at the top of the archive and in AGENTS.md: agents do not read the archive unless an index row points there.
   Before moving, confirm the register is a standing register (exempt marker) rather than a lifecycle document.
2. `scripts/next-lt-id.mjs`: prints the next id from the maximum numeric id in the index (LT-707 today), never from the
   last heading. Point the runbook and the queue's livetest prompt (`plan-queue-prompts.ts:101`) at it.
3. AGENTS.md (line 101) points at a plan that no longer exists, and the plan the register header names
   (`2026-10-05-livetest-campaign-defects`) is closed too; no live remediation plan exists. Reword AGENTS.md: "The
   register's index row is the defect's status; implementation notes go in the plan or livetest document that fixes it."
   Make the same change to the register header and the runbook. Never edit the closed plans.
4. After Phase B lands the October work, queue a weekly live-check campaign on the Windows PC, starting with the October
   plans' livetests.

**Tests.** A small spec for `next-lt-id.mjs` on a fixture with out-of-order sections.

## Step 13. K3.6 (rest)

Phase A Step 6 writes a minimal usage line per ephemeral Codex thread so T2 can be measured. Here, extend it to the full
field list (thread, job, kind, trial arm, requests, tokens, helpers, compactions, duration) and read it from the Costs page.

---

## As-built round-8 review repairs, 3 November 2026

- [x] The direct retry-attribution fixture returns the exact saved running retry from `getRun`; production admission remains mandatory and every attribution assertion remains.
- [x] Checkpoint diet pins regular-file and every lexical directory identity, refuses symlinks/shared hard links, opens without truncation with no-follow flags, compares descriptor identities and exact bytes again, and writes through those descriptors without an intervening await. Exclusive creation protects a missing history. Real-Git checkpoint and production-wrapper regressions preserve the plan, history and unrelated target on refusals, including same-byte replacement, changed ancestors and swaps during handle opening. Existing concurrency, UTF-8 and closure coverage remains.
- [x] Both emitted verifier instructions now accept successful unfamiliar summaries. The prompt/classifier regression and existing gate cases retain failure, timeout and empty-suite refusal.
- [x] The live MCP schema now describes each run's limit, the shared folder's largest effective limit, workload minimums, machine limits and load checks.
- [x] The tracked live-check document in the supplied worktree now tests `automation_result` in a fresh owned `newInstance` session and the owned loop root, separately from existing-thread prompt delivery. The root checkout's independently modified tracked live document was left untouched.
- [x] Regenerated the architecture inventory through the existing generator against the coordinator's current Git index. The final worker edits/new test are all below its 800-line inventory threshold and do not change provider/preload/package/channel inventories; the normal architecture check passes. No real index was staged or replaced.

Verification: the affected selection passed (11 files, 178 tests), followed by the strengthened final identity cases. Both typechecks, lint, size/UI hints, both builds and architecture/IPC/exports/contracts checks pass. Original red reproductions, final green receipts, source locations, review limits and cleanup evidence are in the [round-9 report](2026-10-20-oct2-phaseC-queue-that-finishes_evidence/round9/report.md). No linked Phase C spec exists at the conventional plan/spec sibling paths. No full suite, installed app, provider/browser session or fresh independent acceptance was run by this worker. Existing live checks remain pending; no new agent-runnable check was deferred. The coordinator owns the next checkpoint, full gate and document closure.

## As-built verifier repairs, 3 November 2026

- [x] **1. Estimated spend:** existing exact subtotals distinguish estimates for items, run totals and averages, including mixed/unpriced usage. No schema change.
- [x] **2. Cancelled versus skipped:** removed the unused gate-comparison helper and test the executing gate runner. A shared, production-used outcome helper labels untouched cancellations “Not reached” in item cards, counts and parent summaries while preserving persisted enums.
- [x] **3. Dropped restart retry:** clear the stale retry before scheduling the surviving job. One-time cleanup is atomic and only removes the interrupted retry's exact timestamp; edited dates survive. Real store/scheduler and fresh-scheduler regressions cover immediate/queued retries, recurring, one-time, disabled and deleted jobs.
- [x] **4. Unsafe verifier restore:** Pause, cancellation, closed spawn and finished checker retain invalid folders without checkpoint/removal and visibly park after writers stop. Typed ownership refusals preserve existing messages. Generic transient Pause errors retain the exact checker snapshot for retry. Failed stops retain live ownership, snapshots and evidence; startup/reminder callback failures are logged. Folder inspection is required before resuming parked restore failures.
- [x] **5. Changed document:** verdict history uses the checker's actual input identity. Abandoned hashes clear before new gates; a PASS with no known checker identity is refused. In-flight receipts are independent of the underlying gate cache and survive long queues and cancellation until stopped/recorded under the item lock.
- [x] **6. Wildcards:** traversal and hidden-copy preview begin at the literal directory prefix, checking every ancestor for ignores, exclusions and symlinks. Finite budgets and errors remain explicit; unrelated folders no longer exhaust the selection budget.
- [x] **7. Gate summaries:** successful unknown summaries do not block; Jest, Go and Mocha are recognised. Empty suites, failures and timeouts still block, including all-empty Go package output. The existing shared diagnostic extractor's arbitrary unmarked-prose limitation is recorded in the report, not claimed solved.
- [x] **8. Reason labels:** current source-inspection failures no longer receive a historical label; both card views use the same presenter. Restore-specific help requires folder inspection.
- [x] **9. Set-aside tab:** ready heading appears once and the empty message is reachable, covered through rendered templates.
- [x] **10. Remote-stop behavior:** confirmed the existing rejection is necessary to preserve ownership and observation until stop succeeds. Adapter plus termination/communication integration tests cover failed stop and retry; no new remote-adapter change.

Verification: the broad affected selection passed (33 files, 579 tests); later focused runs cover subsequent receipt, retry, Go-summary and stop-order changes. Final callback/restore selection: 4 files, 51 tests. Both typechecks, lint, size, UI hints, both builds and generated-output checks pass. Actual commands, failed reproductions, superseding green receipts and independent source-review limits are retained in the [round-7 report](2026-10-20-oct2-phaseC-queue-that-finishes_evidence/round7/report.md). Full-suite/whole-plan acceptance remains unchecked above. No new agent-runnable check was deferred; no linked phase-C spec was found. Generated runtime cleanup is recorded after sealing the evidence; dependencies remain in the supplied worktree.

## As-built repair handoff, 2 November 2026

- Resumed history/landing repair: closure reads the candidate history from its committed regular Git file and combines it with the root/legacy snapshots in uniquely named completed evidence. Its receipt includes candidate identity. The temporary squash restores only this byte-proven history to the base version before the existing active-document check and real hook. Root history stays untouched, including concurrent edits and records shared by another open document. Nine real-Git regressions cover the production coordinator path, actual installed guard, staged root work, interrupted/retried closure/promotion, new/deleted histories, stale candidates, incomplete evidence, unrelated active documents and symlink refusal. Final affected verification: 140 tests across ten files, with no pending tests. [Round-6 report and receipts](2026-10-20-oct2-phaseC-queue-that-finishes_evidence/round6/report.md). Independent acceptance remains open.

- The adapter remains below its file-size ceiling; model accounting uses the central pinned identifiers. The provisioned dependency tree passes its compatibility tests without weakening their assertions or changing the lockfile.
- Loop monitors compare every assistant message while retaining the final message as the display summary. Real dispatcher/store coverage proves an earlier changed warning resets slowdown with an identical final signoff; the one-shot regression remains.
- Slowdown selects actual cron occurrences, including unaligned completion, timezone/DST, irregular weekdays and monthly schedules. Existing completion-relative expectations now pin nominal timestamps.
- Checkpoint proves ownership before recovery or document diet and rechecks ownership plus branch before staging. Reattach/removal, verifier restore, base sync and landing restore/recovery use the owning run's repository rather than inferring it from the folder. Real Git fixtures preserve owner/foreign HEAD, index, files and root documents on refusal; legitimate detached recovery remains covered.
- Interrupted checks with unsafe folders become visibly set aside. Checker and retained worker stops are awaited before restoration/parking; failed stops preserve session ownership. Red/green recovery tests and real coordinator runs cover this follow-up.

Evidence, exact command outcomes and review limits: [round-5 report](2026-10-20-oct2-phaseC-queue-that-finishes_evidence/round5/report.md). The full suite and whole-plan audit/acceptance remain assigned to the coordinator/verifier; installed checks remain in the existing live-check document. No new agent-runnable check was deferred.

## Final verification

Run, in order, and paste the summary lines into the history file (not here):

```bash
npx tsc --noEmit
npm run typecheck:spec
npm run lint
npm run check:ts-max-loc
npm run check:ui-hints
npm run build:main
npm run build:renderer
npm run test:quiet
```

Then the fresh-eyes completion gate: a new agent that did not implement the work runs the `task-completion-gate` skill
over the diff and this plan. Fix every actionable finding and repeat with another fresh agent until `VERDICT: PASS`.

## Live checks

Anything needing the rebuilt app goes into `2026-10-20-oct2-phaseC-queue-that-finishes_livetest.md` (create it with the
standard remediation header) before this plan is renamed. Expected entries: the queue page on the Windows PC (Step 8); a
real run with a forced worktree cap (Step 3); a scheduled job stopped by its time limit, and one restart with an
interrupted run (Step 9); one week of the same-finding rule in log-only mode before it is switched on (Step 4).

## Finishing

When every step is built and verified: rewrite the Status block as an as-built summary of at most about 3 KB, move any
deferred checks to the livetest document, rename the history file `_history_completed.md`, then rename this file
`_completed` last. Commit only when James asks.

> Plan Queue parked work: `queue/2026-10-20-oct2-phasec-queue-t-cf5944` — 1 commit(s), reason: worker-error.

> Plan Queue parked work: `queue/2026-10-20-oct2-phasec-queue-t-f2749a` — 6 commit(s), reason: verifier-unreliable.
