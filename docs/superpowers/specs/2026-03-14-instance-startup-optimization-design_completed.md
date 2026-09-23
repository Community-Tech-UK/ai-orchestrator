# Instance Startup Optimization Design

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](../../plans/2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** Implemented by the completed instance-startup plan.


**Date:** 2026-03-14
**Status:** Approved
**Reviewers:** Claude (author), Gemini 3 Pro, Copilot (GPT-5.3 Codex)

## Problem

Instance creation blocks the UI for 100-500ms (process spawn) plus 2-10s (first LLM response). History items cold-start every time. Idle instances either waste RAM or lose context when terminated. The user wants all instances to feel "live" — instant to open, with conversation context preserved.

## Goals

1. Instance creation appears instant (<5ms to UI render)
2. Recent instances hibernate instead of terminating — wake fast with context preserved
3. Older history items show transcript immediately while CLI catches up
4. SessionContinuityManager doesn't block Electron main process

## Non-Goals

- Full provider-specific process pool (complexity/RAM cost outweighs benefit)
- UI redesign of the instance list (handled separately)

---

## Section 1: Instant `createInstance()` with Deferred Init

### Current Behavior

`createInstance()` sequentially: loads permissions → loads CLAUDE.md instruction hierarchy → builds system prompt → resolves provider/model → calculates context window → spawns CLI adapter. Returns only after all steps complete.

### New Behavior

**Phase 1 — Synchronous (<5ms):**
- Generate instance ID
- Set status to `initializing`
- Register in instance store (renderer receives the instance, UI renders chat view)
- Create an `AbortController` for this init
- Kick off Phase 2, store resulting promise as `instance.readyPromise`

**Phase 2 — Background `Promise.all`:**
- Load permissions (async file I/O)
- Load instruction hierarchy (async file I/O)
- Resolve provider and model

Once all three resolve:
- Build system prompt from loaded instructions
- Calculate context window
- Spawn CLI adapter
- Set status to `ready`

If AbortController is signaled (instance destroyed early), clean up any partially-spawned process in `finally` block.

### Guard in `sendInput()`

```typescript
if (instance.readyPromise) {
  const result = await Promise.race([
    instance.readyPromise,
    timeout(30_000, 'Instance initialization timed out')
  ]);
  if (instance.status === 'failed') throw new InitFailedError(instance.error);
}
```

**On timeout:** signal the AbortController to cancel init/wake, transition to `failed`, surface error to UI ("Instance failed to start — try again"). This prevents a late-resolving promise from creating confusing state recovery.

**UX during init:** Send button shows a subtle loading state while `initializing`. Status bar reflects "Starting up..."

---

## Section 2: Hibernation Lifecycle Wiring

### State Machine

```
initializing → ready → busy ↔ idle → hibernating → hibernated → waking → ready
                                   ↘ terminated
any → failed
any → terminated (explicit user action)
```

**Enforcement:** A `TRANSITIONS` map defines allowed from/to pairs. All state changes go through a single `transitionState(instanceId, newState)` method that validates against the map and acquires a per-instance lock. Invalid transitions throw.

### Hibernation Triggers

| Trigger | Condition | Action |
|---------|-----------|--------|
| Idle timeout | `idle` > 30min, >=1 user message | Hibernate |
| Idle timeout | `idle` > 30min, 0 user messages | Terminate |
| Memory pressure | `memory:critical` event | Hibernate oldest idle (with hysteresis: 5min cooldown after wake) |
| Concurrent cap | Running count > 6 | Hibernate via weighted eviction |

**Eviction scoring:** `(idle_time_normalized * 0.5) + (transcript_size_normalized * 0.3) + (restart_cost_normalized * 0.2)`. Includes penalty for "recently failed wake" to avoid thrash loops.

**Idle threshold:** 30 minutes default, user-configurable via settings (15m, 30m, 1h, Never).

### Hibernate Flow

1. Validate state is `idle`
2. Acquire per-instance lock, quiesce I/O (disable input/output event handlers)
3. Transition to `hibernating`
4. `SessionContinuityManager.saveState(instanceId)` — async, atomic write (tmp + fsync + rename, fsync parent dir)
5. Kill CLI adapter process (ensure process is dead before next step)
6. `HibernationManager.markHibernated(instanceId, state)`
7. Transition to `hibernated`
8. Release lock
9. Emit `instance:hibernated` IPC event to renderer

### Wake Flow

1. User clicks hibernated instance
2. Transition to `waking`
3. Load SessionState from disk
4. Send last 50 messages to renderer immediately (UI shows conversation)
5. Spawn CLI adapter in background with `resume: true` flag. The adapter's `spawn()` method already supports `--resume` / `--continue` flags for Claude and Gemini CLIs. For providers that don't support native resume, the adapter replays a context summary as the first system message to rebuild context.
6. Load remaining history in background chunks to renderer
7. On adapter ready: transition to `ready`
8. If adapter spawn fails: transition to `failed`, create fresh instance with context summary, show toast "Session resumed from backup — some context may be missing"

**Scroll anchoring:** When prepending older history chunks to the UI, maintain the user's current scroll position to prevent jarring jumps.

**Unified input guarding:** `sendInput()` uses a single `instance.readyPromise` pattern for both `initializing` and `waking` states. During `createInstance()`, `readyPromise` is set to the init promise. During wake, `readyPromise` is reassigned to the wake promise. `sendInput()` always does:
```
if (instance.readyPromise) await Promise.race([instance.readyPromise, timeout(30_000)]);
```
This avoids separate queue/await logic for init vs wake. On timeout, surface error to UI.

### UI Representation

Hibernated instances appear in the instance list identically to running ones. The status dot uses a subtle visual distinction (e.g., hollow vs filled) but both are clickable and feel instant. No separate "history" section.

---

## Section 3: SessionContinuityManager Performance Fixes

### Async FS Migration

Replace all `fs.*Sync` calls with `fs.promises.*`:
- `readFileSync` → `fs.promises.readFile`
- `readdirSync` → `fs.promises.readdir`
- `writeFileSync` → `fs.promises.writeFile`
- `statSync` → `fs.promises.stat`
- `existsSync` → `fs.promises.access` (catch only `ENOENT` as "missing"; rethrow permission errors)
- `unlinkSync` → `fs.promises.unlink`
- `mkdirSync` → `fs.promises.mkdir`

### Constructor Pattern

Keep synchronous constructor for DI compatibility. Internal `readyPromise` resolves when `loadActiveStates()` completes. Any public method that needs loaded state awaits `readyPromise` first:

```typescript
async saveState(instanceId: string): Promise<void> {
  await this.readyPromise;
  // ... actual save logic
}
```

### Atomic Writes

State saves use tmp file + fsync + rename pattern to prevent corruption on crash:

```typescript
const tmpPath = stateFile + '.tmp';
await fs.promises.writeFile(tmpPath, serialized);
const fd = await fs.promises.open(tmpPath, 'r');
await fd.sync();
await fd.close();
await fs.promises.rename(tmpPath, stateFile);
// fsync parent directory for crash durability
const dirFd = await fs.promises.open(path.dirname(stateFile), 'r');
await dirFd.sync();
await dirFd.close();
```

### Single Global Autosave Timer

Replace per-instance `setInterval` with one global timer (60s). On tick, iterate the `dirty` set, flush each with jittered delay (±5s random offset per instance) to avoid burst I/O. Track in-flight saves to prevent overlapping flushes for the same instance (skip if previous save still pending).

### Compact Serialization

- `JSON.stringify(data)` instead of `JSON.stringify(data, null, 2)`
- `structuredClone()` for deep copies (benchmark against current payloads first; fall back to JSON roundtrip if payload contains non-cloneable entities, wrapped in try/catch)

### In-Memory Snapshot Index

On startup, load snapshot metadata (id, sessionId, timestamp, messageCount) into a `Map`. `listSnapshots()` reads from index. Full snapshot content loaded from disk only on demand. Index updated on create/delete. Single-pass cleanup using index.

### Schema Versioning

Snapshot files include `schemaVersion: number`. Loader validates version:
- Same version: load normally
- Known older version: run migration function
- Unknown/newer version: quarantine file (move to `snapshots/quarantine/`) with warning log, preserving data for future migration

---

## Section 4: "Next-Up" Warm Start

After a user creates an instance for a given provider, pre-spawn one replacement CLI process in the background for the same provider. The warm process is spawned with the same working directory and a minimal system prompt. When assigned to a real instance via `createInstance()`, the system prompt and permissions are updated before the first message is sent (the deferred init in Section 1 handles this naturally — the warm adapter is assigned, then the full system prompt is built and injected before `sendInput()`). This warm process:

- Sits idle until the next `createInstance()` for a matching provider
- Gets assigned instantly instead of spawning fresh (saves 100-500ms)
- Is terminated (not hibernated) if not consumed — warm processes have no conversation history worth preserving
- Is disabled when memory pressure is active or when running instance count is at the concurrent cap
- Terminated after 5 minutes idle if not consumed, or immediately on memory pressure

Only one warm process at a time. Only for the user's most recently used provider.

---

## Section 5: Observability

### Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `instance.init_duration_ms` | histogram | Time from createInstance() to adapter ready |
| `instance.first_message_latency_ms` | histogram | Time from sendInput() to first output |
| `instance.wake_duration_ms` | histogram | Time from wake trigger to adapter ready |
| `instance.wake_attempts` | counter | Total wake attempts |
| `instance.wake_failures` | counter | Failed wake attempts (success rate derived) |
| `hibernation.count` | gauge | Currently hibernated instances |
| `hibernation.eviction_count` | counter | Instances evicted by pressure/cap |
| `continuity.save_duration_ms` | histogram | Time for state save |
| `continuity.snapshot_size_bytes` | histogram | Snapshot file sizes |

### Structured Logging

All lifecycle transitions logged with per-instance correlation ID:
```
[SessionContinuity] State saved { instanceId: "abc-123", duration: 42, size: 15280 }
[HibernationManager] Instance hibernated { instanceId: "abc-123", idleTime: 1800000, messageCount: 24 }
[InstanceLifecycle] Wake succeeded { instanceId: "abc-123", wakeDuration: 340, resumeMethod: "native" }
```

### Cleanup Contract

All destroy/cleanup operations are idempotent:
- Calling `destroyInstance()` on an already-terminated instance is a no-op
- Adapter cleanup removes all event listeners, kills process, clears locks
- Per-instance correlation IDs trace the full lifecycle in logs

---

## Files Affected

### Modified (Main Process)
- `src/main/instance/instance-lifecycle.ts` — deferred init, hibernate/wake methods, state machine guards
- `src/main/instance/instance-manager.ts` — readyPromise plumbing, sendInput guard
- `src/main/instance/instance-communication.ts` — unified readyPromise guard
- `src/main/process/hibernation-manager.ts` — enable auto-hibernation, weighted eviction, hysteresis
- `src/main/session/session-continuity.ts` — async FS, atomic writes, global timer, schema versioning, snapshot index
- `src/main/ipc/handlers/instance-handlers.ts` — new IPC events for hibernate/wake/chunked transcript

### Modified (Shared)
- `src/shared/types/instance.types.ts` — new states (hibernating, hibernated, waking, failed)
- `src/shared/types/ipc.types.ts` — new IPC channels for hibernate/wake events, chunked transcript

### Modified (Renderer)
- `src/renderer/app/core/state/instance.store.ts` — handle new instance states, chunked transcript loading
- `src/renderer/app/features/instance-detail/input-panel.component.ts` — loading state on send button during initializing/waking
- `src/renderer/app/features/instance-detail/output-stream.component.ts` — scroll anchoring for prepended history chunks
- `src/renderer/app/features/instance-list/instance-row.component.ts` — visual distinction for hibernated vs running instances

### New
- `src/main/instance/instance-state-machine.ts` — transition map, per-instance lock, validation
- `src/main/instance/warm-start-manager.ts` — next-up warm process management
- `src/main/session/snapshot-index.ts` — in-memory snapshot metadata index

### Tests
- Unit tests for state machine transitions (valid and invalid)
- Unit tests for hibernate/wake lifecycle
- Unit tests for async SessionContinuityManager (readyPromise, atomic writes)
- Unit tests for warm-start manager
- Integration test: create → hibernate → wake → send round-trip
