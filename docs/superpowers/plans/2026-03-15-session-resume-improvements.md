# Session Resume Improvements Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve session resume reliability and UX with five features: token-budget fallback history injection, per-instance async mutex, conversation-aware rewind points, stuck process detection, and tool result deduplication.

**Architecture:** Five independent features targeting the session/instance layer. Each modifies 1-3 files. Features can be implemented in any order but recommended sequence maximizes incremental value: dedup → mutex → history injection → stuck detection → rewind points.

**Tech Stack:** TypeScript, Vitest, Electron (main process)

---

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `src/main/instance/instance-communication.ts` | Output handling, input dispatch | Add tool result dedup, rewind point triggers, stuck detector calls |
| `src/main/instance/instance-communication.spec.ts` | Communication manager tests | Add dedup + rewind point tests |
| `src/main/session/session-mutex.ts` | Per-instance async mutex | **New file** |
| `src/main/session/session-mutex.spec.ts` | Mutex tests | **New file** |
| `src/main/session/session-continuity.ts` | Session persistence | Replace `inFlightSaves` with mutex, add last-writer fields |
| `src/main/session/session-continuity.spec.ts` | Continuity tests | Add last-writer diagnostic tests |
| `src/main/session/fallback-history.ts` | Token-budget history builder | **New file** |
| `src/main/session/fallback-history.spec.ts` | History builder tests | **New file** |
| `src/main/instance/stuck-process-detector.ts` | Hung process detection | **New file** |
| `src/main/instance/stuck-process-detector.spec.ts` | Stuck detector tests | **New file** |
| `src/main/instance/instance-lifecycle.ts` | Instance lifecycle | Call fallback history, acquire mutex on state changes |
| `src/main/instance/instance-manager.ts` | Manager wiring | Wire stuck detector + snapshot callback |

---

## Chunk 1: Tool Result Deduplication

### Task 1: Add tool result dedup to communication manager

**Files:**
- Modify: `src/main/instance/instance-communication.ts:63-80` (field declarations), `:960-977` (addToOutputBuffer)
- Test: `src/main/instance/instance-communication.spec.ts`

- [ ] **Step 1: Write the failing test — skip duplicate tool_result**

In `src/main/instance/instance-communication.spec.ts`, add a new `describe('tool result deduplication')` block:

```typescript
describe('tool result deduplication', () => {
  it('skips duplicate tool_result with same tool_use_id', () => {
    const instance = createInstance();
    const toolUseId = 'tool-use-123';

    const first = createMessage('tool_result', 'result content', {
      metadata: { tool_use_id: toolUseId, is_error: false },
    });
    const duplicate = createMessage('tool_result', 'result content', {
      metadata: { tool_use_id: toolUseId, is_error: false },
    });

    comm.addToOutputBuffer(instance, first);
    comm.addToOutputBuffer(instance, duplicate);

    const toolResults = instance.outputBuffer.filter(m => m.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
  });

  it('allows tool_result without tool_use_id', () => {
    const instance = createInstance();

    const msg = createMessage('tool_result', 'system result', {
      metadata: {},
    });

    comm.addToOutputBuffer(instance, msg);
    comm.addToOutputBuffer(instance, { ...msg, id: 'different-id' });

    const toolResults = instance.outputBuffer.filter(m => m.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
  });

  it('allows different tool_use_ids', () => {
    const instance = createInstance();

    const msg1 = createMessage('tool_result', 'result 1', {
      metadata: { tool_use_id: 'id-1', is_error: false },
    });
    const msg2 = createMessage('tool_result', 'result 2', {
      metadata: { tool_use_id: 'id-2', is_error: false },
    });

    comm.addToOutputBuffer(instance, msg1);
    comm.addToOutputBuffer(instance, msg2);

    const toolResults = instance.outputBuffer.filter(m => m.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
  });
});
```

Note: Use the existing `createInstance` and `createMessage` helpers from the test file. If they don't exist, create minimal versions matching the existing test patterns (see `FakeAdapter` class at line 37).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/instance/instance-communication.spec.ts --reporter=verbose`
Expected: FAIL — duplicate is not being skipped yet

- [ ] **Step 3: Implement dedup in addToOutputBuffer**

In `src/main/instance/instance-communication.ts`:

Add field declaration after line 81 (`private pendingContextWarnings`):

```typescript
private seenToolResultIds = new Map<string, Set<string>>();
```

In `addToOutputBuffer` method (line 960), add dedup check at the top of the method body, after the error suppression block (after line 977):

```typescript
    // Tool result deduplication — skip duplicate tool_results by tool_use_id
    if (message.type === 'tool_result' && message.metadata) {
      const toolUseId = message.metadata['tool_use_id'] as string | undefined;
      if (toolUseId) {
        let seen = this.seenToolResultIds.get(instance.id);
        if (!seen) {
          seen = new Set();
          this.seenToolResultIds.set(instance.id, seen);
        }
        if (seen.has(toolUseId)) {
          logger.debug('Skipped duplicate tool_result', { instanceId: instance.id, toolUseId });
          return;
        }
        seen.add(toolUseId);
      }
    }
```

- [ ] **Step 4: Add cleanup for dedup state**

Find the existing `cleanupCircuitBreaker` method (line 199). Add a new method right after it:

```typescript
  cleanupToolResultDedup(instanceId: string): void {
    this.seenToolResultIds.delete(instanceId);
  }
```

Also add a call to `this.seenToolResultIds.delete(instanceId)` inside `cleanupCircuitBreaker` so existing cleanup paths cover it:

At line 200 (`this.circuitBreakers.delete(instanceId);`), add below it:
```typescript
    this.seenToolResultIds.delete(instanceId);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/instance/instance-communication.spec.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/instance-communication.ts src/main/instance/instance-communication.spec.ts
git commit -m "$(cat <<'EOF'
feat: add tool result deduplication in communication manager

Track seen tool_use_ids per instance in a Set. When a duplicate
tool_result arrives (same tool_use_id), skip it and log at debug level.
Prevents duplicate tool results from entering the output buffer during
stream reconnection or retries. Cleanup on instance terminate/restart.
EOF
)"
```

---

## Chunk 2: Per-Instance Async Mutex

### Task 2: Create SessionMutex class

**Files:**
- Create: `src/main/session/session-mutex.ts`
- Create: `src/main/session/session-mutex.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/session/session-mutex.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SessionMutex } from './session-mutex';

describe('SessionMutex', () => {
  let mutex: SessionMutex;

  beforeEach(() => {
    mutex = new SessionMutex();
  });

  it('acquires and releases a lock', async () => {
    const release = await mutex.acquire('inst-1', 'test');
    expect(mutex.isLocked('inst-1')).toBe(true);
    release();
    expect(mutex.isLocked('inst-1')).toBe(false);
  });

  it('queues concurrent acquires sequentially', async () => {
    const order: number[] = [];

    const release1 = await mutex.acquire('inst-1', 'first');
    order.push(1);

    const promise2 = mutex.acquire('inst-1', 'second').then(release => {
      order.push(2);
      return release;
    });

    // Release first lock — second should now acquire
    release1();
    const release2 = await promise2;
    release2();

    expect(order).toEqual([1, 2]);
  });

  it('allows locks on different instances concurrently', async () => {
    const release1 = await mutex.acquire('inst-1', 'a');
    const release2 = await mutex.acquire('inst-2', 'b');

    expect(mutex.isLocked('inst-1')).toBe(true);
    expect(mutex.isLocked('inst-2')).toBe(true);

    release1();
    release2();
  });

  it('forceRelease unblocks waiting acquires', async () => {
    const release1 = await mutex.acquire('inst-1', 'holder');

    let resolved = false;
    const promise2 = mutex.acquire('inst-1', 'waiter').then(release => {
      resolved = true;
      return release;
    });

    mutex.forceRelease('inst-1');

    const release2 = await promise2;
    expect(resolved).toBe(true);
    release2();
  });

  it('getLockInfo returns holder info', async () => {
    const release = await mutex.acquire('inst-1', 'test-source');
    const info = mutex.getLockInfo('inst-1');

    expect(info).not.toBeNull();
    expect(info!.source).toBe('test-source');
    expect(info!.durationMs).toBeGreaterThanOrEqual(0);

    release();
    expect(mutex.getLockInfo('inst-1')).toBeNull();
  });

  it('returns null for unlocked instance', () => {
    expect(mutex.isLocked('nonexistent')).toBe(false);
    expect(mutex.getLockInfo('nonexistent')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/session/session-mutex.spec.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SessionMutex**

Create `src/main/session/session-mutex.ts`:

```typescript
import { getLogger } from '../logging/logger';

const logger = getLogger('SessionMutex');

const LONG_HOLD_WARNING_MS = 30_000;

interface LockInfo {
  source: string;
  acquiredAt: number;
  warningTimer?: NodeJS.Timeout;
}

export class SessionMutex {
  private chains = new Map<string, Promise<void>>();
  private holders = new Map<string, LockInfo>();
  private forceResolvers = new Map<string, () => void>();

  async acquire(instanceId: string, source: string): Promise<() => void> {
    const prev = this.chains.get(instanceId) ?? Promise.resolve();

    let releaseFn!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    // Chain: wait for previous holder, then register ourselves
    const acquisition = prev.then(() => {
      const info: LockInfo = {
        source,
        acquiredAt: Date.now(),
      };

      info.warningTimer = setTimeout(() => {
        logger.warn('Lock held for >30s', {
          instanceId,
          source,
          durationMs: Date.now() - info.acquiredAt,
        });
      }, LONG_HOLD_WARNING_MS);
      if (info.warningTimer.unref) info.warningTimer.unref();

      this.holders.set(instanceId, info);

      // Store force-resolver so forceRelease can unblock
      this.forceResolvers.set(instanceId, releaseFn);
    });

    this.chains.set(instanceId, next);

    await acquisition;

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const info = this.holders.get(instanceId);
      if (info?.warningTimer) clearTimeout(info.warningTimer);
      this.holders.delete(instanceId);
      this.forceResolvers.delete(instanceId);

      releaseFn();
    };
  }

  forceRelease(instanceId: string): void {
    const info = this.holders.get(instanceId);
    if (info?.warningTimer) clearTimeout(info.warningTimer);
    this.holders.delete(instanceId);

    const resolver = this.forceResolvers.get(instanceId);
    if (resolver) {
      this.forceResolvers.delete(instanceId);
      logger.warn('Force-released lock', { instanceId, source: info?.source });
      resolver();
    }
  }

  isLocked(instanceId: string): boolean {
    return this.holders.has(instanceId);
  }

  getLockInfo(instanceId: string): { source: string; acquiredAt: number; durationMs: number } | null {
    const info = this.holders.get(instanceId);
    if (!info) return null;
    return {
      source: info.source,
      acquiredAt: info.acquiredAt,
      durationMs: Date.now() - info.acquiredAt,
    };
  }
}

// Singleton
let instance: SessionMutex | null = null;

export function getSessionMutex(): SessionMutex {
  if (!instance) {
    instance = new SessionMutex();
  }
  return instance;
}

export function _resetSessionMutexForTesting(): void {
  instance = null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/session/session-mutex.spec.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/session/session-mutex.ts src/main/session/session-mutex.spec.ts
git commit -m "$(cat <<'EOF'
feat: add per-instance async mutex for session state protection

Promise-based mutex that queues concurrent acquires sequentially.
No TTL — lock held until explicitly released or force-released.
Diagnostic warning after 30s hold. Singleton via getSessionMutex().
EOF
)"
```

### Task 3: Integrate mutex into session continuity and lifecycle

**Files:**
- Modify: `src/main/session/session-continuity.ts:49-73` (SessionState), `:156` (inFlightSaves), `:721-738` (saveStateAsync)
- Modify: `src/main/instance/instance-lifecycle.ts:699` (terminateInstance)

- [ ] **Step 1: Add last-writer fields to SessionState**

In `src/main/session/session-continuity.ts`, after line 73 (`hooksActive: string[];`), add:

```typescript
  lastWriteTimestamp?: number;
  lastWriteSource?: string;
```

- [ ] **Step 2: Replace inFlightSaves with mutex in saveStateAsync**

In `src/main/session/session-continuity.ts`:

Add import at top (after line 22):
```typescript
import { getSessionMutex } from './session-mutex';
```

Remove the `inFlightSaves` field declaration at line 159:
```typescript
// DELETE: private inFlightSaves = new Set<string>();
```

In `startGlobalAutoSave` (line 278), replace the `inFlightSaves` guard:
```typescript
// Change from:
if (this.inFlightSaves.has(instanceId)) continue;
// Change to:
if (getSessionMutex().isLocked(instanceId)) continue;
```

Replace `saveStateAsync` method (lines 721-738) with:

```typescript
  private async saveStateAsync(instanceId: string): Promise<void> {
    const state = this.sessionStates.get(instanceId);
    if (!state) return;

    const mutex = getSessionMutex();
    const release = await mutex.acquire(instanceId, 'auto-save');
    try {
      state.lastWriteTimestamp = Date.now();
      state.lastWriteSource = 'auto-save';

      const stateFile = path.join(this.stateDir, `${instanceId}.json`);
      await this.writePayload(stateFile, state);
      this.dirty.delete(instanceId);
      this.emit('state:saved', { instanceId });
    } catch (error) {
      logger.error('Failed to save session state', error instanceof Error ? error : undefined, { instanceId });
      this.emit('state:save-error', { instanceId, error });
    } finally {
      release();
    }
  }
```

- [ ] **Step 3: Add crash-during-write diagnostic in loadActiveStates**

In `loadActiveStates` (line 207), after loading each state (after `this.sessionStates.set(data.instanceId, data);` around line 225), add:

```typescript
        // Diagnostic: warn if last write was very recent (possible crash during save)
        if (data.lastWriteTimestamp && Date.now() - data.lastWriteTimestamp < 5000) {
          logger.warn('Session state has very recent write timestamp — possible crash during save', {
            instanceId: data.instanceId,
            lastWriteSource: data.lastWriteSource,
            ageMs: Date.now() - data.lastWriteTimestamp,
          });
        }
```

- [ ] **Step 4: Add forceRelease in terminateInstance**

In `src/main/instance/instance-lifecycle.ts`, add import at top:
```typescript
import { getSessionMutex } from '../session/session-mutex';
```

In `terminateInstance` method (line 699), add at the beginning of the method body (after getting the instance):

```typescript
    // Release any held mutex lock to prevent orphaned locks
    getSessionMutex().forceRelease(instanceId);
```

- [ ] **Step 5: Wrap lifecycle methods with mutex acquire/release**

In `src/main/instance/instance-lifecycle.ts`, wrap each of these 5 methods with mutex protection. For each method, add `const release = await getSessionMutex().acquire(instanceId, '<source>');` at the start (after getting the instance) and `release()` in a `finally` block.

**`toggleYoloMode` (line 1214):**
```typescript
  async toggleYoloMode(instanceId: string): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) throw new Error(`Instance ${instanceId} not found`);

    const release = await getSessionMutex().acquire(instanceId, 'yolo-toggle');
    try {
      // ... existing method body (minus the instance lookup) ...
    } finally {
      release();
    }
  }
```

**`changeModel` (line 1381):** Same pattern with source `'model-change'`.

**`changeAgentMode` (line 1056):** Same pattern with source `'agent-mode-change'`.

**`respawnAfterInterrupt` (line 1585):** Same pattern with source `'respawn-interrupt'`.

**`respawnAfterUnexpectedExit` (line 1706):** Same pattern with source `'respawn-unexpected'`.

For each method: move the instance existence check before the acquire (so we don't acquire on a nonexistent instance), then wrap the rest in try/finally.

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 7: Run existing tests**

Run: `npx vitest run src/main/session/ --reporter=verbose`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/main/session/session-continuity.ts src/main/instance/instance-lifecycle.ts
git commit -m "$(cat <<'EOF'
feat: integrate session mutex into continuity saves and lifecycle

Replace inFlightSaves Set with async mutex in saveStateAsync. Wrap
toggleYoloMode, changeModel, changeAgentMode, respawnAfterInterrupt,
and respawnAfterUnexpectedExit with mutex acquire/release. Add
last-writer timestamp diagnostics. Force-release on termination.
EOF
)"
```

---

## Chunk 3: Token-Budget Fallback History Injection

### Task 4: Create fallback history builder

**Files:**
- Create: `src/main/session/fallback-history.ts`
- Create: `src/main/session/fallback-history.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/session/fallback-history.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildFallbackHistoryMessage } from './fallback-history';
import type { OutputMessage } from '../../shared/types/instance.types';

function msg(type: OutputMessage['type'], content: string, overrides: Partial<OutputMessage> = {}): OutputMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    type,
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('buildFallbackHistoryMessage', () => {
  it('returns null for empty message list', () => {
    expect(buildFallbackHistoryMessage([], 'test', 200_000)).toBeNull();
  });

  it('includes SESSION RECOVERY header with reason', () => {
    const messages = [msg('user', 'hello'), msg('assistant', 'hi')];
    const result = buildFallbackHistoryMessage(messages, 'resume-failed', 200_000);
    expect(result).toContain('[SESSION RECOVERY');
    expect(result).toContain('resume-failed');
  });

  it('includes all messages for short conversations within budget', () => {
    const messages = [
      msg('user', 'write tests'),
      msg('assistant', 'I will write tests'),
      msg('user', 'thanks'),
      msg('assistant', 'done'),
    ];
    const result = buildFallbackHistoryMessage(messages, 'test', 200_000)!;
    expect(result).toContain('[USER]');
    expect(result).toContain('write tests');
    expect(result).toContain('done');
  });

  it('truncates tool outputs older than last 5 turns', () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(msg('user', `question ${i}`));
      messages.push(msg('assistant', `answer ${i}`));
      messages.push(msg('tool_result', 'x'.repeat(500), {
        metadata: { name: 'Read', tool_use_id: `tool-${i}` },
      }));
    }
    const result = buildFallbackHistoryMessage(messages, 'test', 200_000)!;
    // Old tool outputs should be truncated
    expect(result).toContain('output truncated');
    // Recent tool outputs should be intact
    expect(result).toContain('x'.repeat(500));
  });

  it('shrinks to fit within budget', () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push(msg('user', `long question ${i} ${'x'.repeat(200)}`));
      messages.push(msg('assistant', `long answer ${i} ${'y'.repeat(200)}`));
    }
    // Very tight budget — should shrink
    const result = buildFallbackHistoryMessage(messages, 'test', 4_000)!;
    expect(result).not.toBeNull();
    // Rough token estimate: result chars / 4 should be <= budget
    expect(result.length / 4).toBeLessThanOrEqual(4_000);
    // Should contain metadata header about omitted turns
    expect(result).toContain('exchanges');
  });

  it('preserves minimum of 3 turns even under tight budget', () => {
    const messages: OutputMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(msg('user', `q${i} ${'z'.repeat(100)}`));
      messages.push(msg('assistant', `a${i} ${'z'.repeat(100)}`));
    }
    const result = buildFallbackHistoryMessage(messages, 'test', 500)!;
    expect(result).not.toBeNull();
    // Should have at least some content
    expect(result).toContain('[USER]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/session/fallback-history.spec.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement fallback history builder**

Create `src/main/session/fallback-history.ts`:

```typescript
import type { OutputMessage } from '../../shared/types/instance.types';

const CHARS_PER_TOKEN = 4;
const RECENT_TURNS_THRESHOLD = 5;
const MIN_TURNS = 3;
const TOOL_TRUNCATE_LIMIT = 200;

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function roleLabel(type: OutputMessage['type']): string {
  switch (type) {
    case 'user': return '[USER]';
    case 'assistant': return '[ASSISTANT]';
    case 'tool_use': return '[TOOL_USE]';
    case 'tool_result': {
      return '[TOOL_RESULT]';
    }
    case 'system': return '[SYSTEM]';
    case 'error': return '[ERROR]';
    default: return `[${String(type).toUpperCase()}]`;
  }
}

function toolName(message: OutputMessage): string {
  const name = message.metadata?.['name'] as string | undefined;
  return name ? `: ${name}` : '';
}

function formatMessage(message: OutputMessage, truncateToolOutput: boolean): string {
  const label = message.type === 'tool_result'
    ? `[TOOL${toolName(message)}]`
    : message.type === 'tool_use'
      ? `[TOOL_USE${toolName(message)}]`
      : roleLabel(message.type);

  const time = formatTimestamp(message.timestamp);
  let content = message.content;

  if (truncateToolOutput && (message.type === 'tool_result' || message.type === 'tool_use')) {
    if (content.length > TOOL_TRUNCATE_LIMIT) {
      content = `[Tool${toolName(message)} — output truncated for recovery, ${content.length} chars original]`;
    }
  }

  return `${label} (${time}): ${content}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function buildMetadataHeader(messages: OutputMessage[], totalTurns: number): string {
  const firstUser = messages.find(m => m.type === 'user');
  const toolNames = new Set<string>();
  for (const m of messages) {
    if (m.type === 'tool_use' || m.type === 'tool_result') {
      const name = m.metadata?.['name'] as string | undefined;
      if (name) toolNames.add(name);
    }
  }

  const lines = [
    `Original objective: ${firstUser?.content.slice(0, 200) || 'Unknown'}`,
    `Total exchanges: ${totalTurns} user+assistant exchanges`,
  ];

  if (toolNames.size > 0) {
    lines.push(`Tools used: ${Array.from(toolNames).join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Build a fallback history message for session recovery.
 * Uses token-budget allocation to fit conversation history within
 * a fraction of the model's context window.
 *
 * @param messages - All available messages (outputBuffer + historical)
 * @param reason - Why the session failed (e.g., 'resume-failed-fallback')
 * @param contextWindowTokens - Total context window size in tokens
 * @param budgetFraction - Fraction of context to use (default 0.3 = 30%)
 * @returns Formatted recovery message, or null if no messages
 */
export function buildFallbackHistoryMessage(
  messages: OutputMessage[],
  reason: string,
  contextWindowTokens: number,
  budgetFraction = 0.3,
): string | null {
  if (messages.length === 0) return null;

  const budgetTokens = Math.floor(contextWindowTokens * budgetFraction);
  const conversational = messages.filter(
    m => m.type === 'user' || m.type === 'assistant' || m.type === 'tool_use' || m.type === 'tool_result'
  );

  if (conversational.length === 0) return null;

  // Identify recent vs old boundary (last 5 user turns)
  let recentBoundary = conversational.length;
  let userTurnsSeen = 0;
  for (let i = conversational.length - 1; i >= 0; i--) {
    if (conversational[i].type === 'user') {
      userTurnsSeen++;
      if (userTurnsSeen >= RECENT_TURNS_THRESHOLD) {
        recentBoundary = i;
        break;
      }
    }
  }

  // Try full injection with truncated old tool outputs
  const formatted = conversational.map((m, i) => {
    const truncate = i < recentBoundary;
    return formatMessage(m, truncate);
  });

  const header = [
    `[SESSION RECOVERY — original session lost (${reason})]`,
    'The following is your conversation history for context continuity.',
    'Continue from where you left off. Do not repeat tool calls that already executed.',
    '',
  ].join('\n');

  const fullBody = formatted.join('\n');
  const fullMessage = `${header}--- Conversation History ---\n${fullBody}`;

  if (estimateTokens(fullMessage) <= budgetTokens) {
    return fullMessage;
  }

  // Over budget — progressively shrink
  const totalUserTurns = conversational.filter(m => m.type === 'user').length;
  const metadataHeader = buildMetadataHeader(messages, totalUserTurns);

  // Try keeping last N turns (count from end), reducing until fits
  for (let keepTurns = conversational.length; keepTurns >= MIN_TURNS; keepTurns = Math.floor(keepTurns * 0.7)) {
    const slice = conversational.slice(-keepTurns);
    const sliceFormatted = slice.map((m, i) => {
      const truncate = i < Math.max(0, slice.length - RECENT_TURNS_THRESHOLD * 2);
      return formatMessage(m, truncate);
    });

    const omittedCount = conversational.length - keepTurns;
    const body = sliceFormatted.join('\n');
    const candidate = [
      header,
      metadataHeader,
      `\n(${omittedCount} earlier messages omitted)\n`,
      '--- Recent Conversation History ---',
      body,
    ].join('\n');

    if (estimateTokens(candidate) <= budgetTokens) {
      return candidate;
    }
  }

  // Absolute minimum: header + metadata + last MIN_TURNS messages, truncated
  const minSlice = conversational.slice(-MIN_TURNS);
  const minFormatted = minSlice.map(m => formatMessage(m, true));
  return [
    header,
    metadataHeader,
    `\n(${conversational.length - MIN_TURNS} earlier messages omitted)\n`,
    '--- Recent Conversation History ---',
    minFormatted.join('\n'),
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/session/fallback-history.spec.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/session/fallback-history.ts src/main/session/fallback-history.spec.ts
git commit -m "$(cat <<'EOF'
feat: add token-budget fallback history builder for session recovery

Builds structured conversation history for injection when --resume fails.
Uses token budget (30% of context window) with progressive shrinking.
Truncates old tool outputs while preserving recent ones. Minimum of 3
turns guaranteed even under tight budget.
EOF
)"
```

### Task 5: Wire fallback history into lifecycle fallback paths

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts:153-161` (buildReplayContinuityMessage), `:1160`, `:1332`, `:1506`, `:1662`, `:1774`

- [ ] **Step 1: Add buildFallbackHistoryMessage method to lifecycle manager**

In `src/main/instance/instance-lifecycle.ts`, add import at top:
```typescript
import { buildFallbackHistoryMessage } from '../session/fallback-history';
```

Add a new private method after `buildReplayContinuityMessage` (after line 161):

```typescript
  /**
   * Build a rich fallback history message when --resume fails.
   * Merges live + historical messages, deduplicates, then creates a
   * token-budget-aware recovery message.
   */
  private async buildFallbackHistory(instance: Instance, reason: string): Promise<string> {
    const outputStorage = getOutputStorageManager();
    const historicalMessages = await outputStorage.loadMessages(instance.id);

    // Merge historical + live, dedup by message ID
    const merged = [...historicalMessages, ...instance.outputBuffer];
    const seenIds = new Set<string>();
    const deduped: OutputMessage[] = [];
    for (const m of merged) {
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      deduped.push(m);
    }

    // Get context window for budget calculation
    const contextWindow = getProviderModelContextWindow(instance.provider, instance.currentModel);

    const fallback = buildFallbackHistoryMessage(deduped, reason, contextWindow);
    if (fallback) return fallback;

    // Final fallback: use old summary-based method
    return this.buildReplayContinuityMessage(instance, reason);
  }
```

- [ ] **Step 2: Replace fallback calls with buildFallbackHistory**

Replace each `buildReplayContinuityMessage` call that uses a `*-fallback` reason with `await this.buildFallbackHistory()`. There are 5 call sites:

**Line 1160** (in `changeAgentMode`): Change from:
```typescript
await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'resume-failed-fallback'));
```
to:
```typescript
await adapter.sendInput(await this.buildFallbackHistory(instance, 'resume-failed-fallback'));
```

**Line 1332** (in `toggleYoloMode`): Same change.

**Line 1506** (in `changeModel`): Same change.

**Lines 1661-1662** (in `respawnAfterInterrupt`): Change from:
```typescript
await fallbackAdapter.sendInput(
  this.buildReplayContinuityMessage(instance, 'resume-failed-fallback')
);
```
to:
```typescript
await fallbackAdapter.sendInput(
  await this.buildFallbackHistory(instance, 'resume-failed-fallback')
);
```

**Line 1774** (in `respawnAfterUnexpectedExit`): Change from:
```typescript
await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'auto-respawn-fallback'));
```
to:
```typescript
await adapter.sendInput(await this.buildFallbackHistory(instance, 'auto-respawn-fallback'));
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run lint**

Run: `npx eslint src/main/instance/instance-lifecycle.ts src/main/session/fallback-history.ts`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "$(cat <<'EOF'
feat: wire token-budget fallback history into resume failure paths

Replace summary-based replay with rich conversation history injection
on all 5 fallback paths (changeAgentMode, toggleYoloMode, changeModel,
respawnAfterInterrupt, respawnAfterUnexpectedExit). Falls back to
old summary method if history builder returns null.
EOF
)"
```

---

## Chunk 4: Stuck Process Detection

### Task 6: Create StuckProcessDetector

**Files:**
- Create: `src/main/instance/stuck-process-detector.ts`
- Create: `src/main/instance/stuck-process-detector.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/instance/stuck-process-detector.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { StuckProcessDetector } from './stuck-process-detector';

describe('StuckProcessDetector', () => {
  let detector: StuckProcessDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new StuckProcessDetector();
  });

  afterEach(() => {
    detector.shutdown();
    vi.useRealTimers();
  });

  it('does not emit for idle instances', () => {
    const handler = vi.fn();
    detector.on('process:suspect-stuck', handler);
    detector.on('process:stuck', handler);

    detector.startTracking('inst-1');
    // Default state is idle — should not trigger
    vi.advanceTimersByTime(600_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('emits suspect-stuck after soft timeout during generating', () => {
    const handler = vi.fn();
    detector.on('process:suspect-stuck', handler);

    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');

    vi.advanceTimersByTime(130_000); // 120s soft + 10s check interval
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
    );
  });

  it('emits stuck after hard timeout during generating', () => {
    const handler = vi.fn();
    detector.on('process:stuck', handler);

    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');

    vi.advanceTimersByTime(250_000); // 240s hard + margin
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'inst-1', state: 'generating' })
    );
  });

  it('uses longer timeouts for tool_executing state', () => {
    const softHandler = vi.fn();
    detector.on('process:suspect-stuck', softHandler);

    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'tool_executing');

    // Should NOT trigger at 200s (below 300s soft timeout for tools)
    vi.advanceTimersByTime(200_000);
    expect(softHandler).not.toHaveBeenCalled();

    // Should trigger around 300s
    vi.advanceTimersByTime(110_000);
    expect(softHandler).toHaveBeenCalled();
  });

  it('recordOutput resets timer and clears warning', () => {
    const softHandler = vi.fn();
    detector.on('process:suspect-stuck', softHandler);

    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');

    vi.advanceTimersByTime(100_000);
    detector.recordOutput('inst-1'); // Reset timer
    vi.advanceTimersByTime(100_000); // 100s after reset, not yet 120s
    expect(softHandler).not.toHaveBeenCalled();
  });

  it('stopTracking removes instance from detection', () => {
    const handler = vi.fn();
    detector.on('process:stuck', handler);

    detector.startTracking('inst-1');
    detector.updateState('inst-1', 'generating');
    detector.stopTracking('inst-1');

    vi.advanceTimersByTime(600_000);
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/instance/stuck-process-detector.spec.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement StuckProcessDetector**

Create `src/main/instance/stuck-process-detector.ts`:

```typescript
import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';

const logger = getLogger('StuckProcessDetector');

const CHECK_INTERVAL_MS = 10_000;

interface TimeoutConfig {
  softMs: number;
  hardMs: number;
}

const TIMEOUTS: Record<string, TimeoutConfig> = {
  generating: { softMs: 120_000, hardMs: 240_000 },
  tool_executing: { softMs: 300_000, hardMs: 600_000 },
};

export type ProcessState = 'generating' | 'tool_executing' | 'idle';

interface ProcessTracker {
  lastOutputAt: number;
  instanceState: ProcessState;
  softWarningEmitted: boolean;
}

export class StuckProcessDetector extends EventEmitter {
  private trackers = new Map<string, ProcessTracker>();
  private checkInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.checkInterval = setInterval(() => this.checkAll(), CHECK_INTERVAL_MS);
    if (this.checkInterval.unref) this.checkInterval.unref();
  }

  startTracking(instanceId: string): void {
    this.trackers.set(instanceId, {
      lastOutputAt: Date.now(),
      instanceState: 'idle',
      softWarningEmitted: false,
    });
  }

  stopTracking(instanceId: string): void {
    this.trackers.delete(instanceId);
  }

  recordOutput(instanceId: string): void {
    const tracker = this.trackers.get(instanceId);
    if (tracker) {
      tracker.lastOutputAt = Date.now();
      tracker.softWarningEmitted = false;
    }
  }

  updateState(instanceId: string, state: ProcessState): void {
    const tracker = this.trackers.get(instanceId);
    if (tracker) {
      tracker.instanceState = state;
      // Reset timer on state change
      tracker.lastOutputAt = Date.now();
      tracker.softWarningEmitted = false;
    }
  }

  shutdown(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.trackers.clear();
  }

  private checkAll(): void {
    const now = Date.now();

    for (const [instanceId, tracker] of this.trackers) {
      if (tracker.instanceState === 'idle') continue;

      const config = TIMEOUTS[tracker.instanceState];
      if (!config) continue;

      const elapsed = now - tracker.lastOutputAt;

      if (elapsed >= config.hardMs) {
        logger.warn('Process stuck — hard timeout exceeded', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
        });
        this.emit('process:stuck', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
        });
        // Stop tracking to avoid repeated emissions
        this.trackers.delete(instanceId);
      } else if (elapsed >= config.softMs && !tracker.softWarningEmitted) {
        logger.warn('Process may be stuck — soft timeout exceeded', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
        });
        tracker.softWarningEmitted = true;
        this.emit('process:suspect-stuck', {
          instanceId,
          state: tracker.instanceState,
          elapsedMs: elapsed,
        });
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/instance/stuck-process-detector.spec.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/instance/stuck-process-detector.ts src/main/instance/stuck-process-detector.spec.ts
git commit -m "$(cat <<'EOF'
feat: add stuck process detector with two-stage timeout

Monitors CLI processes for lack of output. Soft timeout (120s generating,
300s tool executing) emits warning. Hard timeout (240s/600s) triggers
respawn. Idle instances are not tracked. Single 10s interval timer
checks all tracked instances.
EOF
)"
```

### Task 7: Wire stuck detector into instance manager

**Files:**
- Modify: `src/main/instance/instance-manager.ts:86-165` (constructor wiring)
- Modify: `src/main/instance/instance-communication.ts:380-490` (output handler)

- [ ] **Step 1: Add detector to instance manager**

In `src/main/instance/instance-manager.ts`, add import:
```typescript
import { StuckProcessDetector } from './stuck-process-detector';
```

Add field declaration alongside other sub-managers (around line 52-60):
```typescript
  private stuckDetector: StuckProcessDetector;
```

In the constructor (after line 155, after persistence manager init), add:
```typescript
    // Stuck process detector
    this.stuckDetector = new StuckProcessDetector();
    this.stuckDetector.on('process:suspect-stuck', ({ instanceId, elapsedMs }) => {
      const instance = this.state.getInstance(instanceId);
      if (instance) {
        const secs = Math.round(elapsedMs / 1000);
        this.communication.addToOutputBuffer(instance, {
          id: `stuck-warn-${Date.now()}`,
          type: 'system',
          content: `Instance may be stuck — no output for ${secs}s. Will auto-restart if unresponsive.`,
          timestamp: Date.now(),
        });
      }
    });
    this.stuckDetector.on('process:stuck', ({ instanceId }) => {
      this.lifecycle.respawnAfterInterrupt(instanceId).catch(err => {
        logger.error('Failed to respawn stuck process', err instanceof Error ? err : undefined, { instanceId });
      });
    });
```

- [ ] **Step 2: Wire detector calls into communication manager**

In `src/main/instance/instance-communication.ts`, add to `CommunicationDependencies` interface (line 42, before closing brace):
```typescript
  onOutput?: (instanceId: string) => void;
  onToolStateChange?: (instanceId: string, state: 'generating' | 'tool_executing' | 'idle') => void;
```

In the output handler (around line 392 where `tool_use` and `tool_result` are handled), add state change callbacks:

After line 392 (`if (message.type === 'tool_use' || message.type === 'tool_result') {`), inside the block add:
```typescript
          if (message.type === 'tool_use') {
            this.deps.onToolStateChange?.(instanceId, 'tool_executing');
          } else if (message.type === 'tool_result') {
            this.deps.onToolStateChange?.(instanceId, 'generating');
          }
```

In `addToOutputBuffer` (line 960), add at the top of the method (before any early returns):
```typescript
    this.deps.onOutput?.(instance.id);
```

- [ ] **Step 3: Wire callbacks in instance manager constructor**

In the communication manager dependency wiring (line 96-117), add the callbacks:
```typescript
      onOutput: (id) => this.stuckDetector.recordOutput(id),
      onToolStateChange: (id, state) => this.stuckDetector.updateState(id, state),
```

- [ ] **Step 4: Add detector start/stop to instance lifecycle**

Wire `startTracking`/`stopTracking` through the lifecycle dependencies.

In `src/main/instance/instance-lifecycle.ts`, add to `LifecycleDependencies` interface (around line 65):
```typescript
  startStuckTracking?: (instanceId: string) => void;
  stopStuckTracking?: (instanceId: string) => void;
```

In `createInstance` method, after the adapter is spawned and instance status set to `'idle'` (around line 590 where `instance.status = 'idle'`), add:
```typescript
      this.deps.startStuckTracking?.(instance.id);
```

In `terminateInstance` method (line 699), near the top alongside the `forceRelease` call, add:
```typescript
    this.deps.stopStuckTracking?.(instanceId);
```

In `restartInstance` method (line 987), add `stopStuckTracking` before the terminate and `startStuckTracking` after the respawn:
```typescript
    this.deps.stopStuckTracking?.(instanceId);
    // ... existing terminate + respawn ...
    this.deps.startStuckTracking?.(instanceId);
```

In `src/main/instance/instance-manager.ts`, in the lifecycle deps wiring (line 130-155), add:
```typescript
      startStuckTracking: (id) => this.stuckDetector.startTracking(id),
      stopStuckTracking: (id) => this.stuckDetector.stopTracking(id),
```

- [ ] **Step 5: Verify compilation**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Run existing tests**

Run: `npx vitest run src/main/instance/ --reporter=verbose`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/instance-manager.ts src/main/instance/instance-communication.ts
git commit -m "$(cat <<'EOF'
feat: wire stuck process detector into instance manager

Instantiate StuckProcessDetector in InstanceManager. Wire output and
tool state callbacks through CommunicationDependencies. Emit system
warning on soft timeout, trigger respawnAfterInterrupt on hard timeout.
Start/stop tracking on instance create/terminate.
EOF
)"
```

---

## Chunk 5: Conversation-Aware Rewind Points

### Task 8: Add rewind point triggers to communication manager

**Files:**
- Modify: `src/main/instance/instance-communication.ts:29-43` (CommunicationDependencies), `:226-250` (sendInput), `:380-490` (output handler)
- Modify: `src/main/instance/instance-manager.ts:96-117` (wiring)
- Test: `src/main/instance/instance-communication.spec.ts`

- [ ] **Step 1: Write failing tests for hard checkpoint on sendInput**

In `src/main/instance/instance-communication.spec.ts`, add:

```typescript
describe('conversation-aware rewind points', () => {
  it('calls createSnapshot before dispatching user input', async () => {
    const snapshotSpy = vi.fn();
    // Wire createSnapshot into deps (adjust setup to include this callback)
    // The spy should be called with instanceId and a name starting with "Before:"

    await comm.sendInput(instance.id, 'write a function');

    expect(snapshotSpy).toHaveBeenCalledWith(
      instance.id,
      expect.stringContaining('Before:'),
      undefined,
      'checkpoint'
    );
  });

  it('creates soft checkpoint after 6 autonomous tool results (exceeds 5)', async () => {
    const snapshotSpy = vi.fn();

    // Simulate 7 tool_result messages without user input
    // Checkpoint triggers when count exceeds 5 (at count 6), then resets
    for (let i = 0; i < 7; i++) {
      const msg = createMessage('tool_result', `result ${i}`, {
        metadata: { tool_use_id: `tool-${i}`, name: 'Read' },
      });
      comm.addToOutputBuffer(instance, msg);
    }

    // Should have triggered one soft checkpoint (at count 6, then reset)
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(snapshotSpy).toHaveBeenCalledWith(
      instance.id,
      expect.stringContaining('Auto:'),
      undefined,
      'auto'
    );
  });

  it('resets autonomous tool count on user input', async () => {
    const snapshotSpy = vi.fn();

    // 4 tool results (below threshold)
    for (let i = 0; i < 4; i++) {
      comm.addToOutputBuffer(instance, createMessage('tool_result', `r${i}`, {
        metadata: { tool_use_id: `t-${i}`, name: 'Bash' },
      }));
    }

    // User sends input — resets counter
    await comm.sendInput(instance.id, 'continue');

    // 4 more tool results (below threshold again)
    for (let i = 4; i < 8; i++) {
      comm.addToOutputBuffer(instance, createMessage('tool_result', `r${i}`, {
        metadata: { tool_use_id: `t-${i}`, name: 'Bash' },
      }));
    }

    // No soft checkpoint should have been created (never hit 5 consecutive)
    const softCalls = snapshotSpy.mock.calls.filter(
      (args: unknown[]) => args[3] === 'auto'
    );
    expect(softCalls).toHaveLength(0);
  });
});
```

Note: Adapt test setup to wire the `createSnapshot` callback into `CommunicationDependencies`. The exact wiring depends on the existing test fixture setup — follow the pattern used for other callback deps like `onInterruptedExit`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/instance/instance-communication.spec.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Add createSnapshot callback to CommunicationDependencies**

In `src/main/instance/instance-communication.ts`, add to `CommunicationDependencies` interface (line 42):

```typescript
  createSnapshot?: (instanceId: string, name: string, description: string | undefined, trigger: 'checkpoint' | 'auto') => void;
```

- [ ] **Step 4: Add tracking state and rewind logic**

Add field declarations (around line 79):

```typescript
  private autonomousToolCounts = new Map<string, number>();
  private softCheckpointCounts = new Map<string, number>();
```

In `sendInput` method (line 226), add hard checkpoint right before the adapter dispatch (before `await adapter.sendInput(finalMessage, attachments);` around line 303):

```typescript
    // Hard checkpoint: snapshot before user message
    if (this.deps.createSnapshot) {
      const name = `Before: ${message.slice(0, 50)}`;
      try {
        this.deps.createSnapshot(instanceId, name, undefined, 'checkpoint');
      } catch (err) {
        logger.debug('Failed to create checkpoint snapshot', { instanceId, error: String(err) });
      }
    }
    // Reset autonomous tool counter on user input
    this.autonomousToolCounts.set(instanceId, 0);
```

In `addToOutputBuffer` (line 960), add soft checkpoint logic after the dedup check and before buffer manipulation. After the tool result dedup block, add:

```typescript
    // Soft checkpoint: track autonomous tool completions
    if (message.type === 'tool_result' && this.deps.createSnapshot) {
      const count = (this.autonomousToolCounts.get(instance.id) ?? 0) + 1;
      this.autonomousToolCounts.set(instance.id, count);

      if (count > 5) {
        const softCount = this.softCheckpointCounts.get(instance.id) ?? 0;
        if (softCount < 10) {
          const toolName = (message.metadata?.['name'] as string) || 'unknown';
          try {
            this.deps.createSnapshot(
              instance.id,
              `Auto: after ${toolName} (autonomous run, tool #${count})`,
              undefined,
              'auto'
            );
            this.softCheckpointCounts.set(instance.id, softCount + 1);
          } catch (err) {
            logger.debug('Failed to create soft checkpoint', { instanceId: instance.id, error: String(err) });
          }
          // Reset counter after creating checkpoint (per spec)
          this.autonomousToolCounts.set(instance.id, 0);
        }
      }
    }
```

- [ ] **Step 5: Add cleanup for rewind tracking**

In `cleanupCircuitBreaker` (line 199), add:
```typescript
    this.autonomousToolCounts.delete(instanceId);
    this.softCheckpointCounts.delete(instanceId);
```

- [ ] **Step 6: Wire createSnapshot in instance manager**

In `src/main/instance/instance-manager.ts`, in the communication manager dependency wiring (line 96-117), add:
```typescript
      createSnapshot: (id, name, desc, trigger) => {
        try {
          getSessionContinuityManager().createSnapshot(id, name, desc, trigger);
        } catch (err) {
          // Non-critical — don't fail the operation
        }
      },
```

Add import if not present:
```typescript
import { getSessionContinuityManager } from '../session/session-continuity';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/main/instance/instance-communication.spec.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 8: Verify compilation**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 9: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All pass

- [ ] **Step 10: Run lint**

Run: `npm run lint`
Expected: No new errors

- [ ] **Step 11: Commit**

```bash
git add src/main/instance/instance-communication.ts src/main/instance/instance-communication.spec.ts src/main/instance/instance-manager.ts
git commit -m "$(cat <<'EOF'
feat: add conversation-aware rewind points

Hard checkpoints created before each user message dispatch with name
"Before: <message preview>". Soft checkpoints created every 5
autonomous tool completions (capped at 10 per session). Counter resets
on user input. Wired through CommunicationDependencies callback.
EOF
)"
```

---

## Final Verification

- [ ] **Run full test suite:** `npx vitest run --reporter=verbose`
- [ ] **Run typecheck:** `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
- [ ] **Run lint:** `npm run lint`
- [ ] **Verify no regressions in existing session resume flow**
