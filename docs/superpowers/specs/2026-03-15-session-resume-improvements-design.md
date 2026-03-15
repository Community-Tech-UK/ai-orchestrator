# Session Resume Improvements — Design Spec

> **Date:** 2026-03-15
> **Status:** Draft
> **Inspired by:** CodePilot session resume architecture
> **Scope:** 5 improvements to session resume reliability and UX

---

## Problem Statement

When a Claude CLI session cannot be resumed via `--resume` (corrupted session, expired state, API rejection), the orchestrator falls back to a fresh session with a brief summary message. This loses conversation nuance and context. Additionally, several robustness gaps exist: no concurrency protection for session state mutations, no detection of stuck CLI processes, no conversation-aware restore points, and potential duplicate tool results during retries.

## Goals

1. **Better fallback context** — when `--resume` fails, provide the model with actual conversation history rather than a lossy summary
2. **Concurrency safety** — prevent concurrent session state mutations from corrupting state
3. **Conversation-aware restore points** — let users rewind to specific conversation moments, not arbitrary timer intervals
4. **Stuck process detection** — detect and recover from hung CLI processes
5. **Output integrity** — prevent duplicate tool results from entering the output buffer

## Non-Goals

- Replacing the `--resume` mechanism itself (that's Claude CLI's responsibility)
- Distributed locking (single Electron process)
- LLM-generated summaries during recovery (too slow, adds failure points)
- Changing the existing timer-based auto-save (it stays as a crash-recovery safety net)

---

## Feature 1: Token-Budget Fallback History Injection

### Current Behavior

When `--resume` fails, `buildReplayContinuityMessage()` constructs a brief summary:
```
[SYSTEM CONTINUITY NOTICE]
Native resume is unavailable. Continuity mode is replay-based.
Current objective: <first user message>
Conversation summary: <message count> messages exchanged...
```

This loses all conversation nuance — tool results, decisions made, partial progress.

### New Behavior

A new method `buildFallbackHistoryMessage(instance, reason)` replaces the summary-only replay on fallback paths. It uses a **token-budget allocator** rather than message-count tiers.

#### Algorithm

1. **Collect messages:** Merge `instance.outputBuffer` with `outputStorage.loadMessages(instanceId)` using the existing dedup pattern from `buildForkSourceMessages`.

2. **Estimate budget:** Calculate 30% of the model's context window (from `getProviderModelContextWindow()`). Use chars/4 as a rough token estimate.

3. **Attempt full injection:**
   - Serialize all messages as structured blocks: `[USER]: ...`, `[ASSISTANT]: ...`, `[TOOL: toolName]: ...`
   - For tool outputs older than the last 5 turns: truncate to `[Tool: <name> — output truncated for recovery, <charCount> chars original]`
   - If this fits within budget → use it.

4. **If over budget — shrink:**
   - Keep the last N turns (starting from all, reducing) with truncated tool outputs.
   - Prepend a metadata header: first user message (original objective), total exchange count, key tool names used.
   - Reduce N until it fits within budget.
   - Minimum: header + last 3 turns.

5. **Format:** Wrap in a `[SESSION RECOVERY]` header:
   ```
   [SESSION RECOVERY — original session lost (<reason>)]
   The following is your conversation history for context continuity.
   Continue from where you left off.

   <optional metadata header if truncated>

   --- Conversation History ---
   [USER] (timestamp): <content>
   [ASSISTANT] (timestamp): <content>
   [TOOL: Read] (timestamp): <truncated or full output>
   ...
   ```

#### Where It's Called

Every existing fallback path in `instance-lifecycle.ts` that currently calls `buildReplayContinuityMessage()` with a `*-fallback` reason:
- `resume-failed-fallback` (in `toggleYoloMode`, `changeModel`, `changeAgentMode`, `respawnAfterInterrupt`)
- `auto-respawn-fallback` (in `respawnAfterUnexpectedExit`)

The old `buildReplayContinuityMessage()` stays for non-fallback replays (`agent-mode-change`, `yolo-toggle`, `model-change`, `interrupt-respawn`, `auto-respawn`) where we intentionally start fresh with context.

#### Files Modified

| File | Change |
|------|--------|
| `src/main/instance/instance-lifecycle.ts` | Add `buildFallbackHistoryMessage()`, call it from fallback paths |
| `src/main/instance/instance-lifecycle.ts` | Inline the merge+dedup pattern from `InstancePersistenceManager.buildForkSourceMessages` (load historical via `outputStorage.loadMessages`, merge with `outputBuffer`, dedup by message ID) |

---

## Feature 2: Per-Instance Async Mutex

### Current Behavior

No concurrency protection. Multiple code paths can mutate session state simultaneously:
- Auto-save timer writes state to disk
- User toggles yolo mode (terminate → respawn cycle)
- Unexpected exit triggers auto-respawn
- Model change terminates and respawns

The existing `inFlightSaves` Set prevents concurrent saves but doesn't protect the broader terminate→respawn lifecycle.

### New Behavior

A **promise-based async mutex per instance** replaces the TTL lock approach. No expiry, no renewal, no races.

#### `SessionMutex` class

New file: `src/main/session/session-mutex.ts`

```typescript
interface MutexEntry {
  source: string;       // e.g., 'yolo-toggle', 'auto-save', 'respawn'
  acquiredAt: number;
  release: () => void;
}

class SessionMutex {
  private locks: Map<string, Promise<void>>;

  // Returns a release function. Caller MUST call it in a finally block.
  async acquire(instanceId: string, source: string): Promise<() => void>;

  // Emergency release — used during instance cleanup/termination
  forceRelease(instanceId: string): void;

  isLocked(instanceId: string): boolean;

  // Diagnostic: who holds the lock and for how long
  getLockInfo(instanceId: string): { source: string; acquiredAt: number; durationMs: number } | null;
}
```

#### Behavior

- `acquire()` returns a promise that resolves when the lock is available. Callers await it and receive a `release` function.
- If the lock is already held, the caller queues behind the current holder (promise chaining).
- No TTL — the lock is held until explicitly released or force-released.
- **Safety valve:** `forceRelease()` is called in `terminateInstance()` and instance cleanup to prevent orphaned locks from dead instances.
- **Diagnostic logging:** If a lock is held for >30s, log a warning (but don't release — the operation might be legitimately slow).

#### Last-Writer Timestamp (Diagnostic)

Add two fields to the persisted `SessionState`:
```typescript
lastWriteTimestamp?: number;
lastWriteSource?: string;
```

Updated in `saveStateAsync()`. On `loadActiveStates()`, if `lastWriteTimestamp` is < 5 seconds ago, log a warning indicating possible crash during write. This is purely diagnostic — no blocking behavior.

#### Integration Points

| Operation | Acquires mutex? |
|-----------|----------------|
| `saveStateAsync()` | Yes (source: `'auto-save'`) |
| `toggleYoloMode()` | Yes (source: `'yolo-toggle'`) |
| `changeModel()` | Yes (source: `'model-change'`) |
| `changeAgentMode()` | Yes (source: `'agent-mode-change'`) |
| `respawnAfterInterrupt()` | Yes (source: `'respawn-interrupt'`) |
| `respawnAfterUnexpectedExit()` | Yes (source: `'respawn-unexpected'`) |
| `terminateInstance()` | Calls `forceRelease()` |

The `inFlightSaves` Set in `SessionContinuityManager` is replaced by the mutex.

#### Ownership

The `SessionMutex` is a standalone singleton (like other session services). Both `SessionContinuityManager` (for `saveStateAsync`) and `InstanceLifecycleManager` (for terminate→respawn cycles) import and use the same instance via `getSessionMutex()`.

#### Files Modified

| File | Change |
|------|--------|
| `src/main/session/session-mutex.ts` | New file — `SessionMutex` class |
| `src/main/session/session-continuity.ts` | Use mutex in `saveStateAsync`, add last-writer fields, remove `inFlightSaves` |
| `src/main/instance/instance-lifecycle.ts` | Acquire mutex around terminate→respawn cycles |

---

## Feature 3: Conversation-Aware Rewind Points

### Current Behavior

Snapshots are created on a timer (`autoSaveIntervalMs`, default 60s). They're disconnected from conversation flow — you can't say "go back to before I asked X."

### New Behavior

Two types of checkpoints layered on top of the existing snapshot system:

#### Hard Checkpoints (User-Turn Boundaries)

- **Trigger:** In `InstanceCommunicationManager.sendInput()`, right before dispatching a user message to the adapter.
- **Snapshot:** Calls `SessionContinuityManager.createSnapshot()` with:
  - `trigger: 'checkpoint'`
  - `name: "Before: <first 50 chars of user message>"`
- **Budget:** Unlimited (bounded naturally by user turn count). Existing `cleanupSnapshots()` handles retention via `maxSnapshots` and `snapshotRetentionDays`.

#### Soft Checkpoints (Long Autonomous Runs)

- **Tracking:** New `autonomousToolCount` counter per instance in the communication manager. Incremented on each `tool_result` message received. Reset to 0 on each user message sent.
- **Trigger:** When `autonomousToolCount` exceeds 5, create a soft checkpoint and reset the counter.
- **Snapshot:** `trigger: 'auto'`, `name: "Auto: after <toolName> (autonomous run, tool #<count>)"`
- **Cap:** Maximum 10 soft checkpoints per session. After 10, only create new ones if older soft checkpoints can be evicted (oldest-first).

#### No Change to Timer-Based Auto-Save

The existing `globalAutoSaveTimer` continues running. It serves as crash recovery (persisting state even if no user turns happen). Rewind points and auto-save are independent — they share the same snapshot storage and cleanup logic.

#### Files Modified

| File | Change |
|------|--------|
| `src/main/instance/instance-communication.ts` | Add hard checkpoint before `sendInput`, track `autonomousToolCount` for soft checkpoints. Add `createSnapshot` callback to `CommunicationDependencies` interface (the comm manager doesn't import `SessionContinuityManager` directly — the callback is wired in `InstanceManager` during setup). |
| `src/main/session/session-continuity.ts` | No changes needed — `createSnapshot()` already supports the required parameters |

---

## Feature 4: Stuck Process Detection

### Current Behavior

No detection of hung CLI processes. If a CLI hangs (network issue, stuck tool, API timeout), the instance stays in `busy` state indefinitely. The user must manually terminate and restart.

### New Behavior

#### `StuckProcessDetector` class

New file: `src/main/instance/stuck-process-detector.ts`

```typescript
interface ProcessTracker {
  lastOutputAt: number;
  instanceState: 'generating' | 'tool_executing' | 'idle';
  softWarningEmitted: boolean;
}

class StuckProcessDetector extends EventEmitter {
  private trackers: Map<string, ProcessTracker>;
  private checkInterval: NodeJS.Timeout | null;

  startTracking(instanceId: string): void;
  stopTracking(instanceId: string): void;
  recordOutput(instanceId: string): void;
  updateState(instanceId: string, state: ProcessTracker['instanceState']): void;
}
```

#### Detection Logic

A single interval timer (every 10s) iterates all tracked instances:

| Instance State | Soft Timeout | Hard Timeout |
|---------------|-------------|-------------|
| `generating` | 120s | 240s |
| `tool_executing` | 300s | 600s |
| `idle` | Not tracked (hibernation manager's domain) |

- **Soft timeout exceeded:** Emit `process:suspect-stuck` event with `{ instanceId, state, elapsedMs }`. Log warning. Set `softWarningEmitted = true` to avoid repeated warnings.
- **Hard timeout exceeded:** Emit `process:stuck` event with same payload. This triggers respawn.

#### State Updates

The communication manager updates `instanceState` based on output parsing:
- `tool_use` message received → `'tool_executing'`
- `tool_result` message received → `'generating'` (back to waiting for model output)
- Instance goes idle → `'idle'` (stops detection)
- Any output received → `recordOutput()` resets the timer and clears `softWarningEmitted`

#### Lifecycle Response

| Event | Action |
|-------|--------|
| `process:suspect-stuck` | Add system message to output buffer: "Instance may be stuck — no output for {N}s. Will auto-restart if unresponsive." |
| `process:stuck` | Call `respawnAfterInterrupt(instanceId)` — existing method that handles graceful terminate → resume/fallback |

#### Integration

- `StuckProcessDetector` is instantiated in `InstanceManager` alongside the communication manager.
- Communication manager calls `detector.recordOutput()` and `detector.updateState()` as part of its existing output processing.
- Lifecycle manager listens for `process:stuck` events.

#### Files Modified

| File | Change |
|------|--------|
| `src/main/instance/stuck-process-detector.ts` | New file |
| `src/main/instance/instance-communication.ts` | Call `recordOutput()` on output, `updateState()` on status transitions |
| `src/main/instance/instance-manager.ts` | Instantiate detector, wire `process:stuck` to lifecycle |

---

## Feature 5: Tool Result Deduplication

### Current Behavior

No dedup. If a duplicate `tool_result` arrives (e.g., during stream reconnection or retry), it's added to the output buffer as a second entry.

### New Behavior

#### Dedup in Communication Manager Output Handler

- New per-instance tracking: `seenToolResultIds: Map<string, Set<string>>` — maps instanceId to a Set of `tool_use_id` values that have had a `tool_result` processed.

- In the output handler (`handleAdapterOutput` or equivalent), before adding a `tool_result` message to the output buffer:
  1. Extract `tool_use_id` from `message.metadata['tool_use_id']` (typed as `Record<string, unknown>`, cast to `string`). The CLI adapter sets this field on `tool_result` messages (see `claude-cli-adapter.ts` `metadata: { tool_use_id, is_error }`).
  2. If `tool_use_id` is `undefined` or `null` → pass through (no dedup for system-generated results without IDs).
  3. If the ID is already in the instance's Set → **skip** the message. Log at debug level: `"Skipped duplicate tool_result for tool_use_id ${id}"`.
  4. If not in Set → add ID to Set, proceed with normal processing.

#### Lifecycle Cleanup

The Set is cleared when:
- Instance is terminated (`terminateInstance`)
- Instance is restarted (`restartInstance`)
- Session fork or fresh-start (new session has no prior tool IDs)
- Specifically: whenever `stopTracking` or equivalent cleanup runs in the communication manager

#### Files Modified

| File | Change |
|------|--------|
| `src/main/instance/instance-communication.ts` | Add `seenToolResultIds` Map, dedup check in output handler, cleanup on terminate/restart |

---

## Testing Strategy

| Feature | Test Approach |
|---------|--------------|
| Fallback history injection | Unit test `buildFallbackHistoryMessage` with short/long/over-budget conversations. Verify truncation, budget compliance, format. |
| Session mutex | Unit test acquire/release/queue/forceRelease. Test concurrent acquire resolves sequentially. Test diagnostic logging for long holds. |
| Rewind points | Unit test checkpoint creation on sendInput. Test autonomousToolCount tracking and soft checkpoint threshold. |
| Stuck process detector | Unit test timeout detection at various states. Test soft→hard escalation. Test recordOutput resets timer. Mock timer with `vi.useFakeTimers()`. |
| Tool result dedup | Unit test skip-on-duplicate, pass-through for missing IDs, cleanup on terminate. |

## Dependency Order

Features are independent and can be implemented in any order. Recommended sequence for incremental value:

1. **Tool result dedup** (#5) — smallest change, immediate robustness win
2. **Session mutex** (#2) — foundational safety for all other operations
3. **Fallback history injection** (#1) — highest user-facing impact
4. **Stuck process detection** (#4) — new capability, moderate complexity
5. **Rewind points** (#3) — UX enhancement, builds on existing snapshot system

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Fallback history message too large for some models | Token budget guard with progressive shrinking. Minimum of 3 turns ensures graceful degradation. |
| Mutex deadlock from unreleased lock | `forceRelease()` called in all terminate paths. Diagnostic warning after 30s hold. |
| Soft checkpoints bloating snapshot storage | Capped at 10 per session. Existing cleanup handles retention. |
| Stuck process detector false positive during legitimate long tool execution | 300s/600s timeouts for tool_executing state. Soft warning gives visibility before hard action. |
| Tool dedup skipping a legitimate re-execution | Only deduplicates by exact `tool_use_id`, which is unique per invocation. Re-executions produce new IDs. |
