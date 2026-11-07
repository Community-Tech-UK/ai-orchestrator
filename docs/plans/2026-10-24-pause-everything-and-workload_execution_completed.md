# Pause and workload execution log

Status: implementation and automated verification complete on 2026-10-24. Independent completion review 16: PASS.
Current checkout only; no agent-created branches/worktrees, commits, pushes or running-app restart.
Installed-provider/relaunch/remote/heavy-load checks remain explicitly deferred in the linked live-test document.

## Final verified result

- All seven canonical non-test gates exited 0: main/spec typechecks, lint, TypeScript size, UI hints, main build and renderer AOT build.
- Full suite ran in all four supported shards, each exit 0 with JSON success=true and zero failed tests/suites.
  Union: 2,787 distinct files, 35,250 passed tests and 8 existing skipped/platform cases, with no duplicate files across shards.
- Fresh independent review returned PASS with no unresolved actionable finding; 32 independently selected files / 246 tests passed.
- Raw command exits: `_scratch/pause-v16-verification.json`; normal/shard logs: `_scratch/pause-v16-*.log`;
  raw reports: `_scratch/test-results.pause-v16-shard-N.json`; summary: `_scratch/pause-final-verification-summary.json`.
- Independent report: `_scratch/pause-completion-review-16.md`; CLI built-artifact help check exited 0, exposing only status/hold/release.
- Shared-checkout verification with existing dependencies; no immutable clean-install claim. Build advisories remain nonfatal.
- [Completed plan](2026-10-24-pause-everything-and-workload_plan_completed.md),
  [completed spec](2026-10-24-pause-everything-and-workload_spec_completed.md),
  [pending installed live checks](2026-10-24-pause-everything-and-workload_livetest.md).

All prior pending, failed or canceled candidate runs below are historical and superseded by this final result.

## Required work

- [x] Phase 0: reproductions and regression tests.
- [x] Phase 1: admission, hold/release, gates, sentinel and IPC.
- [x] Phase 2: workload policy, settings, counters and background helpers.
- [x] Phase 3: persisted pause batch, engine checkpoints, interruption and continuation notes.
- [x] Phase 4: exact recorded resume, revival, interrupted-resume handling and queue preservation.
- [x] Phase 5: void triggers, reminders, expiry and purge.
- [x] Phase 6: title-bar controls, settings slider, held-session notice, CLI and docs.
- [x] Phase 7: normal gates, dev checks, live-test deferral and independent completion review.

## Decisions

- Use the recommended answers in spec section 8, consistent with the implementation instruction and plan.
- Preserve already tracked active plan/spec; do not change Git index merely to make them untracked. No commit.
- Add a repo-job engine entry to the saved batch. Investigation found repo-job sessions are excluded from normal notes,
  but the draft batch union omitted their engine; leaving that omission would lose running job continuity on restart.
- Keep durable queued messages independent of the VPN-pause setting. Main and renderer previously gated queue persistence
  on that unrelated feature, which is disabled for James.
- Count in-flight helper starts as reservations, preventing simultaneous spawns from exceeding the slider's helper cap.

## Earlier execution evidence (historical)

Full command logs remain under `_scratch/`. Final passing evidence is listed above; earlier attempts below are retained for audit history.
Renderer store/IPC initial tests: `_scratch/test-run.pid-37374.log` (passed).
Work panel + orchestration settings DOM tests: `_scratch/test-run.pid-5786.log` (passed).
Helper reservation red: `_scratch/test-run.pid-84512.log`; green: `_scratch/test-run.pid-4310.log`.
CLI red: `_scratch/test-run.pid-64542.log`; subsequent CLI/dispatcher test run passed those files, with renderer
protocol expectations requiring update for the new automatic-input flag and direct-send timing fixed in production.

## Historical independent review and corrections (superseded)

- Review 1 failed: borrowed chat classification, initialization delivery, native/basic-note resume and running counts.
  Corrected with behavior tests before review 2.
- Review 2 failed: manual pickup racing helper shutdown and local load gating remote automations.
  Corrected, including equivalent pickup races during revival, resume delivery and note cleanup.
- Review 3 failed: successful agent notes dropped captured helper excerpts. Corrected with deterministic helper context
  in storage, the note turn and live/native resume; idle parents with active helpers also receive a note.
  Regression red `_scratch/test-run.pid-12538.log`; core green `_scratch/test-run.pid-50672.log`; mixed main/renderer
  integration green `_scratch/test-run.pid-99294.log`.
- Review 4 failed: explicit repeat Pause retained a manually picked-up session's void entry, leaving its new turn
  unheld while reporting ready. Corrected with transactional current-snapshot refresh, same-provider alias matching
  and deduplication, retaining untouched ready-idle and absent saved notes. Snapshot storage precedes the first state
  notification so manual pickup during the new operation is respected. Running engines are rearmed without changing
  unrelated paused engines. Red `_scratch/test-run.pid-90758.log` and `_scratch/test-run.pid-11516.log`; final mixed
  integration green `_scratch/test-run.pid-24616.log`.
- Review 5 found one low wording issue: an initial-prompt bookkeeping marker appeared in note details. Display now
  explains that the first message is saved until Resume; the durable marker and resume behavior are unchanged.
  DOM red `_scratch/pause-marker-red.log`; focused renderer/integration green `_scratch/pause-marker-green.log`.
- Review 6 found a reviewer creation gap: consult tracking began after asynchronous instance creation, allowing pause
  shutdown to miss an in-flight reviewer spawn. Corrected by tracking before creation, omitting the create-time prompt,
  checking cancellation and sending through the abortable automatic-input path. Pause waits through teardown.
  The related workflow admission-wait gap now rechecks synchronously, and headless reviews are tracked over their
  complete host command. Each reproduced red; final mixed checks green `_scratch/test-run.pid-21226.log`.
  The full v6 run exited 137 without a verdict or JSON; cause is unverified. It is not counted as a pass. Complete
  non-full canonical v6 gates passed. The next full verification will use all supported suite shards sequentially,
  fewer workers and durable exit records to bound resource use and distinguish external termination from assertions.
  Final verification records: `_scratch/pause-v7-verification.json`, individual `_scratch/pause-v7-*.log`, raw suite
  logs/reports `_scratch/test-{run,results}.pause-v7-shard-{1,2,3,4}.{log,json}`.
- Review 7 reproduced incomplete consult teardown: default invokers untracked after a rejected termination, while the
  real review execution host and cross-model cancellation returned before termination settled. Both deterministic
  regressions failed (`_scratch/pause-review7-cleanup.log`). Remediation must retain/await actual teardown and support
  retry after failure. Corrected with a shared per-adapter teardown lifecycle across default invokers, real review host,
  cross-model reviews and reviewer sessions. Reservations are released only after termination succeeds; a failed
  attempt remains tracked and the next Pause retries. Concurrent cleanup calls share one attempt. Immediate
  cancellation/accounting behavior remains separate from the shutdown barrier. Focused green evidence:
  `_scratch/test-run.pid-79352.log`. The v7 canonical non-test gates all passed; its first full shard was deliberately stopped for
  this finding, and no full-suite pass is claimed. Durable cancellation is recorded in the v7 verification JSON.
  Final v8 normal gates and all four supported suite shards are recorded in `_scratch/pause-v8-verification.json`;
  All v8 non-test gates passed; its first shard was stopped after the next independently reproduced finding.
- Review 8 reproduced an admitted helper startup that was still awaiting agent resolution and absent from the instance
  snapshot. Pause reached ready, then the helper appeared and ran. The startup reservation must cover creation and
  shutdown, including remote helper starts, without blocking James's manual new chats. Reproduction:
  `_scratch/pause-review8-helper.spec.ts`, `_scratch/pause-review8-helper.log`. Corrected with shared automatic-startup
  reservation, inherited cancellation at actual initial-prompt delivery, and local/remote helper creation wrappers.
  Pending creation remains behind the shutdown barrier, failed teardown remains retryable, and manual chats inherit
  no startup cancellation. Focused helper/remote evidence `_scratch/test-run.pid-88718.log` and startup/manual-chat
  evidence `_scratch/test-run.pid-41080.log`; main typecheck and focused lint passed.
- Follow-up research reproduced the equivalent first/retry automation creation gap using actual runner/store/runtime
  (`_scratch/pause-review8-automation.log`). Common startup cancellation and recorded-run redispatch are being implemented,
  with thread/loop automation paths covered too. Those paths now preserve recorded running rows on startup cancellation,
  redispatch their original saved request on Resume, retain late loop links and deduplicate delayed callbacks. Final
  focused green `_scratch/test-run.pid-8250.log`; as-built research `_scratch/research8followup.md`.
  Plan Queue start/hold is serialized by item locks.
- Root reproduced a late repository-job cleanup failure (`_scratch/pause-repo-late-red.log`): best-effort termination
  swallowed failure and its instance identity was lost. The late identity is now persisted before cleanup, and Pause
  authoritatively verifies any late instance after its task settles. Failed shutdown leaves the job held for retry;
  green `_scratch/pause-repo-late-green.log`; delayed termination and retry green `_scratch/pause-repo-late-final.log`.
  Focused repo lint and size gates passed. Final normal gates, all four full-suite shards and independent review 9 are
  active. Durable final command results: `_scratch/pause-v9-verification.json`; normal and shard summaries:
  `_scratch/pause-v9-*.log`; raw test logs/reports: `_scratch/test-run.pause-v9-shard-N.log` and
  `_scratch/test-results.pause-v9-shard-N.json` for N=1..4.
- Review 9 reproduced two attached-initialization gaps. A scheduled session whose first prompt was canceled retained
  its instance id, so Resume sent a continuation instead of its original request (`_scratch/pause-review9-attached-automation.log`).
  The automation ready-promise cancellation path now clears only that matching held run's attachment; the snapshot
  remains for redispatch. Existing already-delivered sessions retain native continuation. Both actual-boundary Resume
  cases pass in `_scratch/test-run.pid-60785.log`.
- Actual lifecycle cancellation rollback also reproduced lost physical ownership: startup reservation ended before
  background initialization, and rollback removed the adapter before swallowing termination failure. The fake provider
  remained running while shutdown reported safe (`_scratch/pause-review9-rollback.log`). Common startup now retains its
  reservation through background initialization, captures the actual adapter teardown and checks cleanup before and
  after initialization settles. Automatic rollback retains ownership until termination succeeds; failed attempts are
  retryable. Tests include late spawn after an earlier successful stop and local/remote failed rollback/retry
  (`_scratch/test-run.pid-25201.log`). Lifecycle rollback extraction keeps the source-size ratchet intact.
  The v9 seven non-test gates passed; its full shard was deliberately stopped and recorded as canceled.
- Final coherent-source v10 verification is active: `_scratch/pause-v10-verification.json`, normal/shard summaries
  `_scratch/pause-v10-*.log`, raw shard logs/reports `_scratch/test-run.pause-v10-shard-N.log` and
  `_scratch/test-results.pause-v10-shard-N.json` for N=1..4.
- Review 10 reproduced actual lifecycle early cancellation resolving readiness with no first send, leaving the removed
  automation instance attached. Rejection-only detachment was insufficient (`_scratch/pause-review10-early.log`).
  Corrected using an inherited startup receipt at actual adapter-call entry, after provider-limit holds and before both
  normal/attachment-fallback sends. This records submission attempt, not backend acknowledgement. Runner handles both
  readiness resolution and rejection: cancellation before submission clears only the matching run attachment and
  preserves the original prompt/attachments for Resume. Attempted submissions retain native continuation with the
  original saved task as context. Real lifecycle+runner+SQLite early-abort and provider-hold receipt tests pass; final
  common group `_scratch/test-run.pid-60535.log`, automation `_scratch/test-run.pid-53869.log`.
  Common physical lifecycle tests passed after extraction (`_scratch/test-run.pid-52276.log`); canonical v10 non-test
  gates all passed and its first shard was deliberately stopped for this confirmed finding. Two automation fixture
  timeouts in `_scratch/test-run.pid-16756.log` also need faithful ready-on-terminate behavior after the barrier change.
  Those fixtures now settle/abort initialization on termination, retaining their exact-once assertions.
- Final v11 normal gates and all four suite shards: `_scratch/pause-v11-verification.json` and
  `_scratch/pause-v11-*.log`, with raw `_scratch/test-run.pause-v11-shard-N.log` / test-results JSON for N=1..4.
  All seven non-test gates passed. Review 11 reproduced attempted thread-wakeup cancellation clearing its session link
  and replaying the original wakeup on Resume (`_scratch/pause-review11-thread.log`). Correction must retain actual
  provider-dispatch ownership, continue with saved goal context and avoid duplicate session/automation continuations
  or interference after manual pickup. The first full shard was stopped and cancellation recorded. No full-suite pass.
- Thread correction uses the existing actual `beforeProviderDispatch` callback, preserving attempted delivery while
  pre-provider cancellation remains replayable. The target session continuation owns Resume when it is in the same
  batch; no duplicate automation turn is sent. Focused green `_scratch/test-run.pid-79178.log`.
- Review 12 confirmed closed/deleted target sessions could leave their waiting thread automation running forever
  (`_scratch/test-run.pid-37172.log`). Such runs now need cancellation without retry. Decision for manual pickup:
  it is an ownership handoff, not evidence the original scheduled action succeeded; cancel the waiting automation
  without sending or stopping a manual turn, even if that manual turn has already finished. This avoids attributing
  unrelated user work to the scheduled run. Remediation and stable-source verification are active; v12 was stopped.
- Thread ownership handoff now cancels its recorded automation on close/delete or manual pickup, including takeover
  while session Resume is in flight. It never sends or terminates a manual replacement turn and never attributes
  arbitrary manual output as automation success. Same-batch session Resume remains the sole continuation owner.
  Focused seven-case group passed (`_scratch/test-run.pid-62128.log`); final takeover-during-Resume test is running.
- Final v13 stable-source normal gates and all four shards: `_scratch/pause-v13-verification.json`,
  `_scratch/pause-v13-*.log`, raw `_scratch/test-run.pause-v13-shard-N.log` and corresponding test-results JSON.
  Review 13 reproduced manual pickup before the automation engine interruption: startup cleanup respected the lifted
  hold, but the later runtime branch still interrupted the replacement manual turn
  (`_scratch/pause-review13-manual-before-engine.log`). Immediate ownership recheck is required at that interruption
  boundary. V13 was stopped before its first shard; no full-suite pass is claimed.
- The ownership repair now uses a central void-target callback: while collecting it cancels matching running pause
  candidates even before engine rows exist; ready/resuming matches only recorded runs. Engine entries retain their run
  ids and store original/history/provider session aliases. Actual SessionRevivalService→HistoryRestoreCoordinator→new
  instance tests cover pickup while revival is pending and while continuation is queued, without active automation
  metadata or interference with unrelated runs. Manual handoff releases active automation ownership while retaining
  historical provenance, so a later explicit Pause records the now-manual chat normally.
- Root independently reproduced an ordinary-chat settle timeout terminating a replacement manual turn
  (`_scratch/pause-ordinary-settle-red.log`). Interrupt/initial-start waits now abort on lifted ownership and never
  force-stop a replacement; listeners are removed. Root also reproduced obsolete failure text after a successful retry
  (`_scratch/pause-summary-red.log`) and clears it when a new collection starts. Green service/runtime group:
  `_scratch/pause-summary-ordinary-final2.log`; targeted lint, source-size and whitespace checks passed.
- Final combined testing exposed a non-hermetic remote-admission fixture: at workload 2 its intended busy-computer
  precondition was false because actual host CPU/load readings escaped the OS mock. The fixture now constructs the
  real WorkAdmission through its existing CPU/load dependency inputs, preserving selection assertions and adding the
  explicit computer-busy precondition. No production policy or runner selection was weakened. Combined rerun pending.
- Stable final handover after all ownership/fixture changes: 16 focused files / 181 tests passed
  (`_scratch/test-run.pid-1365.log`), current-tree spec typecheck passed (`_scratch/pause-ownership-final-spec-types.log`),
  targeted lint, size and whitespace gates passed. All source/test writers stopped before the next canonical run.
- V14 canonical evidence is active at `_scratch/pause-v14-verification.json`, normal/shard summaries
  `_scratch/pause-v14-*.log`, raw `_scratch/test-run.pause-v14-shard-N.log` and corresponding test-results JSON.
  Genuinely fresh review 14 and all final command results remain pending. No full-suite pass is claimed yet.
- Review 14 reproduced cross-session automatic provenance being dropped between InstanceManager and
  InstanceCommunication: Pause beginning during preflight caused a cross-session delivery to be treated as manual
  pickup, void its note and send (`_scratch/pause-review14-cross-session.log`). The complete seven v14 non-test gates
  passed; the first shard was stopped for this confirmed High. Provenance forwarding and actual-layer regression
  remediation are active. No full-suite pass is claimed.
- Cross-session repair is stable: one automatic-input classifier and complete manager→communication provenance;
  final synchronous provider fence plus a narrow held-only wait/retry; attachment/overflow recovery checks; and timed
  wakeup admission at native dispatch so Hold without note entries also works. No CLI code was edited. Actual manager,
  communication and remote-native checkpoint regressions passed in `_scratch/test-run.pid-63828.log` (304 tests).
  Main/spec typechecks, focused lint, size and whitespace passed; final spec log
  `_scratch/admission-cross-session-spec-tsc.log`. All writers stopped before the next gate.
- V15 stable-source canonical gates and all four shards: `_scratch/pause-v15-verification.json`,
  `_scratch/pause-v15-*.log`, raw `_scratch/test-run.pause-v15-shard-N.log` and corresponding test-results JSON.
  Independent fresh review 15 and all final results are pending; no full-suite success is claimed yet.
- Review 15 confirmed a manual create-time native first-send window: lifecycle marked the instance idle while the
  actual adapter still awaited provider preparation; Pause recorded idle work and reached ready, then the first
  request started (`_scratch/pause-review15-initial-native.log`). Pending first delivery must remain visible to pause
  collection and have a final direct-adapter fence, with original prompt/attachments saved durably exactly once.
  All v15 non-test gates passed; its first full shard was deliberately stopped for this confirmed High.
- First-input repair is stable. `waitingForInitialization` is separate from unfinished-task status; service awaits the
  startup barrier for empty chats without writing a note or continuation. Explicit create-config intent distinguishes
  a real pending prompt/attachment from historical transcript content. The direct native initial-send boundary is
  signal/fence guarded, and held originals are durably queued and marked before readiness resolves. Queue failures
  retain retry ownership; partial queue/marker success does not duplicate the original. Actual public create, remote
  adapter, pause service/SQLite and queue tests passed, including empty/History-only reopen and manual second chat
  (`_scratch/test-run.pid-54530.log`). Main/spec types, targeted lint, size and whitespace passed. All writers stopped.
- Final v16 canonical evidence: `_scratch/pause-v16-verification.json`, `_scratch/pause-v16-*.log`, raw
  `_scratch/test-run.pause-v16-shard-N.log` and corresponding test-results JSON. Independent fresh review 16 and complete
  normal/full-suite results remain pending. No full-suite pass is claimed yet.
- Review reports: `_scratch/pause-completion-review-1.md` through `_scratch/pause-completion-review-16.md`.
- Agent-runnable renderer check uses actual Angular controls/store with persisted SQLite pause state and WorkAdmission:
  `src/tests/renderer-integration/global-pause-work-controls.spec.ts`.
- Canonical type checks, lint, size/UI checks and both production builds passed before review 3's correction.
  Raw final-pre-correction logs: `_scratch/pause-{types,spec-types,lint,size,ui,main,renderer}-verified.log`.
- Full-suite attempts were deliberately stopped after findings or environment correction; none is claimed as passing.
  Node 26 was unsuitable for the pinned SEA packaging tests; subsequent runs use the repository's Node 24.22.1.
  The last canceled run (`_scratch/test-run.pid-28912.log`, exit 143) began before service corrections and reported two
  old service failures. Fresh focused runs, including independent review 3, pass those deterministic assertions.
  Stale transformed sources during overlapping edits are a hypothesis, not an instrumented cache diagnosis.
  A new full run against stable corrected sources is required; no timeout or assertion was weakened.
- Installed-provider interruption, process exit/relaunch, remote continuity and sustained-load observations remain in
  the linked livetest document. No running app has been restarted.
- After helper fixes the full non-test canonical chain passed (`_scratch/pause-final-{spec-types,lint,size,ui,main,renderer}.log`).
  The next full suite (`_scratch/test-run.pause-final.log`) was deliberately canceled, exit 143, after review 4 found
  the repeat-pause defect. A stable-source full suite and another fresh completion review are still required.
- After repeat-pause fixes the complete non-full canonical chain passed (`_scratch/pause-v5-*.log`). Its full suite
  was canceled, exit 143, for the wording fix. Final coherent-source runs use `_scratch/pause-v6-*.log` and
  `_scratch/pause-full-final-v6.log`, with raw suite evidence `_scratch/test-run.pause-final-v6.log` and
  `_scratch/test-results.pause-final-v6.json`.
