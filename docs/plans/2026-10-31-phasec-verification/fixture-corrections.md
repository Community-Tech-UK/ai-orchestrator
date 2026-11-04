# Phase C compiler fixture corrections

Status: all eight assigned fixture files corrected and verified. No production files were edited. The parent still owns the integrated full verification.

## Root cause and exact changes

The baseline `npm run typecheck:spec` exited 2 and reproduced all nine diagnostics from `_scratch/phasec-gate-integrated-1-2.log`. The baseline runtime run passed all 115 cases, showing these were fixture/type-contract failures rather than a reproduced production behavior failure. The compiler run is the failing reproduction for this compiler-only task; no runtime expectations were updated.

- [x] `src/main/automations/automation-loop-authority.spec.ts:254`: the three-field object asserted as `LoopIteration` omitted required iteration identity, lifecycle, accounting, progress and verification state (TS2352). Replaced that assertion with a complete `const iteration: LoopIteration`. Retained the original `seq: 0`, empty changed-files list and empty output excerpt; added a consistent `bounded-loop` identity, IMPLEMENT stage, fixed fixture timestamps, zero usage, empty evidence and not-run verification state. The refusal assertion and uncalled-reviewer assertion are unchanged. Contract: `src/shared/types/loop-state.types.ts:175`; runtime refuses at `assertLoopModelRoleAuthority` inside `runFreshEyesReviewGate` before reviewer dispatch.
- [x] `src/main/automations/automation-loop-production.integration.spec.ts:51`: `ReturnType<typeof vi.fn>` included constructable mocks and was not guaranteed callable as an EventEmitter listener (TS2345). Both the declaration and creation now use `Mock<(event: AutomationEventMap['runTerminal']) => void>` / the corresponding `vi.fn` generic. No terminal-event values or assertions changed.
- [x] `src/main/automations/automation-settlement.integration.spec.ts:59`: applied the same actual terminal-event mock type (TS2345). At line 236, supplied the missing required `GraphAccount.tenant` as the synthetic string `fixture-tenant` (TS2741). Existing account key, username, timestamps, mutation failure behavior and all assertions remain unchanged. Contracts: `src/main/automations/automation-events.ts:4` and `src/main/graph/graph-token-store.ts:4`.
- [x] `src/main/instance/instance-communication.settled-usage.spec.ts:36`: the sparse `Instance` assertion omitted identity, hierarchy, process, lifecycle and buffer defaults (TS2352). It now spreads the real shared `createInstance` factory and then applies every original fixture override unchanged. Factory input uses a synthetic working directory, Claude, the same parent/build agent and the original session ID, keeping the factory's provider-session identity consistent with that session. The result has an explicit `Instance` annotation and no object type assertion. Contract/factory: `src/shared/types/instance.types.ts:430` / `:815`; usage capture and deferred billing flow through `setupAdapterEvents` and `communication-completion-cost.ts`.
- [x] `src/main/plan-queue/plan-queue-handover.spec.ts:27`: the messenger's full instance port required `restartFreshInstance`, which the fixture omitted (TS2345). Added an asynchronous mock port that throws if a handover unexpectedly tries to restart a provider conversation. All pre-existing changes in this tracked file, including `not_checked` and `preflightRun`, were preserved; those changes were already present when this task started.
- [x] `src/main/plan-queue/plan-queue-session-recycle-flow.spec.ts:34`: the sparse host assertion hid missing host/service and instance-port members (TS2352). Replaced it with a complete `PlanQueueFlowHost` annotation; completed the typed run record; instantiated real `PlanQueueHistoryStore` and `PlanQueueWorktreeService` with an isolated in-memory WASM SQLite database and loop migrations; added explicit throwing unused ports. The existing owner lookup, restart event, provider-session mutation, send ordering, save and role-registration behavior remain. WASM initializes in `beforeAll` and the database closes in `afterEach`. No worktree creation/cleanup is allowed by the fixture creator ports. The exercised path remains `answerWorker` -> `runWorkerTurn` -> `recycleQueueCopilotSession` -> same-owner restart -> worker-session recording -> re-armed tracker -> sendInput. All original assertions remain.
- [x] `src/main/plan-queue/plan-queue-set-aside-answer.spec.ts:31`: the fake worker lacked the `PlanQueueInstanceRecord.outputBuffer` required by coordinator/instance tracking (TS2322). Added the truthful empty buffer and typed the worker record directly; its existing ID, idle status and working directory are unchanged.
- [x] `src/worker-agent/remote-codex-usage.integration.spec.ts:135`: the getter returned `true` for every settings key, which cannot implement the generic key-indexed `AppSettings[K]` contract (TS2322). It now returns `({ ...DEFAULT_SETTINGS, enableSpawnWorkerOffload: true })[key]`. This retains the original exercised true offload setting and true default signal fence while providing actual correctly typed defaults for every other key. It does not load or modify persisted settings. The remote factory/transport isolation and every assertion are unchanged.

## Verification and assertion integrity

- Baseline spec typecheck: exit 2, nine assigned diagnostics.
- Baseline focused runtime tests: exit 0, eight files, 115 passed, zero failed or pending.
- Final spec typecheck: exit 0, no diagnostics.
- Final focused runtime tests: exit 0, eight files, 115 passed, zero failed or pending.
- Focused ESLint on all eight files: exit 0, no output.
- Scoped tracked `git diff --check`: exit 0. Seven assigned files were already untracked, so this Git check only covers tracked changes; compiler, runtime and focused lint checks cover all eight.
- AST comparison confirms every original assertion matcher argument/expected value and literal test title is unchanged: `_scratch/phasec-fixtures-behavior-before.json` and `_scratch/phasec-fixtures-preservation.json`.
- Baseline and final Vitest JSON case names and statuses match exactly. Source hashes and this comparison are recorded in `_scratch/phasec-fixtures-final-audit.json`.
- No tests were weakened, deleted or skipped. No unknown-cast escape, suppression, configuration/ceiling/dependency change or production edit was introduced.

## Full runtime logs

Baseline:
- `_scratch/test-run.phasec-fixtures-baseline-tests-1793418991665482000.log`
- `_scratch/test-results.phasec-fixtures-baseline-tests-1793418991665482000.json`

Final:
- `_scratch/test-run.phasec-fixtures-final-tests-1793419151270126000.log`
- `_scratch/test-results.phasec-fixtures-final-tests-1793419151270126000.json`

All test runs used `AIO_TEST_SUMMARY=0`, `AIO_TEST_NO_CACHE=1` and unique `AIO_TEST_OUT_SUFFIX` values. Node v24.22.1 was first in PATH; every shell command ran through `rtk` (raw checks through `rtk proxy`). The machine-readable command, environment, log and exit-code ledger is `_scratch/phasec-fixtures-commands.jsonl`.

## Limitations and handover

- The settlement suite emits the same pre-existing `MaxListenersExceededWarning` in both baseline and final runs, naming 11 `admission-changed` listeners during the late-created-instance cancellation case. It was not suppressed, the listener limit was not changed, and resolving it is outside this compiler-only scope. Expected synthetic authority-refusal and termination-refusal diagnostics also remain in both raw logs.
- The full suite and repository-wide lint/build gates were not run, as instructed. The parent must run integrated verification after all writers stop. No independent subagent review was started, as instructed; this report is scoped verification, not a claim that the overall integrated work is complete.
- No live personal settings, credentials, shared application or shared database were used. Databases were isolated in memory; Graph fetch and worker transport remain injected doubles. Existing automation RPC tests use local scratch Unix-domain sockets, not external service calls. No browser, Mac UI, deployment or network service send was performed.
- No staging, commit, branch/worktree operation, source copy, merge or `_completed` rename was performed. Parent documents and unrelated work were left alone.
- All owned baseline/final typecheck, test-runner and focused lint subprocesses exited. No process kills were needed. Test-owned scratch folders/sockets retain their existing teardown; the added database has explicit teardown.

## Recorded commands

### baseline-typecheck

```text
PATH=/Users/suas/.nvm/versions/node/v24.22.1/bin:$PATH
AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1 AIO_TEST_OUT_SUFFIX=phasec-fixtures-baseline-typecheck-1793418933876806000
rtk proxy npm run typecheck:spec
```

Exit code: 2. Full captured output: `_scratch/phasec-fixtures-baseline-typecheck-1793418933876806000.log`.

### baseline-tests

```text
PATH=/Users/suas/.nvm/versions/node/v24.22.1/bin:$PATH
AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1 AIO_TEST_OUT_SUFFIX=phasec-fixtures-baseline-tests-1793418991665482000
rtk proxy npm run test:quiet -- src/main/automations/automation-loop-authority.spec.ts src/main/automations/automation-loop-production.integration.spec.ts src/main/automations/automation-settlement.integration.spec.ts src/main/instance/instance-communication.settled-usage.spec.ts src/main/plan-queue/plan-queue-handover.spec.ts src/main/plan-queue/plan-queue-session-recycle-flow.spec.ts src/main/plan-queue/plan-queue-set-aside-answer.spec.ts src/worker-agent/remote-codex-usage.integration.spec.ts
```

Exit code: 0. Full captured output: `_scratch/phasec-fixtures-baseline-tests-1793418991665482000.log`.

### focused-lint

```text
rtk proxy node node_modules/eslint/bin/eslint.js src/main/automations/automation-loop-authority.spec.ts src/main/automations/automation-loop-production.integration.spec.ts src/main/automations/automation-settlement.integration.spec.ts src/main/instance/instance-communication.settled-usage.spec.ts src/main/plan-queue/plan-queue-handover.spec.ts src/main/plan-queue/plan-queue-session-recycle-flow.spec.ts src/main/plan-queue/plan-queue-set-aside-answer.spec.ts src/worker-agent/remote-codex-usage.integration.spec.ts
```

Exit code: 0. Full captured output: `_scratch/phasec-fixtures-focused-lint-1793419122906095000.log`.

### final-typecheck

```text
PATH=/Users/suas/.nvm/versions/node/v24.22.1/bin:$PATH
AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1 AIO_TEST_OUT_SUFFIX=phasec-fixtures-final-typecheck-1793419092241926000
rtk proxy npm run typecheck:spec
```

Exit code: 0. Full captured output: `_scratch/phasec-fixtures-final-typecheck-1793419092241926000.log`.

### final-tests

```text
PATH=/Users/suas/.nvm/versions/node/v24.22.1/bin:$PATH
AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1 AIO_TEST_OUT_SUFFIX=phasec-fixtures-final-tests-1793419151270126000
rtk proxy npm run test:quiet -- src/main/automations/automation-loop-authority.spec.ts src/main/automations/automation-loop-production.integration.spec.ts src/main/automations/automation-settlement.integration.spec.ts src/main/instance/instance-communication.settled-usage.spec.ts src/main/plan-queue/plan-queue-handover.spec.ts src/main/plan-queue/plan-queue-session-recycle-flow.spec.ts src/main/plan-queue/plan-queue-set-aside-answer.spec.ts src/worker-agent/remote-codex-usage.integration.spec.ts
```

Exit code: 0. Full captured output: `_scratch/phasec-fixtures-final-tests-1793419151270126000.log`.

### diff-check

```text
rtk proxy git diff --check -- src/main/automations/automation-loop-authority.spec.ts src/main/automations/automation-loop-production.integration.spec.ts src/main/automations/automation-settlement.integration.spec.ts src/main/instance/instance-communication.settled-usage.spec.ts src/main/plan-queue/plan-queue-handover.spec.ts src/main/plan-queue/plan-queue-session-recycle-flow.spec.ts src/main/plan-queue/plan-queue-set-aside-answer.spec.ts src/worker-agent/remote-codex-usage.integration.spec.ts
```

Exit code: 0. Full captured output: `_scratch/phasec-fixtures-diff-check.log`.
