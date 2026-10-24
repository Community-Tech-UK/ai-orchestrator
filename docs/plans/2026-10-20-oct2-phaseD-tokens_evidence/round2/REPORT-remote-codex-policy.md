# Remote Codex policy bridge and remote trial-policy logging

Checkout: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-20-oct2-phased-tokens-0e371d`.

Status: requested source implemented and focused verification passed. Combined project gates and independent verification remain with main. No completion gate, plan edit/rename, commit, stash, branch/worktree operation, installation, browser/GUI operation, copied checkout/dependencies, or paid provider probe was performed. Continued the supplied partial bridge without resetting it. Other helpers' source remains in place.

## Acceptance checklist

- [x] Controller-selected public Codex policy reaches `RemoteCliAdapter` -> JSON RPC spawn schema -> `LocalInstanceManager` -> actual factory -> actual Codex thread policy and turn-ceiling controller.
- [x] Strict versioned snapshot: `codexSpawnPolicy.version: 1`, session kind, trial key/arm, queue role, and exactly eight public settings (chat/harness helper settings, context tuning, checker skills setting, four ceiling thresholds). Unknown fields/versions and invalid bounds are rejected; settings/profile paths and credentials are not serialized into the snapshot.
- [x] Capability fence: workers must advertise the exact numeric `codexSpawnPolicy: 1`. Missing, malformed and unsupported versions fail with an update-worker error before creating a transport; spawn checks again after worker re-registration. No automatic local fallback.
- [x] Snapshot wins over settings reads in both Codex policy and ceiling decisions. The wire fixture makes the worker settings getter throw and verifies it is never called. Account-pool discovery is isolated as inactive in that fixture; native provider/network calls are mocked.
- [x] Actual adapter behavior: machine kinds (`plan-queue`, `loop`, `automation`, `review`) wrap at 150M and stop at 300M by default; chat/ordinary child never stop by default. Custom stop, explicit chat stop, and zero thresholds are respected. Ultra is clamped to max for machine work, preserved for chats/children; non-chat skills cap and checker omission remain applied.
- [x] Remote start/resume/reopen policy records reach the real main-process session-policy writer via the existing `instance.telemetry` route. No RPC channel or lifecycle was added.
- [x] Strict bounded `session_thread_policy` payload: policy metadata, bounded identifiers/arms/numbers, eight allowlisted override KEY NAMES only; no arbitrary config values or prompt text. Rejected overrides record `applied:false`, `configKeys:[]`, `catalog:'native'`. Checker arm is retained.
- [x] Arm key is sent raw as public cohort identity and hashed exactly once by the existing main sink. Actual writer tests compare the stored SHA-256 value. The log row shape and report reader remain backward compatible; the report-reader regression tests pass unchanged.
- [x] Listener timing and cleanup: initial policy arrives during spawn before acknowledgement; worker observation already precedes `adapter.spawn()`. Hibernate/wake retains the snapshot and logs resume. Terminate, resident exit and failed spawn remove policy telemetry listeners. Durable replay does not duplicate rows. Publisher/writer/observer failures do not fail start/resume.
- [x] Main's fifth `usageAccounting.observe` argument, type-only `PromptSurface` import in RLM, closure guard and guidance helper's Claude/A18/RTK changes preserved.
- [ ] Combined canonical gates and independent verifier: intentionally left to main, as requested. Current typechecks are not green (details below).

## Implementation paths

Completed/retained the partially written bridge:

- `src/main/cli/adapters/remote-codex-spawn-policy.ts`: public controller snapshot, default normalization, lazy controller settings lookup, version/capability fence.
- `src/main/remote-node/codex-spawn-policy-schema.ts`: strict snapshot and settings schemas; added explicit wire version.
- `src/main/remote-node/remote-spawn-policy-schemas.ts`, `src/main/cli/adapters/remote-spawn-policy.ts`: extracted combined Claude/Codex shapes/builders. Preserve the current Claude schema and trial-policy fields owned by the guidance helper.
- `src/shared/types/codex-policy-settings.types.ts`, `adapter-factory.types.ts`, `codex-adapter-config.ts`: narrow typed settings snapshot.
- `adapter-factory.ts`, `remote-cli-adapter.ts`, `rpc-schemas.ts`, `worker-node.types.ts`, `worker-agent/capability-reporter.ts`, `worker-agent/local-instance-manager.ts`, `worker-agent/worker-spawn-policy.ts`: existing partial bridge plumbing retained and verified.
- `codex/codex-thread-policy.ts` and `codex-app-server-notification-adapter.ts`: existing partial snapshot preferences retained and verified, with guidance and ceiling behavior preserved.

Added logging transport:

- `codex/codex-thread-requests.ts`: optional metadata publisher on start/resume; preserves actual-applied/catalog logic and isolates publisher failure. Direct callers still use the existing writer.
- `codex/app-server-initializer.ts`: publisher forwarded through all start/resume paths (specific cursor, thread list, rollout scan, fresh fallback).
- `codex-app-server-adapter.ts`: initialization and reopen publish through `publishSessionThreadPolicy`.
- `codex/codex-session-telemetry.ts`: thread-policy publisher alongside shares/credits.
- `remote-node/instance-telemetry-rpc.ts`: strict bounded payload on the existing telemetry union.
- `worker-agent/worker-instance-telemetry.ts`: schema-validated policy observation and paired listener removal.
- `remote-session-telemetry.ts`: main-side handoff to the existing `recordSessionPolicy`; existing writer hashes the key and keeps the legacy row format. No edit to the writer or report-reader implementation was needed.

New tests:

- `src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts` (16 tests): actual remote adapter, JSON/schema boundary, actual worker manager/factory and Codex initialization/controller, worker observer/notifier, actual coordinator router, real file writer; only native app-server/network and unrelated pool discovery are synthetic. Temporary main-log override is enabled only during fake socket delivery, so worker-side direct writes remain no-ops.
- `src/main/cli/adapters/__tests__/remote-codex-spawn-policy.spec.ts` (10 tests): real controller factory/fence, normalization, explicit snapshot preference, strict schema and provider mismatch.
- `src/main/cli/adapters/codex/codex-thread-policy-telemetry.spec.ts` (3 tests): fail-soft publisher, schema rejection, observer cleanup.

Existing fixture updates only (assertions retained): `remote-instance-telemetry.spec.ts`, `remote-codex-exec-turn.integration.spec.ts`, `worker-rpc-dispatcher.account-route.spec.ts`, and `account-failover-coordinator.worker.spec.ts` now describe a capable Codex worker and provide an explicit public settings snapshot where the settings store is outside their subject. The old untracked `adapter-factory-codex-remote-gap.repro.spec.ts` was replaced by the maintained policy spec; its two cases are covered there.

## Local loop/review classification trace

No expansion was needed. `attachProviderRoutes` in `src/main/instance/lifecycle/provider-route-preflight.ts` already stamps `machineSessionReasonForOrigin(origin)` and `sessionKindOf(reason)` before routing. `createPersistentLoopAdapter` in `default-loop-invoker-helpers.ts` passes origin `loop`; fresh loop invocations in `default-invokers.ts` go through that same route preflight. `cross-model-review-service.ts` passes origin `review`; headless reviews dispatch through the existing host. Instance sessions use `applyInstanceSpawnPolicy`, including queue role and trial identity. These existing stamps now survive remote Codex transport. No edits to those routing modules were made in this continuation.

## Verification receipts

All commands ran in the supplied checkout, prefixed with `rtk`. Redirections captured output and preserved the command's real exit code; no checks were piped through `head`. Quiet-runner raw receipts are also named below. No full suite was run.

Exact final focused regression command (exit **0**, **16 files / 195 tests**):

```sh
rtk npm run test:quiet -- src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts src/main/cli/adapters/__tests__/remote-codex-spawn-policy.spec.ts src/main/cli/adapters/codex/codex-thread-policy-telemetry.spec.ts src/main/cli/adapters/codex/codex-thread-requests.spec.ts src/main/cli/adapters/codex/codex-turn-token-ceiling.adapter.spec.ts src/main/cli/adapters/codex/codex-thread-policy.spec.ts src/main/cli/adapters/codex/codex-session-telemetry.spec.ts src/main/cli/adapters/codex/app-server-initializer.usage.spec.ts src/main/cli/adapters/remote-cli-adapter.spec.ts src/worker-agent/__tests__/remote-instance-telemetry.spec.ts src/worker-agent/remote-codex-exec-turn.integration.spec.ts src/worker-agent/local-instance-manager.spawn-policy.spec.ts src/worker-agent/worker-rpc-dispatcher.account-route.spec.ts src/main/providers/account-pool/account-failover-coordinator.worker.spec.ts src/main/instance/__tests__/context-worker-import-isolation.spec.ts scripts/__tests__/codex-helper-trial-report.spec.ts > _scratch/oct2-phaseD-round2/remote-codex-regression-final.log 2>&1
```

Raw receipt: `_scratch/test-run.pid-68410.log`. Includes worker closure guard and unchanged backward-compatible report-reader tests.

After the final lint-only test-loop change, exact shared-boundary verification (exit **0**, **3 files / 23 tests**):

```sh
rtk npm run test:quiet -- src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts src/main/remote-node/worker-node-claude-spawn-policy.spec.ts src/main/cli/adapters/__tests__/adapter-factory-claude-compaction.spec.ts > _scratch/oct2-phaseD-round2/remote-codex-shared-boundary-final.log 2>&1
```

Raw receipt: `_scratch/test-run.pid-3998.log`.

Exact lint command (exit **0**, four warnings in pre-existing lines: two prefer-const warnings in the exec integration fixture and two regex escapes in existing subagent schema fields; no new lint warning):

```sh
rtk proxy node_modules/.bin/oxlint --config .oxlintrc.json src/main/cli/adapters/remote-codex-spawn-policy.ts src/main/cli/adapters/remote-spawn-policy.ts src/main/cli/adapters/remote-session-telemetry.ts src/main/cli/adapters/codex-adapter-config.ts src/main/cli/adapters/codex-app-server-adapter.ts src/main/cli/adapters/codex/codex-session-telemetry.ts src/main/cli/adapters/codex/codex-thread-requests.ts src/main/cli/adapters/codex/app-server-initializer.ts src/main/cli/adapters/codex/codex-thread-policy.ts src/main/remote-node/codex-spawn-policy-schema.ts src/main/remote-node/remote-spawn-policy-schemas.ts src/main/remote-node/instance-telemetry-rpc.ts src/shared/types/codex-policy-settings.types.ts src/worker-agent/worker-spawn-policy.ts src/worker-agent/worker-instance-telemetry.ts src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts src/main/cli/adapters/__tests__/remote-codex-spawn-policy.spec.ts src/main/cli/adapters/codex/codex-thread-policy-telemetry.spec.ts src/worker-agent/__tests__/remote-instance-telemetry.spec.ts src/worker-agent/remote-codex-exec-turn.integration.spec.ts src/worker-agent/worker-rpc-dispatcher.account-route.spec.ts src/main/providers/account-pool/account-failover-coordinator.worker.spec.ts > _scratch/oct2-phaseD-round2/remote-codex-lint-final.log 2>&1
```

Other exact checks:

| Command | Actual exit/result | Receipt |
| --- | --- | --- |
| `rtk npm run check:ts-max-loc > _scratch/oct2-phaseD-round2/remote-codex-loc.log 2>&1` | 0; ratchet passed; no ceiling changes. `rpc-schemas.ts` 758, remote adapter 686, dispatcher 700. | `remote-codex-loc.log` |
| `rtk git diff --check` | 0 | tool output |
| `rtk npm run typecheck:fast > _scratch/oct2-phaseD-round2/remote-codex-typecheck-fast.log 2>&1` | 1; installed tsgo rejects existing node10 resolution/baseUrl options. No config change made. | `remote-codex-typecheck-fast.log` |
| `rtk npx tsc --noEmit -p tsconfig.electron.json > _scratch/oct2-phaseD-round2/remote-codex-typecheck-electron.log 2>&1` | 2; RTK's compiler resolution rejected existing `ignoreDeprecations:6.0`. | `remote-codex-typecheck-electron.log` |
| `rtk npx tsc --noEmit -p tsconfig.electron.json --ignoreDeprecations 5.0 > _scratch/oct2-phaseD-round2/remote-codex-typecheck-electron-compat.log 2>&1` | 2; eight errors, all in guidance-owned `claude-trial-state.ts`. | `remote-codex-typecheck-electron-compat.log` |
| `rtk proxy node node_modules/typescript/bin/tsc --noEmit -p tsconfig.electron.json > _scratch/oct2-phaseD-round2/remote-codex-typecheck-electron-local.log 2>&1` | 2; local TypeScript 6.0.3 accepts config; eight errors, all in guidance-owned `claude-trial-state.ts`. | `remote-codex-typecheck-electron-local.log` |
| `rtk npm run typecheck:spec > _scratch/oct2-phaseD-round2/remote-codex-typecheck-spec-latest.log 2>&1` | 2; eleven errors, all in guidance-owned `claude-trial-state.ts` and `__tests__/claude-trial-lifetime.integration.spec.ts`; none in this work's files. Earlier new wire-fixture type errors were corrected. | `remote-codex-typecheck-spec-latest.log` |

The helper-owned Claude files were changing during checks. They were not edited here. Main should rerun combined types after that helper finishes; do not treat these receipts as a green global typecheck.

Investigation/intermediate test receipts (command arguments are retained verbatim in each log):

| Receipt under `_scratch/oct2-phaseD-round2/` | Exit/result |
| --- | --- |
| `remote-codex-red.log` (`rtk npm run test:quiet -- src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts`) | 1; 10/11 failed. Crucial red assertion: successful initialization produced zero main policy rows. The other failures included fixture completion behavior, subsequently corrected. Raw `_scratch/test-run.pid-17876.log`. |
| `remote-codex-wire-first.log` (same command after telemetry wiring) | 1; 9/11 failed, fixture interrupt-completion and unrelated pool settings read. Logging assertions reached the writer. Raw `_scratch/test-run.pid-26411.log`. |
| `remote-codex-wire-second.log` (same command after fixture correction) | 0; 11 tests passed. Raw `_scratch/test-run.pid-28994.log`. |
| `remote-codex-focused.log` (new three specs) | 0; 28 tests passed at that revision. Raw `_scratch/test-run.pid-69109.log`. |
| `remote-codex-regression.log` (same 16-file command as final above) | 1; 2/194 failed because two existing fixtures lacked the new worker capability. Raw `_scratch/test-run.pid-6544.log`. |
| `remote-codex-account-fixtures.log` (`rtk npm run test:quiet -- src/worker-agent/worker-rpc-dispatcher.account-route.spec.ts src/main/providers/account-pool/account-failover-coordinator.worker.spec.ts`) | 0; 55 tests passed after fixture updates. Raw `_scratch/test-run.pid-56257.log`. |
| `remote-codex-typecheck-spec.log`, `remote-codex-typecheck-spec-final.log` | Both exit 2; intermediate diagnostics, superseded by latest receipt. |
| `remote-codex-lint.log` | Exit 0; three warnings at that revision, own test spread warning subsequently removed. |

## Upgrade and runtime limits

Update/rebuild the execution worker before using remote Codex with the updated controller. The worker must advertise `codexSpawnPolicy:1` and accept snapshot version 1 plus thread-policy telemetry. Older/malformed capability advertisements are deliberately refused with a clear update-worker message. No real Windows worker was contacted or upgraded in this task.

The existing command-mode limitation remains: `codex exec` has no live token feed, so its per-turn ceiling cannot interrupt mid-turn; the existing notice is preserved. Tests exercise the real app-server adapter/controller with synthetic notifications, not a paid 300M-token run. Source/focused evidence does not claim a deployed-worker live check.

## Source status and cleanup

All implementation and tests remain uncommitted in the supplied checkout. New snapshot/schema/helper/spec files are untracked (`??`); shared tracked files contain preserved changes from the other Phase D helpers. No root plan/spec was edited or copied, and no final completion gate or plan rename was performed.

Disposable receipts: `_scratch/oct2-phaseD-round2/remote-codex-*.log`, plus the raw `_scratch/test-run.pid-*.log` and associated quiet-runner JSON receipts listed above. Keep this report for main's handoff.

Wire tests create `_scratch/oct2-phaseD-round2/remote-codex-log-*` directories and remove them in teardown. A final filesystem check found **zero** remaining directories with that prefix. Managers terminate all fixtures, remotes force-clean listeners, notifier buffers flush, routers stop/dispose their timers, and injected settings readers are reset. No native provider process was started by the new wire tests. No agent-created branch/worktree/stash exists to clean up.
