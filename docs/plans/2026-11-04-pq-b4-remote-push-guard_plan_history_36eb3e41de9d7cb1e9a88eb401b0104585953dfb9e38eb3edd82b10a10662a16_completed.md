- Refuse, not start unguarded: a worker that does not advertise the new capability `queuePushGuard: 1` would strip the flag and run the session unguarded. New `src/main/cli/adapters/remote-queue-push-guard.ts` (`assertRemoteQueuePushGuardSupported`) throws "This worker is out of date, so Harness cannot stop a queued session from pushing code on it. Update the worker, or run the queue on this computer." It runs when the adapter is created (`createCliAdapter`) and again in `RemoteCliAdapter.spawn()`, because the node may re-register on an older build in between, the same two points as the Claude policy. The capability is reported by `capability-reporter.ts`, typed in `worker-node.types.ts` and read as absent when malformed (`rpc-schemas.ts`).
- All providers get the same guard; none is refused on a current worker, because the node builds the guard from the same code the local path uses. Local-model sessions on a node (`RemoteLocalModelAdapter`) are chat-only with no tools, so they have nothing to push with and carry no flag.
- Normal remote sessions: no flag is sent, no capability is required (tests assert the request has no `queuePushGuard`).

### Tests (all pass)

- `adapter-factory-remote-queue-push-guard.spec.ts` (new): refusal for an unknown node, an old node and malformed capability values, before any connection exists; refusal at spawn after a downgrade; the flag in the `instance.spawn` request for each of eight providers; no `env` in the request; ordinary remote session unaffected.
- `local-instance-manager.queue-push-guard.spec.ts` (new): the node's spawn env, run through **real git**, makes a push to each of the seven address forms fail with `aio-queue-push-blocked`; a `pushurl` remote that exists only in the node's repository is blocked; existing `GIT_CONFIG_COUNT` is appended to; ordinary session gets nothing; wake rebuilds the guard; Codex's shell filter keeps the variables; the flag survives wire validation.
- `instance-lifecycle-spawn-rollback.spec.ts`: new case, queue session on a remote node gets `queuePushGuard`, the deny rules and no local environment; the existing local-queue case passes unchanged. `capability-reporter.spec.ts`: advertised through the real heartbeat validator.
- Mutation checks (each removed, then restored; each made at least one test fail): the node's guard call (11 failures), the controller's flag (1), the flag on the wire (10), the refusal at creation (4), the refusal at spawn (1), the capability report (1), the malformed-capability read (1).
- Existing push-guard and Codex shell-policy specs pass unchanged. I also ran `src/worker-agent`, `src/main/remote-node`, `src/main/plan-queue`, `src/main/cli/adapters/__tests__`, `src/main/cli/adapters/remote*`, `src/main/cli/adapters/codex` and `src/main/instance/__tests__`: 342 files, 4675 tests passed.

### Gates run in the worktree

`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer` all exit 0; I also built the worker bundle (`npm run build:worker-agent`) because the worker now imports the guard module. `local-instance-manager.ts` is exactly 700 lines (limit 700), which is why its added comment is on the code line. **Not run:** the full `npm run test:quiet` suite (the verifier runs it; the known three `scripts/__tests__` Vite failures are an environment fault, not from this change).

### Not verified

- Nothing was run on a real remote node. Per-provider behaviour on a real node (each CLI actually seeing the variables, Codex under a restrictive shell policy on that machine, a Windows node's git) is deferred to [the live-test document](2026-11-04-pq-b4-remote-push-guard_plan_livetest.md).
- Same limits as the local guard: an agent that deliberately clears its own environment, and the address forms the fixed prefixes do not cover.
- The programme plan's 1.9 as-built note still lists this gap as not done; I did not edit that document (this job is only this plan).
