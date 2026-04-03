# Phase A: Type Safety & Utilities — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add branded ID types, telemetry-safe errors, a buffered writer, and a sequential execution wrapper to the AI Orchestrator — eliminating entire classes of ID mix-up bugs, PII leaks, blocking I/O, and race conditions.

**Architecture:** Four independent utilities that share no mutual dependencies. Branded types are a compile-time-only change (zero runtime cost). Buffered writer and sequential wrapper are runtime utilities following the singleton + getter pattern. TelemetrySafeError extends the existing `error-utils.ts`.

**Tech Stack:** TypeScript 5.9, Vitest, Node.js `fs/promises`, `crypto`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/shared/types/branded-ids.ts` | Branded ID type definitions + factory functions |
| Create | `src/shared/types/__tests__/branded-ids.spec.ts` | Compile-time safety tests |
| Modify | `src/shared/utils/id-generator.ts` | Return branded types from generators |
| Create | `src/shared/utils/__tests__/id-generator.spec.ts` | Test branded return types |
| Modify | `src/main/util/error-utils.ts` | Add `TelemetrySafeError` + `createSafeErrorInfo()` |
| Modify | `src/main/util/__tests__/error-utils.spec.ts` | Tests for new error utilities |
| Create | `src/main/util/buffered-writer.ts` | Batched async file writes with dedup |
| Create | `src/main/util/__tests__/buffered-writer.spec.ts` | Buffered writer tests |
| Create | `src/main/util/sequential.ts` | Sequential execution wrapper + keyed variant + mutex |
| Create | `src/main/util/__tests__/sequential.spec.ts` | Sequential wrapper tests |

---

## Task 1: Branded ID Types

**Files:**
- Create: `src/shared/types/branded-ids.ts`
- Create: `src/shared/types/__tests__/branded-ids.spec.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/shared/types/__tests__/branded-ids.spec.ts
import { describe, it, expect } from 'vitest';
import {
  toInstanceId, toSessionId, toAgentId, toDebateId,
  toVerificationId, toConsensusId, toReviewId, toWorktreeId,
  toTaskId, toSkillId, toServerId, toSnapshotId,
  toWorkflowId, toArtifactId, toSupervisorNodeId, toWorkerNodeId,
  type InstanceId, type SessionId, type AgentId,
} from '../branded-ids';

describe('branded-ids', () => {
  describe('factory functions', () => {
    it('toInstanceId returns the same string value', () => {
      const raw = 'c8f3k2m1p';
      const branded = toInstanceId(raw);
      expect(branded).toBe(raw);
      // At runtime branded is just a string — the brand is compile-time only
      expect(typeof branded).toBe('string');
    });

    it('toSessionId returns the same string value', () => {
      const branded = toSessionId('s7j4x1q9w');
      expect(branded).toBe('s7j4x1q9w');
    });

    it('toAgentId returns the same string value', () => {
      const branded = toAgentId('agent-default');
      expect(branded).toBe('agent-default');
    });

    it('toDebateId returns the same string value', () => {
      const branded = toDebateId('d5k2m8n3p');
      expect(branded).toBe('d5k2m8n3p');
    });

    it('toVerificationId returns the same string value', () => {
      expect(toVerificationId('v123')).toBe('v123');
    });

    it('toConsensusId returns the same string value', () => {
      expect(toConsensusId('n456')).toBe('n456');
    });

    it('toReviewId returns the same string value', () => {
      expect(toReviewId('r789')).toBe('r789');
    });

    it('toWorktreeId returns the same string value', () => {
      expect(toWorktreeId('w321')).toBe('w321');
    });

    it('toTaskId returns the same string value', () => {
      expect(toTaskId('task-1')).toBe('task-1');
    });

    it('toSkillId returns the same string value', () => {
      expect(toSkillId('skill-1')).toBe('skill-1');
    });

    it('toServerId returns the same string value', () => {
      expect(toServerId('srv-1')).toBe('srv-1');
    });

    it('toSnapshotId returns the same string value', () => {
      expect(toSnapshotId('snap-1')).toBe('snap-1');
    });

    it('toWorkflowId returns the same string value', () => {
      expect(toWorkflowId('wf-1')).toBe('wf-1');
    });

    it('toArtifactId returns the same string value', () => {
      expect(toArtifactId('art-1')).toBe('art-1');
    });

    it('toSupervisorNodeId returns the same string value', () => {
      expect(toSupervisorNodeId('sup-1')).toBe('sup-1');
    });

    it('toWorkerNodeId returns the same string value', () => {
      expect(toWorkerNodeId('wrk-1')).toBe('wrk-1');
    });
  });

  describe('type safety (compile-time)', () => {
    // These tests verify the runtime identity — the real value is
    // that TS prevents assigning InstanceId where SessionId is expected.
    // That's enforced by the compiler, not at runtime.
    it('branded IDs are interchangeable with string at runtime', () => {
      const instanceId: InstanceId = toInstanceId('c123');
      const sessionId: SessionId = toSessionId('s456');
      const agentId: AgentId = toAgentId('a789');

      // All usable as strings at runtime
      expect(instanceId.startsWith('c')).toBe(true);
      expect(sessionId.length).toBe(4);
      expect(agentId.includes('789')).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/types/__tests__/branded-ids.spec.ts`
Expected: FAIL — `Cannot find module '../branded-ids'`

- [ ] **Step 3: Create the branded-ids module**

```typescript
// src/shared/types/branded-ids.ts
/**
 * Branded (nominal) ID types — compile-time safety with zero runtime cost.
 *
 * Inspired by Claude Code's pattern: `type SessionId = string & { readonly __brand: 'SessionId' }`.
 * Prevents passing an InstanceId where a SessionId is expected, caught at compile time.
 *
 * Usage:
 *   function getSession(id: SessionId): Session { ... }
 *   getSession(toSessionId(rawString));  // OK
 *   getSession(instanceId);              // Compile error!
 */

declare const __brand: unique symbol;

/** Brand utility — intersects base type with a phantom brand field. */
type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ── Core ID Types ──────────────────────────────────────────────

export type InstanceId = Brand<string, 'InstanceId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type AgentId = Brand<string, 'AgentId'>;

// ── Orchestration ID Types ─────────────────────────────────────

export type DebateId = Brand<string, 'DebateId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type ConsensusId = Brand<string, 'ConsensusId'>;
export type ReviewId = Brand<string, 'ReviewId'>;
export type WorktreeId = Brand<string, 'WorktreeId'>;

// ── Resource ID Types ──────────────────────────────────────────

export type TaskId = Brand<string, 'TaskId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type ServerId = Brand<string, 'ServerId'>;
export type SnapshotId = Brand<string, 'SnapshotId'>;
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;

// ── Hierarchy ID Types ─────────────────────────────────────────

export type SupervisorNodeId = Brand<string, 'SupervisorNodeId'>;
export type WorkerNodeId = Brand<string, 'WorkerNodeId'>;

// ── Factory Functions (zero-cost casts) ────────────────────────

export function toInstanceId(raw: string): InstanceId { return raw as InstanceId; }
export function toSessionId(raw: string): SessionId { return raw as SessionId; }
export function toAgentId(raw: string): AgentId { return raw as AgentId; }
export function toDebateId(raw: string): DebateId { return raw as DebateId; }
export function toVerificationId(raw: string): VerificationId { return raw as VerificationId; }
export function toConsensusId(raw: string): ConsensusId { return raw as ConsensusId; }
export function toReviewId(raw: string): ReviewId { return raw as ReviewId; }
export function toWorktreeId(raw: string): WorktreeId { return raw as WorktreeId; }
export function toTaskId(raw: string): TaskId { return raw as TaskId; }
export function toSkillId(raw: string): SkillId { return raw as SkillId; }
export function toServerId(raw: string): ServerId { return raw as ServerId; }
export function toSnapshotId(raw: string): SnapshotId { return raw as SnapshotId; }
export function toWorkflowId(raw: string): WorkflowId { return raw as WorkflowId; }
export function toArtifactId(raw: string): ArtifactId { return raw as ArtifactId; }
export function toSupervisorNodeId(raw: string): SupervisorNodeId { return raw as SupervisorNodeId; }
export function toWorkerNodeId(raw: string): WorkerNodeId { return raw as WorkerNodeId; }

/** Union of all branded ID types — useful for generic ID parameters. */
export type AnyId = InstanceId | SessionId | AgentId | DebateId
  | VerificationId | ConsensusId | ReviewId | WorktreeId
  | TaskId | SkillId | ServerId | SnapshotId | WorkflowId | ArtifactId
  | SupervisorNodeId | WorkerNodeId;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/types/__tests__/branded-ids.spec.ts`
Expected: PASS — all 18 tests green

- [ ] **Step 5: Run TypeScript compiler**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/branded-ids.ts src/shared/types/__tests__/branded-ids.spec.ts
git commit -m "feat: add branded ID types for compile-time safety"
```

---

## Task 2: Wire Branded Types into ID Generator

**Files:**
- Modify: `src/shared/utils/id-generator.ts`
- Create: `src/shared/utils/__tests__/id-generator.spec.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/shared/utils/__tests__/id-generator.spec.ts
import { describe, it, expect } from 'vitest';
import {
  generateId, generateShortId, generateToken, generateTimestampedId,
  generatePrefixedId, generateInstanceId, generateOrchestrationId,
  INSTANCE_ID_PREFIXES, ORCHESTRATION_ID_PREFIXES,
} from '../id-generator';

describe('id-generator', () => {
  describe('generateId', () => {
    it('returns a valid UUID v4', () => {
      const id = generateId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('generateShortId', () => {
    it('returns 8 characters', () => {
      expect(generateShortId()).toHaveLength(8);
    });
  });

  describe('generateToken', () => {
    it('returns 64 hex characters', () => {
      const token = generateToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('generateTimestampedId', () => {
    it('contains a dash separator', () => {
      expect(generateTimestampedId()).toContain('-');
    });
  });

  describe('generatePrefixedId', () => {
    it('starts with the given prefix', () => {
      const id = generatePrefixedId('test');
      expect(id.startsWith('test')).toBe(true);
    });

    it('has prefix + 8 random characters', () => {
      const id = generatePrefixedId('z');
      expect(id).toHaveLength(9);  // 'z' + 8 chars
    });
  });

  describe('generateInstanceId', () => {
    it('uses claude prefix by default for claude provider', () => {
      const id = generateInstanceId('claude');
      expect(id.startsWith(INSTANCE_ID_PREFIXES.claude)).toBe(true);
    });

    it('uses generic prefix when no provider specified', () => {
      const id = generateInstanceId();
      expect(id.startsWith(INSTANCE_ID_PREFIXES.generic)).toBe(true);
    });

    it('returns InstanceId branded type usable as string', () => {
      const id = generateInstanceId('gemini');
      // Branded type is still a string at runtime
      expect(typeof id).toBe('string');
      expect(id.startsWith('g')).toBe(true);
    });
  });

  describe('generateOrchestrationId', () => {
    it('uses debate prefix', () => {
      const id = generateOrchestrationId('debate');
      expect(id.startsWith(ORCHESTRATION_ID_PREFIXES.debate)).toBe(true);
    });

    it('uses session prefix', () => {
      const id = generateOrchestrationId('session');
      expect(id.startsWith(ORCHESTRATION_ID_PREFIXES.session)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (existing code already works)**

Run: `npx vitest run src/shared/utils/__tests__/id-generator.spec.ts`
Expected: PASS — tests verify current behavior before we change return types

- [ ] **Step 3: Update id-generator.ts to return branded types**

In `src/shared/utils/id-generator.ts`, make these changes:

**Add import at top of file (after the file header comment on line 3):**
```typescript
import type { InstanceId } from '../types/branded-ids';
import { toInstanceId } from '../types/branded-ids';
```

**Change `generateInstanceId` return type (line 102):**
```typescript
// Before:
export function generateInstanceId(provider: InstanceProvider = 'generic'): string {
  return generatePrefixedId(INSTANCE_ID_PREFIXES[provider]);
}

// After:
export function generateInstanceId(provider: InstanceProvider = 'generic'): InstanceId {
  return toInstanceId(generatePrefixedId(INSTANCE_ID_PREFIXES[provider]));
}
```

**Note:** We only brand `generateInstanceId` in this task. Other generators (`generateOrchestrationId`, etc.) will be branded incrementally in later phases as their consuming code is migrated. This keeps the blast radius minimal.

- [ ] **Step 4: Run test and typecheck**

Run: `npx vitest run src/shared/utils/__tests__/id-generator.spec.ts`
Expected: PASS — all tests still green (InstanceId is assignable to string at runtime)

Run: `npx tsc --noEmit`
Expected: No errors — InstanceId is assignable to `string` in all existing call sites

- [ ] **Step 5: Commit**

```bash
git add src/shared/utils/id-generator.ts src/shared/utils/__tests__/id-generator.spec.ts
git commit -m "feat: generateInstanceId returns branded InstanceId type"
```

---

## Task 3: TelemetrySafeError + createSafeErrorInfo

**Files:**
- Modify: `src/main/util/error-utils.ts`
- Modify: `src/main/util/__tests__/error-utils.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/main/util/__tests__/error-utils.spec.ts`:

```typescript
import { TelemetrySafeError, createSafeErrorInfo } from '../error-utils';

describe('TelemetrySafeError', () => {
  it('has isTelemetrySafe marker', () => {
    const err = new TelemetrySafeError('safe message');
    expect(err.isTelemetrySafe).toBe(true);
    expect(err.name).toBe('TelemetrySafeError');
    expect(err.message).toBe('safe message');
  });

  it('is an instance of Error', () => {
    const err = new TelemetrySafeError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TelemetrySafeError);
  });

  it('supports cause via ErrorOptions', () => {
    const cause = new Error('original');
    const err = new TelemetrySafeError('wrapped', { cause });
    expect(err.cause).toBe(cause);
  });

  describe('from()', () => {
    it('creates TelemetrySafeError from Error with truncated stack', () => {
      const original = new Error('deep error');
      original.stack = [
        'Error: deep error',
        '    at fn1 (file1.ts:1:1)',
        '    at fn2 (file2.ts:2:2)',
        '    at fn3 (file3.ts:3:3)',
        '    at fn4 (file4.ts:4:4)',
        '    at fn5 (file5.ts:5:5)',
        '    at fn6 (file6.ts:6:6)',
        '    at fn7 (file7.ts:7:7)',
      ].join('\n');

      const safe = TelemetrySafeError.from(original, 3);
      expect(safe.isTelemetrySafe).toBe(true);
      expect(safe.message).toBe('deep error');
      // Stack should have header + 3 frames = 4 lines
      const lines = safe.stack!.split('\n');
      expect(lines).toHaveLength(4);
    });

    it('creates TelemetrySafeError from non-Error values', () => {
      const safe = TelemetrySafeError.from('string error');
      expect(safe.isTelemetrySafe).toBe(true);
      expect(safe.message).toBe('string error');
    });

    it('creates TelemetrySafeError from null', () => {
      const safe = TelemetrySafeError.from(null);
      expect(safe.message).toBe('null');
    });

    it('defaults to 5 stack frames', () => {
      const original = new Error('default');
      original.stack = [
        'Error: default',
        ...Array.from({ length: 10 }, (_, i) => `    at fn${i} (file.ts:${i}:1)`),
      ].join('\n');

      const safe = TelemetrySafeError.from(original);
      const frames = safe.stack!.split('\n').filter(l => l.trim().startsWith('at '));
      expect(frames).toHaveLength(5);
    });
  });
});

describe('createSafeErrorInfo', () => {
  it('creates ErrorInfo with truncated stack', () => {
    const err = new Error('test error');
    err.stack = [
      'Error: test error',
      ...Array.from({ length: 10 }, (_, i) => `    at fn${i} (file.ts:${i}:1)`),
    ].join('\n');

    const info = createSafeErrorInfo(err, 'TEST_CODE');
    expect(info.code).toBe('TEST_CODE');
    expect(info.message).toBe('test error');
    expect(info.timestamp).toBeGreaterThan(0);
    // Stack should be truncated to 5 frames
    const frames = info.stack!.split('\n').filter(l => l.trim().startsWith('at '));
    expect(frames).toHaveLength(5);
  });

  it('handles non-Error input', () => {
    const info = createSafeErrorInfo('string error', 'STR_ERR');
    expect(info.code).toBe('STR_ERR');
    expect(info.message).toBe('string error');
    expect(info.timestamp).toBeGreaterThan(0);
  });

  it('handles errors with no message', () => {
    const err = new Error();
    const info = createSafeErrorInfo(err, 'EMPTY');
    expect(info.code).toBe('EMPTY');
    expect(info.message).toBe('Unknown error');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/util/__tests__/error-utils.spec.ts`
Expected: FAIL — `TelemetrySafeError` and `createSafeErrorInfo` are not exported from `../error-utils`

- [ ] **Step 3: Add TelemetrySafeError and createSafeErrorInfo to error-utils.ts**

Append to the end of `src/main/util/error-utils.ts`:

```typescript
// ── Telemetry-Safe Errors ──────────────────────────────────────

/** Import ErrorInfo from shared types for IPC-safe error construction. */
import type { ErrorInfo } from '../../shared/types/ipc.types';

/**
 * Marker class ensuring errors sent to telemetry contain no PII.
 *
 * Forces developers to explicitly construct safe errors before external
 * transmission. The `isTelemetrySafe` flag lets telemetry pipelines
 * assert safety at runtime.
 */
export class TelemetrySafeError extends Error {
  readonly isTelemetrySafe = true as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TelemetrySafeError';
  }

  /** Create from any error, truncating the stack to `maxFrames`. */
  static from(e: unknown, maxFrames = 5): TelemetrySafeError {
    const truncated = shortErrorStack(e, maxFrames);
    const message = e instanceof Error ? e.message : String(e);
    const safe = new TelemetrySafeError(message);
    safe.stack = truncated;
    return safe;
  }
}

/**
 * Create an IPC-safe ErrorInfo with truncated stack.
 * Use this instead of manually constructing ErrorInfo objects in IPC handlers.
 */
export function createSafeErrorInfo(error: unknown, code: string): ErrorInfo {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    code,
    message: err.message || 'Unknown error',
    stack: shortErrorStack(err, 5),
    timestamp: Date.now(),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/util/__tests__/error-utils.spec.ts`
Expected: PASS — all tests green (existing + new)

- [ ] **Step 5: Run TypeScript compiler**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/util/error-utils.ts src/main/util/__tests__/error-utils.spec.ts
git commit -m "feat: add TelemetrySafeError and createSafeErrorInfo for PII-safe telemetry"
```

---

## Task 4: Buffered Writer — Tests

**Files:**
- Create: `src/main/util/__tests__/buffered-writer.spec.ts`

- [ ] **Step 1: Write the full test file**

```typescript
// src/main/util/__tests__/buffered-writer.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

vi.mock('fs/promises');
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { BufferedWriter } from '../buffered-writer';

describe('BufferedWriter', () => {
  let writer: BufferedWriter;
  const mockWriteFile = vi.mocked(fs.writeFile);
  const mockAppendFile = vi.mocked(fs.appendFile);
  const mockMkdir = vi.mocked(fs.mkdir);

  beforeEach(() => {
    vi.useFakeTimers();
    mockWriteFile.mockResolvedValue();
    mockAppendFile.mockResolvedValue();
    mockMkdir.mockResolvedValue(undefined);
    writer = new BufferedWriter({ flushIntervalMs: 1000, maxBufferSize: 10, maxBufferBytes: 1024 * 1024 });
  });

  afterEach(async () => {
    await writer.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('write()', () => {
    it('buffers a write without immediately flushing', async () => {
      writer.write('/tmp/test.txt', 'hello');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('flushes on timer tick', async () => {
      writer.write('/tmp/test.txt', 'hello');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/test.txt', 'hello', 'utf-8');
    });

    it('deduplicates writes to the same path (keeps latest)', async () => {
      writer.write('/tmp/test.txt', 'first');
      writer.write('/tmp/test.txt', 'second');
      writer.write('/tmp/test.txt', 'third');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/test.txt', 'third', 'utf-8');
    });

    it('writes to different paths are independent', async () => {
      writer.write('/tmp/a.txt', 'alpha');
      writer.write('/tmp/b.txt', 'beta');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockWriteFile).toHaveBeenCalledTimes(2);
      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/a.txt', 'alpha', 'utf-8');
      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/b.txt', 'beta', 'utf-8');
    });

    it('creates parent directories before writing', async () => {
      writer.write('/tmp/deep/nested/file.txt', 'content');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockMkdir).toHaveBeenCalledWith('/tmp/deep/nested', { recursive: true });
    });
  });

  describe('append()', () => {
    it('coalesces multiple appends to the same path', async () => {
      writer.append('/tmp/log.txt', 'line1\n');
      writer.append('/tmp/log.txt', 'line2\n');
      writer.append('/tmp/log.txt', 'line3\n');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockAppendFile).toHaveBeenCalledTimes(1);
      expect(mockAppendFile).toHaveBeenCalledWith('/tmp/log.txt', 'line1\nline2\nline3\n', 'utf-8');
    });
  });

  describe('flush()', () => {
    it('immediately flushes all pending writes', async () => {
      writer.write('/tmp/test.txt', 'urgent');

      await writer.flush();

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/test.txt', 'urgent', 'utf-8');
    });

    it('is a no-op when buffer is empty', async () => {
      await writer.flush();

      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockAppendFile).not.toHaveBeenCalled();
    });
  });

  describe('overflow protection', () => {
    it('auto-flushes when buffer reaches maxBufferSize', async () => {
      for (let i = 0; i < 10; i++) {
        writer.write(`/tmp/file-${i}.txt`, `content-${i}`);
      }

      // 10th write should trigger auto-flush (maxBufferSize = 10)
      // Need to let the microtask queue drain
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('shutdown()', () => {
    it('flushes remaining writes and stops timer', async () => {
      writer.write('/tmp/final.txt', 'last write');

      await writer.shutdown();

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/final.txt', 'last write', 'utf-8');
    });

    it('is safe to call multiple times', async () => {
      writer.write('/tmp/test.txt', 'data');

      await writer.shutdown();
      await writer.shutdown();

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('logs errors without crashing', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('disk full'));

      writer.write('/tmp/fail.txt', 'data');
      await vi.advanceTimersByTimeAsync(1000);

      // Should not throw — error is logged
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('stats()', () => {
    it('returns buffer statistics', () => {
      writer.write('/tmp/a.txt', 'hello');
      writer.append('/tmp/b.txt', 'world');

      const stats = writer.stats();
      expect(stats.pendingWrites).toBe(1);
      expect(stats.pendingAppends).toBe(1);
      expect(stats.totalBufferedBytes).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/util/__tests__/buffered-writer.spec.ts`
Expected: FAIL — `Cannot find module '../buffered-writer'`

---

## Task 5: Buffered Writer — Implementation

**Files:**
- Create: `src/main/util/buffered-writer.ts`

- [ ] **Step 1: Create the buffered-writer module**

```typescript
// src/main/util/buffered-writer.ts
/**
 * Buffered Writer — coalesces file writes and flushes in batches.
 *
 * Inspired by Claude Code's BufferedWriter pattern. Replaces blocking
 * fs.writeFileSync calls with batched async writes, preventing event
 * loop stalls in persistence-heavy paths (RLM, snapshots, session archive).
 *
 * Features:
 * - Write deduplication (same-path overwrites keep only latest)
 * - Append coalescing (multiple appends merged into one)
 * - Overflow protection (auto-flush at buffer limit)
 * - Graceful shutdown (flush + stop timer)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';

const logger = getLogger('BufferedWriter');

export interface BufferedWriterOptions {
  /** Flush interval in milliseconds. Default: 1000 */
  flushIntervalMs?: number;
  /** Max number of buffered entries before auto-flush. Default: 100 */
  maxBufferSize?: number;
  /** Max total bytes before auto-flush. Default: 1MB */
  maxBufferBytes?: number;
}

interface WriteEntry {
  filePath: string;
  content: string;
  type: 'write' | 'append';
}

export class BufferedWriter {
  private writes = new Map<string, WriteEntry>();
  private appends = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private totalBytes = 0;
  private isShutdown = false;
  private flushPromise: Promise<void> | null = null;

  private readonly flushIntervalMs: number;
  private readonly maxBufferSize: number;
  private readonly maxBufferBytes: number;

  constructor(options: BufferedWriterOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxBufferSize = options.maxBufferSize ?? 100;
    this.maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    if (this.timer.unref) this.timer.unref();
  }

  /** Buffer a write (overwrites previous buffered write to same path). */
  write(filePath: string, content: string): void {
    if (this.isShutdown) return;

    const prev = this.writes.get(filePath);
    if (prev) {
      this.totalBytes -= Buffer.byteLength(prev.content, 'utf-8');
    }

    this.writes.set(filePath, { filePath, content, type: 'write' });
    this.totalBytes += Buffer.byteLength(content, 'utf-8');

    this.maybeAutoFlush();
  }

  /** Buffer an append (coalesces with previous appends to same path). */
  append(filePath: string, content: string): void {
    if (this.isShutdown) return;

    const existing = this.appends.get(filePath) ?? '';
    this.appends.set(filePath, existing + content);
    this.totalBytes += Buffer.byteLength(content, 'utf-8');

    this.maybeAutoFlush();
  }

  /** Immediately flush all buffered writes. */
  async flush(): Promise<void> {
    // Serialize flushes to prevent concurrent file operations
    if (this.flushPromise) {
      await this.flushPromise;
    }

    this.flushPromise = this.doFlush();
    await this.flushPromise;
    this.flushPromise = null;
  }

  /** Flush remaining writes and stop the timer. */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    this.isShutdown = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.flush();
  }

  /** Return current buffer statistics. */
  stats(): { pendingWrites: number; pendingAppends: number; totalBufferedBytes: number } {
    return {
      pendingWrites: this.writes.size,
      pendingAppends: this.appends.size,
      totalBufferedBytes: this.totalBytes,
    };
  }

  private async doFlush(): Promise<void> {
    // Snapshot and clear buffers atomically
    const writes = new Map(this.writes);
    const appends = new Map(this.appends);
    this.writes.clear();
    this.appends.clear();
    this.totalBytes = 0;

    const tasks: Promise<void>[] = [];

    for (const [filePath, entry] of writes) {
      tasks.push(this.safeWrite(filePath, entry.content));
    }

    for (const [filePath, content] of appends) {
      tasks.push(this.safeAppend(filePath, content));
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  private async safeWrite(filePath: string, content: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
    } catch (e) {
      logger.error('Buffered write failed', e instanceof Error ? e : new Error(String(e)), { filePath });
    }
  }

  private async safeAppend(filePath: string, content: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, content, 'utf-8');
    } catch (e) {
      logger.error('Buffered append failed', e instanceof Error ? e : new Error(String(e)), { filePath });
    }
  }

  private maybeAutoFlush(): void {
    const entryCount = this.writes.size + this.appends.size;
    if (entryCount >= this.maxBufferSize || this.totalBytes >= this.maxBufferBytes) {
      void this.flush();
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────

let instance: BufferedWriter | null = null;

export function getBufferedWriter(): BufferedWriter {
  if (!instance) {
    instance = new BufferedWriter();
  }
  return instance;
}

/** Flush and stop the global writer. Call during app shutdown. */
export async function shutdownBufferedWriter(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}

/** Reset for testing. */
export function _resetBufferedWriterForTesting(): void {
  if (instance) {
    clearInterval((instance as any).timer);
    instance = null;
  }
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/main/util/__tests__/buffered-writer.spec.ts`
Expected: PASS — all tests green

- [ ] **Step 3: Run TypeScript compiler**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/util/buffered-writer.ts src/main/util/__tests__/buffered-writer.spec.ts
git commit -m "feat: add BufferedWriter for batched async file I/O"
```

---

## Task 6: Sequential Execution Wrapper — Tests

**Files:**
- Create: `src/main/util/__tests__/sequential.spec.ts`

- [ ] **Step 1: Write the full test file**

```typescript
// src/main/util/__tests__/sequential.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sequential, keyedSequential, createMutex } from '../sequential';

describe('sequential()', () => {
  it('serializes concurrent calls', async () => {
    const order: number[] = [];

    const fn = sequential(async (n: number) => {
      order.push(n);
      await new Promise(r => setTimeout(r, 10));
      order.push(n * 10);
      return n;
    });

    const [r1, r2, r3] = await Promise.all([fn(1), fn(2), fn(3)]);

    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(r3).toBe(3);
    // Calls execute in order: 1, 10 (done), 2, 20 (done), 3, 30 (done)
    expect(order).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it('preserves return values', async () => {
    const fn = sequential(async (x: string) => `result:${x}`);

    const result = await fn('hello');
    expect(result).toBe('result:hello');
  });

  it('propagates errors without blocking the queue', async () => {
    const fn = sequential(async (shouldFail: boolean) => {
      if (shouldFail) throw new Error('boom');
      return 'ok';
    });

    await expect(fn(true)).rejects.toThrow('boom');
    const result = await fn(false);
    expect(result).toBe('ok');
  });

  it('handles void-returning async functions', async () => {
    let called = false;
    const fn = sequential(async () => {
      called = true;
    });

    await fn();
    expect(called).toBe(true);
  });
});

describe('keyedSequential()', () => {
  it('serializes calls with the same key', async () => {
    const order: string[] = [];

    const fn = keyedSequential(async (key: string, value: string) => {
      order.push(`start:${key}:${value}`);
      await new Promise(r => setTimeout(r, 10));
      order.push(`end:${key}:${value}`);
      return value;
    });

    const [r1, r2] = await Promise.all([fn('a', 'first'), fn('a', 'second')]);

    expect(r1).toBe('first');
    expect(r2).toBe('second');
    expect(order).toEqual([
      'start:a:first', 'end:a:first',
      'start:a:second', 'end:a:second',
    ]);
  });

  it('allows concurrent execution for different keys', async () => {
    const order: string[] = [];

    const fn = keyedSequential(async (key: string, value: string) => {
      order.push(`start:${key}:${value}`);
      await new Promise(r => setTimeout(r, 10));
      order.push(`end:${key}:${value}`);
      return value;
    });

    await Promise.all([fn('a', '1'), fn('b', '2')]);

    // Both should start before either ends (concurrent)
    expect(order[0]).toBe('start:a:1');
    expect(order[1]).toBe('start:b:2');
  });

  it('cleans up idle key chains', async () => {
    vi.useFakeTimers();

    const fn = keyedSequential(
      async (key: string) => key,
      { idleCleanupMs: 100 },
    );

    await fn('temp-key');

    // Advance past cleanup interval
    await vi.advanceTimersByTimeAsync(200);

    // Internal map should be cleaned (we can't inspect directly,
    // but verify it still works after cleanup)
    const result = await fn('temp-key');
    expect(result).toBe('temp-key');

    vi.useRealTimers();
  });

  it('propagates errors without blocking the key queue', async () => {
    const fn = keyedSequential(async (key: string, shouldFail: boolean) => {
      if (shouldFail) throw new Error(`fail:${key}`);
      return `ok:${key}`;
    });

    await expect(fn('a', true)).rejects.toThrow('fail:a');
    const result = await fn('a', false);
    expect(result).toBe('ok:a');
  });
});

describe('createMutex()', () => {
  it('allows single acquisition', async () => {
    const mutex = createMutex();

    expect(mutex.isLocked()).toBe(false);
    const release = await mutex.acquire();
    expect(mutex.isLocked()).toBe(true);
    release();
    expect(mutex.isLocked()).toBe(false);
  });

  it('queues concurrent acquisitions', async () => {
    const mutex = createMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire();
    order.push(1);

    const promise2 = mutex.acquire().then(release => {
      order.push(2);
      return release;
    });

    release1();
    const release2 = await promise2;
    release2();

    expect(order).toEqual([1, 2]);
  });

  it('is safe to release multiple times', async () => {
    const mutex = createMutex();
    const release = await mutex.acquire();

    release();
    release(); // Should not throw or double-release

    expect(mutex.isLocked()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/util/__tests__/sequential.spec.ts`
Expected: FAIL — `Cannot find module '../sequential'`

---

## Task 7: Sequential Execution Wrapper — Implementation

**Files:**
- Create: `src/main/util/sequential.ts`

- [ ] **Step 1: Create the sequential module**

```typescript
// src/main/util/sequential.ts
/**
 * Sequential execution utilities — prevent concurrent async mutations.
 *
 * Inspired by Claude Code's `sequential()` wrapper (57 lines). Generalizes
 * the SessionMutex pattern into reusable primitives:
 *
 * - sequential()      — wraps any async fn for strict FIFO execution
 * - keyedSequential() — per-key queues (e.g., per-instance operations)
 * - createMutex()     — lightweight acquire/release for code regions
 *
 * Use these to protect concurrent Map/Set mutations in:
 * - SupervisorTree.registerInstance/unregisterInstance
 * - MultiVerifyCoordinator.activeVerifications
 * - OutcomeTracker.recordOutcome
 */

/**
 * Wrap an async function so concurrent calls execute strictly in order.
 * Return values and errors are preserved and forwarded to each caller.
 *
 * @example
 * const safeSave = sequential(save);
 * await Promise.all([safeSave(a), safeSave(b)]); // b waits for a
 */
export function sequential<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
): (...args: TArgs) => Promise<TReturn> {
  let chain: Promise<unknown> = Promise.resolve();

  return (...args: TArgs): Promise<TReturn> => {
    const next = chain.then(() => fn(...args));
    // Keep the chain going even if fn throws
    chain = next.catch(() => {});
    return next;
  };
}

/**
 * Per-key sequential execution. The first argument is the key;
 * calls with the same key serialize, different keys run concurrently.
 *
 * @example
 * const safeUpdate = keyedSequential(updateInstance);
 * // These serialize (same instance):
 * await Promise.all([safeUpdate('inst-1', data1), safeUpdate('inst-1', data2)]);
 * // These run concurrently (different instances):
 * await Promise.all([safeUpdate('inst-1', data1), safeUpdate('inst-2', data2)]);
 */
export function keyedSequential<TArgs extends [string, ...unknown[]], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options?: { idleCleanupMs?: number },
): (...args: TArgs) => Promise<TReturn> {
  const chains = new Map<string, Promise<unknown>>();
  const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const idleMs = options?.idleCleanupMs ?? 60_000;

  return (...args: TArgs): Promise<TReturn> => {
    const key = args[0];
    const prev = chains.get(key) ?? Promise.resolve();

    // Clear any pending cleanup for this key
    const existingTimer = cleanupTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      cleanupTimers.delete(key);
    }

    const next = prev.then(() => fn(...args));
    chains.set(key, next.catch(() => {}));

    // Schedule cleanup after chain goes idle
    const scheduleCleanup = (): void => {
      const timer = setTimeout(() => {
        cleanupTimers.delete(key);
        chains.delete(key);
      }, idleMs);
      if (timer.unref) timer.unref();
      cleanupTimers.set(key, timer);
    };

    void next.finally(scheduleCleanup);

    return next;
  };
}

/**
 * Lightweight mutex for protecting code regions.
 *
 * @example
 * const mutex = createMutex();
 * const release = await mutex.acquire();
 * try {
 *   // ... critical section ...
 * } finally {
 *   release();
 * }
 */
export function createMutex(): { acquire: () => Promise<() => void>; isLocked: () => boolean } {
  let chain: Promise<unknown> = Promise.resolve();
  let locked = false;

  return {
    acquire(): Promise<() => void> {
      let releaseFn!: () => void;
      const next = new Promise<void>((resolve) => {
        releaseFn = resolve;
      });

      const acquisition = chain.then(() => {
        locked = true;
      });

      chain = next;

      return acquisition.then(() => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          locked = false;
          releaseFn();
        };
      });
    },

    isLocked(): boolean {
      return locked;
    },
  };
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/main/util/__tests__/sequential.spec.ts`
Expected: PASS — all tests green

- [ ] **Step 3: Run TypeScript compiler**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/util/sequential.ts src/main/util/__tests__/sequential.spec.ts
git commit -m "feat: add sequential/keyedSequential/createMutex execution utilities"
```

---

## Task 8: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all Phase A tests together**

Run: `npx vitest run src/shared/types/__tests__/branded-ids.spec.ts src/shared/utils/__tests__/id-generator.spec.ts src/main/util/__tests__/error-utils.spec.ts src/main/util/__tests__/buffered-writer.spec.ts src/main/util/__tests__/sequential.spec.ts`
Expected: All tests PASS

- [ ] **Step 2: Full TypeScript compilation check**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 3: Lint check**

Run: `npm run lint`
Expected: No new errors introduced

- [ ] **Step 4: Verify no broken imports**

Run: `npx vitest run --reporter=verbose 2>&1 | head -50`
Expected: No import resolution failures across the full test suite
