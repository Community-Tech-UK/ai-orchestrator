# Session Recovery Features — Unified Design Spec

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](../../plans/2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** Implemented by the completed session-recovery plan.


> Three features to improve session resilience: Fork UI, Message-Count Restore, Multi-Layer Session Repair

## Status

| Feature | Backend | Frontend | Status |
|---------|---------|----------|--------|
| Doom Loop Detection | Done | Done | **Complete** (not in scope) |
| Per-message isReplayed / Recovery UX | Done | Done | **Complete** (not in scope) |
| Session Forking | Done | **Missing** | UI needed |
| Message-Count Restore | **Missing** | N/A | New logic |
| Multi-Layer Session Repair | **Missing** | N/A | New service |

---

## Feature 1: Session Forking UI

### Background

Backend infrastructure is fully implemented:
- `InstancePersistenceManager.forkInstance()` copies messages up to a fork point and creates a new instance
- IPC handler for `SESSION_FORK` validates payload and returns the forked instance
- `HistoryIpcService.forkSession()` is exposed to renderer components
- `IpcFacadeService` re-exports it

**What's missing:** Zero UI to trigger any of this.

### Design

#### 1.1 Context Menu Component (NEW)

**File:** `src/renderer/app/shared/components/context-menu/context-menu.component.ts`

Lightweight, reusable standalone component:

```typescript
interface ContextMenuItem {
  label: string;
  icon?: string;       // Optional icon class
  action: () => void;
  disabled?: boolean;
  divider?: boolean;   // Render a separator above this item
}

@Component({
  selector: 'app-context-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Positioned absolutely at cursor coordinates
})
export class ContextMenuComponent {
  items = input.required<ContextMenuItem[]>();
  x = input.required<number>();
  y = input.required<number>();
  visible = input.required<boolean>();
  closed = output<void>();
}
```

- Renders at `(x, y)` screen coordinates via `position: fixed`
- Closes on click-outside, Escape key, or item selection
- Uses existing design tokens (colors, border-radius, shadows)
- `@HostListener('document:click')` and `@HostListener('document:keydown.escape')` for dismiss

#### 1.2 Output Stream Integration

**File:** `src/renderer/app/features/instance-detail/output-stream.component.ts`

Add `(contextmenu)` handler to `.transcript-item` divs:

```html
<div class="transcript-item"
     [attr.data-item-index]="i"
     (contextmenu)="onContextMenu($event, item, i)">
```

Component methods:

```typescript
// State
contextMenuVisible = signal(false);
contextMenuX = signal(0);
contextMenuY = signal(0);
contextMenuItems = signal<ContextMenuItem[]>([]);

onContextMenu(event: MouseEvent, item: DisplayItem, index: number): void {
  event.preventDefault();
  this.contextMenuX.set(event.clientX);
  this.contextMenuY.set(event.clientY);
  this.contextMenuItems.set(this.buildMenuItems(item, index));
  this.contextMenuVisible.set(true);
}

private buildMenuItems(item: DisplayItem, index: number): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  // Copy message content
  if (item.message?.content) {
    items.push({
      label: 'Copy message',
      action: () => this.copyMessageContent(item)
    });
  }

  // Fork from here (only for user/assistant messages)
  if (item.message && ['user', 'assistant'].includes(item.message.type)) {
    items.push({
      label: 'Fork from here',
      divider: true,
      action: () => this.forkFromMessage(item)
    });
  }

  return items;
}

private async forkFromMessage(item: DisplayItem): Promise<void> {
  const instanceId = this.instanceId();
  const bufferIndex = item.bufferIndex;
  if (!instanceId || bufferIndex === undefined) return;

  const result = await this.ipc.forkSession({
    instanceId,
    atMessageIndex: bufferIndex + 1, // Fork includes this message
    displayName: `Fork at message ${bufferIndex + 1}`
  });

  if (result.success) {
    // Navigate to the new instance
    this.instanceStore.setSelectedInstance(result.data.id);
  }
}
```

#### 1.3 Buffer Index on DisplayItem

**File:** `src/renderer/app/features/instance-detail/display-item-processor.service.ts`

Add `bufferIndex` to `DisplayItem` interface:

```typescript
export interface DisplayItem {
  // ... existing fields
  bufferIndex?: number; // Index in the original outputBuffer for fork operations
}
```

Set it during processing so the fork action knows the exact cut point in the original message array.

#### 1.4 Post-Fork Behavior

After successful fork:
1. New instance appears in instance list with name "Fork of [source name]"
2. New instance is auto-selected
3. The forked instance contains messages up to the fork point
4. A system message is added to the fork: "Forked from [source] at message [N]. This is a fresh session — the agent does not remember the displayed conversation."

### Files Changed

| File | Change |
|------|--------|
| `src/renderer/app/shared/components/context-menu/context-menu.component.ts` | NEW — reusable context menu |
| `src/renderer/app/features/instance-detail/output-stream.component.ts` | Add contextmenu handler, render context menu |
| `src/renderer/app/features/instance-detail/display-item-processor.service.ts` | Add `bufferIndex` to DisplayItem |

---

## Feature 2: Message-Count Restore

### Background

The `HISTORY_RESTORE` handler's fallback path (Phase 2, session-handlers.ts:1016-1062) passes the **full** `data.messages` array as `initialOutputBuffer`. For conversations with hundreds or thousands of messages, this:
- Slows initial render (Angular change detection on all DOM nodes)
- Wastes memory on messages the user may never scroll to
- Ignores the existing "Load earlier messages" lazy-loading infrastructure

**Critical insight:** `initialOutputBuffer` is **display-only** in the fallback path. The fresh CLI instance has zero memory of these messages. Token budgets are irrelevant — the constraint is render performance, which correlates with message count.

### Design

#### 2.1 Message Selection Function

**Inline in session-handlers.ts** (no new file — it's ~15 lines):

```typescript
function selectMessagesForRestore(
  messages: OutputMessage[],
  limit = 100
): { selected: OutputMessage[]; truncatedCount: number } {
  if (!messages?.length || messages.length <= limit) {
    return { selected: messages || [], truncatedCount: 0 };
  }

  let startIdx = messages.length - limit;

  // Don't orphan tool_use/tool_result pairs at the boundary
  while (startIdx > 0 && messages[startIdx]?.type === 'tool_result') {
    startIdx--;
  }

  return {
    selected: messages.slice(startIdx),
    truncatedCount: startIdx
  };
}
```

#### 2.2 Integration in Fallback Path

In the replay-fallback branch (~line 1022):

```typescript
// Cap initial display to last 100 messages; older ones available via "Load earlier messages"
const { selected: displayMessages, truncatedCount } =
  selectMessagesForRestore(data.messages, 100);

const instance = await instanceManager.createInstance({
  workingDirectory: workingDir,
  displayName,
  historyThreadId,
  initialOutputBuffer: displayMessages,
  provider: restoreProvider,
  modelOverride: restoreModel
});
```

If truncated, the system notice message includes the count:

```typescript
content: `Previous ${providerName} CLI session could not be restored. ` +
  `Your conversation history is displayed above (${truncatedCount} earlier messages available via "Load earlier messages"), ` +
  `but ${providerName} does not have this context.`,
```

#### 2.3 Ensure Full History is Stored to Disk

The full `data.messages` array must be written to the output storage layer so "Load earlier messages" can access the truncated portion. Verify that `history.loadConversation()` already stores to disk — if it loads from disk, the full history is already available. If messages are only in memory, the full array needs to be persisted via `outputStorage.storeMessages(instanceId, data.messages)` before truncation.

#### 2.4 Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Session with < 100 messages | No truncation, no notice modification |
| All messages are tool_use/tool_result | Boundary scan walks back to include complete pairs |
| Empty message array | Guard returns empty array, no crash |
| Rapid sequential restores | Existing instance cleanup handles this |

### Files Changed

| File | Change |
|------|--------|
| `src/main/ipc/handlers/session-handlers.ts` | Add `selectMessagesForRestore()`, integrate in fallback path |

---

## Feature 3: Multi-Layer Session Repair

### Background

`SessionContinuityManager.deserializePayload()` catches JSON parse errors and returns `null`, silently dropping corrupted sessions. There is:
- No structured validation of session data
- No detection of orphaned tool_use/tool_result entries from process crashes
- No cleanup of orphaned `.tmp` files from interrupted atomic writes
- No attempt at repair before quarantining

### Design

#### 3.1 New Service: SessionRepairService

**File:** `src/main/session/session-repair.ts`

```typescript
import { getLogger } from '../logging/logger';

const logger = getLogger('SessionRepair');

// ============================================
// Types
// ============================================

export interface RepairResult {
  status: 'ok' | 'repaired' | 'quarantined' | 'unrecoverable';
  repairs: string[];      // Human-readable descriptions of fixes applied
  quarantinedPath?: string; // Path if file was quarantined
}

export interface TranscriptRepairResult {
  status: 'ok' | 'repaired';
  entries: ConversationEntry[];
  repairs: string[];
}

export interface TmpCleanupResult {
  recovered: string[];    // .tmp files successfully promoted to .json
  deleted: string[];      // .tmp files deleted (corresponding .json existed)
  failed: string[];       // .tmp files that couldn't be processed
}

// ============================================
// Layer 1: File-Level Validation & Recovery
// ============================================

export function repairFile(
  filePath: string,
  quarantineDir: string
): RepairResult {
  // 1. Try normal JSON parse
  // 2. If fails, try parsing the envelope ({ encrypted, data })
  //    - If envelope parses but inner data doesn't, attempt inner recovery
  // 3. If unrecoverable, move to quarantineDir with timestamp suffix
  // 4. Log all actions
}

// ============================================
// Layer 2: Transcript-Level Validation
// ============================================

export function validateTranscript(
  history: ConversationEntry[]
): TranscriptRepairResult {
  const repairs: string[] = [];
  const entries = [...history]; // Don't mutate input

  // 2a. Orphan tool_use detection
  // If last entry is tool_use with no subsequent tool_result,
  // append synthetic tool_result
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.toolUse && entry.role === 'assistant') {
      // Check if next entry is the corresponding tool result
      const next = entries[i + 1];
      if (!next || next.role !== 'tool') {
        // Orphaned tool_use — insert synthetic result
        const synthetic: ConversationEntry = {
          id: `repair-${Date.now()}-${i}`,
          role: 'tool',
          content: '[Tool execution interrupted — session recovered]',
          timestamp: entry.timestamp + 1,
          toolUse: {
            toolName: entry.toolUse.toolName,
            input: entry.toolUse.input,
            output: '[interrupted]'
          }
        };
        entries.splice(i + 1, 0, synthetic);
        repairs.push(
          `Inserted synthetic tool_result for orphaned ${entry.toolUse.toolName} at index ${i}`
        );
      }
    }
  }

  // 2b. Remove empty entries (zero-length content with no tool_use)
  const beforeCount = entries.length;
  const filtered = entries.filter(e =>
    e.content.length > 0 || e.toolUse != null
  );
  if (filtered.length < beforeCount) {
    repairs.push(
      `Removed ${beforeCount - filtered.length} empty entries`
    );
  }

  // 2c. Timestamp monotonicity check (warn only, don't remove)
  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i].timestamp < filtered[i - 1].timestamp) {
      repairs.push(
        `Warning: Non-monotonic timestamp at index ${i} ` +
        `(${filtered[i].timestamp} < ${filtered[i - 1].timestamp})`
      );
    }
  }

  return {
    status: repairs.length > 0 ? 'repaired' : 'ok',
    entries: filtered,
    repairs
  };
}

// ============================================
// Layer 3: Lock Staleness / Orphaned Tmp Files
// ============================================

export async function cleanupOrphanedTmpFiles(
  directory: string
): Promise<TmpCleanupResult> {
  // 1. Scan directory for *.tmp files
  // 2. For each .tmp:
  //    a. Check if corresponding .json exists
  //    b. If .json exists: delete .tmp (incomplete write, main file is good)
  //    c. If .json doesn't exist: rename .tmp → .json (rename never completed)
  //       Then validate the promoted file
  // 3. Log all actions
}
```

#### 3.2 Integration Points

**Startup — `SessionContinuityManager.initAsync()`:**

```typescript
private async initAsync(): Promise<void> {
  await this.ensureDirectories();

  // Layer 3: Clean up orphaned tmp files BEFORE loading states
  const tmpResult = await cleanupOrphanedTmpFiles(this.stateDir);
  const snapTmpResult = await cleanupOrphanedTmpFiles(this.snapshotDir);
  if (tmpResult.recovered.length || snapTmpResult.recovered.length) {
    logger.info('Recovered orphaned tmp files', {
      states: tmpResult.recovered.length,
      snapshots: snapTmpResult.recovered.length
    });
  }

  await this.loadActiveStates();
  await this.buildSnapshotIndex();
  this.startGlobalAutoSave();
}
```

**Load — `readPayload()` enhancement:**

When `deserializePayload()` returns `null`, call `repairFile()` before giving up:

```typescript
private async readPayload<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const result = this.deserializePayload<T>(raw);
    if (result) return result;

    // Deserialization failed — attempt repair
    const repair = repairFile(filePath, this.quarantineDir);
    if (repair.status === 'repaired') {
      logger.info('File repaired', { path: filePath, repairs: repair.repairs });
      const reRaw = await fs.promises.readFile(filePath, 'utf-8');
      return this.deserializePayload<T>(reRaw);
    }

    logger.warn('File unrecoverable', { path: filePath, status: repair.status });
    return null;
  } catch (error) {
    logger.error('Failed to read continuity payload', error instanceof Error ? error : undefined);
    return null;
  }
}
```

**Resume — `resumeSession()` transcript validation:**

After loading state, validate the conversation history:

```typescript
async resumeSession(instanceId: string, options: ResumeOptions = {}): Promise<SessionState | null> {
  // ... existing load logic ...
  if (!state) return null;

  // Layer 2: Validate transcript integrity
  if (state.conversationHistory.length > 0) {
    const repairResult = validateTranscript(state.conversationHistory);
    if (repairResult.status === 'repaired') {
      state.conversationHistory = repairResult.entries;
      logger.info('Transcript repaired during resume', {
        instanceId,
        repairs: repairResult.repairs
      });
    }
  }

  // ... existing resume logic ...
}
```

### Files Changed

| File | Change |
|------|--------|
| `src/main/session/session-repair.ts` | NEW — repair service (3 layers) |
| `src/main/session/session-continuity.ts` | Integrate repair at startup, load, and resume |

---

## Cross-Cutting Concerns

### Logging

All features use structured logging via `getLogger()`:
- Fork events: `logger.info('Instance forked', { sourceId, forkIndex, forkedId })`
- Truncation: `logger.info('Restore messages truncated', { total, displayed, truncated })`
- Repairs: `logger.info('Transcript repaired', { instanceId, repairs })`
- Quarantine: `logger.warn('File quarantined', { path, quarantinedPath })`

### Testing

Each feature gets a spec file:
- `src/renderer/app/shared/components/context-menu/context-menu.component.spec.ts` — menu rendering, positioning, dismiss
- `src/main/ipc/handlers/session-handlers.spec.ts` — extend existing tests for `selectMessagesForRestore()`
- `src/main/session/session-repair.spec.ts` — all 3 repair layers with corrupt data fixtures

### No New IPC Channels

- Fork UI uses existing `SESSION_FORK` channel
- Message-count restore modifies existing `HISTORY_RESTORE` handler behavior
- Session repair is internal to the main process

---

## Complete File Change Summary

| # | File | Feature | Change |
|---|------|---------|--------|
| 1 | `src/renderer/app/shared/components/context-menu/context-menu.component.ts` | Fork UI | NEW — reusable context menu component |
| 2 | `src/renderer/app/features/instance-detail/output-stream.component.ts` | Fork UI | Add contextmenu handler + render menu |
| 3 | `src/renderer/app/features/instance-detail/display-item-processor.service.ts` | Fork UI | Add `bufferIndex` to DisplayItem |
| 4 | `src/main/ipc/handlers/session-handlers.ts` | Msg-Count | Add `selectMessagesForRestore()` + integrate |
| 5 | `src/main/session/session-repair.ts` | Repair | NEW — 3-layer repair service |
| 6 | `src/main/session/session-continuity.ts` | Repair | Integrate repair at startup/load/resume |

**Total: 2 new files, 4 modified files**

---

## Verification Checklist

1. `npx tsc --noEmit` — passes
2. `npx tsc --noEmit -p tsconfig.spec.json` — passes
3. `npm run lint` — passes
4. Unit tests:
   - Context menu renders, positions, dismisses correctly
   - Fork from message calls IPC with correct `atMessageIndex`
   - `selectMessagesForRestore` correctly caps at limit
   - `selectMessagesForRestore` keeps tool_use/tool_result pairs together
   - `selectMessagesForRestore` handles edge cases (empty, under limit)
   - `validateTranscript` detects orphaned tool_use entries
   - `validateTranscript` inserts synthetic tool_result
   - `validateTranscript` removes empty entries
   - `cleanupOrphanedTmpFiles` recovers .tmp files
   - `repairFile` quarantines unrecoverable files
5. Manual verification:
   - Right-click message → "Fork from here" → new instance created with correct messages
   - Restore large session → only last 100 messages displayed, "Load earlier messages" works
   - Corrupt a session state file → verify repair or quarantine on startup

---

## Design Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Message count, not token budget | `initialOutputBuffer` is display-only; render cost scales with DOM nodes, not tokens |
| 100 message default | Most sessions have 20-60 exchanges; 100 gives headroom without DOM bloat |
| Leverage existing "Load earlier messages" | Infrastructure already exists; users understand the interaction |
| Keep tool_use/tool_result pairs together | Splitting creates orphaned, meaningless UI entries |
| Quarantine dir for corrupt files | Preserves data for manual recovery; doesn't silently delete |
| Repair before quarantine | Maximizes data recovery; quarantine is last resort |
| Reusable context menu component | First context menu in codebase; making it reusable prevents future duplication |
| No new IPC channels | All features work with existing infrastructure |
| Synthetic tool_result for orphans | Clearly marks interrupted tool calls; `metadata.synthetic` flag prevents confusion |
| Tmp cleanup before state load | Recovers from mid-write crashes before loading potentially stale data |

---

## Consensus Review

Reviewed via multi-provider consensus query:
- **Claude**: Validated all design decisions. Confirmed message-count approach over token budget. Identified edge cases (rapid restores, thinking blocks, attachments).
- **Codex**: Provider timed out (connectivity issue, not design concern).
- **Gemini**: CLI unavailable (connectivity issue, not design concern).

Single-provider review validated the core design. Full multi-provider review recommended on the implementation plan.
