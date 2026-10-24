# Remote worker: Claude policy guard and Codex one-shot exit loop

Status: completed 2026-10-19. Implemented and verified locally; two independent completion-gate passes returned
PASS. The windows-pc live proof needs a pushed commit (James to authorise) for the worker's auto-update and a rebuilt
Harness, so it is deferred to
[the live-test doc](2026-10-19-remote-worker-claude-policy-and-codex-exit_livetest.md).

Local verification (2026-10-19): `tsc --noEmit` (main, worker, spec), lint, LOC ratchet, `build:main`,
`build:renderer`, worker bundle (no new Electron imports: 15 lazy references before and after), targeted suites
(2,066 tests) green. Full suite: 18 failures in 10 files unrelated to this change, under load average 16-19; all 10
files pass when rerun alone.

## Bug 1: remote Claude refused by `run_on_node`

### Reproduced (2026-10-19, worker build bca871e)

`run_on_node { node: "windows-pc", provider: "claude", prompt: "Reply with just the word READY." }` failed at once with
"Remote Claude execution cannot enforce read-only review, machine-session policy or turn/context limits yet."

### Root cause

- `run_on_node` (`src/main/app/orchestrator-tools-step.ts`) creates the instance with
  `metadata.spawnParentInstanceId` whenever an agent session calls the tool.
- `applyInstanceSpawnPolicy` (`src/main/instance/lifecycle/instance-spawn-policy.ts`) maps that metadata through
  `machineSessionReasonOf` to `machineSession: 'node-run'`.
- The remote branch of `createCliAdapter` refuses any remote Claude session with `machineSession` set, because the
  `instance.spawn` RPC and the worker's `createCliAdapter` call do not carry it.
- For Claude, `machineSession` disables the security-guidance plugin (settings overlay + env) and selects the
  machine context-ceiling setting. `readOnlyReview`, `maxTurns`, `maxBudgetUsd` and `contextCeilingTokens` are all
  applied inside `createClaudeAdapter` (argv/env), which the worker also uses to build Claude.

### Fix (carry and enforce, fail closed on legacy workers)

1. `instance.spawn` gains an optional, strict `claudeSpawnPolicy` object
   (`machineSession`, `contextCeilingTokens`, `readOnlyReview`, `maxTurns`, `maxBudgetUsd`).
2. The coordinator resolves the policy exactly as a local Claude spawn would (including the settings-derived context
   ceiling) and sends it for remote Claude spawns.
3. The worker passes the policy into its own `createCliAdapter('claude', …)`, so the worker-built argv/env enforce it.
4. Workers advertise `claudeSpawnPolicy: 1` in their capabilities. The adapter factory (and `RemoteCliAdapter.spawn`,
   in case the node re-registered on an older build) refuses a policy-bearing remote Claude session unless the target
   node advertises exactly that value. Legacy workers keep failing closed; ordinary sessions without a policy are
   unaffected.

## Bug 2: remote Codex one-shot loops "Session restarted automatically (resume failed)"

### Reproduced (2026-10-19, instance xrc426yaa)

Codex answered READY; the coordinator logged `Adapter exit event code 0` with `previousStatus: busy`, auto-respawned,
re-sent the turn, and repeated.

### Root cause

- On the worker, Codex runs in exec mode (one `codex exec` process per turn). `CodexExecAdapter` emits `exit` when each
  turn's process closes, before the turn's `idle`/`complete`.
- Locally the coordinator ignores that per-turn exit (`isStatelessExecAdapter` in `handleExit`).
- On the worker, `LocalInstanceManager` treats every adapter `exit` as the instance ending: it deletes the instance,
  releases its Android lease and forwards `instance:exit`. The coordinator's `RemoteCliAdapter` cannot tell a per-turn
  exit from a crash, so it reports a crash mid-turn and the respawn machinery re-runs the turn.

### Fix

1. Move the stateless-exec classification into an Electron-free leaf module shared by the coordinator and the worker.
2. The worker ignores per-turn exits from stateless exec adapters (keeps the instance, keeps the Android lease, forwards
   nothing). Resident adapters (Claude, Codex app-server, ACP) still forward `exit`, so real crashes still recover.
   Exec-mode turn failures surface as error output and a rejected `sendInput`, as locally. (The worker does not
   forward adapter `error`/`turn_error` events; that predates this change, see Follow-ups.)
3. An interrupted exec turn reports no `idle` of its own (locally the coordinator holds the adapter's completion
   promise). The worker now emits `idle` once a stateless exec adapter's interrupt completion settles, so the
   coordinator settles the interrupt in place instead of waiting for its force-abort net.

## As built

- `src/main/remote-node/claude-spawn-policy-schema.ts`: strict `RemoteClaudeSpawnPolicySchema`
  (reasons from the new `MACHINE_SESSION_REASONS` in `src/shared/utils/machine-session.ts`).
- `src/main/remote-node/rpc-schemas.ts`: `instance.spawn.claudeSpawnPolicy`; capability `claudeSpawnPolicy: 1`
  (malformed reads as absent).
- `src/main/cli/adapters/remote-claude-spawn-policy.ts`: `resolveRemoteClaudeSpawnPolicy` (incl. settings-derived
  context ceiling), exact-value capability check, `remoteClaudeSpawnPolicyFor` used by the factory guard and again by
  `RemoteCliAdapter.spawn`, which sends the policy.
- Worker: `capability-reporter.ts` advertises `claudeSpawnPolicy: 1`; `LocalInstanceManager.spawn` passes the policy into
  its own `createCliAdapter` (and refuses one addressed to a non-Claude provider).
- `src/main/cli/adapters/stateless-exec-adapter.ts`: Electron-free, duck-typed classifier; the coordinator helper now
  delegates to it.
- `src/worker-agent/worker-exec-turn.ts` + `LocalInstanceManager`: per-turn exec exits no longer end the instance,
  forward `exited` or release the Android lease; an interrupted exec turn reports `idle`.
- Completion-gate follow-up (2026-10-19): Antigravity, Cursor, Copilot (exec) and Gemini end a failed turn with
  `status: 'error'`. Locally the coordinator downgrades that to `idle` for stateless exec adapters, but a
  `RemoteCliAdapter` is not classified stateless, and the worker's busy watchdog kept emitting `processing` after it,
  so with the instance now kept alive a remote session would stay busy. The worker's `status` handler now applies the
  same `error` → `idle` downgrade for `endsOnlyTheTurn` adapters before updating `lastStatus`, the watchdog and the
  forwarded state. Resident adapters still forward `error`. (Codex exec already settles a failed turn as `idle`.)
- Policy note: `maxBudgetUsd` is carried too (it was silently dropped before and is only set by read-only reviewers).
  A legacy worker now also refuses Claude when the user has set a context-ceiling setting, because that ceiling would
  otherwise be silently dropped; the defaults are 0, so ordinary sessions are unaffected.

## Verification

- Factory/guard tests: refused on legacy node; carried and accepted on a capable node; ordinary sessions unaffected.
- RemoteCliAdapter test: policy reaches the `instance.spawn` RPC.
- Worker tests: policy reaches the worker's `createCliAdapter`; per-turn exec exit is not forwarded and the instance
  stays usable for a second turn; a resident adapter's exit is still forwarded; interrupted exec turn reports idle.
- AGENTS.md checklist; fresh-eyes completion gate.
- Worker: a failed exec turn's `error` reaches the coordinator as `idle` and the watchdog stops (fails without the
  fix: `error` then repeated `processing`); a resident adapter's `error` is still forwarded.
- Live checks: deferred to [the live-test doc](2026-10-19-remote-worker-claude-policy-and-codex-exit_livetest.md).

Verification run for completion (2026-10-19, after the follow-up fix): `tsc --noEmit` (main, worker),
`typecheck:spec`, `lint`, `check:ts-max-loc`, `build:main`, `build:renderer`, `build:worker-agent` (still 15 lazy
`require("electron")` in `dist/worker-agent/index.js`) all exit 0. Related suites (`src/worker-agent`,
`src/main/remote-node`, Claude remote-policy and `RemoteCliAdapter` specs): 1,510 tests pass. Full suite: 34,266 of
34,267 pass; the one failure was the new worker test, run while the fix was deliberately switched off to prove the test
catches the bug, and it passes on the restored code. `capability-reporter.spec.ts` "returns valid capabilities" times
out at 5 s at load averages of 30-60 (it probes installed CLIs) and passes alone with a longer timeout; the change only
adds a literal field to that output.

## Follow-ups (not in scope)

- The worker drops adapter `error`/`turn_error` events (its runtime-event switch has no case for them), so
  coordinator-side handling driven by `adapter.on('error')` (for example provider-limit or auth classification) is not
  mirrored for remote sessions. The failure text still arrives as output and a rejected send. Predates this change.
- `createCliAdapter`'s remote branch reads the node registry for every provider, not just Claude; harmless with the
  real registry.
