# Session Diff Stats & Unread Completion Indicator

**Date**: 2026-03-14
**Status**: Approved

## Overview

Add two Codex-inspired features to the instance list UI:

1. **Lines changed indicator** — Show `+N -M` (green/red) per instance session, tracking only what that instance changed during the session.
2. **Unread completion dot** — A blue dot appears when an instance finishes a task (busy→idle) and persists until the user selects/views that instance.

## Motivation

When managing multiple concurrent AI instances, the user needs at-a-glance answers to two questions:
- "Did this instance actually change anything, and how much?"
- "Which instances have finished since I last looked?"

Codex provides both — `+N -M` diff stats and a blue unread dot. We adapt the same UX to our orchestrator's instance list.

## Research

### How other tools do it

| App | Change tracking method | Completion indicator |
|-----|----------------------|---------------------|
| **Codex** | `TurnDiffTracker` — file content baselines captured before patches, unified diff computed after. Uses `similar::TextDiff`. | Blue dot (unread semantics — clears on view) |
| **opencode** | Snapshot at "step-start"/"step-finish", session-level summary of additions/deletions/file count. `Session.Event.Diff` event. | N/A |
| **t3code** | Turn-based diff checkpoints, `additions`/`deletions` per file, aggregated to directories. | N/A |
| **openclaw** | Ephemeral state with timestamp-based auto-clearing. `chatNewMessagesBelow` for unread. | Toast notifications, count badges |

### Design input

**Gemini** recommended: intercept file writes rather than polling git; ephemeral crossfade for completion; hide `+0 -0`; aggregate in row with file detail on tooltip.

**Copilot** recommended: fixed-width diff slot (mono font, tabular-nums); state model (running/done+changes/done+no-changes/failed); 700-1200ms highlight animation on completion.

## Architecture

### Approach: File Content Snapshots (Codex-style)

We chose Approach C — file content snapshots — modeled on Codex's `TurnDiffTracker`. This approach:
- Captures file content baselines before modifications
- Computes line-level diffs after each busy→idle transition
- Works in non-git directories
- Provides per-instance isolation without git coordination

This was chosen over git-based approaches because:
- It isolates changes per instance even when multiple instances work in the same repo
- It doesn't require spawning git subprocesses
- It matches the proven Codex architecture

---

## Feature 1: Session Diff Tracking Engine

### Data Model

```typescript
/** Stored on the main-process Instance and sent via IPC.
 *  Uses Record (not Map) so it survives JSON serialization without special handling. */
interface SessionDiffStats {
  totalAdded: number;
  totalDeleted: number;
  files: Record<string, FileDiffEntry>;  // keyed by relative path
}

interface FileDiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  added: number;
  deleted: number;
}
```

### SessionDiffTracker (main process)

One `SessionDiffTracker` per active Instance. **NOT a singleton** — created per-instance.

**Storage and lifecycle:**
- Stored in a `Map<string, SessionDiffTracker>` as a new field `diffTrackers` on `InstanceStateManager`.
- `InstanceStateManager` gets three new methods:
  - `setDiffTracker(instanceId: string, tracker: SessionDiffTracker): void`
  - `getDiffTracker(instanceId: string): SessionDiffTracker | undefined`
  - `deleteDiffTracker(instanceId: string): void`
- `LifecycleDependencies` interface is extended with:
  - `getDiffTracker: (id: string) => SessionDiffTracker | undefined`
  - `setDiffTracker: (id: string, tracker: SessionDiffTracker) => void`
  - `deleteDiffTracker: (id: string) => void`
- **Created** in `InstanceLifecycleManager.createInstance()` after the adapter is spawned and instance is stored.
- **Destroyed** in `InstanceLifecycleManager.terminateInstance()` alongside `deleteAdapter()` and `deleteInstance()`.
- **On restart**: The tracker is destroyed and a new one created (stats reset to zero — new session, fresh start).
- **On hibernation**: Diff stats (`SessionDiffStats`) are persisted as part of the instance state (already serialized to disk during hibernation). The in-memory `SessionDiffTracker` (baselines map) is lost — on wake, a new tracker is created but the accumulated `diffStats` on the `Instance` are preserved.
- **On context compaction**: No effect — compaction doesn't restart the process or change files.

**Baseline capture:**
- When a `tool_use` or `tool_result` message indicates a file is being modified, `ToolOutputParser` extracts the file path.
- The first time a file is seen in a turn, `SessionDiffTracker.captureBaseline(filePath)` reads the file from disk and stores its content in memory.
- If the file doesn't exist yet (new file being created), baseline is stored as empty string.

**Diff computation:**
- Triggered on busy→idle (or busy→ready) transition.
- For each file with a captured baseline: read current content from disk, compute line-level diff.
- Sum additions and deletions across all files.
- Uses a diffing library (e.g., `diff` npm package) for line-level comparison.
- Binary files detected and skipped (counted as file changes but not line changes).
- After computation, updates the `Instance.diffStats` field directly, then calls `queueUpdate()` to include it in the next batch-update flush.

**Accumulation across turns:**
- Diff stats accumulate across the session's lifetime.
- After each diff computation, baselines are updated to current content so subsequent turns don't double-count.
- Running totals in `totalAdded` and `totalDeleted` grow monotonically.

**Edge cases:**
- **Non-git directories**: Works fine — pure file content diffing, no git dependency.
- **Binary files**: Detected (content fails UTF-8 check), counted as 1 file changed but 0 line changes.
- **File deleted by instance**: All baseline lines count as deletions.
- **File created by instance**: All new lines count as additions (baseline was empty).
- **Shell commands modifying files indirectly**: Best-effort detection via bash tool output parsing. Accepted limitation — matches Codex's behavior (they only track files going through their patch system).

### ToolOutputParser (main process)

Extracts file paths from instance output messages. Provider-specific parsing with documented conventions.

```typescript
class ToolOutputParser {
  extractFilePaths(
    message: OutputMessage,
    workingDirectory: string,
    provider: InstanceProvider
  ): string[];
}
```

**Where it hooks into the event pipeline:**

The `ToolOutputParser` is invoked inside `InstanceCommunicationManager.setupAdapterEvents()` (in `src/main/instance/instance-communication.ts`), specifically in the `adapter.on('output', ...)` callback where individual messages are already inspected for tool_use/tool_result types, RLM ingestion, and circuit breaker logic.

When a `tool_use` or `tool_result` message arrives:

1. Call `ToolOutputParser.extractFilePaths(message, instance.workingDirectory, instance.provider)`
2. For each returned file path, call `diffTracker.captureBaseline(filePath)` (via `deps.getDiffTracker(instanceId)`)
3. Continue with existing output handling (no change to current behavior)

This requires extending `CommunicationDependencies` (not `LifecycleDependencies`) with:
- `getDiffTracker: (id: string) => SessionDiffTracker | undefined`

The `InstanceManager` wires this dep when constructing `CommunicationDependencies`, sourcing it from `InstanceStateManager.getDiffTracker()`.

Note: `generateActivityStatus` is a renderer-side concern (in `InstanceStore.setupIpcListeners`). The diff tracking is main-process-side, alongside the existing RLM ingestion and circuit breaker checks in `setupAdapterEvents()`.

**Provider tool naming conventions:**

These conventions MUST be documented with real examples and covered by tests, so we detect when providers change their output format.

#### Claude CLI
- **`Write` tool**: `file_path` in tool_use metadata/content
- **`Edit` tool**: `file_path` in tool_use metadata/content
- **`Bash` tool**: Best-effort regex for file-modifying commands (`>`, `sed -i`, `mv`, `cp`, `tee`, etc.)
- **`Read` tool**: Ignored (doesn't modify files)
- **`Glob`/`Grep` tools**: Ignored (read-only)

#### Codex CLI
- **`write_file`**: File path in arguments
- **`apply_patch`**: File paths in patch content
- **`shell`**: Best-effort regex (same as Claude Bash)

#### Gemini CLI
- **`edit_file`**: File path in arguments
- **`write_file`**: File path in arguments
- **`shell`**: Best-effort regex

#### Copilot CLI
- **`editFile`**: File path in arguments
- **`createFile`**: File path in arguments
- **`runCommand`**: Best-effort regex

#### General fallback
- For any unrecognized provider or tool name: scan message content and metadata for strings that look like file paths within the working directory (heuristic).

**Test requirements:**
- Each provider's tool conventions must have dedicated test cases with real-world example messages.
- Tests should include the tool_use message format (what the JSON looks like) as documentation.
- Tests should cover: simple file path extraction, multiple files in one message, relative vs absolute paths, paths outside working directory (should be ignored), shell commands with file targets.

---

## Feature 2: Unread Completion Indicator

### State

- New field on renderer-side `Instance` type: `hasUnreadCompletion: boolean`
- **Set to `true`** when a batch-update arrives showing status changed to `idle`, `ready`, or `waiting_for_input` and previous status was `busy`
- **Also set** on `busy` → `error` (instance failed — user should check why)
- **Cleared to `false`** when the user selects that instance (clicks on the row)
- NOT set on: initial creation, waking from hibernation, respawning, or any non-busy origin transition
- Note: `ready` is documented as an alias for `idle` in the renderer types, so `busy` → `ready` is treated identically to `busy` → `idle`

### State location and implementation

This is purely renderer-side state. The main process doesn't track or care about "unread" status.

**Previous-status tracking:** The `applyUpdate()` and `applyBatchUpdates()` methods in `InstanceStore` (`src/renderer/app/core/state/instance/instance.store.ts`) must read the current instance status BEFORE applying the update. This is the comparison point:

```typescript
// Inside applyUpdate() — before updating state:
const instance = this.stateService.getInstance(update.instanceId);
const previousStatus = instance?.status;
const newStatus = update.status as InstanceStatus;

// After state is updated:
if (previousStatus === 'busy' &&
    (newStatus === 'idle' || newStatus === 'ready' ||
     newStatus === 'waiting_for_input' || newStatus === 'error')) {
  // Set hasUnreadCompletion = true, UNLESS this instance is currently selected
  if (this.queries.selectedInstanceId() !== update.instanceId) {
    this.stateService.updateInstance(update.instanceId, { hasUnreadCompletion: true });
  }
}
```

The same logic applies inside `applyBatchUpdates()` — read previous status before the batch state update, set flags after.

**Clearing on selection:** In `InstanceStore.setSelectedInstance()`, after delegating to `selectionStore.setSelectedInstance(id)`, clear the flag:

```typescript
setSelectedInstance(id: string | null): void {
  this.selectionStore.setSelectedInstance(id);
  if (id) {
    const instance = this.stateService.getInstance(id);
    if (instance?.hasUnreadCompletion) {
      this.stateService.updateInstance(id, { hasUnreadCompletion: false });
    }
  }
}
```

### Visual treatment

**Placement**: Inline before the instance name, inside `.instance-info`:
```
[provider icon]  ● Instance name...    +13 -13   8m
```

**Styling:**
- 8px diameter circle
- Color: `#60A5FA` (blue-400, muted blue for dark backgrounds)
- Subtle glow: `box-shadow: 0 0 6px rgba(96, 165, 250, 0.5)`
- Appears with 200ms fade-in animation
- Disappears immediately on selection (no fade-out)

**Edge cases:**
- Instance errors (busy→error): Show dot — user should look at the error
- Rapid busy→idle→busy (multi-step): Clear dot on first idle, set new dot on next idle. Diff stats accumulate independently.
- Multiple instances complete at once: Each gets independent dot state

---

## Feature 3: Diff Stats Display (UI)

### Placement

Between instance name and time label, matching Codex's layout:
```
[provider icon]  ● Instance name...    +13 -13   8m
```

### Rendering rules

| State | Display |
|-------|---------|
| Has changes (`totalAdded > 0 \|\| totalDeleted > 0`) | `+N` in green, `-M` in red |
| No changes (both zero) | Hidden completely — no visual element |
| Instance is busy (working) | Stats update live as files are detected |
| Instance errored | Hidden (focus on error state) |

### Styling

```css
.diff-stats {
  display: flex;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  white-space: nowrap;
}

.diff-added { color: #4ade80; }
.diff-deleted { color: #f87171; }
```

Both the sign character and number are the same color (`+13` all green, `-13` all red).

### Tooltip

On hover over the diff stats, show per-file breakdown:
```
Modified:
  src/app/main.ts        +10  -2
  package.json            +2  -2
  src/utils/helpers.ts    +1  -9
```

Data comes from `SessionDiffStats.files` — already tracked by the engine. Sent as part of the `Instance.diffStats` field (uses `Record<string, FileDiffEntry>`, not Map, so it serializes cleanly via IPC).

### IPC transport

Diff stats are included directly on the `Instance.diffStats` field:
- The `InstanceStateUpdatePayload` in `src/shared/types/ipc.types.ts` is extended with `diffStats?: { totalAdded: number; totalDeleted: number; files: Record<string, FileDiffEntry> }`
- The `StateUpdate` interface in `src/renderer/app/core/services/update-batcher.service.ts` is also extended with the same field
- `queueUpdate()` in `InstanceStateManager` gains an optional `diffStats` parameter
- On busy→idle transition, after `SessionDiffTracker.computeDiff()`, the lifecycle manager calls `queueUpdate(instanceId, 'idle', contextUsage, diffStats)` to include it in the next 100ms batch flush
- The renderer's `applyUpdate()` and `applyBatchUpdates()` in `InstanceStore` apply the `diffStats` field alongside status and contextUsage

This piggybacks on the existing batch system — no new IPC channel needed.

**Batcher merge guards:** Both the main-process and renderer batchers merge updates for the same instance within their batch window. If a second update arrives without `diffStats`, it would overwrite the field with `undefined`. Both must preserve existing optional fields:

- **Main process** (`InstanceStateManager.queueUpdate()` in `instance-state.ts`): Currently does `pendingUpdates.set(instanceId, { instanceId, status, contextUsage })`. Must merge with existing: `diffStats: diffStats ?? existing?.diffStats`
- **Renderer** (`UpdateBatcherService.queueUpdate()` in `update-batcher.service.ts`): Currently does `{ ...existing, ...update }`. Must use: `diffStats: update.diffStats ?? existing?.diffStats`

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/main/instance/session-diff-tracker.ts` | `SessionDiffTracker` class — baseline snapshots + diff computation |
| `src/main/instance/tool-output-parser.ts` | `ToolOutputParser` — provider-specific file path extraction |
| `src/main/instance/tool-output-parser.spec.ts` | Tests for tool naming conventions per provider, with documented examples |
| `src/main/instance/session-diff-tracker.spec.ts` | Tests for baseline capture, diff computation, accumulation |

## Files to Modify

### Shared types
| File | Changes |
|------|---------|
| `src/shared/types/instance.types.ts` | Add `diffStats?: SessionDiffStats` to `Instance` type; initialize to `undefined` in `createInstance()` |
| `src/shared/types/ipc.types.ts` | Add `diffStats?` to `InstanceStateUpdatePayload` |

### Main process
| File | Changes |
|------|---------|
| `src/main/instance/instance-state.ts` | Add `diffTrackers` Map and `getDiffTracker`/`setDiffTracker`/`deleteDiffTracker` methods; extend `queueUpdate` to accept optional `diffStats`; add merge guard to preserve `diffStats` across batched updates |
| `src/main/instance/instance-lifecycle.ts` | Extend `LifecycleDependencies` with diff tracker methods; create tracker on spawn, destroy on terminate/restart |
| `src/main/instance/instance-communication.ts` | Extend `CommunicationDependencies` with `getDiffTracker`; in `setupAdapterEvents()` output handler, call `ToolOutputParser` → `SessionDiffTracker.captureBaseline()`; in `adapter.on('status')` handler, trigger `computeDiff()` on busy→idle transitions and include diffStats in `queueUpdate()` |
| `src/main/instance/instance-manager.ts` | Wire diff tracker deps into both `LifecycleDependencies` and `CommunicationDependencies`, sourcing from `InstanceStateManager` |

### Renderer
| File | Changes |
|------|---------|
| `src/renderer/app/core/state/instance/instance.types.ts` | Add `diffStats?: { totalAdded: number; totalDeleted: number; files: Record<string, FileDiffEntry> }` and `hasUnreadCompletion?: boolean` |
| `src/renderer/app/core/state/instance/instance.store.ts` | In `applyUpdate()` and `applyBatchUpdates()`: read previous status before update, set `hasUnreadCompletion` on busy→idle/ready/waiting_for_input/error transitions, apply `diffStats` from update payload. In `setSelectedInstance()`: clear `hasUnreadCompletion` |
| `src/renderer/app/core/state/instance/instance-list.store.ts` | Add `diffStats` and `hasUnreadCompletion` to `deserializeInstance()` |
| `src/renderer/app/core/services/update-batcher.service.ts` | Add `diffStats?` to `StateUpdate` interface |
| `src/renderer/app/features/instance-list/instance-row.component.ts` | Render diff stats display, unread dot, tooltip |

## Event Flow

```
Instance output arrives (tool_use/tool_result message)
  → [InstanceCommunicationManager.setupAdapterEvents, adapter output handler]
  → ToolOutputParser.extractFilePaths(message, workingDir, provider)
  → For each path: diffTracker.captureBaseline(filePath)
  → Continue existing output forwarding (unchanged)

Instance status: busy → idle/ready
  → [InstanceCommunicationManager.setupAdapterEvents, adapter.on('status') handler]
  → Read previous status from instance, detect busy→idle transition
  → diffTracker.computeDiff() → returns SessionDiffStats
  → Update instance.diffStats on Instance object
  → queueUpdate(instanceId, 'idle', contextUsage, diffStats)
  → Batch flush (100ms) → IPC to renderer

Renderer receives batch-update
  → [InstanceStore.applyBatchUpdates()]
  → Read previous status for each instance
  → Apply new status + contextUsage + diffStats
  → If previous was 'busy' and new is idle/ready/waiting/error:
    → Set hasUnreadCompletion = true (unless currently selected)
  → InstanceRowComponent re-renders with +N -M and blue dot

User selects instance
  → [InstanceStore.setSelectedInstance()]
  → Delegates to selectionStore
  → Clears hasUnreadCompletion on the selected instance
  → Blue dot disappears
```

## Lifecycle Matrix

| Event | SessionDiffTracker | Instance.diffStats | hasUnreadCompletion |
|-------|-------------------|-------------------|---------------------|
| Instance created | New tracker created | `undefined` | `false` |
| busy → idle | `computeDiff()` called, baselines updated | Updated with new totals | Set to `true` (if not selected) |
| busy → ready | Same as idle | Same as idle | Same as idle |
| busy → error | Not computed (partial changes unreliable) | Unchanged | Set to `true` |
| Instance restarted | Old destroyed, new created | Reset to `undefined` | Unchanged |
| Instance hibernated | Destroyed (in-memory baselines lost) | Preserved (serialized with instance) | Unchanged |
| Instance woken | New tracker created | Preserved from pre-hibernation | Unchanged |
| Instance terminated | Destroyed | N/A (instance removed) | N/A |
| User selects instance | No effect | No effect | Cleared to `false` |
