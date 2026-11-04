# Automation runtime regression repair report

Date: 2026-10-31. Scope: supplied AIO checkout only; no staging, commits, branches, worktrees, merges, document completion renames, subagents, live app, personal settings/data, credentials, browser, deployment or external service calls.

## Result and checklist

- [x] Read the supplied integrated failure log and the relevant JSON test results; reproduced the original failures without editing code first.
- [x] Restored final provider-limit notice classification on the settled automation completion path.
- [x] Updated obsolete provider-limit test inputs to include the live instance and current request/generation evidence; retained every existing expected status and assertion.
- [x] Replaced the incomplete spend-attribution run input with a fully typed `AutomationRun`, including its required schedule; retained all attribution assertions.
- [x] Reconciled the wait-reason test with the required rejecting termination API; retained its cleanup assertion and added rejection/ownership assertions.
- [x] Verified the focused failures and a broader scheduled-run/stop/settlement group.
- [x] Ran application and test typechecks, lint, source-size and UI-hint checks, both builds and whitespace validation.
- [ ] Full suite: deliberately not run, as requested. Parent owns the final integrated run after all writers stop.
- [ ] Fresh-agent review: deliberately not run, as requested (no subagents).
- [ ] Live provider/app/UI validation: not run; prohibited for this task. Isolated runtime integration tests cover the executing settlement path.

## Root causes, demonstrated separately

### 1. Provider-limit tests had obsolete completion inputs and concealed a real production regression

The original focused run reproduced five failing provider-limit test scenarios with status `running` (one scenario attempts six consecutive runs). Their manager returned no live instance and their normalized `complete` event omitted the request identity.

The actual main-process path captures `requestCount` when the adapter completes (`src/main/instance/instance-communication.ts:1757`), registers cost accounting, waits for deferred response usage (`:1798`) and pending descendant completion tasks, then publishes normalized completion with the captured request marker (`:1805`). `completionReceipt()` in `src/main/automations/automation-completion-receipts.ts` requires the live instance, matching request count, and matching adapter generation where supplied. A bare output, idle or exit event does not authorize root success.

The provider-limit fixture now returns the same instance through creation and lookup, with `requestCount: 1`, `adapterGeneration: 1`, `restartEpoch: 0` and root lineage. It sends the matching completion marker. Before that marker, it emits idle, clean exit and unbound completion and explicitly asserts that the durable run stays `running` (`src/main/automations/automation-run-provider-limit.spec.ts:206`). Output files use a per-test scratch directory with cleanup; tracked timers/subscriptions are cleared after each test.

With only those protocol inputs repaired, three existing tests still failed: they now observed `succeeded` where their unchanged assertions required `failed`. This is the decisive production reproduction, in `phasec-automation-regressions-protocol-red.log` (exit 1). The working diff against HEAD showed that the former classifier call inside `completeTrackedInstance()` had been removed during the completion-path changes. The classifier still existed and terminal bookkeeping still recognized `provider_limit:` errors, but nothing on the new settled-success path classified final output.

The production fix calls `completedAutomationTurnError()` from `finishCompletedTurn()` only after elapsed/token checks, the current-request receipt and descendant settlement checks (`src/main/automations/automation-runner.ts:691`). The helper lives with output reconciliation (`src/main/automations/automation-runner-reconcile.ts:9`) and applies the existing whole-final-output classifier, retaining the existing empty-result failure. A provider notice therefore records a non-retryable `provider_limit:` failure; real output mentioning another service's limits or real work after a mid-run notice still succeeds. Existing streak/no-disable/no-retry assertions all pass.

This placement preserves the strong settlement guarantee: no idle/output/exit shortcut, no timeout standing in for usage settlement, and no success or delivery before late caches are included. The real `InstanceCommunicationManager` integration cases also passed for late cache-only over-cap usage after idle, clean exit and creation-time reconciliation, old-request settlement, removed children and failed stop retries (`automation-settlement.integration.spec.ts:104`, `:136`, `:155`, `:178`). That other agent's file was only read/run, never edited.

The runner remains 799 lines, its existing allowed maximum. The helper was added to the existing small reconciliation module; no ceiling, suppression, configuration or dependency was changed.

### 2. Spend-attribution input was not a valid persisted run snapshot

The original test used an unknown cast around a partial `AutomationRun` whose `configSnapshot` omitted `schedule`. Dispatch now arms `AutomationDispatchDeadline`, which uses the action and schedule to select run/token limits. `withRunLimits()` correctly reads the required `schedule.type`; the invalid test object threw before instance creation.

This is not evidence of a production snapshot migration gap: `AutomationConfigSnapshot.schedule` is required, `toSnapshot()` copies it from the automation (`src/main/automations/automation-store-mappers.ts:28`), and retry insertion preserves the original snapshot's schedule. No optional schedule or silent default was added to production.

The test input is now a complete, directly typed `AutomationRun` (`src/main/automations/automation-spend-attribution.spec.ts:33`) with a one-time schedule and all required fields. Its narrow manager/store fixtures now supply the lookup and usage-accounting operations exercised by the run limits, and teardown untracks its instance. This removes the invalid run cast rather than hiding missing fields. All four original attribution assertions are unchanged.

### 3. Wait-reason test assumed stop failure was swallowed

The existing production termination behavior is correct for automation: `InstanceManager.terminateInstance()` awaits lifecycle termination (`src/main/instance/instance-manager.ts:1194`), lifecycle awaits the coordinator (`src/main/instance/instance-lifecycle.ts:1931`), and the coordinator awaits `adapter.terminate()` without swallowing failure (`src/main/instance/lifecycle/instance-termination.ts:233`). Its `finally` clears the wait reason (`:141`), but adapter/instance deletion is reached only after successful termination. A failure must reject so `AutomationStopAttempts` retains ownership and retries rather than treating an unresolved runtime as stopped.

The original wait-reason test awaited that deliberately rejecting call without handling the rejection, so execution never reached its existing wait-reason assertion. The test now asserts rejection with `boom`, then runs the unchanged wait-reason assertion and additionally verifies that the adapter and instance remain registered and that no archive/removal was emitted (`src/main/instance/lifecycle/__tests__/instance-termination.spec.ts:177`). No production termination behavior was changed. The separate existing lifecycle failure/retry test and broader automation failed-stop tests passed as well.

## Exact edit ownership

Only these five source/test files were edited by this task:

1. `src/main/automations/automation-runner.ts`: import/call the final-output error helper after existing settlement checks.
2. `src/main/automations/automation-runner-reconcile.ts`: add the final-output/empty-result error helper. This file was already untracked on entry and must remain part of the parent's existing work.
3. `src/main/automations/automation-run-provider-limit.spec.ts`: live root fixture/current completion marker, added pre-settlement running assertion, isolated output directory and cleanup.
4. `src/main/automations/automation-spend-attribution.spec.ts`: valid typed run input, narrow fixture operations, subscription/timer cleanup.
5. `src/main/instance/lifecycle/__tests__/instance-termination.spec.ts`: explicitly observe the required stop rejection, then preserve cleanup and verify ownership.

Scratch-only additions: this report, command/log runner, command ledger, verification logs/JSON and assertion audit. No parent documents or any of the eight excluded fixture files were edited. Existing unknown casts elsewhere in these files were left as they were; no new unknown-cast escape, suppression, skipped test, weakened assertion or compatibility shim was introduced.

## Commands and evidence

Every command used the `rtk` route, raw output through `rtk proxy`, with `/Users/suas/.nvm/versions/node/v24.22.1/bin` first in PATH. No dependencies were installed; existing dependencies were reused.

Reproducible verification commands, environment, output-log paths and exit codes are recorded in `_scratch/phasec-automation-regressions-commands.jsonl`. `_scratch/phasec-automation-regressions-run.py` records each invocation; subsequent test runs use `AIO_TEST_SUMMARY=0`, `AIO_TEST_NO_CACHE=1`, and a unique explicit `AIO_TEST_OUT_SUFFIX`. The original run used the quiet runner's unique PID output suffix (`pid-4368`); its outer log and exit code are also recorded in the ledger.

| Run | Result | Outer log |
| --- | --- | --- |
| Original three-file focused run | Exit 1; 7 failed of 23 | `phasec-automation-regressions-original.log` |
| Protocol/input correction, before runtime fix | Exit 1; 3 provider-limit failures of 23, now incorrectly succeeded | `phasec-automation-regressions-protocol-red.log` |
| Same focused group, runtime fixed | Exit 0; 23 passed | `phasec-automation-regressions-focused-green.log` |
| Broader scheduled/stop/settlement group | Exit 0; 19 files, 231 passed | `phasec-automation-regressions-broader-runtime.log` |
| `npx tsc --noEmit` | Exit 0 | `phasec-automation-regressions-typecheck.log` |
| `npm run typecheck:spec` | Exit 0; existing project script/heap setting unchanged | `phasec-automation-regressions-spec-typecheck.log` |
| `npm run lint` | Exit 0 | `phasec-automation-regressions-lint.log` |
| `npm run check:ts-max-loc` | Exit 0; no limit changes | `phasec-automation-regressions-loc.log` |
| `npm run check:ui-hints` | Exit 0; unrelated new-wording advisory remains for parent | `phasec-automation-regressions-ui-hints.log` |
| `npm run build:main` | Exit 0 | `phasec-automation-regressions-build-main.log` |
| `npm run build:renderer` | Exit 0; initial bundle budget warning (1.64 MB versus 1 MB) | `phasec-automation-regressions-build-renderer.log` |
| `git diff --check` | Exit 0 | `phasec-automation-regressions-diff-check.log` |

All log names in the table are under `_scratch/`. The quiet runner also retained full per-test logs and JSON at `_scratch/test-run.phasec-automation-regressions-<label>.log` and `_scratch/test-results.phasec-automation-regressions-<label>.json` for the protocol-red, focused-green and broader-runtime runs. The original full focused log is `_scratch/test-run.pid-4368.log`.

The broader command's exact 19-file list is in the ledger and log header. It covers runner success/failure, PhaseC policy, processed-token contract, dispatch deadlines, pause/startup, retry integration/admission, loop runs/authority/production, both termination suites, title cleanup and actual instance communication settlement. It does not run the repository's full suite.

Assertion preservation was independently checked against HEAD for all three edited test files: 27, 4 and 40 original `expect` lines respectively, with none missing or changed. The result is `_scratch/phasec-automation-regressions-assertion-audit.json`; manual diff inspection additionally confirmed the original multiline expectation arguments and statuses remain unchanged.

Investigation used raw `cat`/Python reads for the supplied errors, complete edited files, completion receipts, reconciliation, run limits, run policy/deadlines, snapshot/retry mapping, classifier, deferred usage, cost attribution, descendant settlement and stop attempts; focused `rg` traced the executing communication and lifecycle call sites. One preliminary shell glob for a nonexistent `scripts/ts-max-loc*` filename exited 1; the actual `scripts/check-ts-max-loc.ts` was then read and its gate passed. This was an inspection typo, not a product failure.

## Remaining integration limits and cleanup

All owned test/check/build subprocesses exited and their output was collected; no server, dev app, shared database or browser was started and no process was killed. Per-test scratch output directories added here are removed in teardown; diagnostic logs and the named report are intentionally retained. The normal builds generated ignored compiled outputs only.

The supplied checkout was already extensively dirty. This report distinguishes these five edits from the parent's existing changes; no attempt was made to reset, stage, integrate or clean up anyone else's work. Successful checks describe the current shared checkout at the recorded run time, not a frozen final integrated snapshot. Parent must run the final full suite after all writers stop, address its separate Copilot/import-isolation/wording work, and perform any independently required review outside this no-subagent task.

Requested named report is written; no further edits or background work are planned.
