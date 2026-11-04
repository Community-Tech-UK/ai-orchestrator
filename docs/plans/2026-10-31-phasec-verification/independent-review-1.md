VERDICT: FAIL
Task: Entire `docs/plans/2026-10-20-oct2-phaseC-queue-that-finishes_plan.md`, all 13 steps, including the unresolved first-round whole-plan acceptance finding.
Range: `507d1592dd9417258ce6aaf1241fbe5d3a5f536e..6c77e943c9be5339848de8c39021f530ad126cd7`, PLUS staged/unstaged/untracked working-tree changes. HEAD and index were unchanged by this verifier.
Gate 0 evidence: Independent focused run 1 exit 0 (6 files / 56 passed); focused run 2 exit 0 (18 files / 213 passed); final independent behavioral reproductions exit 1 (6 intended behavior assertions failed / no pending tests). Clean checkout/install/full-suite reproduction was explicitly prohibited for this interim pass. The separately executed parent integrated-1 receipts record spec compiler exit 2, LOC exit 1, wording guard exit 1, and full suite exit 1. These are attributed historical receipts, not my independent executions or a certification of later edits.
Claims vs reality: No implementation completion claim was made. No Critical misreporting finding. The plan correctly remains IN PROGRESS with 0/13 independently accepted end to end. Prior scoped PASS/checkpoint reports do not establish current whole-plan acceptance.
Findings: F1 High retained runtime loses error/lifecycle observation; F2 High scheduled-job reactivation bypasses caller authority; F3 Medium cancellation waits for unrelated gate sets; F4 Medium estimated queue prices become exact; F5 Medium monitor backoff ignores changed earlier messages; F6 Medium absolute paths escape into the visible last finding. All six reproduced against real production modules, with controlled infrastructure collaborators. D1 Low live-test token formula contradicts the plan. Known integrated-1 gate failures remain separately recorded below.
Acceptance criteria: All 13 steps mapped below. None is independently accepted end to end by this pass. Step 12 has genuine authority/prerequisite blockers in addition to the code defects elsewhere.
Escalation: Applied `repo-health-audit` and `references/deep-audit.md`: security-sensitive execution/authentication/cancellation changes and a change well beyond 400 lines / 15 files. All audit passes 0–6 are recorded below; this is not a whole-repository PASS.

## Evidence, scope and reproducibility

I am a fresh verifier, not an implementer. I read both requested skills and their complete runbook/deep-audit reference, the entire plan, current/historical evidence reports, architecture, rejected decisions, Angular conventions and screen/wording guide. Review concentrated on the executing queue, automation, review, provider, remote usage, persistence and renderer paths. No browser, service account, personal database/settings, dependency installation, external send, deployment or additional agent was used.

Initial inventory: 199 tracked changed paths and 110 untracked paths. The committed portion alone is six discovery files, 497 insertions / 55 deletions. The substantially larger working tree is included in the review, rather than treating HEAD as the finished implementation. See `phasec-fresh-gate-inventory/{status,committed,numstat,full-diff,untracked}.log` and `source-sha256.json`.

The integrated-1 source freeze ended during this audit. Later parent repairs changed files, including the automation runner and compiler fixtures; `source-drift.json` records the observed differences. I then repeated all six reproductions. The 14 affected production/fixture paths in `reproduction4-before.json` and `reproduction4-after.json` were byte-identical throughout that final run. This is an affected-path fence, not a claim that the whole checkout was frozen. Reports of the earlier integrated run are deliberately separate from current reproduction evidence.

All shell entry points used `rtk proxy`. Test commands used Node 24.22.1 first in PATH and `AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1` with a unique `AIO_TEST_OUT_SUFFIX`. Reproductions also used `AIO_COST_ATTRIBUTION=0`. The quiet runner's generated raw/JSON logs have been moved to verifier-owned `phasec-fresh-gate-*` filenames; their internal original output-path text is retained verbatim.

Final reproduction command (exit 1):

```sh
rtk proxy env PATH=/Users/suas/.nvm/versions/node/v24.22.1/bin:/opt/homebrew/bin:/usr/bin:/bin AIO_COST_ATTRIBUTION=0 AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1 AIO_TEST_OUT_SUFFIX=phasec-fresh-gate-reproductions4 npm run test:quiet -- --config _scratch/phasec-fresh-gate-vitest.config.ts _scratch/phasec-fresh-gate-defects.spec.ts
```

Exact tests, outcomes and raw failures: `phasec-fresh-gate-reproductions4-results.json` and `phasec-fresh-gate-reproductions4.log`. Scratch fixture: `phasec-fresh-gate-defects.spec.ts`. All fixture promises/timers are released in finally/teardown. These probes launch no provider or worker and no uncontrolled child. The existing gate-timeout test in focused1 uses a bounded real Node child through the production process-group runner.

Independent successful commands and exact selected files are preserved in `phasec-fresh-gate-inventory/independent-test-receipts.json`; raw logs/results are `phasec-fresh-gate-focused1*` and `phasec-fresh-gate-focused2*`. They cover receipt classification/timeout/base policy, history, migrations, triage memory, immutable closure, late spend, automation authority/settlement, review cancellation/retirement, local/remote usage and rendered queue controls. Successful focused tests do not override the reproduced defects.

## Actionable findings, ordered by severity

### F1 — High — Retained runtime has no error or lifecycle observers after a refused stop

Gate 4.1/4.3; deep passes 2/4/6. `src/main/instance/lifecycle/instance-termination.ts:127` removes every adapter listener before awaiting termination (`:139`). The new rejection propagation at `:233` retains the live adapter and instance when termination rejects, but restores none of their listeners. The existing new regression only checks retention and a second termination attempt.

Real route: `InstanceManager.terminateInstance` → lifecycle → `InstanceTerminationCoordinator.terminateInstance`. Queue retirement and automation stop attempts both reach it. Live adapter error delivery is real: `src/main/cli/adapters/base-cli-adapter.ts:739` and `:750` re-emit non-EPIPE stream errors on the adapter.

Independent probe invokes the real coordinator with an EventEmitter runtime whose stop rejects. Observed `RETAINED_RUNTIME_ERROR_LISTENERS 0`; a subsequent `adapter.emit('error', ...)` throws `fixture later provider error`. The runtime also cannot publish further status/output/usage through the removed communication observers. This is a production observation failure, not merely a failed-stop warning. Required result: preserve an observed, safely stopping runtime after refusal, including safe error handling and settlement, while still preventing ordinary exit recovery from respawning it. Do not restore the old swallow-and-delete behavior.

### F2 — High — Agent can reactivate a disabled higher-authority job without an authority check

Gate 3.3; deep passes 3/4/6. `src/main/automations/automation-tool-impl.ts:347` limits `actionChanged` to executable action fields. `:375` checks caller authority only when an action object was rebuilt. `enabled: true` at `:382` therefore bypasses it and `:404` schedules the job. The authenticated MCP handler does supply caller identity; it is ignored on this path.

Independent probe creates a disabled operator job (Claude Opus / max / auto-approval), calls the real `update_automation` definition and implementation as a Sonnet / low / no-auto-approval caller with only `{id, enabled:true}`, and inspects the real in-memory store. Output: `ENABLE_HIGH_AUTHORITY {"refused":false,"enabled":true,"scheduled":1}`. Thus a meaningful transition from no execution to higher-authority execution is allowed even though equivalent prompt replacement or duplicate creation is refused. This is distinct from harmless name/description edits, which should preserve existing operator intent.

Required result: reactivation, and schedule changes that newly trigger execution, must not let a lower-authority agent start higher-authority work without the corresponding authority check. The human form remains unrestricted. If product policy deliberately intends reactivation to retain independent operator authority, that policy must be explicitly resolved against Step 9.5; the current code and tests do not establish such an exception.

### F3 — Medium — Cancelling a queued gate set waits for another run's gates

Gate 4.3/4.4; deep passes 2/4. `src/main/plan-queue/plan-queue-gate-receipts.ts:67` awaits the previous slot promise without observing the abort signal; cancellation is checked only afterward. `PlanQueueVerification.prepare` awaits that call while holding the item lock. `plan-queue-item-flow.ts:223` aborts checks for Pause, then `:225` waits for that same lock.

Independent probe holds run A's executor, queues run B, aborts B and races its completion against a short real timer. Output: `QUEUED_GATE_CANCELLATION still waiting for unrelated gates`. B rejects only after A is explicitly released in finally. Production gates have a 15-minute per-command deadline (`plan-queue-gate-receipts.ts:49`), and a set may run several commands plus baseline checks. Pause/Cancel of B can therefore wait many minutes on unrelated work even though B has started no command. Required result: an aborted waiter releases its caller promptly without allowing subsequent gate sets to overlap the still-running owner.

### F4 — Medium — Queue converts explicitly estimated pricing into exact billing

Gate 4/5.2; deep passes 1/4/6. `src/main/plan-queue/plan-queue-spend.ts:19` re-resolves cost from `usage.cost`; `:24` decides exactness from that new result instead of the attribution record's existing `costSource`.

The executing producer `src/main/instance/communication-completion-cost.ts` places computed list-price estimates into `usage.cost` while correctly setting `costSource:'priced'`; `recordInstanceTurnAttribution` preserves that source. `resolveModelCallCost` treats any nonnegative supplied `usage.cost` as provider-reported. A measured-token estimate from non-Codex providers is consequently promoted to `costBasis:'exact'` and then contributes to `exact_cost_usd` in the real queue store.

Independent probe uses the real attribution bus and real queue recorder with `{provider:'claude', costSource:'priced', costKnown:true, usage:{inputTokens:1000, outputTokens:100, cost:0.0045}}`. Observed `PRICE_RECEIPT ... "costBasis":"exact"`; expected estimated. Required result: retain cost provenance already established by the producer. A numeric cost does not prove exact billing. Step 7.3 explicitly requires this distinction.

### F5 — Medium — Monitor slows despite a changed warning in earlier assistant output

Gate 4; deep passes 4/5. `src/main/automations/automation-runner.ts:474` accumulates all output, but `:660` passes only `tracking.lastAssistantOutput` as `monitorOutput`. `AutomationStore.terminalizeRun` forwards that value to `recordMonitorOutcome`; `src/main/automations/automation-monitor.ts:49` fingerprints it as the supposedly full output.

Independent test runs the real runner/store/migrations twice. First output: `Server healthy`, then `Finished checking.`. Second output: `Server has a new urgent warning`, then the same `Finished checking.`. Both settle through normalized completion. Output: `MONITOR_STATE {"unchangedChecks":2,"intervalMultiplier":2,...}`. The unchanged final message hides the substantive warning and doubles the next interval. Required result: compare the relevant complete assistant output for the run; changing an earlier assistant message must reset opt-in backoff. The existing long-output test uses one message and does not cover this case.

### F6 — Medium — Visible last finding bypasses path scrubbing

Gate 7.1; deep passes 3/5. `src/renderer/app/features/plan-queue/plan-queue-park-reason-help.ts:192` reads the raw summary, and `:193` constructs unsanitized `extra`. `components/plan-queue-parked-list.component.html:41` renders it unconditionally outside Details. Other finding/detail paths use `foldDetail` or `stripAbsolutePaths`.

Independent probe of the real presenter returns `VISIBLE_LAST_FINDING Last finding: Broken /Users/fixture-person/private-project/src/task.ts`. This violates Step 8's absolute-path removal and folded diagnostic requirements. Angular interpolation prevents HTML execution, but does not remove the private path. Required result: apply the same display scrubbing to this summary path.

### D1 — Low — Pending live check still counts output against the processed-token cap

`docs/plans/2026-10-20-oct2-phaseC-queue-that-finishes_livetest.md:60` says input, both caches **and output** count. Step 9.2 / Step 7.1 and the actual run-limit implementation use processed=input+cache-read+cache-write, with output separate. The live check would reject correct code or encourage changing the canonical metric again. Update the active live-check expectation; do not weaken the existing canonical processed-token tests.

## Gate 0 and known integrated-1 failures

Clean-state deviation is deliberate and blocking for a final PASS: the user prohibited clean checkout copies, commits/worktrees, dependency installs and a duplicate full suite during integrated-1. Existing dependencies were reused. I did not independently execute all typecheck/lint/build/full-suite gates. No clean-state success is claimed.

I read the parent's raw integrated-1 logs and copied its command receipts into `phasec-fresh-gate-inventory/integrated1-command-receipts.json`. They record:

| Command | Parent exit | Actual recorded result |
|---|---:|---|
| `npx tsc --noEmit` | 0 | Empty successful log |
| `npm run typecheck:spec` | 2 | Fixture typing failures in automation loop authority/production/settlement, settled usage, queue handover/recycle/set-aside and remote Codex usage |
| `npm run lint`, `npm run lint:fast` | 0 / 0 | Angular lint succeeds; fast lint has warnings |
| `npm run check:ts-max-loc` | 1 | Codex app-server turn adapter 701 lines against 700 |
| `npm run check:ui-hints` | 1 | Review tooltip lost recorded words and introduced unrecorded wording |
| `verify:ipc`, `verify:ipc-usage`, `check:contracts` | 0 / 0 / 0 | IPC usage remains warn-level; no stricter claim |
| `build:main`, `build:renderer`, `build:worker-agent`, worker self-check | 0 / 0 / 0 / 0 | Renderer bundle-budget warning retained |
| `npm run test:quiet` | 1 | 36,419 passed / 12 failed / 9 pending, from the actual JSON |

The full-suite failures are broader than the initially known compiler/LOC/wording fixes: UI-hints baseline (1), automation final-provider-limit suite (5), automation spend fixture missing schedule (1), pinned Copilot roster size (1), live roster expectations (2), context-worker import-closure size (1), and old termination-rejection expectation (1). Some are fixtures/changed contracts; they must be adjudicated against actual behavior, not blanket-waived. These are historical integrated-1 failures, not assertions that later repairs are still failing. No new full suite was launched by this verifier.

## Acceptance criteria: all 13 steps

`Exercised` below means named source paths and selected tests were inspected/executed; it does not mean whole-step acceptance.

| Step and criteria | Criterion-to-evidence mapping | Actual status |
|---|---|---|
| 1 — events, verdicts, stable findings, shared progress | `PlanQueueStore.upsertItem` transaction writes transition events; history store retains verdicts/pins; progress helpers used by verification and restart. Independent history/store/loop-schema tests pass. | Exercised; final whole-plan gate still open. |
| 2 — machine receipts, classification, baseline, red refusal, not_checked, serial load/cancel/cache | Real gate runner → verification prepare/record → item-flow checker spawn; contracts require meaningful `not_checked`; receipt/policy tests and real timeout pass. Current-HEAD/missing/red/document changes are checked. | F3 blocks cancellation acceptance; full final gates open. |
| 3 — global capacity, shared error pause, preflight, two retries, restart loop | Worktree service counts manager and retained folders; pump admission, preparation-error backoff, preflight selection, turn retry, restart-history consumers traced. Independent safety/verification tests pass. | Exercised partially; installed forced-cap check and final acceptance open. |
| 4 — earlier rounds, unchanged-work warning/park, repeated finding step-back, resume offer | Verification prompt reads durable rows/worker claims/pins; progress helpers implement one warning then no-progress; third finding remains log-only; run-start/answer paths offer same-owner parked work. | Code inspected/exercised in receipt/policy tests; observation week open. |
| 5 — checkpoint diet, source hash guard, pinned criteria, immutable close-small | Worktree checkpoint → diet; original pin before worker; source/output closure receipts, exclusive publication and retirement inspected. Independent diet/doc-close/history tests pass, including concurrent hash/encoding/recovery cases. | Exercised; final acceptance open. Per-closure history naming differs deliberately from the original shared filename. |
| 6 — real-plan discovery, bounded header/walk, glob preview/confirmation, memory, exact pick, bulk skip | Committed discovery plus current path/preview/memory modules, form and coordinator wiring included. Independent triage-memory tests pass; rendered queue and existing receipt/safety tests pass. Exact-path/preview assertions were read, but not every discovery/bulk test was independently rerun in this pass. | Round1 discovery-only incompleteness is no longer an implementation description of the current tree; discovery acceptance remains unchecked. |
| 7 — processed/cache/output, nullable unpriced spend, exact provenance and labels/average | Captured lineage → attribution bus → queue spend/store → renderer labels. Independent late-usage/store tests pass. | F4 violates exact-cost criterion; no acceptance. |
| 8 — three tabs, folded history/details/attempts, exhaustive help/actions, previewed bulk, honest receipts/spend | Actual templates/store/presenters reviewed; page/parked-list DOM tests pass independently. Tab roles, aria-controls/selected/labels and arrow/Home/End navigation exist. No native-title/icon-only regression identified in the inspected changed controls. | F6 violates visible diagnostics criterion; Windows visual/keyboard check remains pending. |
| 9 — time/token bounds, restart once/no replay, semantic quiet result, caller ceilings, model hint, opt-in backoff | Real runner/limits/dispatch deadlines/settlement/restart/delivery/authority paths inspected, including first-turn invocation MCP registration. Independent authority/settlement tests pass. | F1/F2/F5 block code acceptance; D1 contradicts live expectation. Installed restart/process checks open. |
| 10 — per-instance staleness abort, daily invalid-schema retirement, tooltip, premium measurement | Input-started/batch listeners → source epochs/controllers → cancellation-neutral breaker; reviewer pool retires after two validation operations/day; tooltip reads daily usage. Independent staleness/retirement tests pass. | No additional reproduced code defect in this pass; final gate and post-restart premium measurement open. |
| 11 — premium labels/counters, numeric allowlisted tail, >90% recycle, old-version warning | Factory chooses Copilot-specific ACP/native usage wiring; numeric tail, queue restart, loop recycle and remote projection traced. Independent tail/remote tests and rendered queue tests pass. | No extra reproduced code defect here; installed numeric/recycle/history checks and final gate open. |
| 12 — owner agreement, archive/header, max-index helper, guidance, weekly Windows campaign | Shared root `git diff --numstat` independently returns **143 additions / 0 deletions**. Register declares standing-register exemption; current header still points at older plans. Independent next-ID/structure tests pass. | BLOCKED/PARTIAL: no owner agreement supplied; archive/header not done; weekly campaign depends on unintegrated Phase A/B source work. No authority to change shared root or schedule now. Not a code-defect waiver or a whole-plan PASS. |
| 13 — complete per-thread ephemeral receipt, native/exec/remote ownership, bounded Costs reader/display | Native/exec trackers → validated numeric writer/reader; worker metadata/current callback → authenticated node telemetry → interaction/owner/job/kind/trial validation → controller reader; Costs IPC/preload/page path inspected. Independent native/reader/remote integration tests pass. Missing request counts remain explicitly unavailable. | Exercised; real native/installed Costs check and final acceptance open. |

**0 of 13 independently accepted end to end.** The first-round whole-plan finding remains open. Unimplemented Step 12 work cannot disappear into a scoped code PASS or be called fully verified because its authority/prerequisites are genuine.

## Escalated repository audit: passes 0–6

1. **Pass 0, inventory:** scanned 3,691 production TypeScript modules for approximate relative-import topology. Logger, instance types, loop types and provider types are high-fanout dependencies; the changed provider types and lifecycle paths received extra attention. `topology.json` preserves counts/callers. Huge existing orchestration modules are context, not new demands for unrelated refactoring. Git range confirms one discovery checkpoint, not the entire working implementation.
2. **Pass 1, architecture:** traced startup → queue bootstrap/store/history/flow; startup → automation tools/runner/invocation config; factory/runtime → Copilot/Codex adapters; telemetry → remote numeric store; preload/IPC → renderer. New helpers have executing callers on these routes. F4 is a real producer/consumer provenance mismatch; no second authority service or broad replacement architecture is proposed.
3. **Pass 2, async/state:** reviewed item locks, shared slot chain, abort controllers, turn retries, stop attempts, root/descendant usage settlement, first-turn early events, restart retry markers and stale reviews. F1/F3 are reproduced lifecycle/cancellation gaps. Failed remote terminate keeps the acknowledged identity and rejects for retry; the inspected new remote numeric receipt path checks interaction ownership before persistence. Focused remote/settlement tests pass; this does not prove OS process absence.
4. **Pass 3, security:** socket capability verification occurs before dispatch; caller identity reaches automation mutations; scoped invocation capabilities allow only automation_result; connector mutation hooks and lineage delivery markers were traced. F2 remains an authorization gap. Local gitleaks commit-range and combined diff/untracked scans both exit 0 with no leaks (redacted logs/JSON retained). No manifest/lockfile changes were found. Registry/CVE checks were not run because no new dependency was added and external sends are prohibited. No assertion that all pre-existing dependencies are vulnerability-free.
5. **Pass 4, logic/data:** F4/F5/F6 reproduce boundary inconsistencies. Loop migrations add history/spend tables/columns without destructive existing-table rebuilds; RLM policy migration adds facts/usage/monitor state and backfills limits. Independent migration tests use in-memory databases and pass. Queue history/state transactions, immutable closure identity and durable retry markers were inspected. Full rollback of derived JSON defaults is not claimed by the additive migration down script.
6. **Pass 5, quality/performance/accessibility:** whole-diff scans found no new skip/only/exit-success harness hack, compiler/linter configuration weakening or dependency change in the initial captured range. Removed/replaced assertions were examined: migration shape, renamed wording, new explicit completion contract and deliberate immutable closure behavior explain the inspected changes. Coordinator gate execution is injected in Git/session fixtures, with separate real timeout/policy tests; no tampering finding asserted. Main output chunks are still retained for complete run output; new monitor logic incorrectly consumes the last message (F5). Numeric tail reads, receipt cache counts and Costs rotation/reader limits are bounded. UI review is headless; F6 is a concrete display issue, not an invented visual critique.
7. **Pass 6, iterative regressions:** examined changes that replaced swallow-and-cleanup with retained stop ownership, token/cost provenance crossing independent modules, and agent ceilings across tool/store/runtime boundaries. F1/F2/F4 are precisely integration defects that helper-presence tests miss. A fresh gate after repairs must retest these paths rather than accepting prior scoped PASS histories.

## Limits and required next review

- This interim review does not certify every line of the 309-path change or every module in the repository. All audit passes were applied, with depth concentrated on the named runtime/security/accounting paths and independently reproducible defects. No invented confidence from inventory scans.
- Gate 0 is not independently complete. Canonical typechecks/lint/build/full-suite checks must pass against the repaired source, then a genuinely fresh verifier must run the final whole-plan gate. Parent integrated-1 outputs are not substitutes for that.
- No live provider turns, OS-wide process inventory, installed-app restart, remote worker upgrade, browser/visual audit or weekly campaign was run. Known authority constraints remain explicit. No Mac UI was used.
- The shared register and its 143 additions were read only. No owner agreement was inferred from silence. No closed plan was edited, no completion filename changed, and no branch/worktree/index/HEAD alteration was made by this verifier.
- Scratch probes intentionally remain red as defect reproductions; they are excluded from normal repository tests by location and use only the explicit scratch test configuration. They are evidence, not production changes.

Repair F1–F6, correct D1 and resolve every current canonical failure on evidence. Then perform the requested fresh final review over both the commit range and the complete working tree again. Preserve Step 12 as incomplete until its owner/prerequisite requirements are actually satisfied.
