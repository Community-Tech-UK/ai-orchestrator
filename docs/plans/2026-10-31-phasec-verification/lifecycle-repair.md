# F1 lifecycle repair handover

Status: F1 implemented and verified by focused runtime regressions. Parent full gates and independent review remain required. No whole-plan completion or independent PASS is claimed.

## Result and executing path

- Read the complete `_scratch/phasec-fresh-gate-report.md`, including F1, the known gate failures and the limits of its earlier verification. Read the LT-013 register entry and its existing regression before changing termination.
- Production route remains `InstanceManager.terminateInstance` (`src/main/instance/instance-manager.ts:1186`) -> `InstanceLifecycleManager.terminateInstance` (`src/main/instance/instance-lifecycle.ts:1926`) -> `InstanceTerminationCoordinator.terminateInstance`.
- `src/main/instance/lifecycle/instance-termination.ts:121` now marks the actual adapter as deliberately stopping before calling native termination. Listener removal is after successful termination (`:137`). A rejection still propagates, retains the adapter and instance, and does not archive, publish removal or claim successful shutdown.
- `src/main/providers/adapter-stop-state.ts` is a small process-local WeakSet of runtime identities. It is independent of the transient terminating wait reason, instance IDs, and status events. A refused stop keeps its fence. A replacement does not inherit it. An explicitly reused remote adapter clears the fence only once the preceding remote runtime is gone.
- `src/main/instance/instance-communication.ts:1268` retains output publication and real provider-session adoption during stopping, bypassing recovery/compaction/orchestration/tool hooks. Status and context remain observed; startup recovery and context-warning sends do not run for the stopping runtime. Usage and complete retain the existing production accounting and deferred-settlement path. Completion is published only after usage settlement and does not rearm provider-limit/auth replay or completion hooks (`:1820`).
- `src/main/instance/instance-adapter-error-handler.ts:59` publishes stopping errors to normalized provider events and the transcript, increments the error count and queues the current state. It does not recover, park, replay, change the instance to an error-cleanup owner, or silently delete the runtime. The existing duplicate-error publication logic moved into this module; its sole production caller was updated, with no compatibility property left behind.
- `src/main/instance/instance-communication.ts:2019` observes deliberate exits and clears process/interrupt/background-work tracking without entering unexpected-exit, interrupted-exit or deferred recovery. The existing recent-exit timer also checks the adapter fence before invoking recovery (`:2197`). Already scheduled force cleanup refuses to delete a deliberately stopping adapter (`:2511`).
- The provider factory also installs a direct quota callback, outside communication: `ProviderRuntimeService.createAdapter` -> `attachUsageOverageStopGuard`. `src/main/instance/instance-usage-overage-wiring.ts:83` fences that callback so late quota telemetry cannot interrupt the retained runtime and rearm account switch/resume. Passive quota/accounting telemetry remains attached.
- The real remote adapter had its own independent observation loss: `RemoteCliAdapter.terminate` detached worker-registry listeners and cleared provider/interaction identity before its stop RPC. `src/main/cli/adapters/remote-cli-adapter.ts:487` now keeps those listeners and identities until confirmed stop/exit, and uses the same fence to reject further spawn/input/permission dispatch while the preceding runtime is stopping. Normal remote completion forwarding handles final usage; the redundant special finalization-only listener was removed. Existing explicit reuse after confirmed shutdown and the rule against context recycling during stopping are preserved.

No automation tool, monitor, runner, queue receipt, spend, renderer path-display or plan/document source was edited by this repair. The existing output, normalized completion and cost-attribution interfaces remain unchanged, so no automation caller change is needed for F1.

## Owned source edits

1. `src/main/instance/lifecycle/instance-termination.ts`
2. `src/main/instance/instance-communication.ts`
3. `src/main/instance/instance-adapter-error-handler.ts`
4. `src/main/instance/instance-usage-overage-wiring.ts`
5. `src/main/cli/adapters/remote-cli-adapter.ts`
6. `src/main/providers/adapter-stop-state.ts` (new)
7. `src/main/instance/lifecycle/instance-termination.spec.ts`
8. `src/main/instance/lifecycle/instance-termination-observation.integration.spec.ts` (new)

Several of those files already contained parent changes at entry. Edits were applied to the supplied working tree in place; its earlier changes were preserved. Git diffs against HEAD include those earlier changes and must not be attributed entirely to this repair. The other termination suite, settled-usage helper/tests and remote Copilot tests were exercised but not edited.

The LT-013 test fixture now uses the real communication listener rather than an arbitrary subscriber that always mutates the session. Its archive/session assertions remain intact. This fixture update happened after the new real integration regression was green. No existing assertion was deleted, skipped or weakened. The remote Copilot tests that exposed lifecycle compatibility problems were left intact and made green by the implementation.

## Runtime regression evidence

The new integration suite executes the real termination coordinator, communication manager, state machine, provider ingress/turn-ending enrichment, event bus, cost tracker, attribution bus, deferred response usage and remote settlement protocol. Host settings/disk continuity/storage, executable plugin hooks, logging and remote transport/registry infrastructure are isolated. No live provider or worker is contacted.

Covered observable behavior:

- Refused stop -> retained adapter/instance -> later error safely published -> later assistant output -> delayed input/output/cache-read/cache-write/cost settlement booked once -> normalized completion -> successful retry and archive using the real provider-session anchor.
- SIGTERM exit during a deliberate stop, with and without an outstanding interrupt, is observed without respawn or session-anchor mutation.
- Exit after a refused stop retains the owner/runtime and does not schedule recent-exit recovery.
- Context-overflow and corrupt-session output after refusal remains visible without recovery or silent cleanup.
- Provider-limit completion and startup/MCP events do not restart deliberately stopped work.
- Direct late provider quota telemetry does not rearm account failover/resume.
- A recent-exit retry queued before the deliberate stop is fenced when its timer fires after refusal.
- Retry termination can itself finalize deferred usage without deadlocking accounting and completion.
- The real RemoteCliAdapter receives later worker output and pending/final usage through registry forwarding after rejection; the same remote identity receives the retry stop. Input, pending permission response and spawn are refused during the retained stop.
- Normal unexpected-exit recovery still runs when there was no deliberate stop.

## Commands, exits and logs

All verification shell entry points used `rtk proxy`, with Node 24.22.1 first in PATH. All tests used `AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1` and a unique output suffix. Test raw logs and JSON results remain in `_scratch/` under the runner's corresponding `test-run.<suffix>.log` / `test-results.<suffix>.json` names. No failure summary was sent to a model endpoint.

Common exact test command form:

```sh
rtk proxy env PATH=/Users/suas/.nvm/versions/node/v24.22.1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1 AIO_TEST_OUT_SUFFIX=<suffix> npm run test:quiet -- <selected files>
```

| Suffix | Selected files | Exit | Evidence |
|---|---|---:|---|
| `phasec-lifecycle-baseline-20261031a` | termination suite, nested termination suite, settled-usage suite | 0 | 3 files / 37 passed |
| `phasec-lifecycle-red-20261031b` | new integration suite | 1 | 7 of 8 failed: unhandled later error and absent output/exit/completion; normal recovery passed |
| `phasec-lifecycle-green-20261031c` | new integration suite | 0 | 8 passed before updating the LT-013 fixture |
| `phasec-lifecycle-telemetry-red-20261031d` | new integration suite | 1 | 1 of 9 failed: direct quota callback interrupted/rearmed stopping work |
| `phasec-lifecycle-backoff-red-20261031e` | new integration + termination | 1 | 1 of 26 failed: already queued recent-exit timer respawned deliberately stopped work |
| `phasec-lifecycle-green-20261031f` | new integration + termination + quota wiring | 0 | 3 files / 35 passed |
| `phasec-lifecycle-remote-red-20261031g` | new integration + remote adapter suite | 1 | 1 of 21 failed: real remote registry output disappeared after refusal |
| `phasec-lifecycle-remote-green-20261031h` | new integration + remote adapter + settled usage | 0 | 3 files / 28 passed |
| `phasec-lifecycle-focused-20261031j` | final selection below | 1 | 3 of 314 failed: stopped Copilot evidence/reuse contract; fixed in runtime, no fixture changes |
| `phasec-lifecycle-remote-reuse-green-20261031l` | new integration + both remote adapter suites + remote Copilot usage | 0 | 4 files / 58 passed |
| `phasec-lifecycle-focused-final-20261031m` | final selection below | 0 | 16 files / 314 passed, no failed or pending tests |

Final focused command, exit 0:

```sh
rtk proxy env PATH=/Users/suas/.nvm/versions/node/v24.22.1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin AIO_TEST_SUMMARY=0 AIO_TEST_NO_CACHE=1 AIO_TEST_OUT_SUFFIX=phasec-lifecycle-focused-final-20261031m npm run test:quiet -- \
  src/main/instance/instance-communication.spec.ts \
  src/main/instance/instance-source-diagnostics.spec.ts \
  src/main/instance/instance-input-failure-recovery.spec.ts \
  src/main/instance/instance-communication.status-recovery.spec.ts \
  src/main/instance/instance-communication.background-stop.spec.ts \
  src/main/instance/instance-communication.settled-usage.spec.ts \
  src/main/instance/instance-communication-provider-events.spec.ts \
  src/main/instance/instance-communication.mcp-startup.spec.ts \
  src/main/instance/instance-usage-overage-wiring.spec.ts \
  src/main/instance/lifecycle/instance-termination.spec.ts \
  src/main/instance/lifecycle/__tests__/instance-termination.spec.ts \
  src/main/instance/lifecycle/instance-termination-title.spec.ts \
  src/main/instance/lifecycle/instance-termination-observation.integration.spec.ts \
  src/main/cli/adapters/remote-cli-adapter.spec.ts \
  src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts \
  src/main/cli/adapters/remote-cli-adapter.copilot-usage.spec.ts
```

Other commands used the same `rtk proxy env PATH=...` prefix; compiler/lint output was redirected to the named local log, then the command's exit status was returned unchanged.

| Command | Exit | Log / result |
|---|---:|---|
| `npm run typecheck:spec` | 0 | `_scratch/phasec-lifecycle-typecheck-20261031i.log` |
| `npx eslint` over all eight owned source paths, first pass | 1 | `_scratch/phasec-lifecycle-eslint-20261031i.log`; empty test callback bodies and the touched quota adapter type/interface convention were corrected without suppressions |
| `npx eslint` over all eight owned source paths, next pass | 0 | `_scratch/phasec-lifecycle-eslint-20261031k.log` |
| `npx eslint` over all eight owned source paths, final pass | 0 | `_scratch/phasec-lifecycle-eslint-final-20261031m.log` |
| `npm run typecheck:fast` | 1 | `_scratch/phasec-lifecycle-typecheck-fast-20261031m.log`; installed native compiler rejects existing `moduleResolution=node10` and `baseUrl` options. No configuration or dependency change made. |
| `npx tsc --noEmit -p tsconfig.electron.json` | 0 | `_scratch/phasec-lifecycle-typecheck-main-20261031n.log`; regular compiler replacement for the incompatible fast checker |
| `git diff --check` | 0 | No whitespace errors; read-only command, no index/HEAD change |

## Limits and parent boundary

- No full suite, production build, full-project lint or duplicate broad build was run. The parent owns those once all writers stop. The focused results do not certify the whole shared diff.
- The spec typecheck passed before the final remote reuse guard adjustment; final main-process typecheck is separately recorded above. The parent still owns the final canonical complete verification run.
- No live native-provider process, live worker RPC, installed Electron restart, browser or Mac UI was used. The integration substitutes only the provider-process/worker transport and host infrastructure; actual operating-system process disappearance is not claimed.
- No extra agent was started. The parent/read-only reviewer must perform independent acceptance. No independent gate PASS is claimed here.
- No commits, staging, branches, worktrees, checkout copies, merge, dependency/configuration/ceiling/suppression changes, completion rename, personal database/settings access, credentials, external sends or deployment were performed.
- No persistent provider session or test promise is left running. Integration teardown releases deferred settlement, provider-bus context timers, subscriptions, remote listeners, turn-supervisor state and fake timers. Every owned test/compiler/lint shell session returned an exit code; none remains running. No live provider/worker child was started.

Checklist: F1 reproduction and implementation complete; local/remote runtime and LT-013 regression coverage green; focused checks, main compiler and spec compiler green; file-scoped lint green; parent full gates and independent review outstanding by instruction. The optional fast-checker configuration incompatibility is recorded above and was not changed.
