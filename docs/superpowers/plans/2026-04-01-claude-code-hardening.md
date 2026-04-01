# Claude Code Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 7 hardening improvements inspired by the Claude Code CLI, organized into 3 deployable batches.

**Architecture:** New utilities are standalone (no service dependencies). Existing utilities (cleanup registry, abort controller tree) get wired into singleton services and coordinators. File-based locking uses atomic O_EXCL creation. Sibling abort cascades through the existing abort controller tree.

**Tech Stack:** TypeScript 5.9, Vitest, Node.js `fs` (O_EXCL), `AbortController`, `process.kill(pid, 0)` for PID liveness.

**Spec:** `docs/superpowers/specs/2026-04-01-claude-code-hardening-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/main/util/error-utils.ts` | Error stack truncation, abort detection, FS error classification |
| Create | `src/main/util/__tests__/error-utils.spec.ts` | Tests for error utilities |
| Modify | `src/main/process/resource-governor.ts` | Register cleanup on construction |
| Modify | `src/main/process/hibernation-manager.ts` | Register cleanup on construction |
| Modify | `src/main/process/pool-manager.ts` | Register cleanup on construction |
| Modify | `src/main/orchestration/cross-model-review-service.ts` | Register cleanup on construction |
| Modify | `src/main/channels/channel-manager.ts` | Register cleanup on construction |
| Modify | `src/main/session/session-continuity.ts` | Register cleanup on construction + file locking |
| Modify | `src/main/instance/stuck-process-detector.ts` | Register cleanup on construction |
| Modify | `src/main/mcp/mcp-manager.ts` | Register cleanup on construction |
| Modify | `src/main/workspace/lsp-manager.ts` | Register cleanup on construction |
| Modify | `src/main/index.ts` | Wire runCleanupFunctions + sync-first shutdown |
| Modify | `src/shared/types/child-announce.types.ts` | Add 'abort' and 'filesystem' categories |
| Modify | `src/main/orchestration/child-error-classifier.ts` | Integrate error-utils |
| Modify | `src/main/orchestration/utils/coordinator-error-handler.ts` | Use truncateErrorForContext |
| Modify | `src/main/cli/adapters/claude-cli-adapter.ts` | Add classified field to error events |
| Modify | `src/main/orchestration/multi-verify-coordinator.ts` | Sibling abort + concurrency classification |
| Modify | `src/main/orchestration/debate-coordinator.ts` | Sibling abort + concurrency classification |
| Modify | `src/main/orchestration/consensus-coordinator.ts` | Sibling abort + concurrency classification |
| Modify | `src/main/orchestration/parallel-worktree-coordinator.ts` | Sibling abort + file locking + concurrency classification |
| Create | `src/main/util/file-lock.ts` | Atomic file-based cross-process locking |
| Create | `src/main/util/__tests__/file-lock.spec.ts` | Tests for file locking |
| Create | `src/main/orchestration/concurrency-classifier.ts` | Operation concurrency safety classification |
| Create | `src/main/orchestration/__tests__/concurrency-classifier.spec.ts` | Tests for concurrency classifier |
| Modify | `src/main/persistence/rlm-database.ts` | File locking around writes |

---

## Batch 1: Wire Existing + Small Utilities

### Task 1: Error Utilities — Tests

**Files:**
- Create: `src/main/util/__tests__/error-utils.spec.ts`

- [ ] **Step 1: Write failing tests for shortErrorStack**

```typescript
import { describe, expect, it } from 'vitest';
import { shortErrorStack, isAbortError, isFsInaccessible, truncateErrorForContext } from '../error-utils';

describe('shortErrorStack', () => {
  it('returns string representation of non-Error values', () => {
    expect(shortErrorStack('oops')).toBe('oops');
    expect(shortErrorStack(42)).toBe('42');
    expect(shortErrorStack(null)).toBe('null');
  });

  it('returns full stack when frames <= maxFrames', () => {
    const err = new Error('short');
    // Error with 1-2 frames should be returned as-is
    const result = shortErrorStack(err, 5);
    expect(result).toContain('short');
    expect(result).toContain('at ');
  });

  it('truncates stack to maxFrames', () => {
    const err = new Error('deep');
    // Simulate a deep stack by overwriting
    err.stack = [
      'Error: deep',
      '    at fn1 (file1.ts:1:1)',
      '    at fn2 (file2.ts:2:2)',
      '    at fn3 (file3.ts:3:3)',
      '    at fn4 (file4.ts:4:4)',
      '    at fn5 (file5.ts:5:5)',
      '    at fn6 (file6.ts:6:6)',
      '    at fn7 (file7.ts:7:7)',
    ].join('\n');

    const result = shortErrorStack(err, 3);
    const lines = result.split('\n');
    // Header + 3 frames = 4 lines
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('Error: deep');
    expect(lines[3]).toContain('fn3');
  });

  it('defaults to 5 frames', () => {
    const err = new Error('default');
    err.stack = [
      'Error: default',
      ...Array.from({ length: 10 }, (_, i) => `    at fn${i} (file.ts:${i}:1)`),
    ].join('\n');

    const result = shortErrorStack(err);
    const frames = result.split('\n').filter(l => l.trim().startsWith('at '));
    expect(frames).toHaveLength(5);
  });

  it('handles Error with no stack', () => {
    const err = new Error('no-stack');
    err.stack = undefined;
    expect(shortErrorStack(err)).toBe('no-stack');
  });
});
```

- [ ] **Step 2: Write failing tests for isAbortError**

Append to the same file:

```typescript
describe('isAbortError', () => {
  it('detects native AbortError by name', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('detects Error with name set to AbortError', () => {
    const err = new Error('cancelled');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('detects AbortController signal reason', () => {
    const ac = new AbortController();
    ac.abort(new Error('test abort'));
    expect(isAbortError(ac.signal.reason)).toBe(true);
  });

  it('returns false for regular errors', () => {
    expect(isAbortError(new Error('nope'))).toBe(false);
    expect(isAbortError(new TypeError('nope'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });
});
```

- [ ] **Step 3: Write failing tests for isFsInaccessible**

Append to the same file:

```typescript
describe('isFsInaccessible', () => {
  function makeErrno(code: string): NodeJS.ErrnoException {
    const err = new Error(`${code}: operation failed`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  it('returns true for ENOENT', () => {
    expect(isFsInaccessible(makeErrno('ENOENT'))).toBe(true);
  });

  it('returns true for EACCES', () => {
    expect(isFsInaccessible(makeErrno('EACCES'))).toBe(true);
  });

  it('returns true for EPERM', () => {
    expect(isFsInaccessible(makeErrno('EPERM'))).toBe(true);
  });

  it('returns true for ENOTDIR', () => {
    expect(isFsInaccessible(makeErrno('ENOTDIR'))).toBe(true);
  });

  it('returns true for ELOOP', () => {
    expect(isFsInaccessible(makeErrno('ELOOP'))).toBe(true);
  });

  it('returns false for other errno codes', () => {
    expect(isFsInaccessible(makeErrno('EEXIST'))).toBe(false);
    expect(isFsInaccessible(makeErrno('EISDIR'))).toBe(false);
  });

  it('returns false for non-errno errors', () => {
    expect(isFsInaccessible(new Error('not fs'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isFsInaccessible(null)).toBe(false);
    expect(isFsInaccessible('ENOENT')).toBe(false);
  });
});
```

- [ ] **Step 4: Write failing tests for truncateErrorForContext**

Append to the same file:

```typescript
describe('truncateErrorForContext', () => {
  it('returns short error messages unchanged', () => {
    const result = truncateErrorForContext(new Error('short'));
    expect(result).toContain('short');
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('truncates long errors to maxChars', () => {
    const err = new Error('x'.repeat(1000));
    err.stack = [
      `Error: ${'x'.repeat(1000)}`,
      ...Array.from({ length: 20 }, (_, i) => `    at fn${i} (file.ts:${i}:1)`),
    ].join('\n');

    const result = truncateErrorForContext(err, 200);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('handles non-Error values', () => {
    expect(truncateErrorForContext('string error')).toBe('string error');
    expect(truncateErrorForContext(42)).toBe('42');
    expect(truncateErrorForContext(null)).toBe('null');
  });

  it('defaults to 500 chars', () => {
    const err = new Error('y'.repeat(2000));
    const result = truncateErrorForContext(err);
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run src/main/util/__tests__/error-utils.spec.ts`
Expected: FAIL — module `../error-utils` does not exist

---

### Task 2: Error Utilities — Implementation

**Files:**
- Create: `src/main/util/error-utils.ts`

- [ ] **Step 1: Implement all four functions**

```typescript
/**
 * Error utilities — standalone functions with zero dependencies.
 *
 * Inspired by Claude Code utils/errors.ts. Provides error stack truncation,
 * abort detection, filesystem error classification, and context-bounded
 * error formatting for orchestration flows.
 */

const FS_INACCESSIBLE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP']);

/**
 * Truncate an error stack to at most `maxFrames` "at ..." lines.
 * Used when errors flow into orchestration context to save tokens.
 */
export function shortErrorStack(e: unknown, maxFrames = 5): string {
  if (!(e instanceof Error)) return String(e);
  if (!e.stack) return e.message;

  const lines = e.stack.split('\n');
  const header = lines[0] ?? e.message;
  const frames = lines.slice(1).filter(l => l.trim().startsWith('at '));

  if (frames.length <= maxFrames) return e.stack;
  return [header, ...frames.slice(0, maxFrames)].join('\n');
}

/**
 * Detect AbortError from multiple sources:
 * - DOMException with name 'AbortError'
 * - Any Error with name 'AbortError'
 * - AbortSignal reason that is an Error
 */
export function isAbortError(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false;
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  if (e instanceof Error && e.name === 'AbortError') return true;
  return false;
}

/**
 * True for filesystem errors that indicate the path is inaccessible:
 * ENOENT, EACCES, EPERM, ENOTDIR, ELOOP.
 */
export function isFsInaccessible(e: unknown): e is NodeJS.ErrnoException {
  if (e == null || typeof e !== 'object') return false;
  const code = (e as NodeJS.ErrnoException).code;
  return typeof code === 'string' && FS_INACCESSIBLE_CODES.has(code);
}

/**
 * Combine shortErrorStack + message truncation for agent context.
 * Returns a bounded string suitable for passing between agents.
 */
export function truncateErrorForContext(e: unknown, maxChars = 500): string {
  const full = shortErrorStack(e);
  if (full.length <= maxChars) return full;
  return full.slice(0, maxChars);
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/main/util/__tests__/error-utils.spec.ts`
Expected: All tests PASS

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/util/error-utils.ts src/main/util/__tests__/error-utils.spec.ts
git commit -m "feat: add error utility functions (shortErrorStack, isAbortError, isFsInaccessible, truncateErrorForContext)"
```

---

### Task 3: Wire Cleanup Registry into Singleton Services

**Files:**
- Modify: `src/main/process/resource-governor.ts`
- Modify: `src/main/process/hibernation-manager.ts`
- Modify: `src/main/process/pool-manager.ts`
- Modify: `src/main/orchestration/cross-model-review-service.ts`
- Modify: `src/main/channels/channel-manager.ts`
- Modify: `src/main/session/session-continuity.ts`
- Modify: `src/main/instance/stuck-process-detector.ts`
- Modify: `src/main/mcp/mcp-manager.ts`
- Modify: `src/main/workspace/lsp-manager.ts`

Each service follows the same pattern. Add import + registration in the constructor. The cleanup function calls the service's existing `stop()`/`shutdown()` method.

- [ ] **Step 1: Wire ResourceGovernor**

In `src/main/process/resource-governor.ts`:

Add import at top:
```typescript
import { registerCleanup } from '../util/cleanup-registry';
```

At the end of `constructor()` (after `this.logger = ...` on line 108), add:
```typescript
    registerCleanup(() => { this.stop(); });
```

- [ ] **Step 2: Wire HibernationManager**

In `src/main/process/hibernation-manager.ts`:

Add import at top:
```typescript
import { registerCleanup } from '../util/cleanup-registry';
```

At the end of the constructor, add:
```typescript
    registerCleanup(() => { this.stop(); });
```

- [ ] **Step 3: Wire PoolManager**

In `src/main/process/pool-manager.ts`:

Add import at top:
```typescript
import { registerCleanup } from '../util/cleanup-registry';
```

At the end of the constructor, add:
```typescript
    registerCleanup(() => { this.stop(); });
```

- [ ] **Step 4: Wire CrossModelReviewService**

In `src/main/orchestration/cross-model-review-service.ts`:

Add import at top:
```typescript
import { registerCleanup } from '../util/cleanup-registry';
```

At the end of the constructor, add:
```typescript
    registerCleanup(() => { this.shutdown(); });
```

- [ ] **Step 5: Wire ChannelManager**

In `src/main/channels/channel-manager.ts`:

Add import at top:
```typescript
import { registerCleanup } from '../util/cleanup-registry';
```

At the end of the constructor, add:
```typescript
    registerCleanup(() => this.shutdown());
```

- [ ] **Step 6: Wire SessionContinuityManager**

In `src/main/session/session-continuity.ts`:

Add import at top:
```typescript
import { registerCleanup } from '../util/cleanup-registry';
```

At the end of the constructor, add:
```typescript
    registerCleanup(() => { this.shutdown(); });
```

- [ ] **Step 7: Wire StuckProcessDetector**

In `src/main/instance/stuck-process-detector.ts`:

Add import at top:
```typescript
import { registerCleanup } from '../util/cleanup-registry';
```

At the end of the constructor, add:
```typescript
    registerCleanup(() => { this.shutdown(); });
```

- [ ] **Step 8: Wire McpManager**

In `src/main/mcp/mcp-manager.ts`:

Add import at top:
```typescript
import { registerCleanup } from '../util/cleanup-registry';
```

At the end of the constructor, add:
```typescript
    registerCleanup(() => this.shutdown());
```

- [ ] **Step 9: Wire LspManager**

In `src/main/workspace/lsp-manager.ts`:

Add import at top:
```typescript
import { registerCleanup } from '../util/cleanup-registry';
```

At the end of the constructor, add:
```typescript
    registerCleanup(() => this.shutdown());
```

- [ ] **Step 10: Wire runCleanupFunctions into index.ts cleanup**

In `src/main/index.ts`:

Add import at top (near other util imports):
```typescript
import { runCleanupFunctions } from './util/cleanup-registry';
```

In the `cleanup()` method (line 826), add `runCleanupFunctions()` as the first call:
```typescript
  async cleanup(): Promise<void> {
    logger.info('Cleaning up');
    // Phase 1: Run all registered cleanup functions (additive safety net)
    await runCleanupFunctions();
    // Phase 2: Existing manual teardown (kept as fallback)
    try { getResourceGovernor().stop(); } catch { /* best effort */ }
    // ... rest unchanged
```

- [ ] **Step 11: Run typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: No errors

- [ ] **Step 12: Run existing cleanup registry tests**

Run: `npx vitest run src/main/util/__tests__/cleanup-registry.spec.ts`
Expected: All PASS

- [ ] **Step 13: Commit**

```bash
git add src/main/process/resource-governor.ts src/main/process/hibernation-manager.ts src/main/process/pool-manager.ts src/main/orchestration/cross-model-review-service.ts src/main/channels/channel-manager.ts src/main/session/session-continuity.ts src/main/instance/stuck-process-detector.ts src/main/mcp/mcp-manager.ts src/main/workspace/lsp-manager.ts src/main/index.ts
git commit -m "feat: wire cleanup registry into 9 singleton services and main shutdown"
```

---

## Batch 2: Medium Effort, High Impact

### Task 4: Sync-First Shutdown Sequence

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add cleanupSync method to AIOrchestratorApp**

In `src/main/index.ts`, add this method to the `AIOrchestratorApp` class, before `cleanup()`:

```typescript
  /**
   * Synchronous best-effort shutdown — guarantees state is saved and processes
   * are signaled even if the async cleanup phase hangs or times out.
   *
   * Inspired by Claude Code's writeSync()-first pattern in gracefulShutdown.ts.
   */
  private cleanupSync(): void {
    // Save all dirty session states synchronously (writeFileSync)
    try {
      getSessionContinuityManagerIfInitialized()?.shutdown();
    } catch (error) {
      logger.error('Sync session save failed', error instanceof Error ? error : undefined);
    }

    // Send SIGTERM to all tracked CLI processes
    try {
      BaseCliAdapter.killAllActiveProcesses();
    } catch (error) {
      logger.error('Sync process kill failed', error instanceof Error ? error : undefined);
    }
  }
```

- [ ] **Step 2: Remove duplicate session shutdown from async cleanup**

In the `cleanup()` method, remove the session continuity shutdown block since it now runs in `cleanupSync()`. Replace:

```typescript
    // Save all tracked session states before terminating
    try {
      getSessionContinuityManagerIfInitialized()?.shutdown();
    } catch (error) {
      logger.error('Failed to save sessions on shutdown', error instanceof Error ? error : undefined);
    }
```

With a comment:
```typescript
    // Session state already saved synchronously in cleanupSync()
```

- [ ] **Step 3: Wire cleanupSync into before-quit handler**

In the `before-quit` handler (line 898), add `cleanupSync()` call before `event.preventDefault()`:

```typescript
app.on('before-quit', (event) => {
  if (cleanupDone || !orchestratorApp) return;

  // Phase 1: Synchronous — guaranteed state save + process signaling
  orchestratorApp.cleanupSync();

  // Phase 2: Async — thorough cleanup with timeout
  event.preventDefault();
  cleanupDone = true;

  const timeout = setTimeout(() => {
    logger.warn('Cleanup timed out — forcing quit');
    app.exit(0);
  }, CLEANUP_TIMEOUT_MS);

  orchestratorApp.cleanup()
    .catch((error) => {
      logger.error('Cleanup failed', error instanceof Error ? error : undefined);
    })
    .finally(() => {
      clearTimeout(timeout);
      app.quit();
    });
});
```

Note: `cleanupSync()` must be called before `cleanupDone = true` to ensure it runs even on repeated `before-quit` events.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: add sync-first shutdown phase for guaranteed state save"
```

---

### Task 5: Enhance Error Classification — Types

**Files:**
- Modify: `src/shared/types/child-announce.types.ts`

- [ ] **Step 1: Add 'abort' and 'filesystem' to ChildErrorCategory**

In `src/shared/types/child-announce.types.ts`, update the `ChildErrorCategory` type (line 44):

```typescript
export type ChildErrorCategory =
  | 'timeout'           // Child timed out
  | 'context_overflow'  // Child ran out of context window
  | 'process_crash'     // Child process died unexpectedly
  | 'rate_limited'      // Provider rate limited the child
  | 'auth_failure'      // Authentication/authorization issue
  | 'network_error'     // Network connectivity issue
  | 'task_failure'      // Child reported task failure (not a system error)
  | 'stuck'             // Child detected as stuck by StuckProcessDetector
  | 'abort'             // Operation was aborted (cancellation, sibling abort)
  | 'filesystem'        // Filesystem inaccessible (ENOENT, EACCES, EPERM, etc.)
  | 'unknown';          // Unclassified error
```

- [ ] **Step 2: Run typecheck on both configs**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors (existing code handles unknown categories gracefully)

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/child-announce.types.ts
git commit -m "feat: add 'abort' and 'filesystem' to ChildErrorCategory"
```

---

### Task 6: Enhance Error Classification — Classifier + Error Handler

**Files:**
- Modify: `src/main/orchestration/child-error-classifier.ts`
- Modify: `src/main/orchestration/utils/coordinator-error-handler.ts`
- Modify: `src/main/cli/adapters/claude-cli-adapter.ts`

- [ ] **Step 1: Integrate error-utils into ChildErrorClassifier**

In `src/main/orchestration/child-error-classifier.ts`:

Add import at top:
```typescript
import { isAbortError, isFsInaccessible } from '../util/error-utils';
```

In the `classify()` method (line 140), add early-exit checks before the `wasStuck` check:

```typescript
  classify(
    errorMessage: string,
    instanceStatus: string,
    wasStuck = false,
    rawError?: unknown,
  ): ChildErrorClassification {
    // Abort errors take highest priority — cancellation should not be retried
    if (rawError !== undefined && isAbortError(rawError)) {
      return {
        category: 'abort',
        userMessage: 'Operation was aborted.',
        retryable: false,
        suggestedAction: 'skip',
        rawError: errorMessage,
      };
    }

    // Filesystem errors are non-retryable infrastructure issues
    if (rawError !== undefined && isFsInaccessible(rawError)) {
      return {
        category: 'filesystem',
        userMessage: `Filesystem inaccessible: ${(rawError as NodeJS.ErrnoException).code}`,
        retryable: false,
        suggestedAction: 'escalate_to_user',
        rawError: errorMessage,
      };
    }

    // Special case: stuck detection takes priority over pattern matching
    if (wasStuck) {
```

Note: The new `rawError` parameter is optional to maintain backward compatibility.

- [ ] **Step 2: Update coordinator-error-handler to use truncateErrorForContext**

In `src/main/orchestration/utils/coordinator-error-handler.ts`:

Add import at top:
```typescript
import { truncateErrorForContext } from '../../util/error-utils';
```

In the `handleCoordinatorError` function, update the log data to use truncated error context. After the `const err = ...` line (line 66), update the `logData` block:

```typescript
  const err = error instanceof Error ? error : new Error(String(error));
  const classified = recovery.classifyError(err);

  const maxRetries = context.maxRetries ?? DEFAULT_MAX_RETRIES;
  const attempt = context.attempt ?? 0;

  const shouldFailFast = FAIL_FAST_CATEGORIES.has(classified.category);
  const shouldRetry = !shouldFailFast && classified.recoverable && attempt < maxRetries;
  const retryDelayMs = classified.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS;

  const logData: Record<string, unknown> = {
    operation: context.operationName,
    category: classified.category,
    severity: classified.severity,
    recoverable: classified.recoverable,
    attempt,
    maxRetries,
    shouldRetry,
    shouldFailFast,
    errorContext: truncateErrorForContext(error),
    ...context.metadata,
  };
```

Also update the return to include truncated context in `userMessage`:

```typescript
  return {
    classified,
    shouldRetry,
    retryDelayMs,
    shouldFailFast,
    userMessage: classified.userMessage || truncateErrorForContext(error, 200),
  };
```

- [ ] **Step 3: Add classified field to claude-cli-adapter error events**

In `src/main/cli/adapters/claude-cli-adapter.ts`:

Add import at top:
```typescript
import { classifyError } from '../cli-error-handler';
```

Find the error emit at line 294 (`this.emit('error', error);`) and change to:
```typescript
          this.emit('error', error, classifyError(error));
```

Find the error emit at line 630 (`this.emit('error', error);`) and change to:
```typescript
        this.emit('error', error, classifyError(error));
```

Find the error emit at line 651 (`this.emit('error', error);`) and change to:
```typescript
      this.emit('error', error, classifyError(error));
```

- [ ] **Step 4: Run typecheck + lint**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run lint`
Expected: No errors

- [ ] **Step 5: Run existing child-error-classifier tests**

Run: `npx vitest run src/main/orchestration/__tests__/child-error-classifier.spec.ts`
Expected: All PASS (new parameter is optional)

- [ ] **Step 6: Commit**

```bash
git add src/main/orchestration/child-error-classifier.ts src/main/orchestration/utils/coordinator-error-handler.ts src/main/cli/adapters/claude-cli-adapter.ts
git commit -m "feat: integrate error-utils into child classifier, coordinator handler, and CLI adapter"
```

---

### Task 7: Sibling Abort — Tests

**Files:**
- Create: `src/main/orchestration/__tests__/sibling-abort.spec.ts`

- [ ] **Step 1: Write tests for sibling abort behavior**

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createAbortController, createChildAbortController } from '../../util/abort-controller-tree';

describe('Sibling abort pattern', () => {
  it('parent abort cascades to all children', () => {
    const parent = createAbortController();
    const child1 = createChildAbortController(parent);
    const child2 = createChildAbortController(parent);
    const child3 = createChildAbortController(parent);

    expect(child1.signal.aborted).toBe(false);
    expect(child2.signal.aborted).toBe(false);
    expect(child3.signal.aborted).toBe(false);

    parent.abort('fatal error');

    expect(child1.signal.aborted).toBe(true);
    expect(child2.signal.aborted).toBe(true);
    expect(child3.signal.aborted).toBe(true);
  });

  it('child abort does not cascade to siblings', () => {
    const parent = createAbortController();
    const child1 = createChildAbortController(parent);
    const child2 = createChildAbortController(parent);

    child1.abort('child1 failed');

    expect(child1.signal.aborted).toBe(true);
    expect(child2.signal.aborted).toBe(false);
    expect(parent.signal.aborted).toBe(false);
  });

  it('selective abort: only abort parent on non-retryable errors', () => {
    const parent = createAbortController();
    const child1 = createChildAbortController(parent);
    const child2 = createChildAbortController(parent);

    // Simulate retryable error — do NOT abort parent
    const retryableError = { category: 'timeout', retryable: true };
    if (!retryableError.retryable) parent.abort();

    expect(parent.signal.aborted).toBe(false);
    expect(child2.signal.aborted).toBe(false);

    // Simulate non-retryable error — abort parent
    const fatalError = { category: 'auth_failure', retryable: false };
    if (!fatalError.retryable) parent.abort('auth_failure');

    expect(parent.signal.aborted).toBe(true);
    expect(child2.signal.aborted).toBe(true);
  });

  it('abort handler fires on child when parent aborts', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent);
    const handler = vi.fn();

    child.signal.addEventListener('abort', handler);
    parent.abort('cascade');

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/main/orchestration/__tests__/sibling-abort.spec.ts`
Expected: All PASS (this tests existing abort-controller-tree behavior applied to the sibling pattern)

- [ ] **Step 3: Commit**

```bash
git add src/main/orchestration/__tests__/sibling-abort.spec.ts
git commit -m "test: add sibling abort pattern tests for coordination groups"
```

---

### Task 8: Sibling Abort — Wire into Coordinators

**Files:**
- Modify: `src/main/orchestration/multi-verify-coordinator.ts`
- Modify: `src/main/orchestration/debate-coordinator.ts`
- Modify: `src/main/orchestration/consensus-coordinator.ts`
- Modify: `src/main/orchestration/parallel-worktree-coordinator.ts`

- [ ] **Step 1: Wire into MultiVerifyCoordinator**

In `src/main/orchestration/multi-verify-coordinator.ts`:

Add import at top:
```typescript
import { createAbortController, createChildAbortController } from '../util/abort-controller-tree';
```

In `runVerification()` (line 252), create a parent abort controller before the agent launch:

After the `agentConfigs` array creation (line 269), add:
```typescript
    // Sibling abort: parent controller for this verification round
    const roundAbort = createAbortController();
```

Change the `Promise.all` call (line 286) to pass abort controllers:
```typescript
    const responses = await Promise.all(agentConfigs.map((agentConfig) => {
      const childAbort = createChildAbortController(roundAbort);
      return this.runAgent(request, agentConfig, childAbort).catch((error) => {
        // On non-retryable error, abort all siblings
        if (!roundAbort.signal.aborted) {
          const classification = this.classifyAgentError(error);
          if (!classification.retryable) {
            roundAbort.abort(classification.category);
          }
        }
        throw error;
      });
    }));
```

Update `runAgent` signature (line 386) to accept an optional abort controller:
```typescript
  private async runAgent(
    request: VerificationRequest,
    agentConfig: { agentId: string; agentIndex: number; model: string; personality?: PersonalityType },
    abortController?: AbortController,
  ): Promise<AgentResponse> {
```

Inside `runAgent`, add an early abort check after creating the promise (after line 409):
```typescript
      // Check if sibling abort fired before we even start
      if (abortController?.signal.aborted) {
        throw new Error(`Aborted: ${abortController.signal.reason}`);
      }
```

Add a helper method to the class:
```typescript
  private classifyAgentError(error: unknown): { retryable: boolean; category: string } {
    const msg = error instanceof Error ? error.message : String(error);
    if (/auth|unauthorized|forbidden/i.test(msg)) return { retryable: false, category: 'auth_failure' };
    if (/SIGKILL|SIGSEGV/i.test(msg)) return { retryable: false, category: 'process_crash' };
    // Default: retryable (timeout, rate limit, etc.)
    return { retryable: true, category: 'transient' };
  }
```

- [ ] **Step 2: Wire into DebateCoordinator**

In `src/main/orchestration/debate-coordinator.ts`:

Add import at top:
```typescript
import { createAbortController, createChildAbortController } from '../util/abort-controller-tree';
```

In `runDebate()` (line 154), create a debate-level abort controller:
```typescript
  private async runDebate(debate: ActiveDebate): Promise<void> {
    const debateAbort = createAbortController();
    try {
      await this.runInitialRound(debate, debateAbort);
```

Update `runInitialRound` to accept and use the abort controller:
```typescript
  private async runInitialRound(debate: ActiveDebate, abortController?: AbortController): Promise<void> {
    const roundStart = Date.now();
    const contributions: DebateContribution[] = [];

    const results = await Promise.all(
      Array.from({ length: debate.config.agents }, (_, i) => {
        const childAbort = abortController ? createChildAbortController(abortController) : undefined;
        const temperature = this.getAgentTemperature(i, debate.config);
        return this.generateInitialResponse(debate, i, temperature).catch((error) => {
          if (abortController && !abortController.signal.aborted) {
            const msg = error instanceof Error ? error.message : String(error);
            if (/auth|unauthorized|forbidden/i.test(msg)) {
              abortController.abort('auth_failure');
            }
          }
          throw error;
        });
      })
    );
```

Apply the same pattern to `runCritiqueRound` — pass `abortController` through the `runDebate` loop.

- [ ] **Step 3: Wire into ConsensusCoordinator and ParallelWorktreeCoordinator**

Follow the same pattern as Steps 1-2:
- Create parent `AbortController` per coordination round
- Create child controllers for each parallel operation
- On non-retryable error classification, abort parent
- Check abort signal at the start of each child operation

For `ParallelWorktreeCoordinator`, the abort controller goes in `startParallelExecution()`.

- [ ] **Step 4: Run typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: No errors

- [ ] **Step 5: Run all existing orchestration tests**

Run: `npx vitest run src/main/orchestration/__tests__/`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/orchestration/multi-verify-coordinator.ts src/main/orchestration/debate-coordinator.ts src/main/orchestration/consensus-coordinator.ts src/main/orchestration/parallel-worktree-coordinator.ts
git commit -m "feat: wire sibling abort into all coordination groups"
```

---

## Batch 3: Targeted Hardening

### Task 9: File-Based Locking — Tests

**Files:**
- Create: `src/main/util/__tests__/file-lock.spec.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLock, withLock } from '../file-lock';

describe('file-lock', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
    lockPath = path.join(tmpDir, 'test.lock');
  });

  afterEach(() => {
    // Clean up
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  describe('acquireLock', () => {
    it('acquires lock on fresh path', async () => {
      const result = await acquireLock(lockPath, { purpose: 'test' });
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') {
        await result.release();
      }
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('returns blocked when lock already held', async () => {
      const first = await acquireLock(lockPath);
      expect(first.kind).toBe('acquired');

      const second = await acquireLock(lockPath);
      expect(second.kind).toBe('blocked');
      if (second.kind === 'blocked') {
        expect(second.holder.pid).toBe(process.pid);
      }

      if (first.kind === 'acquired') await first.release();
    });

    it('recovers stale lock from dead process', async () => {
      // Write a lock with a PID that doesn't exist
      const staleLock = {
        pid: 999999,
        sessionId: 'dead-session',
        acquiredAt: Date.now() - 60000,
        purpose: 'stale',
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleLock));

      const result = await acquireLock(lockPath, { purpose: 'recovery' });
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') {
        await result.release();
      }
    });

    it('lock file contains correct holder info', async () => {
      const result = await acquireLock(lockPath, { purpose: 'info-check' });
      expect(result.kind).toBe('acquired');

      const content = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      expect(content.pid).toBe(process.pid);
      expect(content.purpose).toBe('info-check');
      expect(typeof content.acquiredAt).toBe('number');

      if (result.kind === 'acquired') await result.release();
    });

    it('release is idempotent', async () => {
      const result = await acquireLock(lockPath);
      expect(result.kind).toBe('acquired');
      if (result.kind === 'acquired') {
        await result.release();
        await result.release(); // second call should not throw
      }
    });
  });

  describe('withLock', () => {
    it('acquires lock, runs fn, releases', async () => {
      let insideLock = false;
      await withLock(lockPath, async () => {
        insideLock = true;
        expect(fs.existsSync(lockPath)).toBe(true);
      });
      expect(insideLock).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('releases lock even if fn throws', async () => {
      await expect(withLock(lockPath, async () => {
        throw new Error('boom');
      })).rejects.toThrow('boom');
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('throws when lock is blocked and no timeout', async () => {
      const first = await acquireLock(lockPath);
      await expect(withLock(lockPath, async () => {})).rejects.toThrow(/blocked/i);
      if (first.kind === 'acquired') await first.release();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/util/__tests__/file-lock.spec.ts`
Expected: FAIL — module `../file-lock` does not exist

---

### Task 10: File-Based Locking — Implementation

**Files:**
- Create: `src/main/util/file-lock.ts`

- [ ] **Step 1: Implement file lock**

```typescript
/**
 * Atomic file-based cross-process locking using O_EXCL.
 *
 * Inspired by Claude Code utils/computerUse/computerUseLock.ts.
 * Uses atomic file creation for acquisition, PID liveness checking
 * for stale lock recovery, and cleanup registry for shutdown safety.
 */

import * as fs from 'fs';
import { registerCleanup } from './cleanup-registry';

export interface LockHolder {
  pid: number;
  sessionId: string;
  acquiredAt: number;
  purpose?: string;
}

export type LockResult =
  | { kind: 'acquired'; release: () => Promise<void> }
  | { kind: 'blocked'; holder: LockHolder };

function getSessionId(): string {
  return `${process.pid}-${Date.now()}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tryExclusiveCreate(lockPath: string, holder: LockHolder): Promise<boolean> {
  try {
    await fs.promises.writeFile(lockPath, JSON.stringify(holder), { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

async function readLockHolder(lockPath: string): Promise<LockHolder | null> {
  try {
    const content = await fs.promises.readFile(lockPath, 'utf8');
    return JSON.parse(content) as LockHolder;
  } catch {
    return null;
  }
}

/**
 * Acquire an exclusive file lock using O_EXCL atomic creation.
 * Automatically recovers stale locks from dead processes.
 */
export async function acquireLock(lockPath: string, options?: {
  purpose?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): Promise<LockResult> {
  const sessionId = getSessionId();
  const holder: LockHolder = {
    pid: process.pid,
    sessionId,
    acquiredAt: Date.now(),
    purpose: options?.purpose,
  };

  const attempt = async (): Promise<LockResult> => {
    // Try atomic exclusive create
    if (await tryExclusiveCreate(lockPath, holder)) {
      return makeAcquiredResult(lockPath, sessionId);
    }

    // Lock exists — check if holder is alive
    const existing = await readLockHolder(lockPath);
    if (!existing) {
      // Lock file exists but unreadable — try to clean up
      try { await fs.promises.unlink(lockPath); } catch { /* race */ }
      if (await tryExclusiveCreate(lockPath, holder)) {
        return makeAcquiredResult(lockPath, sessionId);
      }
      return { kind: 'blocked', holder: { pid: 0, sessionId: '', acquiredAt: 0, purpose: 'unknown' } };
    }

    // Same process re-acquiring
    if (existing.pid === process.pid) {
      return { kind: 'blocked', holder: existing };
    }

    // Check if holder process is alive
    if (isProcessAlive(existing.pid)) {
      return { kind: 'blocked', holder: existing };
    }

    // Stale lock — holder is dead, try to reclaim
    try { await fs.promises.unlink(lockPath); } catch { /* lost race */ }
    if (await tryExclusiveCreate(lockPath, holder)) {
      return makeAcquiredResult(lockPath, sessionId);
    }

    // Lost the recovery race
    const winner = await readLockHolder(lockPath);
    return { kind: 'blocked', holder: winner ?? existing };
  };

  // No timeout — single attempt
  if (!options?.timeoutMs) {
    return attempt();
  }

  // With timeout — poll until acquired or timeout
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.retryIntervalMs ?? 200;

  while (Date.now() < deadline) {
    const result = await attempt();
    if (result.kind === 'acquired') return result;
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  return attempt(); // Final attempt
}

function makeAcquiredResult(lockPath: string, sessionId: string): LockResult {
  let released = false;

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    unregister();
    try {
      const current = await readLockHolder(lockPath);
      if (current?.sessionId === sessionId) {
        await fs.promises.unlink(lockPath);
      }
    } catch {
      // Lock file already gone — fine
    }
  };

  // Register cleanup so lock is released on shutdown
  const unregister = registerCleanup(release);

  return { kind: 'acquired', release };
}

/**
 * Scoped lock — acquire, run fn, release in finally.
 * Throws if lock cannot be acquired.
 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, options?: {
  purpose?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): Promise<T> {
  const result = await acquireLock(lockPath, options);
  if (result.kind === 'blocked') {
    throw new Error(`Lock blocked by PID ${result.holder.pid} (${result.holder.purpose ?? 'unknown'})`);
  }
  try {
    return await fn();
  } finally {
    await result.release();
  }
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/main/util/__tests__/file-lock.spec.ts`
Expected: All PASS

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/util/file-lock.ts src/main/util/__tests__/file-lock.spec.ts
git commit -m "feat: add atomic file-based cross-process locking utility"
```

---

### Task 11: Apply File Locking to Shared Resources

**Files:**
- Modify: `src/main/orchestration/parallel-worktree-coordinator.ts`
- Modify: `src/main/persistence/rlm-database.ts`
- Modify: `src/main/session/session-continuity.ts`

- [ ] **Step 1: Add locking to ParallelWorktreeCoordinator**

In `src/main/orchestration/parallel-worktree-coordinator.ts`:

Add import:
```typescript
import { withLock } from '../util/file-lock';
```

In `startParallelExecution()` (line 82), wrap each worktree operation with a lock. Find where individual worktree tasks are executed and wrap them:

```typescript
// Before executing in a worktree, acquire a lock on it
const lockPath = path.join(worktreePath, '.orchestrator.lock');
await withLock(lockPath, async () => {
  // ... existing worktree execution code
}, { purpose: `parallel-worktree-${taskId}` });
```

- [ ] **Step 2: Add locking to RLM database backup**

In `src/main/persistence/rlm-database.ts`:

Add import:
```typescript
import { withLock } from '../util/file-lock';
```

Find the `backupDatabase()` method and wrap it:
```typescript
  async backupDatabase(): Promise<void> {
    const lockPath = `${this.dbPath}.lock`;
    await withLock(lockPath, async () => {
      // ... existing backup code
    }, { purpose: 'rlm-backup' });
  }
```

- [ ] **Step 3: Add locking to session snapshot writes**

In `src/main/session/session-continuity.ts`:

Add import (may already be present from Task 3):
```typescript
import { withLock } from '../util/file-lock';
```

Find the snapshot save method(s) that write to disk and wrap with a lock:
```typescript
const lockPath = `${snapshotPath}.lock`;
await withLock(lockPath, async () => {
  await fs.promises.writeFile(snapshotPath, serialized);
}, { purpose: `snapshot-${instanceId}` });
```

Note: The synchronous `shutdown()` method should NOT use file locking (it uses `writeFileSync` intentionally for reliability).

Note: Memory stores (episodic, procedural, semantic) are in-memory only — their disk writes are delegated through SessionContinuityManager's snapshot system (covered above) and RLM database (covered in Step 2). No separate locking needed for memory stores.

- [ ] **Step 4: Run typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/main/orchestration/parallel-worktree-coordinator.ts src/main/persistence/rlm-database.ts src/main/session/session-continuity.ts
git commit -m "feat: apply file-based locking to worktree, RLM, and session resources"
```

---

### Task 12: Concurrency Classifier — Tests

**Files:**
- Create: `src/main/orchestration/__tests__/concurrency-classifier.spec.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, expect, it } from 'vitest';
import {
  classifyOperationSafety,
  scheduleOperations,
  type OperationDescriptor,
} from '../concurrency-classifier';

describe('classifyOperationSafety', () => {
  it('read operations are concurrent', () => {
    expect(classifyOperationSafety({ type: 'read', target: '/foo' })).toBe('concurrent');
  });

  it('analysis operations are concurrent', () => {
    expect(classifyOperationSafety({ type: 'analysis' })).toBe('concurrent');
  });

  it('write operations need target check', () => {
    expect(classifyOperationSafety({ type: 'write', target: '/foo' })).toBe('needs_target_check');
  });

  it('git operations need target check', () => {
    expect(classifyOperationSafety({ type: 'git', target: '/repo' })).toBe('needs_target_check');
  });

  it('shell operations need target check', () => {
    expect(classifyOperationSafety({ type: 'shell', target: '/dir' })).toBe('needs_target_check');
  });

  it('unknown type defaults to exclusive', () => {
    expect(classifyOperationSafety({ type: 'unknown' as any })).toBe('exclusive');
  });

  it('write without target is exclusive', () => {
    expect(classifyOperationSafety({ type: 'write' })).toBe('exclusive');
  });
});

describe('scheduleOperations', () => {
  it('all concurrent ops go in one batch', () => {
    const ops: OperationDescriptor[] = [
      { type: 'read', target: '/a' },
      { type: 'analysis' },
      { type: 'read', target: '/b' },
    ];
    const batches = scheduleOperations(ops);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('non-overlapping writes go in one batch', () => {
    const ops: OperationDescriptor[] = [
      { type: 'write', target: '/a' },
      { type: 'write', target: '/b' },
      { type: 'write', target: '/c' },
    ];
    const batches = scheduleOperations(ops);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('overlapping writes go in separate batches', () => {
    const ops: OperationDescriptor[] = [
      { type: 'write', target: '/a' },
      { type: 'write', target: '/a' },
    ];
    const batches = scheduleOperations(ops);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
  });

  it('mixed concurrent and exclusive ops are batched correctly', () => {
    const ops: OperationDescriptor[] = [
      { type: 'read', target: '/a' },
      { type: 'write', target: '/a' },
      { type: 'analysis' },
    ];
    const batches = scheduleOperations(ops);
    // Read + analysis concurrent, write to /a exclusive
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });

  it('targetless writes each get their own batch', () => {
    const ops: OperationDescriptor[] = [
      { type: 'write' },
      { type: 'write' },
    ];
    const batches = scheduleOperations(ops);
    expect(batches).toHaveLength(2);
  });

  it('empty input returns empty batches', () => {
    expect(scheduleOperations([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/orchestration/__tests__/concurrency-classifier.spec.ts`
Expected: FAIL — module does not exist

---

### Task 13: Concurrency Classifier — Implementation

**Files:**
- Create: `src/main/orchestration/concurrency-classifier.ts`

- [ ] **Step 1: Implement classifier**

```typescript
/**
 * Tool concurrency safety classification for orchestration.
 *
 * Inspired by Claude Code StreamingToolExecutor's isConcurrencySafe pattern.
 * Classifies operations as safe/unsafe for parallel execution and groups
 * them into schedulable batches.
 */

export interface OperationDescriptor {
  type: 'read' | 'write' | 'git' | 'shell' | 'analysis';
  target?: string;
}

export type ConcurrencySafety = 'concurrent' | 'needs_target_check' | 'exclusive';

const ALWAYS_CONCURRENT = new Set(['read', 'analysis']);
const NEEDS_TARGET_CHECK = new Set(['write', 'git', 'shell']);

/**
 * Classify a single operation's inherent safety (without overlap context).
 */
export function classifyOperationSafety(operation: OperationDescriptor): ConcurrencySafety {
  if (ALWAYS_CONCURRENT.has(operation.type)) return 'concurrent';
  if (NEEDS_TARGET_CHECK.has(operation.type)) {
    return operation.target ? 'needs_target_check' : 'exclusive';
  }
  return 'exclusive';
}

/**
 * Given a set of operations, group them into parallelizable batches.
 *
 * Rules:
 * - 'concurrent' ops all go in the first batch
 * - 'needs_target_check' ops with distinct targets go in the same batch
 * - 'needs_target_check' ops with overlapping targets go in separate batches
 * - 'exclusive' ops each get their own batch
 *
 * Returns batches in execution order — run each batch in parallel,
 * batches run sequentially.
 */
export function scheduleOperations(operations: OperationDescriptor[]): OperationDescriptor[][] {
  if (operations.length === 0) return [];

  const concurrent: OperationDescriptor[] = [];
  const targetChecked: OperationDescriptor[] = [];
  const exclusive: OperationDescriptor[] = [];

  for (const op of operations) {
    const safety = classifyOperationSafety(op);
    if (safety === 'concurrent') concurrent.push(op);
    else if (safety === 'needs_target_check') targetChecked.push(op);
    else exclusive.push(op);
  }

  const batches: OperationDescriptor[][] = [];

  // Group target-checked ops by target overlap
  const targetBatches = groupByTargetOverlap(targetChecked);

  // First batch: all concurrent ops + first group of non-overlapping target-checked ops
  const firstBatch = [...concurrent];
  if (targetBatches.length > 0) {
    firstBatch.push(...targetBatches[0]);
  }
  if (firstBatch.length > 0) {
    batches.push(firstBatch);
  }

  // Remaining target batches
  for (let i = 1; i < targetBatches.length; i++) {
    batches.push(targetBatches[i]);
  }

  // Exclusive ops: one per batch
  for (const op of exclusive) {
    batches.push([op]);
  }

  return batches;
}

/**
 * Group operations so that no two ops in the same group share a target.
 * Uses a greedy coloring algorithm.
 */
function groupByTargetOverlap(ops: OperationDescriptor[]): OperationDescriptor[][] {
  if (ops.length === 0) return [];

  const groups: OperationDescriptor[][] = [];

  for (const op of ops) {
    let placed = false;
    for (const group of groups) {
      const targets = new Set(group.map(o => o.target));
      if (!targets.has(op.target)) {
        group.push(op);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push([op]);
    }
  }

  return groups;
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/main/orchestration/__tests__/concurrency-classifier.spec.ts`
Expected: All PASS

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/orchestration/concurrency-classifier.ts src/main/orchestration/__tests__/concurrency-classifier.spec.ts
git commit -m "feat: add operation concurrency safety classifier with batch scheduling"
```

---

### Task 14: Wire Concurrency Classifier into Coordinators

**Files:**
- Modify: `src/main/orchestration/multi-verify-coordinator.ts`
- Modify: `src/main/orchestration/debate-coordinator.ts`
- Modify: `src/main/orchestration/consensus-coordinator.ts`
- Modify: `src/main/orchestration/parallel-worktree-coordinator.ts`

- [ ] **Step 1: Add operation descriptors to MultiVerifyCoordinator**

In `src/main/orchestration/multi-verify-coordinator.ts`:

Add import:
```typescript
import { scheduleOperations, type OperationDescriptor } from './concurrency-classifier';
```

In `runVerification()`, before the `Promise.all` that spawns agents, classify the operations:

```typescript
    // All verification agents perform read-only analysis — classify as concurrent
    const operations: OperationDescriptor[] = agentConfigs.map(() => ({
      type: 'analysis' as const,
    }));
    const batches = scheduleOperations(operations);

    // Execute batches (for verification, this will always be 1 batch since all are analysis)
    const allResponses: AgentResponse[] = [];
    for (const batch of batches) {
      const batchResponses = await Promise.all(
        batch.map((_, batchIdx) => {
          const globalIdx = allResponses.length + batchIdx;
          const agentConfig = agentConfigs[globalIdx];
          const childAbort = createChildAbortController(roundAbort);
          return this.runAgent(request, agentConfig, childAbort).catch((error) => {
            if (!roundAbort.signal.aborted) {
              const classification = this.classifyAgentError(error);
              if (!classification.retryable) {
                roundAbort.abort(classification.category);
              }
            }
            throw error;
          });
        })
      );
      allResponses.push(...batchResponses);
    }
    const responses = allResponses;
```

- [ ] **Step 2: Add operation descriptors to DebateCoordinator**

In `src/main/orchestration/debate-coordinator.ts`:

Add import:
```typescript
import { scheduleOperations, type OperationDescriptor } from './concurrency-classifier';
```

In `runInitialRound()` and `runCritiqueRound()`, the operations are all analysis so classification confirms current parallel execution is correct. Add a comment for documentation:

```typescript
    // Debate rounds are analysis-only — concurrency classifier confirms parallel execution is safe
    const results = await Promise.all(
```

- [ ] **Step 3: Add operation descriptors to ConsensusCoordinator**

In `src/main/orchestration/consensus-coordinator.ts`:

Add import:
```typescript
import { scheduleOperations, type OperationDescriptor } from './concurrency-classifier';
```

Classify voting rounds as analysis (concurrent) and synthesis as write (exclusive). The synthesis step should be documented as exclusive:

```typescript
    // Voting rounds: concurrent analysis
    // Final synthesis: exclusive (writes result)
```

- [ ] **Step 4: Add operation descriptors to ParallelWorktreeCoordinator**

In `src/main/orchestration/parallel-worktree-coordinator.ts`:

Add import:
```typescript
import { scheduleOperations, type OperationDescriptor } from './concurrency-classifier';
```

In `startParallelExecution()`, classify each task by its worktree target:

```typescript
    const operations: OperationDescriptor[] = tasks.map(task => ({
      type: 'write' as const,
      target: task.worktreePath,
    }));
    const batches = scheduleOperations(operations);

    // Execute batches sequentially, tasks within each batch in parallel
    for (const batch of batches) {
      await Promise.all(batch.map(op => {
        const task = tasks.find(t => t.worktreePath === op.target);
        if (!task) return Promise.resolve();
        const lockPath = path.join(task.worktreePath, '.orchestrator.lock');
        return withLock(lockPath, () => this.executeTask(task), {
          purpose: `worktree-${task.id}`,
        });
      }));
    }
```

- [ ] **Step 5: Run typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: No errors

- [ ] **Step 6: Run all orchestration tests**

Run: `npx vitest run src/main/orchestration/__tests__/`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/orchestration/multi-verify-coordinator.ts src/main/orchestration/debate-coordinator.ts src/main/orchestration/consensus-coordinator.ts src/main/orchestration/parallel-worktree-coordinator.ts
git commit -m "feat: wire concurrency classifier into all coordinators"
```

---

### Task 15: Final Verification

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 2: Full lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: All tests PASS

- [ ] **Step 4: Verify all new files are tracked**

Run: `git status`
Expected: All new files committed, no untracked files
