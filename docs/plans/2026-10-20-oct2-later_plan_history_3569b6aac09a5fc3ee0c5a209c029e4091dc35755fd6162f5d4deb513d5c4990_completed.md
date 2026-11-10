## Snapshot of 2026-10-20-oct2-later_history.md

# Oct-2 later: implementation and verification evidence

Plan: [2026-10-20-oct2-later_plan.md](2026-10-20-oct2-later_plan.md).

Current status (2 November 2026): verification-round-1 findings repaired; worker checks passed, ready for independent verification.
The current implementation instruction supersedes the earlier A-F sequencing block. The 20/30 October prerequisite
audits below are dated history, not the current readiness decision. Step 1 belongs to the separate completed
pause/workload plan. There is no separately linked spec; this plan, its backlog and the answered decisions define scope.
The coordinator owns the full suite, independent verdict, commit and document completion rename.

## Current per-item as-built record

Paths below are relative to the queue worktree. Test names identify executable coverage, not claims about a deployed
provider or James's running app. This retry re-ran the focused checks recorded in
[command receipts](2026-10-20-oct2-later_evidence/retry-20261102/commands.jsonl).
Live checks remain open in [the live-check list](2026-10-20-oct2-later_livetest.md).

| Item | Actual status and executing implementation | Evidence or remaining acceptance |
| --- | --- | --- |
| 2.1 | Deferred live action; none of the five dated runs has been closed by this worker. | Live-check section 1 requires full history reconciliation and the app's own close path. The earlier read-only resumable inventory is not closure evidence. |
| 2.2 | Implemented: `loop-idle-nudge.ts:116` records bounded receipt history; `loop-control.component.html:125` renders collapsed, timestamped rows with open counts. | `loop-idle-nudge.spec.ts`; live-check section 3 for deployed provider event ordering. |
| 2.3 | Implemented: `loop-scorecard.ts:33` counts observed short tool-free turns; `plan-queue-instance-tracker.ts:96` measures each queue turn; item flow/store/schema persist the round measurements. | `loop-scorecard.spec.ts`, `loop-store-spend.spec.ts`, `plan-queue-turn-activity.spec.ts` cover DTO, round response and restoration. |
| 2.4 | Implemented: `restart-compaction.ts:18` logs provenance counts; its prompt calls `compactionTurnLabel` for Harness turns. | `restart-compaction.spec.ts`; bounded read-only frequency sample in `worker-20261102/aggregate-observations.json` recorded 29 explicit Harness turns, none mislabelled as user, in 339 readable files. No transcript text retained; the sample is not a population estimate. |
| 2.5 | Implemented: `plan-queue-spawn.ts:74` tags unattended sessions; `plan-queue-item-flow.ts` sends one routine reminder before escalating an unresolved question. Retention/approval/consent questions bypass it. | `plan-queue-unattended.spec.ts`, `plan-queue-spawn.spec.ts`, machine-session guard and the two coordinator regressions. Reminder grants no new authority. |
| 3.1 | Implemented: `context-menu.component.ts:19` groups Copy actions and delegates focusable disabled reasons/children to the shared nested menu. | Context-menu and workspace-rail component tests, including keyboard-visible disabled explanation and refusal to execute. Native desktop interaction remains live-check section 2. |
| 3.2 | Implemented: `navigation-hubs.ts:9` derives hubs from the existing destinations; sidebar, shell and command palette consume them. | `navigation-hubs.spec.ts`, cross-wave smoke and command-palette tests. The earlier Windows preview is limited to the standalone renderer, not desktop wiring. |
| 3.3 | Implemented: `scheduled-countdown.component.ts:11` ticks through the shared scheduler; automation/wake-up components supply deadlines and busy-session state. | Scheduled-countdown component tests; installed wake-up interaction remains live-check section 2. |
| 3.4 | Implemented: `next-attention-session.service.ts:16` registers a configurable shortcut and cycles attention sessions; instance rows name sign-in waits. | Next-attention service and instance-row tests; installed shortcut/sign-in remains live-check section 2. |
| 3.5 | Implemented: receipt metadata flows through main dispatch and renderer merge to each message delivery line; only definite refusals retry with the original bubble identity. | Messaging store, queue persistence, main receipt/send and queue-service tests. The earlier bounded log sample saw 21 send-attempt entries and no failure entries, not proof of delivery. Actual provider receipts remain live-check section 3. |
| 3.6 | Implemented: `session-facts.component.ts` calls the shared session-facts derivation for paired timings, failures, outstanding calls and compactions. | `session-facts.spec.ts`, including restored tool names; installed provider sample remains live-check section 2. |
| 3.7 | Implemented: context attribution distinguishes unverified/partial totals and deferred availability; `context-attribution-panel.component.ts:202` displays on-demand wording. | Context-attribution service tests. No missing provider measurement is presented as a measured zero. |
| 3.8 | Conditional requirement not activated: this change adds no Everyday transcript preset that hides tool groups. | Traced `output-stream.component.ts` to `output-stream-item-filter.ts`; existing explicit visibility toggles remain. No new provider narration is invented. Reassess if a future Everyday preset hides tools. |
| 3.9 | Implemented: app initialization starts `VisibleAnimationsService`; intersection/document-visibility observers pause infinite animations, including newly discovered off-screen ones, and own their cleanup. | Visible-animations service tests cover visibility changes, new animations and cleanup. |
| 4.1 | Already implemented in the base: all six shared components expose `heading`; H2c bans component-host titles. Retained rather than duplicated. | `heading-input-hosts.spec.ts` exercises all six; UI-hints gate checks templates. |
| 4.2 | Implemented: removed unused tooltip-template input/panel path and tooling provider recognition. | Tooltip building-block/directive specs; UI-facts now asserts the removed attribute cannot satisfy tooltip coverage. |
| 4.3 | Implemented: About is registered in Settings; running-build stamp/IPC selects memory and loop databases separately and supports copying details and unknown states. | `build-info.spec.ts`, help-content guard; installed binary/preload/clipboard remains live-check section 2. |
| 5.1 | Implemented: `opencode-adapter-factory.ts:194` installs a content-hashed instructions path; `opencode-instructions.ts` verifies readability/content before launch. | Instructions and startup-preflight tests; effective real-provider configuration remains live-check section 3. |
| 5.2 | Implemented: OpenCode ACP compaction events retain summaries/cancellation; transcript divider exposes Show summary. | `opencode-acp-updates.spec.ts`; native compaction/cancellation remains live-check section 3. |
| 5.3 | Implemented via the authorized interim alternative: unattended helper spawning is denied while usage is not counted. | `opencode-unattended-policy.ts` applies and verifies effective native permissions; policy/preflight tests. Real effective permissions remain live-check section 3. |
| 5.4 | Implemented: OpenCode 2 unattended output is capped at 1,000 lines/30,000 bytes, with at least 20,000 tokens or 15% compaction buffer; effective config is verified. | Unattended-policy and startup-preflight tests; respects stricter native limits. Real config remains live-check section 3. |
| 5.5 | Upstream source closure only: v2.0.28 chunk silence defaults to 900,000 ms, separately from header timeout, in `packages/ai/src/schema/options.ts:62` and `route/transport/http.ts:128`. | Public tagged source re-fetched on this retry; source hashes/lines retained in `retry-20261102/upstream-timeouts.json`. No claim of an exercised fifteen-minute provider stream; installed-provider check remains open. |
| 5.6 | Documentation requirement retained: the plan explicitly says old `opencode/packages/opencode/...` citations belong to `origin/v1`. | Current plan Step 5.6; no checkout switch or upstream code change. |

## Verification-round-1 repairs

- Reproduced the type error and reported failing specs before repair; current focused/static receipts are kept separately
  from the failed baseline. The baseline run loaded some already-repaired messaging tests late; its seven failures are
  not a claim to reproduce all twelve failures in one run. The dependency/model run reproduced the other three.
- Fixed human-boundary handling in unattended queue clarifications. Kept the existing coordinator expectations for
  retention policy; a policy controlling data deletion is not an arbitrary coding choice.
- Updated the spawn guard to follow `routeQueueSpawn` through the unattended metadata merge and require preserved tags.
  Updated hub/tooltip/paused-send expectations to their intentional interfaces without suppressing their checks.
- About help now includes actionable reporting steps. Clearing unread automation notices has a specific focusable
  disabled reason. Queue identity test passes only the validated fields in its scenario instead of asserting away the
  attachment wire/service type difference.
- Model guard exposed a pre-existing base defect: accounting literals moved to a named pricing-only constant, separate
  from selectable models. The guard and dependency tests remain unchanged.
- Dependency installation repair and the final gate receipts are detailed in the current retry report.

## Historical prerequisite audits (superseded)

The following entries describe earlier checkouts and decisions. Their open rows and blocked rulings do not override
this retry's explicit implementation instruction or the current per-item table above.

## Decision and sequencing

1. The original plan's "Starts after Phases A-F" sequence is preserved in its current Status. At the initial audit all six
   root phase plans reported "Not started" and "On main: no". On the verification-round-1 retry, Phase A reports
   "In progress in the AIO queue worktree" and "not integrated"; B-F still report "Not started" and "On main: no".
2. James's answered decisions page records 1(a), built October work first, and 12(a), extend the existing pause.
   Neither answer waives the phase sequence. The queue's recorded prerequisite-audit decision explicitly preserves it.
3. Ruling: perform read-only prerequisite/source checks and baseline verification; do not start later implementation,
   take over earlier phases, restart the app or close live runs while this prerequisite is unmet. Starting any of the
   later features now would bypass the stated order and can overlap the earlier queue, tooltip and renderer work.
4. Active filenames alone are not proof of missing implementation. In this checkout and the root checkout,
   `src/main/plan-queue/plan-queue-checkout-guard.ts` is absent. The supplied checkout's
   `src/main/core/system/cost-entries-a0-repair.ts` still selects the `a0-per-turn-booking-live` cutoff and applies it to
   all repair rows, including Claude aliases. Phase A's separate Claude cutoff is therefore not implemented here.
   The audit did not start Harness or run the repair against James's data.

The retained [prerequisite snapshot](2026-10-20-oct2-later_evidence/prerequisites.json) contains the six status blocks,
source hashes, checkout identity and source-presence observations. These are point-in-time findings, not evidence that
another worker's unintegrated work is absent. Re-read the phase plans and integrated source before a later retry.

## Existing implementation observations

- `PauseReasonSchema` already includes `user`; `PausePersistence` accepts and persists it, and the coordinator's tests
  cover user pause/restoration. Reuse that manual reason rather than inventing a second equivalent reason.
- `PauseFeatureRuntime.deactivateFeature()` clears all reasons, and `PauseRendererController` only starts while
  `pauseFeatureEnabled` is on. Extending pause requires investigating these paths as well as exposing the toggle.
  The code default is `true`; this does not establish James's persisted setting, which was not read or changed.
- The queue/automation directories have no `PauseCoordinator`/`getPauseCoordinator` references in the targeted search.
  This is a search observation, not a complete runtime proof of every start-of-work path.
- `prepareRestartCompaction()` formats the selected turns as `[${turn.type}]` without a source-aware label. No real
  conversation was scanned, so the requested frequency measurement has not been made.
- Shared `empty-state` and `settings-card` still expose a `title` input. `appTooltipTpl` remains in the directive and
  has a test fixture consumer. Production usage must be rechecked after Phase F before removing it.
- Step 5.6 already contains the `origin/v1` citation guidance. This audit did not fetch or certify upstream OpenCode
  behavior, installed versions, helper accounting, stream behavior or the other OpenCode acceptance criteria.

## Historical requested-item checklist (20 October)

At that audit, all rows were open behind the same A-F prerequisite. Existing fragments above are not credited as completed acceptance.

| Item | Requirement | Actual status |
| --- | --- | --- |
| 1.1 | Manual pause and quiet start-of-work gates | Open; existing `user` reason identified |
| 1.2 | Always-available pause toggle/chip and tooltip | Open |
| 1.3 | Sentinel file and aio-mcp command | Open |
| 2.1 | Close five stale paused loops through the app | Open; live state not changed |
| 2.2 | Collapsed timestamped nudge receipts | Open |
| 2.3 | Status-only turn counters | Open |
| 2.4 | Measure and label Harness-written summary input | Open; formatting path identified, frequency unmeasured |
| 2.5 | Unattended queue sessions | Open |
| 3.1 | Grouped session menu, children and disabled reasons | Open |
| 3.2 | Navigation hubs paired with C10 palette | Open |
| 3.3 | Scheduled-job/wake-up countdowns | Open |
| 3.4 | Needs-James shortcut and sign-in wait wording | Open |
| 3.5 | Send-failure measurement and honest delivery line | Open; frequency unmeasured |
| 3.6 | Session facts popover | Open |
| 3.7 | Deferred-tool and unverified context wording | Open |
| 3.8 | Narration if Everyday hides tool rows | Open; condition must be checked after prerequisites |
| 3.9 | Pause invisible infinite animations | Open |
| 4.1 | Six title-to-heading migrations and component-title ban | Open |
| 4.2 | Remove template tooltip if unused after migration | Open; conditional production-usage check pending |
| 4.3 | Build/version/copy details beside About migration levels | Open |
| 5.1 | Stable OpenCode instructions file and unreadable-file check | Open |
| 5.2 | OpenCode compaction summary display | Open |
| 5.3 | OpenCode helper accounting or unattended denial | Open |
| 5.4 | OpenCode 2 tool-output caps and compaction buffer | Open |
| 5.5 | Validate upstream silent-stream fix and close A6.6 | Open; no upstream/runtime verification |
| 5.6 | Planner citation guidance for origin/v1 | Present in plan; acceptance remains unverified |

## Verification receipts

Commands ran in the supplied queue worktree at HEAD `542f1f690fae155ecec3e6dddfc901c008fec3b7`.
They verify the unchanged baseline, not the later features.

| Command | Result | Evidence |
| --- | --- | --- |
| `rtk npm run test:quiet -- src/main/pause/pause-coordinator.spec.ts src/main/pause/pause-persistence.spec.ts src/main/app/pause-feature-bootstrap.spec.ts --no-cache` | PASS, 3 files / 21 tests | `2026-10-20-oct2-later_evidence/pause-baseline.log`, raw log and JSON report alongside it |
| `rtk npx tsc --noEmit` | PASS | `2026-10-20-oct2-later_evidence/typecheck.log` |
| `rtk npm run typecheck:spec` | PASS, prescribed 8 GiB ceiling | `2026-10-20-oct2-later_evidence/typecheck-spec.log` |
| `rtk npm run lint` | PASS | `2026-10-20-oct2-later_evidence/lint.log` |

The [JSONL command receipts](2026-10-20-oct2-later_commands.jsonl) retain actual exit codes, command arguments,
working directory, durations and log hashes. Baseline tests ran without cache and with auxiliary LLM summaries disabled.
No full suite was run, as instructed for this queue worker. Builds, generators, file-size validation and fresh-agent
completion review were not claimed: no implementation diff exists. The coordinator must not treat baseline green as
feature readiness or mark this plan completed.

## Resume and cleanup

1. Complete, independently verify and integrate A-F through their owning work; supply their required running-app evidence.
   The coordinator must provide a checkout containing that work before this worker implements later items. This worker
   must not merge, switch branches, modify AIO lifecycle metadata or take over earlier sessions.
2. Re-audit partial implementations, then implement the still-open items, including the frequency measurements before
   delivery/summary changes. Finish focused tests and required static/build gates; the verifier runs the full suite.
3. The stale-loop closure must eventually use the app's own close path, identifying each dated run first. Browser/desktop
   verification must use `windows-pc` with gateway health preflight; no browser or desktop action was attempted here.
4. No code acceptance was converted into a live-test deferral. A-F is an implementation dependency, not a human-only
   check. Create the plan's `_livetest.md` when genuine live requirements can be isolated from implemented, verified work.
5. No dependencies, copied checkouts, browsers, database clusters or compiled app were created. Preserve the pre-existing
   `node_modules` directory, including its shared `.vite` symlink. Copy the focused test's raw log and JSON report into the
   evidence folder, then remove only the two worker-created `_scratch` files and their now-empty directory. The seal and
   cleanup receipt record the final state. No commit, stash, branch/worktree operation or app restart was performed.

## Verification-round-1 retry (20 October 2026)

Result: **BLOCKED_PREREQUISITES; 0 of 26 subitems newly implemented.** This retry is not a completion submission.
The retry compared `git log`, HEAD, `main`, merge-base, working-tree status and `git diff main` before editing anything.
HEAD, main and merge-base are still `542f1f690fae155ecec3e6dddfc901c008fec3b7`; the implementation diff is empty.
There was no previously committed implementation to resume. No separate spec is linked.

The [retry prerequisite snapshot](2026-10-20-oct2-later_evidence/resume-r1-prerequisites.json) corrects the initial
audit's stale six-plans-unstarted statement: Phase A is in progress in its owning AIO worktree, explicitly not integrated;
B-F still report not started. Both this checkout and the root still lack `plan-queue-checkout-guard.ts`; the supplied
checkout's cost repair still uses the common `a0-per-turn-booking-live` cutoff. Another worker's unfinished work is not
assumed absent, completed or integrated. The prerequisite is therefore still unmet on source evidence as well as status.

| Verifier finding | Retry disposition |
| --- | --- |
| 1. No implementation; all 26 items open | Confirmed, unresolved. Kept the plan active and marked this handoff blocked rather than ready for completion verification. |
| 2. No quiet pause checks in queue/automations | Confirmed by targeted source search, unresolved. The existing persisted `user` pause reason does not implement these gates. |
| 3. Restart-compaction uses raw turn type | Confirmed at `src/main/context/restart-compaction.ts:27`, unresolved. Required frequency measurement is also outstanding. |
| 4. Shared `title` input and no menu disabled reason | Confirmed in empty-state and the ContextMenuItem declaration; `children` is also absent. Migration and all its consumers remain open. |
| 5. A-F prerequisite unmet | Confirmed. Updated the Phase A status claim; integration and verification of A-F remain with their owning workers/coordinator. |

Ruling: the user's recorded prerequisite-audit decision explicitly says not to interpret the product decisions as a
sequencing waiver. A verifier's absence-of-implementation findings do not supply the missing prerequisite or authorize
this worker to take over A-F, merge their work, or change AIO lifecycle metadata. Starting the later pause, queue,
navigation and tooltip changes now would bypass that order and overlap active prerequisite work. No product approval
or credential input is missing; the remaining action is for the coordinator to supply an eligible checkout after A-F.
Do not repeatedly dispatch this plan for completion verification while that condition remains false.

Fresh checks ran against the unchanged feature baseline, using `rtk proxy` to retain full output and actual exit codes:

| Command | Actual result | Retained log under `2026-10-20-oct2-later_evidence/` |
| --- | --- | --- |
| `rtk proxy npm run test:quiet -- src/main/pause/pause-coordinator.spec.ts src/main/pause/pause-persistence.spec.ts src/main/app/pause-feature-bootstrap.spec.ts --no-cache` | PASS; 3 files, 21 tests, exit 0 | `resume-r1-pause-baseline.log`; raw log and JSON report retained beside it |
| `rtk proxy npx tsc --noEmit` | PASS; exit 0 | `resume-r1-typecheck.log` (empty output, exit code recorded) |
| `rtk proxy npm run typecheck:spec` | PASS; exit 0, prescribed 8 GiB ceiling | `resume-r1-typecheck-spec.log` |
| `rtk proxy npm run lint` | PASS; exit 0 | `resume-r1-lint.log` |

The command receipts append this retry without overwriting the previous run. The full suite was not run, as instructed.
No code or generated interface changed, so no generator ran. Builds and independent completion-gate PASS are not claimed.
No `_livetest.md` was created: missing implementation prerequisites cannot be converted to live-test deferrals.

The root plan and this history remain untracked at their exact original paths; neither is copied into the worktree or
renamed completed. The report, seal, receipts and raw evidence are retained. Only this retry's two generated `_scratch`
test files are removed after evidence is sealed; the scratch directory is retained because it contains another run's
`pid-15562` log and report. No dependencies, copied source trees,
browser binaries, database clusters or compiled app were created. Pre-existing dependencies and shared caches are retained.
Final cleanup and clean-worktree assertions are recorded in the receipt and seal. All 26 rows above retain their open status.

## Queue retry: 30 October 2026

Result: **BLOCKED_PREREQUISITES; no implementation submission.** The supplied checkout is clean at `507d1592d`,
matching main. This is a newer base than the 20 October audit, not the old unchanged base. All six prerequisite status
blocks were re-read and retained with hashes in the [current snapshot](2026-10-20-oct2-later_evidence/resume-20261030/prerequisites.json).
A-F have progressed substantially; none is assumed unstarted. Their own documents still leave integration or whole-plan
acceptance open. Source checks independently confirm that the named Phase A checkout guard is absent from both this
checkout and the root, and the cost-repair implementation still selects one cutoff for its repair rows.

Ruling: preserve the plan's prerequisite ordering and James's answered decision 1(a). His existing implementation
authorization is recognized; this is a missing integrated dependency, not an approval or credentials question. No
merge, branch switch, earlier-phase takeover, app restart or live-run closure was attempted. The coordinator needs to
finish prerequisite integration/acceptance through the owning queue work and supply the resulting checkout. An old
"needs James" label was not treated as a new permission requirement.

Step 1 now explicitly belongs to `2026-10-24-pause-everything-and-workload_plan_completed.md`; its status was read,
not independently re-certified. The old 26-item count included three former Step 1 subitems. The current report tracks
each of the 23 retained subitems individually, including existing planner guidance and conditional requirements;
no source fragment or baseline test is credited as feature acceptance.

Fresh uncached tests covering restart compaction, its input budget, the shared context menu and OpenCode configuration
passed (4 files, 54 tests). Both prescribed typechecks and lint also passed. Full output, exit codes, durations and log
hashes are retained in the current evidence directory. No full suite was run, as instructed. No generator, build,
live-provider check, real-data measurement or independent completion PASS is claimed. No implementation prerequisite
was converted into a live-test deferral.

Only this plan, this history and the current evidence directory were written in the root checkout. The plan and history
were already tracked at task start, with this plan already modified; that pre-existing tracking was preserved rather
than claiming they were untracked. New evidence remains unstaged. No plan/spec copy was placed in the worktree, no staging/commit/stash occurred and no file was
renamed completed. The current report, seal and cleanup receipt record retained dependency installs, copied test
evidence and removal of only worker-created transient output. The coordinator must not promote this blocked retry.

## Queue round: 10 November 2026

Worktree `queue/2026-10-20-oct2-later-f7b0f7` at f4cc70357 (clean, equal to main). Every row in the table above except
2.1 and 4.2 is already in this checkout (spot-checked: `navigation-hubs.ts`, `session-facts.ts`, `build-info.ts`,
`opencode-instructions.ts`, `scheduled-countdown.component.ts`, `compactionTurnLabel` in `restart-compaction.ts:61`).

- 2.1: live data action on the running app's database; stays in livetest section 1. Not attempted from an agent.
- 4.2: `rg appTooltipTpl` still finds production uses at `model-selection-panel.component.ts:168` and
  `instance-row.component.html:127`, plus the directive's own selector/input. The plan's condition ("if still unused")
  is false, so the directive input is kept. This supersedes the 2 November row that said it was removed; main has since
  reintroduced both uses.

Checks run in the worktree: `npm run typecheck` 0, `npm run typecheck:spec` 0, `npm run lint` 0,
`npm run check:ts-max-loc` 0, `npm run check:ui-hints` 0. `npm run test:quiet` on restart-compaction,
opencode-instructions, navigation-hubs, session-facts, scheduled-countdown, aio-tooltip.directive and build-info specs:
7 files, 56 tests passed. Builds and the full suite were not run (no code changed; the verifier owns them).
No code, generated file, or livetest content changed, so the deferred checks are exactly the existing livetest sections 1-4.
