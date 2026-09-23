# F12: Session Continuity Integration Plan

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](../../plans/2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** SessionContinuityManager is wired: tracking starts/stops in `instance-event-forwarding.ts`, shutdown saves sessions from `index.ts`, and the SESSION_LIST_RESUMABLE / RESUME / CREATE_SNAPSHOT / GET_STATS handlers are registered in `session-handlers.ts` with preload exposure.


> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `SessionContinuityManager` into the app lifecycle so sessions auto-save and restore on startup/shutdown.

**Architecture:** The `SessionContinuityManager` (806 lines, fully implemented) lives in `src/main/session/session-continuity.ts` with `startTracking()`, `stopTracking()`, `shutdown()`, and `getResumableSessions()`. It's a singleton via `getSessionContinuityManager()`. The gap is purely integration: `src/main/index.ts` never imports or calls it. We wire it into (1) `initialize()` for startup restore, (2) instance event forwarding for tracking, (3) `cleanup()` for shutdown save.

**Tech Stack:** Electron main process (TypeScript/CommonJS), Node.js EventEmitter patterns, singleton services via `getXxx()` helpers.

---

## Chunk 1: Core Lifecycle Integration

### Task 1: Wire SessionContinuityManager into App Initialization

**Files:**
- Modify: `src/main/index.ts:1-10` (add import)
- Modify: `src/main/index.ts:46-95` (add init step)

- [ ] **Step 1: Add import for SessionContinuityManager**

Add to the imports section of `src/main/index.ts`:

```typescript
import { getSessionContinuityManager } from './session/session-continuity';
```

- [ ] **Step 2: Add session continuity init step to `initialize()`**

In the `steps` array inside `initialize()` (after the 'Truncation cleanup' step at approx line 72), add:

```typescript
{ name: 'Session continuity', fn: () => { getSessionContinuityManager(); } },
```

This eagerly initializes the singleton, which calls `loadActiveStates()` in its constructor — loading any previously persisted session states from disk.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no new errors

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(f12): initialize SessionContinuityManager on app startup"
```

---

### Task 2: Track New Instances for Session Continuity

**Files:**
- Modify: `src/main/index.ts:105-128` (inside `setupInstanceEventForwarding()`)

When a new instance is created, start tracking it. When removed, stop tracking (with archive).

- [ ] **Step 1: Add startTracking on instance:created**

In `setupInstanceEventForwarding()`, inside the `instance:created` handler (after line 117), add:

```typescript
      // Track for session continuity (auto-save)
      try {
        getSessionContinuityManager().startTracking(instance);
      } catch (error) {
        logger.warn('Failed to start session tracking', { instanceId: instance.id, error: error instanceof Error ? error.message : String(error) });
      }
```

- [ ] **Step 2: Add stopTracking on instance:removed**

In `setupInstanceEventForwarding()`, inside the `instance:removed` handler (after line 127, before the observer publish), add:

```typescript
      // Stop tracking and archive for potential resume
      try {
        getSessionContinuityManager().stopTracking(instanceId as string, true);
      } catch (error) {
        logger.warn('Failed to stop session tracking', { instanceId, error: error instanceof Error ? error.message : String(error) });
      }
```

The `archive = true` parameter preserves the state file on disk so the session can be resumed later.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(f12): track instance lifecycle for session continuity"
```

---

### Task 3: Save All Sessions on Shutdown

**Files:**
- Modify: `src/main/index.ts:428-431` (cleanup method)

- [ ] **Step 1: Call shutdown() before terminateAll()**

Replace the `cleanup()` method:

```typescript
  cleanup(): void {
    logger.info('Cleaning up');
    // Save all tracked session states before terminating
    try {
      getSessionContinuityManager().shutdown();
    } catch (error) {
      logger.error('Failed to save sessions on shutdown', error instanceof Error ? error : undefined);
    }
    this.instanceManager.terminateAll();
  }
```

This ensures all dirty session states are flushed to disk before instances are terminated.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(f12): save session state on app shutdown"
```

---

### Task 4: Update Session State on Output and Context Changes

**Files:**
- Modify: `src/main/index.ts:130-172` (inside `setupInstanceEventForwarding()`)

The SessionContinuityManager needs to know when session state changes so it can mark sessions as dirty for auto-save.

- [ ] **Step 1: Update session state on batch-update (context usage)**

Inside the `instance:batch-update` handler, after the context usage processing loop (after line 171), add:

```typescript
      // Update session continuity with latest context usage
      if (data.updates) {
        const continuity = getSessionContinuityManager();
        for (const update of data.updates) {
          if (update.contextUsage) {
            continuity.updateState(update.instanceId, {
              contextUsage: {
                used: update.contextUsage.used,
                total: update.contextUsage.total,
              },
            });
          }
        }
      }
```

Note: We reuse the `data.updates` already parsed above — no duplicate parsing needed.

- [ ] **Step 2: Track conversation entries from instance:output**

Inside the `instance:output` handler (after line 137), add:

```typescript
      // Track output for session continuity
      try {
        const msg = output.message;
        if (msg && (msg.type === 'user' || msg.type === 'assistant' || msg.type === 'tool_use' || msg.type === 'tool_result')) {
          getSessionContinuityManager().addConversationEntry(output.instanceId, {
            id: msg.id || `msg-${Date.now()}`,
            role: msg.type === 'user' ? 'user' : msg.type === 'assistant' ? 'assistant' : 'tool',
            content: msg.content || '',
            timestamp: msg.timestamp || Date.now(),
          });
        }
      } catch (error) {
        logger.warn('Failed to track conversation entry', { instanceId: output.instanceId });
      }
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(f12): feed output and context updates to session continuity"
```

---

## Chunk 2: IPC Handlers for Renderer Access

### Task 5: Add IPC Channels for Session Continuity

**Files:**
- Modify: `src/shared/types/ipc.types.ts` (add channel constants)

- [ ] **Step 1: Add session continuity IPC channels**

In `IPC_CHANNELS` in `src/shared/types/ipc.types.ts`, add to the existing "Session operations" section (after `SESSION_SHARE_REPLAY` at ~line 130):

```typescript
  SESSION_LIST_RESUMABLE: 'session:list-resumable',
  SESSION_RESUME: 'session:resume',
  SESSION_LIST_SNAPSHOTS: 'session:list-snapshots',
  SESSION_CREATE_SNAPSHOT: 'session:create-snapshot',
  SESSION_GET_STATS: 'session:get-stats',
```

Also add the same constants to the **preload's local** `IPC_CHANNELS` copy in `src/preload/preload.ts` (after the existing `SESSION_SHARE_REPLAY` entry at ~line 127).

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/ipc.types.ts
git commit -m "feat(f12): add session continuity IPC channel constants"
```

---

### Task 6: Register IPC Handlers for Session Continuity

**Files:**
- Modify: `src/main/ipc/handlers/session-handlers.ts` (add continuity handlers to existing file)

The existing `session-handlers.ts` already handles session fork/export/import. Add session continuity handlers there, following the established pattern.

- [ ] **Step 1: Add continuity handlers to session-handlers.ts**

Add import at the top of `src/main/ipc/handlers/session-handlers.ts`:

```typescript
import { getSessionContinuityManager } from '../../session/session-continuity';
import type { ResumeOptions } from '../../session/session-continuity';
```

At the end of the `registerSessionHandlers()` function, add:

```typescript
  // --- Session Continuity ---

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_RESUMABLE, async () => {
    try {
      return getSessionContinuityManager().getResumableSessions();
    } catch (error) {
      logger.error('Failed to list resumable sessions', error instanceof Error ? error : undefined);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_RESUME, async (_event: IpcMainInvokeEvent, payload: { instanceId: string; options?: ResumeOptions }) => {
    try {
      return await getSessionContinuityManager().resumeSession(payload.instanceId, payload.options);
    } catch (error) {
      logger.error('Failed to resume session', error instanceof Error ? error : undefined);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_SNAPSHOTS, async (_event: IpcMainInvokeEvent, payload?: { instanceId?: string }) => {
    try {
      return getSessionContinuityManager().listSnapshots(payload?.instanceId);
    } catch (error) {
      logger.error('Failed to list snapshots', error instanceof Error ? error : undefined);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE_SNAPSHOT, async (_event: IpcMainInvokeEvent, payload: { instanceId: string; name?: string; description?: string }) => {
    try {
      return getSessionContinuityManager().createSnapshot(payload.instanceId, payload.name, payload.description, 'manual');
    } catch (error) {
      logger.error('Failed to create snapshot', error instanceof Error ? error : undefined);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_STATS, async () => {
    try {
      return getSessionContinuityManager().getStats();
    } catch (error) {
      logger.error('Failed to get session stats', error instanceof Error ? error : undefined);
      return null;
    }
  });
```

Note: Uses `ResumeOptions` type (not `Record<string, boolean>`) to match `SessionContinuityManager.resumeSession()` signature. The `IpcMainInvokeEvent` type is already imported in this file.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/handlers/session-handlers.ts
git commit -m "feat(f12): add session continuity IPC handlers"
```

---

### Task 7: Expose Session Continuity API in Preload

**Files:**
- Modify: `src/preload/preload.ts` (add channel constants + bridge methods)

The preload file has its own local copy of `IPC_CHANNELS` (cannot import from shared) and exposes methods via `contextBridge.exposeInMainWorld`. Both need updating.

- [ ] **Step 1: Add channel constants to preload's local IPC_CHANNELS**

In `src/preload/preload.ts`, find the local `IPC_CHANNELS` object (line 12) and add to the session section (after `SESSION_SHARE_REPLAY`):

```typescript
  SESSION_LIST_RESUMABLE: 'session:list-resumable',
  SESSION_RESUME: 'session:resume',
  SESSION_LIST_SNAPSHOTS: 'session:list-snapshots',
  SESSION_CREATE_SNAPSHOT: 'session:create-snapshot',
  SESSION_GET_STATS: 'session:get-stats',
```

- [ ] **Step 2: Add bridge methods to the exposeInMainWorld object**

Find the existing session methods (near `sessionFork`, `sessionExport`, etc.) and add:

```typescript
  // Session continuity
  listResumableSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST_RESUMABLE),
  resumeSession: (payload: { instanceId: string; options?: Record<string, unknown> }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_RESUME, payload),
  listSessionSnapshots: (payload?: { instanceId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST_SNAPSHOTS, payload),
  createSessionSnapshot: (payload: { instanceId: string; name?: string; description?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE_SNAPSHOT, payload),
  getSessionStats: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_STATS),
```

Note: Uses `IPC_CHANNELS.*` constants (not raw strings) to match the pattern used by all other preload methods.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/preload/preload.ts
git commit -m "feat(f12): expose session continuity API via preload bridge"
```

---

### Task 8: Verify Integration End-to-End

- [ ] **Step 1: Run full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings)

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: PASS

- [ ] **Step 4: Verify in dev mode**

Run: `npm run dev`
Expected: App starts, creates session-continuity directory in userData, no errors in console.

- [ ] **Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix(f12): address typecheck/lint issues from session continuity integration"
```
