# Session Recovery Features Implementation Plan

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](../../plans/2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** `session-repair.ts` (transcript validation, tmp cleanup) wired into continuity, `selectMessagesForRestore()`, context-menu component and fork UI in the output stream.


> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement session forking UI, message-count restore, and multi-layer session repair to improve session resilience.

**Architecture:** Three independent features that share no code paths. Feature 1 (Fork UI) is frontend-only — a context menu triggers the existing `SESSION_FORK` IPC handler. Feature 2 (Message-Count Restore) is a ~15-line function inlined in the session-handlers fallback path. Feature 3 (Session Repair) is a new service with 3 repair layers integrated into `SessionContinuityManager` at startup, load, and resume.

**Tech Stack:** Angular 21 (signals, standalone components, OnPush), Electron IPC, Vitest, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-14-session-recovery-features-design.md`

---

## File Map

| File | Role | Task |
|------|------|------|
| `src/main/session/session-repair.ts` | NEW — 3-layer repair service (file, transcript, tmp) | 1 |
| `src/main/session/session-repair.spec.ts` | NEW — repair service tests | 1 |
| `src/main/session/session-continuity.ts` | Integrate repair at startup/load/resume | 2 |
| `src/main/ipc/handlers/session-handlers.ts` | Add `selectMessagesForRestore()` + integrate in fallback | 3 |
| `src/main/ipc/handlers/session-handlers.spec.ts` | Tests for message selection | 3 |
| `src/renderer/app/features/instance-detail/display-item-processor.service.ts` | Add `bufferIndex` to DisplayItem | 4 |
| `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts` | Test bufferIndex propagation | 4 |
| `src/renderer/app/shared/components/context-menu/context-menu.component.ts` | NEW — reusable context menu | 5 |
| `src/renderer/app/features/instance-detail/output-stream.component.ts` | Add contextmenu handler + fork action | 6 |

---

## Chunk 1: Session Repair Service

### Task 1: Session Repair — Types and Transcript Validation (TDD)

**Files:**
- Create: `src/main/session/session-repair.ts`
- Create: `src/main/session/session-repair.spec.ts`

**Reference:** `src/main/session/session-continuity.ts:75-88` for `ConversationEntry` type definition

- [ ] **Step 1: Write failing tests for `validateTranscript`**

```typescript
// src/main/session/session-repair.spec.ts
import { describe, it, expect } from 'vitest';
import { validateTranscript } from './session-repair';
import type { ConversationEntry } from './session-continuity';

describe('validateTranscript', () => {
  function entry(overrides: Partial<ConversationEntry> & { role: ConversationEntry['role'] }): ConversationEntry {
    return {
      id: `test-${Math.random().toString(36).slice(2)}`,
      content: 'test content',
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it('returns ok for a valid transcript', () => {
    const history = [
      entry({ role: 'user', content: 'hello' }),
      entry({ role: 'assistant', content: 'hi' }),
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('ok');
    expect(result.repairs).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
  });

  it('inserts synthetic tool_result for orphaned tool_use', () => {
    const history = [
      entry({ role: 'user', content: 'do something' }),
      entry({
        role: 'assistant',
        content: 'calling tool',
        toolUse: { toolName: 'bash', input: { cmd: 'ls' } },
      }),
      // Missing tool_result — process crashed
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('repaired');
    expect(result.entries).toHaveLength(3);
    expect(result.entries[2].role).toBe('tool');
    expect(result.entries[2].content).toContain('interrupted');
    expect(result.repairs).toEqual(
      expect.arrayContaining([expect.stringContaining('orphaned')])
    );
  });

  it('does not insert synthetic result when tool_result follows', () => {
    const history = [
      entry({
        role: 'assistant',
        content: 'calling tool',
        toolUse: { toolName: 'bash', input: { cmd: 'ls' } },
      }),
      entry({ role: 'tool', content: 'file1.ts\nfile2.ts' }),
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('ok');
    expect(result.entries).toHaveLength(2);
  });

  it('removes empty entries with no tool_use', () => {
    const history = [
      entry({ role: 'user', content: 'hello' }),
      entry({ role: 'assistant', content: '' }), // empty noise
      entry({ role: 'assistant', content: 'real response' }),
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('repaired');
    expect(result.entries).toHaveLength(2);
    expect(result.repairs).toEqual(
      expect.arrayContaining([expect.stringContaining('empty')])
    );
  });

  it('keeps entries with tool_use even if content is empty', () => {
    const history = [
      entry({
        role: 'assistant',
        content: '',
        toolUse: { toolName: 'read', input: { path: '/foo' } },
      }),
      entry({ role: 'tool', content: 'file contents' }),
    ];
    const result = validateTranscript(history);
    expect(result.entries).toHaveLength(2);
  });

  it('warns on non-monotonic timestamps without removing', () => {
    const now = Date.now();
    const history = [
      entry({ role: 'user', content: 'a', timestamp: now }),
      entry({ role: 'assistant', content: 'b', timestamp: now - 5000 }),
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('repaired');
    expect(result.entries).toHaveLength(2); // Not removed
    expect(result.repairs).toEqual(
      expect.arrayContaining([expect.stringContaining('Non-monotonic')])
    );
  });

  it('does not mutate the input array', () => {
    const history = [
      entry({
        role: 'assistant',
        content: 'tool call',
        toolUse: { toolName: 'bash', input: {} },
      }),
    ];
    const originalLength = history.length;
    validateTranscript(history);
    expect(history).toHaveLength(originalLength);
  });

  it('handles empty history', () => {
    const result = validateTranscript([]);
    expect(result.status).toBe('ok');
    expect(result.entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/session/session-repair.spec.ts`
Expected: FAIL — module `./session-repair` not found

- [ ] **Step 3: Implement `validateTranscript`**

```typescript
// src/main/session/session-repair.ts
/**
 * Session Repair Service — Multi-layer session data validation and recovery.
 *
 * Layer 1: File-level validation & recovery (repairFile)
 * Layer 2: Transcript-level validation (validateTranscript)
 * Layer 3: Orphaned tmp file cleanup (cleanupOrphanedTmpFiles)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import type { ConversationEntry } from './session-continuity';

const logger = getLogger('SessionRepair');

// ============================================
// Types
// ============================================

export interface RepairResult {
  status: 'ok' | 'repaired' | 'quarantined' | 'unrecoverable';
  repairs: string[];
  quarantinedPath?: string;
}

export interface TranscriptRepairResult {
  status: 'ok' | 'repaired';
  entries: ConversationEntry[];
  repairs: string[];
}

export interface TmpCleanupResult {
  recovered: string[];
  deleted: string[];
  failed: string[];
}

// ============================================
// Layer 2: Transcript-Level Validation
// ============================================

export function validateTranscript(
  history: ConversationEntry[]
): TranscriptRepairResult {
  if (history.length === 0) {
    return { status: 'ok', entries: [], repairs: [] };
  }

  const repairs: string[] = [];
  const entries = [...history]; // Don't mutate input

  // 2a. Orphan tool_use detection — insert synthetic tool_result
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.toolUse && entry.role === 'assistant') {
      const next = entries[i + 1];
      if (!next || next.role !== 'tool') {
        const synthetic: ConversationEntry = {
          id: `repair-${Date.now()}-${i}`,
          role: 'tool',
          content: '[Tool execution interrupted — session recovered]',
          timestamp: entry.timestamp + 1,
          toolUse: {
            toolName: entry.toolUse.toolName,
            input: entry.toolUse.input,
            output: '[interrupted]',
          },
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
  const filtered = entries.filter(
    (e) => e.content.length > 0 || e.toolUse != null
  );
  if (filtered.length < beforeCount) {
    repairs.push(`Removed ${beforeCount - filtered.length} empty entries`);
  }

  // 2c. Timestamp monotonicity check (warn only)
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
    repairs,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/session/session-repair.spec.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/session/session-repair.ts src/main/session/session-repair.spec.ts
git commit -m "feat: add transcript validation for session repair (Layer 2)"
```

---

### Task 2: Session Repair — File Repair and Tmp Cleanup (Layers 1 & 3)

**Files:**
- Modify: `src/main/session/session-repair.ts`
- Modify: `src/main/session/session-repair.spec.ts`

- [ ] **Step 1: Write failing tests for `cleanupOrphanedTmpFiles` and `repairFile`**

Add to `session-repair.spec.ts`:

```typescript
import { cleanupOrphanedTmpFiles, repairFile } from './session-repair';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('cleanupOrphanedTmpFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'repair-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('deletes .tmp when corresponding .json exists', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'state.json'), '{"valid": true}');
    await fs.promises.writeFile(path.join(tmpDir, 'state.json.tmp'), '{"partial": true}');

    const result = await cleanupOrphanedTmpFiles(tmpDir);
    expect(result.deleted).toHaveLength(1);
    expect(result.recovered).toHaveLength(0);

    const files = await fs.promises.readdir(tmpDir);
    expect(files).toEqual(['state.json']);
  });

  it('promotes .tmp to .json when .json is missing', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'orphan.json.tmp'), '{"recovered": true}');

    const result = await cleanupOrphanedTmpFiles(tmpDir);
    expect(result.recovered).toHaveLength(1);
    expect(result.deleted).toHaveLength(0);

    const files = await fs.promises.readdir(tmpDir);
    expect(files).toEqual(['orphan.json']);
  });

  it('handles empty directory', async () => {
    const result = await cleanupOrphanedTmpFiles(tmpDir);
    expect(result.recovered).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

describe('repairFile', () => {
  let tmpDir: string;
  let quarantineDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'repair-file-'));
    quarantineDir = path.join(tmpDir, 'quarantine');
    await fs.promises.mkdir(quarantineDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns ok for valid JSON file', () => {
    const filePath = path.join(tmpDir, 'good.json');
    fs.writeFileSync(filePath, JSON.stringify({ encrypted: false, data: '{"valid":true}' }));

    const result = repairFile(filePath, quarantineDir);
    expect(result.status).toBe('ok');
  });

  it('quarantines unrecoverable file', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, 'this is not json at all {{{{');

    const result = repairFile(filePath, quarantineDir);
    expect(result.status).toBe('quarantined');
    expect(result.quarantinedPath).toBeTruthy();

    // Original should be gone
    expect(fs.existsSync(filePath)).toBe(false);
    // Quarantined copy should exist
    expect(fs.existsSync(result.quarantinedPath!)).toBe(true);
  });

  it('repairs file with valid envelope but corrupt inner data', () => {
    const filePath = path.join(tmpDir, 'partial.json');
    // Valid envelope wrapping invalid inner JSON
    fs.writeFileSync(filePath, JSON.stringify({ encrypted: false, data: '{invalid json' }));

    const result = repairFile(filePath, quarantineDir);
    // Can't fix invalid inner JSON — quarantine
    expect(['quarantined', 'unrecoverable']).toContain(result.status);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/session/session-repair.spec.ts`
Expected: FAIL — `cleanupOrphanedTmpFiles` and `repairFile` not exported

- [ ] **Step 3: Implement `cleanupOrphanedTmpFiles` and `repairFile`**

Add to `src/main/session/session-repair.ts`:

```typescript
// ============================================
// Layer 1: File-Level Validation & Recovery
// ============================================

export function repairFile(
  filePath: string,
  quarantineDir: string
): RepairResult {
  const repairs: string[] = [];

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');

    // Try parsing as the envelope format
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && 'encrypted' in parsed && 'data' in parsed) {
        // Envelope parsed — try inner data
        if (parsed['encrypted'] === false && typeof parsed['data'] === 'string') {
          try {
            JSON.parse(parsed['data'] as string);
            return { status: 'ok', repairs: [] }; // Both layers valid
          } catch {
            repairs.push('Envelope valid but inner data corrupt');
          }
        } else if (parsed['encrypted'] === true) {
          // Can't repair encrypted data
          repairs.push('Encrypted file — cannot repair inner data');
        } else {
          return { status: 'ok', repairs: [] }; // Legacy plain JSON
        }
      } else {
        return { status: 'ok', repairs: [] }; // Legacy plain JSON, valid
      }
    } catch {
      repairs.push('Outer JSON parse failed');
    }
  } catch (readError) {
    repairs.push(`File read failed: ${(readError as Error).message}`);
  }

  // If we got here, the file is not usable — quarantine it
  return quarantineFile(filePath, quarantineDir, repairs);
}

function quarantineFile(
  filePath: string,
  quarantineDir: string,
  repairs: string[]
): RepairResult {
  const filename = path.basename(filePath);
  const quarantinedPath = path.join(
    quarantineDir,
    `${filename}.${Date.now()}.corrupt`
  );

  try {
    fs.renameSync(filePath, quarantinedPath);
    repairs.push(`Quarantined to ${quarantinedPath}`);
    logger.warn('File quarantined', { filePath, quarantinedPath, repairs });
    return { status: 'quarantined', repairs, quarantinedPath };
  } catch (error) {
    repairs.push(`Quarantine failed: ${(error as Error).message}`);
    logger.error('Failed to quarantine file', error instanceof Error ? error : undefined, { filePath });
    return { status: 'unrecoverable', repairs };
  }
}

// ============================================
// Layer 3: Orphaned Tmp File Cleanup
// ============================================

export async function cleanupOrphanedTmpFiles(
  directory: string
): Promise<TmpCleanupResult> {
  const recovered: string[] = [];
  const deleted: string[] = [];
  const failed: string[] = [];

  let files: string[];
  try {
    files = await fs.promises.readdir(directory);
  } catch {
    return { recovered, deleted, failed };
  }

  const tmpFiles = files.filter((f) => f.endsWith('.tmp'));

  for (const tmpFile of tmpFiles) {
    const tmpPath = path.join(directory, tmpFile);
    // Derive the target .json name: "state.json.tmp" → "state.json"
    const jsonName = tmpFile.replace(/\.tmp$/, '');
    const jsonPath = path.join(directory, jsonName);

    try {
      const jsonExists = files.includes(jsonName);

      if (jsonExists) {
        // .json exists → delete the orphaned .tmp
        await fs.promises.unlink(tmpPath);
        deleted.push(tmpFile);
        logger.debug('Deleted orphaned tmp file', { tmpFile, reason: 'json exists' });
      } else {
        // .json missing → promote .tmp to .json
        await fs.promises.rename(tmpPath, jsonPath);
        recovered.push(tmpFile);
        logger.info('Recovered orphaned tmp file', { tmpFile, promotedTo: jsonName });
      }
    } catch (error) {
      failed.push(tmpFile);
      logger.error('Failed to process orphaned tmp file', error instanceof Error ? error : undefined, { tmpFile });
    }
  }

  return { recovered, deleted, failed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/session/session-repair.spec.ts`
Expected: All tests PASS

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npx eslint src/main/session/session-repair.ts src/main/session/session-repair.spec.ts`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/session/session-repair.ts src/main/session/session-repair.spec.ts
git commit -m "feat: add file repair and tmp cleanup for session repair (Layers 1 & 3)"
```

---

### Task 3: Integrate Repair into SessionContinuityManager

**Files:**
- Modify: `src/main/session/session-continuity.ts:176-181` (initAsync)
- Modify: `src/main/session/session-continuity.ts:747-755` (readPayload)
- Modify: `src/main/session/session-continuity.ts:452-507` (resumeSession)

- [ ] **Step 1: Add import at top of session-continuity.ts**

After the existing imports (~line 20):

```typescript
import { cleanupOrphanedTmpFiles, repairFile, validateTranscript } from './session-repair';
```

- [ ] **Step 2: Integrate Layer 3 into `initAsync` (line 176)**

Replace:
```typescript
private async initAsync(): Promise<void> {
  await this.ensureDirectories();
  await this.loadActiveStates();
```

With:
```typescript
private async initAsync(): Promise<void> {
  await this.ensureDirectories();

  // Layer 3: Clean up orphaned tmp files before loading states
  const stateTmp = await cleanupOrphanedTmpFiles(this.stateDir);
  const snapTmp = await cleanupOrphanedTmpFiles(this.snapshotDir);
  if (stateTmp.recovered.length || snapTmp.recovered.length) {
    logger.info('Recovered orphaned tmp files on startup', {
      states: stateTmp.recovered.length,
      snapshots: snapTmp.recovered.length,
    });
  }

  await this.loadActiveStates();
```

- [ ] **Step 3: Integrate Layer 1 into `readPayload` (~line 747)**

Replace the existing `readPayload` method:
```typescript
private async readPayload<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return this.deserializePayload<T>(raw);
  } catch (error) {
    logger.error('Failed to read continuity payload', error instanceof Error ? error : undefined);
    return null;
  }
}
```

With:
```typescript
private async readPayload<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const result = this.deserializePayload<T>(raw);
    if (result) return result;

    // Deserialization failed — attempt repair (Layer 1)
    const repair = repairFile(filePath, this.quarantineDir);
    if (repair.status === 'repaired') {
      logger.info('File repaired during load', { path: filePath, repairs: repair.repairs });
      const reRaw = await fs.promises.readFile(filePath, 'utf-8');
      return this.deserializePayload<T>(reRaw);
    }

    logger.warn('File unrecoverable during load', { path: filePath, status: repair.status });
    return null;
  } catch (error) {
    logger.error('Failed to read continuity payload', error instanceof Error ? error : undefined);
    return null;
  }
}
```

- [ ] **Step 4: Integrate Layer 2 into `resumeSession` (~line 487)**

After the line `if (!state) return null;` in `resumeSession()`, insert:

```typescript
    // Layer 2: Validate transcript integrity
    if (state.conversationHistory.length > 0) {
      const repairResult = validateTranscript(state.conversationHistory);
      if (repairResult.status === 'repaired') {
        state.conversationHistory = repairResult.entries;
        logger.info('Transcript repaired during resume', {
          instanceId,
          repairs: repairResult.repairs,
        });
      }
    }
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/session/session-continuity.ts
git commit -m "feat: integrate session repair into continuity manager startup/load/resume"
```

---

## Chunk 2: Message-Count Restore

### Task 4: Message-Count Selection for History Restore (TDD)

**Files:**
- Modify: `src/main/ipc/handlers/session-handlers.ts:1016-1062`
- Modify or create: `src/main/ipc/handlers/session-handlers.spec.ts`

**Reference:** The `HISTORY_RESTORE` handler's Phase 2 fallback is at lines 1016-1062. The `selectMessagesForRestore` function is inlined in the same file.

- [ ] **Step 1: Write failing tests for `selectMessagesForRestore`**

Check if `session-handlers.spec.ts` exists. If not, create it. Add:

```typescript
import { describe, it, expect } from 'vitest';

// The function will be exported for testing
import { selectMessagesForRestore } from './session-handlers';
import type { OutputMessage } from '../../../shared/types/instance.types';

function msg(type: OutputMessage['type'], index: number): OutputMessage {
  return {
    id: `msg-${index}`,
    timestamp: Date.now() + index,
    type,
    content: `Message ${index}`,
  };
}

describe('selectMessagesForRestore', () => {
  it('returns all messages when under limit', () => {
    const messages = [msg('user', 0), msg('assistant', 1)];
    const result = selectMessagesForRestore(messages, 100);
    expect(result.selected).toHaveLength(2);
    expect(result.truncatedCount).toBe(0);
  });

  it('caps at limit and returns truncated count', () => {
    const messages = Array.from({ length: 150 }, (_, i) => msg('user', i));
    const result = selectMessagesForRestore(messages, 100);
    expect(result.selected).toHaveLength(100);
    expect(result.truncatedCount).toBe(50);
  });

  it('keeps tool_use/tool_result pairs together at boundary', () => {
    // Messages: [user, assistant, tool_use, tool_result, user, ...]
    // If boundary falls on tool_result, include its tool_use too
    const messages = [
      ...Array.from({ length: 48 }, (_, i) => msg('user', i)),
      msg('tool_use', 48),
      msg('tool_result', 49),
      ...Array.from({ length: 100 }, (_, i) => msg('user', 50 + i)),
    ];
    // limit=100 → startIdx at 50 normally, but messages[50] is 'user' so no adjustment
    // Let's make the boundary land on tool_result:
    const msgs2 = [
      ...Array.from({ length: 49 }, (_, i) => msg('user', i)),
      msg('tool_use', 49),
      msg('tool_result', 50), // ← this would be at startIdx with limit=100
      ...Array.from({ length: 99 }, (_, i) => msg('user', 51 + i)),
    ];
    // total = 149, limit = 100, startIdx = 49, but msgs2[49] is tool_use not tool_result
    // startIdx should stay 49. Let's test with startIdx landing on tool_result:
    const msgs3 = [
      ...Array.from({ length: 50 }, (_, i) => msg('user', i)),
      msg('tool_result', 50), // ← startIdx with limit=100 from 150 total
      ...Array.from({ length: 99 }, (_, i) => msg('user', 51 + i)),
    ];
    const result = selectMessagesForRestore(msgs3, 100);
    // Should walk back to include the tool_use before tool_result
    expect(result.selected[0].type).not.toBe('tool_result');
    expect(result.selected.length).toBeGreaterThanOrEqual(100);
  });

  it('handles empty messages', () => {
    const result = selectMessagesForRestore([], 100);
    expect(result.selected).toHaveLength(0);
    expect(result.truncatedCount).toBe(0);
  });

  it('handles undefined messages', () => {
    const result = selectMessagesForRestore(undefined as any, 100);
    expect(result.selected).toHaveLength(0);
    expect(result.truncatedCount).toBe(0);
  });

  it('uses default limit of 100', () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg('user', i));
    const result = selectMessagesForRestore(messages);
    expect(result.selected).toHaveLength(100);
    expect(result.truncatedCount).toBe(100);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/ipc/handlers/session-handlers.spec.ts`
Expected: FAIL — `selectMessagesForRestore` not exported

- [ ] **Step 3: Add `selectMessagesForRestore` to session-handlers.ts**

Add near the top of the file (after imports, before the handler registrations):

```typescript
/**
 * Select the most recent messages within a count limit for display during restore.
 * Keeps tool_use/tool_result pairs together at the boundary.
 * Exported for testing.
 */
export function selectMessagesForRestore(
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
    truncatedCount: startIdx,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/ipc/handlers/session-handlers.spec.ts`
Expected: All tests PASS

- [ ] **Step 5: Integrate into HISTORY_RESTORE fallback path (~line 1022)**

In the replay-fallback branch, replace:
```typescript
initialOutputBuffer: data.messages,
```

With:
```typescript
// Cap initial display to last 100 messages; older available via "Load earlier messages"
const { selected: displayMessages, truncatedCount } =
  selectMessagesForRestore(data.messages, 100);
```

Then use `displayMessages` as `initialOutputBuffer`:
```typescript
initialOutputBuffer: displayMessages,
```

Update the system message content (~line 1035) to mention truncation when applicable:
```typescript
content: truncatedCount > 0
  ? `Previous ${providerName} CLI session could not be restored. Your conversation history is displayed above (${truncatedCount} earlier messages available via "Load earlier messages"), but ${providerName} does not have this context. You may need to re-summarize what you were working on.`
  : `Previous ${providerName} CLI session could not be restored. Your conversation history is displayed above, but ${providerName} does not have this context. You may need to re-summarize what you were working on.`,
```

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/main/ipc/handlers/session-handlers.ts`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/handlers/session-handlers.ts src/main/ipc/handlers/session-handlers.spec.ts
git commit -m "feat: add message-count cap to history restore fallback path"
```

---

## Chunk 3: Session Fork UI

### Task 5: Add `bufferIndex` to DisplayItem (TDD)

**Files:**
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.ts:12-25`
- Modify: `src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`

- [ ] **Step 1: Write failing test for bufferIndex**

Add to `display-item-processor.service.spec.ts`:

```typescript
it('should set bufferIndex on each message item', () => {
  const messages: OutputMessage[] = [
    { id: '1', timestamp: 1000, type: 'user', content: 'hello' },
    { id: '2', timestamp: 2000, type: 'assistant', content: 'hi' },
    { id: '3', timestamp: 3000, type: 'user', content: 'how are you' },
  ];
  const items = processor.process(messages);
  const messageItems = items.filter(i => i.type === 'message');
  for (const item of messageItems) {
    expect(item.bufferIndex).toBeDefined();
    expect(typeof item.bufferIndex).toBe('number');
  }
  // First user message should have bufferIndex 0
  expect(messageItems[0].bufferIndex).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts -t "bufferIndex"`
Expected: FAIL — `bufferIndex` is undefined

- [ ] **Step 3: Add `bufferIndex` to DisplayItem interface and set it during processing**

In `display-item-processor.service.ts`, add to the `DisplayItem` interface (line 12):

```typescript
export interface DisplayItem {
  // ... existing fields
  bufferIndex?: number; // Index in the original outputBuffer for fork operations
}
```

In the `convertToItems` method, where items are created from messages, set `bufferIndex` to `this.lastProcessedCount - newMessages.length + localIndex` (the offset into the full message array). The exact insertion depends on where items are created — look for where `type: 'message'` items are constructed and add `bufferIndex: offset + i` where `offset = this.lastProcessedCount - newMessages.length`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
Expected: All tests PASS (including existing tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/features/instance-detail/display-item-processor.service.ts src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts
git commit -m "feat: add bufferIndex to DisplayItem for fork operations"
```

---

### Task 6: Context Menu Component

**Files:**
- Create: `src/renderer/app/shared/components/context-menu/context-menu.component.ts`

- [ ] **Step 1: Create the context menu component**

```typescript
// src/renderer/app/shared/components/context-menu/context-menu.component.ts
import {
  Component,
  input,
  output,
  ChangeDetectionStrategy,
  HostListener,
  ElementRef,
  inject,
} from '@angular/core';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  action: () => void;
  disabled?: boolean;
  divider?: boolean;
}

@Component({
  selector: 'app-context-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="context-menu" [style.left.px]="x()" [style.top.px]="y()">
        @for (item of items(); track item.label) {
          @if (item.divider) {
            <div class="context-menu-divider"></div>
          }
          <button
            class="context-menu-item"
            [class.disabled]="item.disabled"
            [disabled]="item.disabled"
            (click)="onItemClick(item)"
          >
            {{ item.label }}
          </button>
        }
      </div>
    }
  `,
  styles: [`
    :host {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 10000;
      pointer-events: none;
    }

    :host(.active) {
      pointer-events: all;
    }

    .context-menu {
      position: fixed;
      min-width: 160px;
      background: var(--bg-secondary, #1e1e2e);
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
      border-radius: 8px;
      padding: 4px 0;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      pointer-events: all;
      z-index: 10001;
    }

    .context-menu-item {
      display: block;
      width: 100%;
      padding: 8px 16px;
      border: none;
      background: none;
      color: var(--text-primary, #cdd6f4);
      font-size: 13px;
      text-align: left;
      cursor: pointer;
      transition: background 0.1s;
    }

    .context-menu-item:hover:not(.disabled) {
      background: var(--bg-hover, rgba(255, 255, 255, 0.08));
    }

    .context-menu-item.disabled {
      opacity: 0.4;
      cursor: default;
    }

    .context-menu-divider {
      height: 1px;
      background: var(--border-color, rgba(255, 255, 255, 0.1));
      margin: 4px 0;
    }
  `],
})
export class ContextMenuComponent {
  private el = inject(ElementRef);

  items = input.required<ContextMenuItem[]>();
  x = input.required<number>();
  y = input.required<number>();
  visible = input.required<boolean>();
  closed = output<void>();

  onItemClick(item: ContextMenuItem): void {
    if (!item.disabled) {
      item.action();
      this.closed.emit();
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.visible()) {
      // Close if click is outside the menu
      const menuEl = this.el.nativeElement.querySelector('.context-menu');
      if (menuEl && !menuEl.contains(event.target as Node)) {
        this.closed.emit();
      }
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.visible()) {
      this.closed.emit();
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/shared/components/context-menu/context-menu.component.ts
git commit -m "feat: add reusable context menu component"
```

---

### Task 7: Wire Fork UI into Output Stream

**Files:**
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.ts`

**Reference:** The template is in the component decorator (line 45+). The `.transcript-item` div is at line 63. Existing imports are at lines 8-31.

- [ ] **Step 1: Add imports**

Add to the imports at the top of the file:

```typescript
import { ContextMenuComponent, ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';
```

Add `ContextMenuComponent` to the component's `imports` array (line 44).

- [ ] **Step 2: Add context menu signals and template**

Add signals to the component class:

```typescript
contextMenuVisible = signal(false);
contextMenuX = signal(0);
contextMenuY = signal(0);
contextMenuItems = signal<ContextMenuItem[]>([]);
```

Add the context menu component to the template, just before the closing of the `@else` block:

```html
<app-context-menu
  [items]="contextMenuItems()"
  [x]="contextMenuX()"
  [y]="contextMenuY()"
  [visible]="contextMenuVisible()"
  (closed)="contextMenuVisible.set(false)"
/>
```

- [ ] **Step 3: Add `(contextmenu)` handler to transcript-item**

Change the `.transcript-item` div (line 63) from:
```html
<div class="transcript-item" [attr.data-item-index]="i">
```
To:
```html
<div class="transcript-item" [attr.data-item-index]="i" (contextmenu)="onContextMenu($event, item, i)">
```

- [ ] **Step 4: Add component methods**

```typescript
onContextMenu(event: MouseEvent, item: DisplayItem, _index: number): void {
  event.preventDefault();
  const menuItems = this.buildContextMenuItems(item);
  if (menuItems.length === 0) return;

  this.contextMenuX.set(event.clientX);
  this.contextMenuY.set(event.clientY);
  this.contextMenuItems.set(menuItems);
  this.contextMenuVisible.set(true);
}

private buildContextMenuItems(item: DisplayItem): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  // Copy message content
  const content = item.message?.content || item.response?.content;
  if (content) {
    items.push({
      label: 'Copy message',
      action: () => {
        navigator.clipboard.writeText(content);
        this.contextMenuVisible.set(false);
      },
    });
  }

  // Fork from here (only for user/assistant messages with bufferIndex)
  if (
    item.message &&
    ['user', 'assistant'].includes(item.message.type) &&
    item.bufferIndex !== undefined
  ) {
    items.push({
      label: 'Fork from here',
      divider: true,
      action: () => this.forkFromMessage(item),
    });
  }

  return items;
}

private async forkFromMessage(item: DisplayItem): Promise<void> {
  const instanceId = this.instanceId();
  const bufferIndex = item.bufferIndex;
  if (!instanceId || bufferIndex === undefined) return;

  this.contextMenuVisible.set(false);

  const result = await this.ipc.forkSession({
    instanceId,
    atMessageIndex: bufferIndex + 1,
    displayName: `Fork at message ${bufferIndex + 1}`,
  });

  if (result?.success && result.data?.id) {
    this.instanceStore.setSelectedInstance(result.data.id);
  }
}
```

Note: Check the component for how `ipc` and `instanceStore` are injected. The component likely already has `private ipc = inject(InstanceIpcService)` or similar. If `forkSession` is on `HistoryIpcService`, inject that one instead, or use the facade. Read the existing injections and follow the pattern.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/renderer/app/features/instance-detail/output-stream.component.ts`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/features/instance-detail/output-stream.component.ts
git commit -m "feat: add context menu with fork-from-here to output stream"
```

---

## Chunk 4: Final Verification

### Task 8: Full Verification Pass

- [ ] **Step 1: Run full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 3: Run all tests**

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 4: Run the modified test files specifically**

Run: `npx vitest run src/main/session/session-repair.spec.ts src/main/ipc/handlers/session-handlers.spec.ts src/renderer/app/features/instance-detail/display-item-processor.service.spec.ts`
Expected: All tests PASS

- [ ] **Step 5: Verify no stale imports**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No "Cannot find module" or "unused import" errors

- [ ] **Step 6: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore: final cleanup for session recovery features"
```
