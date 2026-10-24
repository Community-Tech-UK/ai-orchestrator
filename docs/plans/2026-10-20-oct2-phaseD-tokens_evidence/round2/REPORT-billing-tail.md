# Phase D: graceful remote Codex billing tail

Scope: one shutdown integration finding, implemented in the exact supplied AIO worktree. Implementer verification only; no independent completion-gate verdict is claimed. Main/coordinator retains final canonical gates, documentation lifecycle, sealing and cleanup.

## Finding and implementation

The worker removed its runtime/telemetry observers before awaiting native termination. Codex flushes its last pending turn-share correction and reads root-thread credits inside termination, so neither record reached the controller. The controller also removed its telemetry listener before the RPC, independently losing any forwarded final records.

Changed source:

- `src/worker-agent/local-instance-manager.ts`: delegates established-instance termination to the narrow helper; removes instance/resume/lease bookkeeping in `finally`, including rejection.
- `src/worker-agent/worker-instance-termination.ts`: immediately removes the existing runtime/proof observers and makes the residual heartbeat/stream-idle callbacks inert. Retains only Codex share/credit listeners on the captured adapter. Concurrent termination shares one promise. Native exit/error and the termination promise's `finally` close the tail.
- `src/main/remote-node/codex-billing-tail.ts`: uses the existing strict notifier telemetry schemas; accepts only `session_turn_share` and `session_thread_credits`, deduplicates receipt identities, bounds retained keys, and makes publication fail-soft. Closing invalidates callbacks already captured by an emitter.
- `src/main/cli/adapters/remote-termination-tail.ts`: preserves the existing pending COMPLETE finalization path and adds only the Codex billing receiver, scoped to target node, captured worker instance and captured controller owner. Writes through the existing real session-policy writer without emitting another adapter billing event.
- `src/main/cli/adapters/remote-cli-adapter.ts`: attaches the scoped tail through the awaited RPC, retains immediate normal lifecycle teardown, prevents respawn during termination, and closes its own tail in `finally`. Existing forceCleanup/remote-exit cleanup also closes it. A stale RPC's finally cannot clear a replacement owner's cleanup or settle its bills.
- `src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts`: expands the existing fixture and routes JSON-roundtripped commands through the real WorkerRpcDispatcher, real LocalInstanceManager/factory, real Codex initialization/turn/termination, worker observer/notifier/durable router, and real main writer.

The final wire fixture verifies the initial share at 100 tokens, shutdown correction revision 1 at 150 tokens, one native `account/usage/read` for `native-thread` with a 2500 ms deadline, and exactly one final credit row. The controller row keeps `controller-instance`, root thread/turn identity and a once-hashed trial key. It checks duplicate native/live/replayed receipts, concurrent worker termination, rejection cleanup, forceCleanup, resident exit/error, throwing publication, excluded policy/init/system-prompt telemetry, foreign node/instance rejection, captured owner despite later option mutation, and no late output/state/heartbeat resurrection.

The A18 handoff flag was observed before any writes. A18 observer/schema source was reread and retained; no trial-init proof is accepted by the termination tail. Native notification-adapter credit parser/ledger and forced termination behavior were not changed. The native forced-termination regression verifies share flush with no credit read. Existing remote graceful-argument wire semantics were not expanded by this task.

## Commands and actual results

All commands ran from:

`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-20-oct2-phased-tokens-0e371d`

Logs below are complete stdout/stderr files, with the actual command exit observed from the execution tool. No head/tail pipeline was used.

1. Baseline reproduction, before either production fix:

```sh
rtk proxy env AIO_TEST_MAX_FORKS=1 npx vitest run --project main src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts -t 'drains the last share' --reporter=verbose > _scratch/oct2-phaseD-round2/billing-tail-red.log 2>&1
```

Exit **1**: one regression failed. Native observers saw both final records, but the real main log had only revision 0 / 100 tokens and zero credit rows. At this stage the existing fixture dispatched parsed RPC arguments directly to the real manager; the final fixture below additionally uses the real worker dispatcher.

2. Worker fix alone, same regression:

```sh
rtk proxy env AIO_TEST_MAX_FORKS=1 npx vitest run --project main src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts -t 'drains the last share' --reporter=verbose > _scratch/oct2-phaseD-round2/billing-tail-worker-only-red.log 2>&1
```

Exit **1**: the same missing main share correction and credit row. This demonstrates the coordinator receiver also needs the fix.

3. Both production fixes:

```sh
rtk proxy env AIO_TEST_MAX_FORKS=1 npx vitest run --project main src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts -t 'drains the last share' --reporter=verbose > _scratch/oct2-phaseD-round2/billing-tail-green.log 2>&1
```

Exit **0**: 1 passed, 16 unrelated tests skipped by the name filter.

4. Expanded shutdown wire coverage:

```sh
rtk proxy env AIO_TEST_MAX_FORKS=1 npx vitest run --project main src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts --reporter=verbose > _scratch/oct2-phaseD-round2/billing-tail-wire.log 2>&1
```

Exit **0**: 24 passed.

5. Focused surrounding regressions:

```sh
rtk proxy env AIO_TEST_MAX_FORKS=1 npx vitest run --project main src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts src/worker-agent/__tests__/remote-instance-telemetry.spec.ts src/worker-agent/__tests__/local-instance-manager.spec.ts src/worker-agent/local-instance-manager.spawn-policy.spec.ts src/worker-agent/__tests__/remote-claude-trial-execution.spec.ts src/worker-agent/__tests__/remote-claude-failed-cost.spec.ts src/worker-agent/__tests__/remote-usage-settlement-protocol.spec.ts src/main/cli/adapters/remote-cli-adapter.spec.ts src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts src/main/cli/adapters/codex/codex-credit-reader.spec.ts src/main/cli/adapters/codex/codex-session-telemetry.spec.ts src/main/cli/adapters/codex/codex-turn-ceiling-controller.spec.ts src/main/instance/context-worker-import-isolation.spec.ts --reporter=verbose > _scratch/oct2-phaseD-round2/billing-tail-focused.log 2>&1
```

Exit **0**: 12 files, 163 tests passed. The last isolation path in that command was incorrect and selected no file; it was corrected and run explicitly in command 6. Existing A18 trial, worker exit/cancellation, legacy usage protocol and native paid finalization tests passed.

6. Final fixture with the real WorkerRpcDispatcher, plus the correct worker isolation guard:

```sh
rtk proxy env AIO_TEST_MAX_FORKS=1 npx vitest run --project main src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts src/main/instance/__tests__/context-worker-import-isolation.spec.ts --reporter=verbose > _scratch/oct2-phaseD-round2/billing-tail-final-wire.log 2>&1
```

Exit **0**: 2 files, 27 tests passed (24 wire + 3 isolation). The fixture is isolated to one fork and disables account-pool discovery; no user's live account pool is read. The log override is enabled only while the synthetic socket delivers to main, so worker-local publication cannot fake the main log assertion.

7. Types:

```sh
rtk proxy npx tsc --noEmit > _scratch/oct2-phaseD-round2/billing-tail-types.log 2>&1
rtk proxy npm run typecheck:spec > _scratch/oct2-phaseD-round2/billing-tail-spec-types.log 2>&1
rtk proxy npm run typecheck:spec > _scratch/oct2-phaseD-round2/billing-tail-final-spec-types.log 2>&1
```

Each exit **0**. Final spec types were rerun after strengthening the dispatcher fixture.

8. Targeted lint, before and after the final fixture change:

```sh
rtk proxy npx oxlint --config .oxlintrc.json src/main/cli/adapters/remote-cli-adapter.ts src/main/cli/adapters/remote-termination-tail.ts src/main/remote-node/codex-billing-tail.ts src/worker-agent/local-instance-manager.ts src/worker-agent/worker-instance-termination.ts src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts > _scratch/oct2-phaseD-round2/billing-tail-lint.log 2>&1
rtk proxy npx oxlint --config .oxlintrc.json src/main/cli/adapters/remote-cli-adapter.ts src/main/cli/adapters/remote-termination-tail.ts src/main/remote-node/codex-billing-tail.ts src/worker-agent/local-instance-manager.ts src/worker-agent/worker-instance-termination.ts src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts > _scratch/oct2-phaseD-round2/billing-tail-final-lint.log 2>&1
```

Both exit **0**, no lint output.

9. LOC and worker closure:

```sh
rtk proxy npm run check:ts-max-loc > _scratch/oct2-phaseD-round2/billing-tail-loc.log 2>&1
rtk proxy node _scratch/oct2-phaseD-round2/closure-measure.mjs _scratch/oct2-phaseD-round2/billing-tail-closure > _scratch/oct2-phaseD-round2/billing-tail-closure.log 2>&1
rtk wc -l src/main/cli/adapters/remote-cli-adapter.ts src/worker-agent/local-instance-manager.ts src/worker-agent/worker-rpc-dispatcher.ts src/main/remote-node/rpc-schemas.ts src/main/cli/adapters/remote-termination-tail.ts src/main/remote-node/codex-billing-tail.ts src/worker-agent/worker-instance-termination.ts src/worker-agent/__tests__/remote-codex-policy-wire.spec.ts
```

Each exit **0**. Ratchet passed, retaining existing legacy tolerance notices. Final counts: RemoteCliAdapter **692**, LocalInstanceManager **699**, worker dispatcher **700**, RPC schemas **758**; new helpers **30 / 28 / 33**, wire spec **443**. No ceiling changes. Context-worker closure remains **155 modules / 288 edges / zero Electron value importers**; the actual isolation test also passes. The existing native usage observe fifth argument was untouched.

10. Whitespace check:

```sh
rtk proxy git diff --check -- src/main/cli/adapters/remote-cli-adapter.ts src/worker-agent/local-instance-manager.ts
```

Exit **0**.

## Limitations and cleanup handoff

- Native client requests/notifications and socket I/O are synthetic. The factory, Codex logic, worker dispatcher, manager, telemetry schemas/notifier/router and filesystem main writer are real. This is not a deployed-worker or paid-provider validation.
- No full suite, GUI/browser, provider probe, new agent, commit, stash, branch, worktree, merge or deployment was run. Full canonical gates and independent review remain for main/coordinator.
- No root plan/history documents were edited, copied, renamed or closed. Existing changes and A18 source were preserved. No independent PASS is claimed.
- Each fixture cleans its own temporary policy-log directory and transport listeners. No other probe, source runtime, existing artifact or worktree was deleted. These billing-tail logs/report and closure measurement outputs remain for coordinator sealing and cleanup.

## Item status

- [x] Worker and coordinator graceful billing-tail fix implemented.
- [x] Actual final credits and pending last-share correction reach the real main writer once.
- [x] Scoped identity, strict payloads, lifecycle/proof exclusion, rejection/force/exit/error cleanup and publisher failure checked.
- [x] Focused regressions, types, targeted lint, LOC and worker closure checked.
- [ ] Main/coordinator canonical gates, independent gate, documentation lifecycle and seal/cleanup: intentionally owned by coordinator, not performed here.
