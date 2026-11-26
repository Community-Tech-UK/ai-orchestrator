# Session restart reliability — implementation plan

Status: **completed** — all three changes implemented and verified; provider-facing checks deferred to [2026-07-25-session-restart-reliability_livetest.md](./2026-07-25-session-restart-reliability_livetest.md)
Date: 2026-07-25
Trigger: James reported "the restart button didn't work. I had to click the red X and then type to restart the session. I dont think session restarting is working properly" during a ChatGPT/Codex 503 outage (`biscuit_baker_service_me_circuit_open`).

## Evidence

All timings from `~/Library/Application Support/Harness/logs/app.log` and `lifecycle.ndjson`, instance `x5mf48pzq` (Codex, GPT-5.6 Sol).

Verified restart #1 timeline (`lifecycle.ndjson` status transitions + `app.log`):

| Time | Event |
| --- | --- |
| 10:15:00.082 | `error → initializing` — restart begins (`[RESTART] begin`, restartCount 0) |
| 10:15:00.481 | New temp CODEX_HOME `codex-browser-mcp-9ZCK2N` created |
| 10:15:01.028 | `Persisted cursor resume failed (recoverable), falling back to fresh thread` — rollout path `…/codex-browser-mcp-fzfD6p/sessions/2026/07/25/rollout-…-019f988d-….jsonl`: **file does not exist** |
| 10:15:01.157 | App-server thread started **fresh** (`019f988e-7628`), gen 2, `initializing → idle` |
| 10:15:01.172 | `SessionRecovery: Native resume failed, trying replay` (`Native resume did not stabilize`) |
| 10:15:01.287 | `IPC INSTANCE_SEND_INPUT received` — user's restored draft, mid-restart |
| 10:15:01.572 | Replay adapter spawned (`019f988e-77cd`), gen 3, `idle → ready → busy` |
| 10:15:01.949 | `Sending message to adapter` (status busy) |
| **10:15:01.956** | `busy → error` (gen 3, turnId `019f988e-7846`) — 7 ms later: *"Codex app-server runtime already has an active turn"* |
| **10:15:02.991** | `IdleMonitor: Found zombie process, force killing {status: "error"}` → `Force cleaning up adapter` |
| 10:15:02.995 | `SessionRecovery: Recovery methods failed` |
| 10:15:02.996 | `Restart (resume context) failed; leaving instance in error state` — error **"Codex app-server runtime closed"** |
| 10:15:02.996 | `Deferred runtime change failed; dropping the queued request` (codex→claude swap lost) |

Restart #2 (10:15:08) repeated the same resume failure and was finished off by a genuine 503 at 10:15:55.

Disk state confirms the resume failure is a path bug, not data loss:

- `~/.ai-orchestrator/codex/sessions/2026/07/25/rollout-2026-07-25T10-14-03-019f988d-96a1-….jsonl` — **exists, 127 573 bytes** (the real conversation).
- `/var/folders/…/T/codex-browser-mcp-fzfD6p` — **gone** (deleted on adapter cleanup).

## Root causes

### D1 — A failed restart is invisible to the user (the reported bug)
`InstanceLifecycleManager.restartInstance` returns `Promise<void>` and, on recovery failure, logs a warning and `return`s normally (`src/main/instance/instance-lifecycle.ts:2647-2671`). The IPC handler therefore always answers `{ success: true }` (`src/main/ipc/handlers/instance-handlers.ts:339-343`), and the renderer only surfaces `!response.success` (`src/renderer/app/core/state/instance/instance-list.store.ts:778-788`). The button does its work, fails, and says nothing.

### D2 — The zombie reaper kills the adapter an in-flight restart is using
`IdleMonitor.cleanupZombieProcesses` (`src/main/instance/lifecycle/idle-monitor.ts:387-423`) force-kills any adapter whose instance is `error`/`terminated`. It has no in-flight-lifecycle guard, unlike `check()` which deliberately skips `error`/`initializing` (lines 231-238). Here it fired 1 s into a restart that held the session mutex, terminating the freshly spawned app-server and making the in-flight replay `sendInput` reject with "Codex app-server runtime closed".

### D3 — Codex native resume can never succeed within an app run
`CodexHomeManager` symlinks `sessions/` into the persistent store, so rollout **files** survive temp-home cleanup (`codex-home-manager.ts:195-235`). But Codex records the *resolved* path through the per-spawn temp home in `state_5.sqlite.threads.rollout_path`. That directory is deleted on cleanup, so resume fails with "failed to resolve rollout path". `reconcilePrivateCodexRolloutPaths()` repairs exactly these rows but runs **only as a startup step** (`src/main/app/initialization-steps.ts:497`), so a session created and restarted in the same run is never repaired. Every Codex restart silently degrades to replay-fallback and loses the thread.

### D4 — A user send racing a restart collides with the replay turn (out of scope, see below)
`sendInput` never acquires the session mutex (only `auto-save`, `restart`, `restart-fresh`, `agent-mode-change`, `runtime-change`, `interrupt-respawn` do). A send landing mid-restart hit the same app-server runtime as the replay turn → "already has an active turn" → `busy → error`, which is what armed D2.

## Changes

### F1 — Guard the zombie reaper against in-flight lifecycle operations
`idle-monitor.ts`: skip an instance in `cleanupZombieProcesses` when `getSessionMutex().isLocked(instanceId)`. A held lock means restart/recovery/runtime-change owns the adapter; the reaper's next tick (60 s) will catch a genuinely orphaned adapter once the lock is released. Also guard the second pass (PID-without-adapter → `error`) for the same reason: mid-restart there is legitimately a window with a cleared PID.

Injected via a new optional dep (`isLifecycleLocked`) so the existing spec suite can drive it deterministically without the singleton.

### F2 — Make restart failure visible
1. `restartInstance` returns `Promise<RestartOutcome>` (`{ success, method?, error? }`) instead of `void`. Both internal callers (`setFastMode:3172`, `dispatchRecoveryActions:3374`) ignore the value, so their behaviour is unchanged — no new throw paths.
2. `InstanceManager.restartInstance` forwards the outcome.
3. `INSTANCE_RESTART` and `INSTANCE_HARDENED_ALLOW_PATH` map `!outcome.success` to `{ success: false, error: { code: 'RESTART_FAILED', … } }`.
4. The failure path emits a `type: 'system'` output message into the conversation naming the reason, so it appears where the user is already looking (matching the `queuePausedInitialPrompt` pattern at `instance-lifecycle.ts:880-892`).

### F3 — Repair the target thread's rollout path before a native resume
New `repairPrivateCodexRolloutPath(threadId)` in `codex-private-rollout-reconcile.ts`: for one thread id, if `rollout_path` matches `isOwnedAioRolloutPath` and `persistentRolloutPathFor(...)` exists on disk, rewrite that single row in a `BEGIN IMMEDIATE` transaction. Reuses the existing, tested predicates. No `VACUUM INTO` backup — a one-row, destination-verified rewrite on the private DB, and the whole-DB backup already happens at startup.

Called from `initializeCodexAppServer` immediately before `resumeThreadWithRetry` (`app-server-initializer.ts:88-96`), best-effort: never throws into spawn.

## Out of scope (report, do not fix here)

**D4.** Serialising sends against lifecycle operations needs a decision on semantics (queue vs reject) and touches the send hot path. `SessionMutex` is non-reentrant, so having `sendInput` acquire it risks the known self-deadlock class (lock holders must use the `*Locked` variants). Deferring rather than half-fixing.

## As-built

Landed as described, with one correction found during implementation.

`repairPrivateCodexRolloutPath` was first written with a lazy `require` of the sqlite driver, on the assumption that pulling `better-sqlite3` into the CLI-adapter graph would break worker processes that import that graph dynamically to spawn CLIs on remote nodes. Two things disproved it:

1. The lazy `require` does not resolve under vitest (the pitfall documented in `src/main/session/safe-storage-accessor.ts`), which broke `codex-cli-adapter.thread-recovery.spec.ts`.
2. Walking the real import graph showed `better-sqlite3-driver` is **already** statically reachable from `adapter-factory`: `adapter-factory.types → codex-cli-adapter → codex-app-server-turn-adapter → codex/browser-approval-watchdog → browser-gateway/browser-approval-store → persistence/rlm-database → persistence/rlm/rlm-backup → db/better-sqlite3-driver`.

So the guard protected nothing. Reverted to a plain static import.

A real hazard did surface from the same review: `defaultDriverFactory` passes no options, so better-sqlite3 applies its default 5 s lock timeout, and a live Codex process with its MCP connected is an active writer on this database. A contended repair would have stalled the spawn for up to 5 s. The repair now sets `busy_timeout = 250` on its own connection, so contention degrades to the previous behaviour almost immediately instead of delaying resume.

### Files changed

- `src/main/instance/lifecycle/idle-monitor.ts` — `isLifecycleLocked` dep + reaper guard (F1)
- `src/main/instance/instance-lifecycle.ts` — `RestartOutcome` return, `emitRestartFailureNotice`, IdleMonitor wiring (F1/F2)
- `src/main/instance/instance-lifecycle.types.ts` — `RestartOutcome` (F2)
- `src/main/instance/instance-manager.ts` — forwards the outcome (F2)
- `src/main/ipc/handlers/instance-handlers.ts` — `INSTANCE_RESTART` / `INSTANCE_HARDENED_ALLOW_PATH` report failure (F2)
- `src/main/cli/adapters/codex/codex-private-rollout-reconcile.ts` — `repairPrivateCodexRolloutPath` (F3)
- `src/main/cli/adapters/codex/app-server-initializer.ts` — calls the repair before resume (F3)
- Specs: `lifecycle/__tests__/idle-monitor.spec.ts` (+4), `codex/codex-private-rollout-reconcile.spec.ts` (+8), `ipc/handlers/__tests__/instance-handlers.spec.ts` (+1, 1 updated)

## Verification

All run on 2026-07-25 against the final state of the changes:

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npx tsc --noEmit -p tsconfig.spec.json` | pass |
| `npm run lint` (`ng lint`) | pass |
| `npm run lint:fast` (oxlint) | 0 errors (568 pre-existing repo-wide warnings) |
| `npm run check:ts-max-loc` | pass |
| `npm run test:quiet` | **1573 files · 15609 tests passed** |

Provider-facing behaviour (does resume actually reattach the thread; does the failure notice appear in the real UI; does the reaper stay off a slow restart) needs a rebuilt app and a live Codex session. Recorded as LT1-LT3 in the livetest doc — **not** verified here.
