# Claude Code Audit Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 14 improvements identified by comparing Claude Code CLI patterns against the orchestrator, addressing security gaps, reliability bugs, and architectural deficiencies.

**Architecture:** New utility services follow the existing singleton + EventEmitter pattern. Security fixes go in `src/main/security/`, process utilities in `src/main/util/`, and bug fixes in their respective domains. Each task is independently testable.

**Tech Stack:** TypeScript 5.9, Vitest, Node.js `crypto` for randomness, `AbortController` for cancellation.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/main/security/unicode-sanitizer.ts` | Strip invisible Unicode from all text entering LLM context |
| Create | `src/main/security/__tests__/unicode-sanitizer.spec.ts` | Tests for Unicode sanitization |
| Create | `src/main/util/abort-controller-tree.ts` | Hierarchical AbortController with WeakRef GC safety |
| Create | `src/main/util/__tests__/abort-controller-tree.spec.ts` | Tests for abort tree |
| Create | `src/main/util/cleanup-registry.ts` | Global cleanup registry for graceful shutdown |
| Create | `src/main/util/__tests__/cleanup-registry.spec.ts` | Tests for cleanup registry |
| Modify | `src/main/instance/stuck-process-detector.ts` | Add sleep/wake detection |
| Modify | `src/main/instance/stuck-process-detector.spec.ts` | Tests for sleep detection |
| Modify | `src/main/tasks/background-task-manager.ts` | Add notification dedup + failed dependency propagation |
| Create | `src/main/tasks/__tests__/background-task-manager.spec.ts` | Tests for dedup + dependency fixes |
| Modify | `src/main/security/secret-detector.ts` | Add prefix-based value scanning, stop storing raw values |
| Create | `src/main/security/__tests__/secret-detector.spec.ts` | Tests for prefix scanning |
| Modify | `src/main/plugins/plugin-manager.ts` | Add path traversal protection |
| Modify | `src/main/skills/skill-loader.ts` | Add path traversal protection |
| Modify | `src/main/cli/adapters/base-cli-adapter.ts` | NDJSON U+2028/U+2029 safety on write path |
| Modify | `src/main/session/session-continuity.ts` | Add migration runner framework |

---

## Task 1: Unicode/ASCII Smuggling Sanitization (P0)

**Files:**
- Create: `src/main/security/unicode-sanitizer.ts`
- Create: `src/main/security/__tests__/unicode-sanitizer.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/security/__tests__/unicode-sanitizer.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { sanitizeUnicode, containsDangerousUnicode } from '../unicode-sanitizer';

describe('UnicodeSanitizer', () => {
  describe('containsDangerousUnicode', () => {
    it('returns false for plain ASCII text', () => {
      expect(containsDangerousUnicode('Hello, world!')).toBe(false);
    });

    it('detects zero-width spaces', () => {
      expect(containsDangerousUnicode('Hello\u200Bworld')).toBe(true);
    });

    it('detects zero-width joiners', () => {
      expect(containsDangerousUnicode('test\u200Dvalue')).toBe(true);
    });

    it('detects zero-width non-joiners', () => {
      expect(containsDangerousUnicode('test\u200Cvalue')).toBe(true);
    });

    it('detects direction override characters', () => {
      expect(containsDangerousUnicode('admin\u202Etest')).toBe(true);
    });

    it('detects Tag characters (U+E0001-U+E007F)', () => {
      expect(containsDangerousUnicode('text\u{E0001}injected')).toBe(true);
    });

    it('detects BOM', () => {
      expect(containsDangerousUnicode('\uFEFFhello')).toBe(true);
    });

    it('allows safe non-ASCII (accents, CJK, emoji)', () => {
      expect(containsDangerousUnicode('cafe resume')).toBe(false);
      expect(containsDangerousUnicode('test emoji')).toBe(false);
    });
  });

  describe('sanitizeUnicode', () => {
    it('returns clean text unchanged', () => {
      expect(sanitizeUnicode('Hello, world!')).toBe('Hello, world!');
    });

    it('strips zero-width characters', () => {
      expect(sanitizeUnicode('He\u200Bllo\u200Cwo\u200Drld')).toBe('Helloworld');
    });

    it('strips direction overrides', () => {
      expect(sanitizeUnicode('admin\u202Etest')).toBe('admintest');
    });

    it('strips Tag characters', () => {
      expect(sanitizeUnicode('text\u{E0001}\u{E0068}\u{E0065}end')).toBe('textend');
    });

    it('strips BOM', () => {
      expect(sanitizeUnicode('\uFEFFhello')).toBe('hello');
    });

    it('applies NFKC normalization', () => {
      expect(sanitizeUnicode('\uFB01le')).toBe('file');
    });

    it('handles iterative stripping (nested dangerous chars)', () => {
      const input = 'a\u200B\u200Cb';
      expect(sanitizeUnicode(input)).toBe('ab');
    });

    it('preserves newlines, tabs, and normal whitespace', () => {
      expect(sanitizeUnicode('line1\nline2\ttab')).toBe('line1\nline2\ttab');
    });

    it('handles empty string', () => {
      expect(sanitizeUnicode('')).toBe('');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/security/__tests__/unicode-sanitizer.spec.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Write the implementation**

Create `src/main/security/unicode-sanitizer.ts`:

```typescript
/**
 * Unicode Sanitizer -- strips invisible/dangerous Unicode from text entering LLM context.
 *
 * Defends against prompt injection via:
 * - Zero-width spaces/joiners (U+200B-U+200F)
 * - Direction overrides (U+202A-U+202E, U+2066-U+2069)
 * - Tag characters (U+E0001-U+E007F) used for invisible instruction injection
 * - BOM (U+FEFF)
 * - Other format characters excluding safe whitespace
 *
 * Inspired by Claude Code utils/sanitization.ts (HackerOne #3086545).
 */

const MAX_ITERATIONS = 10;

/**
 * Regex matching dangerous invisible Unicode characters.
 * Covers: zero-width chars, direction controls, tag chars, BOM,
 * soft hyphen, word joiner, interlinear annotation anchors.
 *
 * Excludes safe whitespace: \t \n \r and normal space.
 */
const DANGEROUS_UNICODE_RE = new RegExp(
  [
    '[\u200B-\u200F]',           // zero-width space, ZWNJ, ZWJ, LRM, RLM
    '[\u2028-\u2029]',           // line/paragraph separator
    '[\u202A-\u202E]',           // direction embeddings and overrides
    '[\u2060-\u2064]',           // word joiner, invisible separators
    '[\u2066-\u2069]',           // isolate controls
    '[\u00AD]',                  // soft hyphen
    '[\uFEFF]',                  // BOM / ZWNBSP
    '[\uFFF9-\uFFFB]',          // interlinear annotation anchors
    '[\u{E0001}-\u{E007F}]',    // Tag characters
    '[\u{E0100}-\u{E01EF}]',    // Variation selectors supplement
  ].join('|'),
  'gu'
);

/**
 * Check whether a string contains dangerous invisible Unicode characters.
 */
export function containsDangerousUnicode(text: string): boolean {
  DANGEROUS_UNICODE_RE.lastIndex = 0;
  return DANGEROUS_UNICODE_RE.test(text);
}

/**
 * Strip dangerous invisible Unicode from text, then apply NFKC normalization.
 * Iterates up to MAX_ITERATIONS to handle cases where stripping reveals
 * new dangerous sequences.
 */
export function sanitizeUnicode(text: string): string {
  if (!text) return text;

  let result = text;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    DANGEROUS_UNICODE_RE.lastIndex = 0;
    const cleaned = result.replace(DANGEROUS_UNICODE_RE, '');
    const normalized = cleaned.normalize('NFKC');
    if (normalized === result) break;
    result = normalized;
  }
  return result;
}

/**
 * Deep-sanitize an object's string values recursively.
 * Useful for sanitizing entire IPC payloads or tool outputs.
 */
export function sanitizeObjectStrings<T>(obj: T): T {
  if (typeof obj === 'string') return sanitizeUnicode(obj) as T;
  if (Array.isArray(obj)) return obj.map(sanitizeObjectStrings) as T;
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = sanitizeObjectStrings(value);
    }
    return result as T;
  }
  return obj;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/security/__tests__/unicode-sanitizer.spec.ts`
Expected: PASS (all 11 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/main/security/unicode-sanitizer.ts src/main/security/__tests__/unicode-sanitizer.spec.ts
git commit -m "feat: add Unicode sanitizer to defend against invisible prompt injection"
```

---

## Task 2: Hierarchical AbortController Tree (P0)

**Files:**
- Create: `src/main/util/abort-controller-tree.ts`
- Create: `src/main/util/__tests__/abort-controller-tree.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/util/__tests__/abort-controller-tree.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  createAbortController,
  createChildAbortController,
} from '../abort-controller-tree';

describe('AbortControllerTree', () => {
  describe('createAbortController', () => {
    it('returns a standard AbortController', () => {
      const ac = createAbortController();
      expect(ac.signal.aborted).toBe(false);
      ac.abort();
      expect(ac.signal.aborted).toBe(true);
    });
  });

  describe('createChildAbortController', () => {
    it('child aborts when parent aborts', () => {
      const parent = createAbortController();
      const child = createChildAbortController(parent);

      expect(child.signal.aborted).toBe(false);
      parent.abort();
      expect(child.signal.aborted).toBe(true);
    });

    it('parent does NOT abort when child aborts', () => {
      const parent = createAbortController();
      const child = createChildAbortController(parent);

      child.abort();
      expect(child.signal.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
    });

    it('propagates abort reason from parent to child', () => {
      const parent = createAbortController();
      const child = createChildAbortController(parent);

      parent.abort('timeout');
      expect(child.signal.reason).toBe('timeout');
    });

    it('cleans up parent listener when child is aborted independently', () => {
      const parent = createAbortController();
      const child = createChildAbortController(parent);

      child.abort('done');
      // After child abort, parent aborting should not throw or leak
      parent.abort();
      expect(parent.signal.aborted).toBe(true);
    });

    it('supports multiple children', () => {
      const parent = createAbortController();
      const child1 = createChildAbortController(parent);
      const child2 = createChildAbortController(parent);
      const child3 = createChildAbortController(parent);

      parent.abort();
      expect(child1.signal.aborted).toBe(true);
      expect(child2.signal.aborted).toBe(true);
      expect(child3.signal.aborted).toBe(true);
    });

    it('supports grandchild hierarchy', () => {
      const root = createAbortController();
      const child = createChildAbortController(root);
      const grandchild = createChildAbortController(child);

      root.abort();
      expect(child.signal.aborted).toBe(true);
      expect(grandchild.signal.aborted).toBe(true);
    });

    it('does not affect siblings when one child aborts', () => {
      const parent = createAbortController();
      const child1 = createChildAbortController(parent);
      const child2 = createChildAbortController(parent);

      child1.abort();
      expect(child1.signal.aborted).toBe(true);
      expect(child2.signal.aborted).toBe(false);
      expect(parent.signal.aborted).toBe(false);
    });

    it('handles already-aborted parent', () => {
      const parent = createAbortController();
      parent.abort('already');
      const child = createChildAbortController(parent);
      expect(child.signal.aborted).toBe(true);
      expect(child.signal.reason).toBe('already');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/util/__tests__/abort-controller-tree.spec.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Write the implementation**

Create `src/main/util/abort-controller-tree.ts`:

```typescript
/**
 * Hierarchical AbortController tree with GC-safe parent-child propagation.
 *
 * Pattern from Claude Code utils/abortController.ts:
 * - Parent abort cascades to all children
 * - Child abort does NOT cascade to parent or siblings
 * - Cleanup listeners removed when child aborts independently
 * - setMaxListeners(50) prevents Node.js warnings
 */

import { setMaxListeners } from 'events';

/**
 * Create a root AbortController with raised listener limit.
 */
export function createAbortController(): AbortController {
  const ac = new AbortController();
  try {
    setMaxListeners(50, ac.signal);
  } catch {
    // Older Node.js versions may not support setMaxListeners on AbortSignal
  }
  return ac;
}

/**
 * Create a child AbortController that aborts when parent aborts.
 * Child abort is independent -- does not affect parent or siblings.
 * Listener is cleaned up when the child aborts to prevent leaks.
 */
export function createChildAbortController(parent: AbortController): AbortController {
  const child = createAbortController();

  // If parent is already aborted, abort child immediately
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason);
    return child;
  }

  // Propagate parent abort to child
  const onParentAbort = () => {
    child.abort(parent.signal.reason);
  };

  parent.signal.addEventListener('abort', onParentAbort, { once: true });

  // When child aborts independently, remove the parent listener
  child.signal.addEventListener('abort', () => {
    parent.signal.removeEventListener('abort', onParentAbort);
  }, { once: true });

  return child;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/util/__tests__/abort-controller-tree.spec.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/main/util/abort-controller-tree.ts src/main/util/__tests__/abort-controller-tree.spec.ts
git commit -m "feat: add hierarchical AbortController tree with GC-safe propagation"
```

---

## Task 3: Cleanup Registry (P1)

**Files:**
- Create: `src/main/util/cleanup-registry.ts`
- Create: `src/main/util/__tests__/cleanup-registry.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/util/__tests__/cleanup-registry.spec.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  registerCleanup,
  runCleanupFunctions,
  getCleanupCount,
  _resetForTesting,
} from '../cleanup-registry';

describe('CleanupRegistry', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('registers and runs cleanup functions', async () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    registerCleanup(fn1);
    registerCleanup(fn2);

    expect(getCleanupCount()).toBe(2);
    await runCleanupFunctions();
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('returns unregister function', async () => {
    const fn = vi.fn();
    const unregister = registerCleanup(fn);

    unregister();
    expect(getCleanupCount()).toBe(0);
    await runCleanupFunctions();
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs cleanups concurrently with timeout', async () => {
    const slow = vi.fn(async () => new Promise(resolve => setTimeout(resolve, 50)));
    const fast = vi.fn(async () => 'done');
    registerCleanup(slow);
    registerCleanup(fast);

    await runCleanupFunctions(200);
    expect(slow).toHaveBeenCalledOnce();
    expect(fast).toHaveBeenCalledOnce();
  });

  it('does not throw if a cleanup function throws', async () => {
    const bad = vi.fn(() => { throw new Error('cleanup boom'); });
    const good = vi.fn();
    registerCleanup(bad);
    registerCleanup(good);

    await runCleanupFunctions();
    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
  });

  it('clears registry after running', async () => {
    registerCleanup(vi.fn());
    expect(getCleanupCount()).toBe(1);
    await runCleanupFunctions();
    expect(getCleanupCount()).toBe(0);
  });

  it('handles double unregister gracefully', () => {
    const unregister = registerCleanup(vi.fn());
    unregister();
    unregister();
    expect(getCleanupCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/util/__tests__/cleanup-registry.spec.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Write the implementation**

Create `src/main/util/cleanup-registry.ts`:

```typescript
/**
 * Cleanup Registry -- services register their own cleanup at construction time.
 *
 * Pattern from Claude Code utils/cleanupRegistry.ts:
 * - registerCleanup(fn) returns an unregister function
 * - runCleanupFunctions() runs all concurrently with a timeout
 * - Replaces fragile manual teardown lists in terminateInstance() and shutdown()
 */

type CleanupFn = () => void | Promise<void>;

const cleanups = new Set<CleanupFn>();

/**
 * Register a cleanup function to run on shutdown.
 * Returns an unregister function -- call it on normal completion.
 */
export function registerCleanup(fn: CleanupFn): () => void {
  cleanups.add(fn);
  let removed = false;
  return () => {
    if (!removed) {
      cleanups.delete(fn);
      removed = true;
    }
  };
}

/**
 * Run all registered cleanup functions concurrently.
 * Each cleanup is wrapped in try/catch -- one failure does not block others.
 * Clears the registry after running.
 *
 * @param timeoutMs Maximum time to wait for all cleanups (default: 2000ms)
 */
export async function runCleanupFunctions(timeoutMs = 2000): Promise<void> {
  const fns = [...cleanups];
  cleanups.clear();

  if (fns.length === 0) return;

  const results = fns.map(async (fn) => {
    try {
      await fn();
    } catch {
      // Swallow -- cleanup failures must not block shutdown
    }
  });

  await Promise.race([
    Promise.allSettled(results),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/** Number of registered cleanup functions. */
export function getCleanupCount(): number {
  return cleanups.size;
}

/** Reset for testing -- clears all registered cleanups. */
export function _resetForTesting(): void {
  cleanups.clear();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/util/__tests__/cleanup-registry.spec.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`

```bash
git add src/main/util/cleanup-registry.ts src/main/util/__tests__/cleanup-registry.spec.ts
git commit -m "feat: add cleanup registry for graceful shutdown"
```

---

## Task 4: Sleep/Wake Detection in StuckProcessDetector (P1)

**Files:**
- Modify: `src/main/instance/stuck-process-detector.ts` (add constant + check() logic)
- Modify: `src/main/instance/stuck-process-detector.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/main/instance/stuck-process-detector.spec.ts`:

```typescript
describe('sleep/wake detection', () => {
  it('resets all tracker timers after detecting system sleep', () => {
    const detector = new StuckProcessDetector({ checkIntervalMs: 100 });
    const stuckHandler = vi.fn();
    detector.on('process:stuck', stuckHandler);

    detector.startTracking('inst-1', 'busy');
    const tracker = (detector as any).trackers.get('inst-1')!;
    tracker.lastOutputAt = Date.now() - 120_000;

    // Simulate system sleep: last check was 120s ago
    (detector as any).lastCheckTime = Date.now() - 120_000;

    (detector as any).check();

    expect(stuckHandler).not.toHaveBeenCalled();
    // Tracker timers should be reset to ~now
    expect(Date.now() - tracker.lastOutputAt).toBeLessThan(1000);
  });

  it('emits process:stuck normally when gap is within normal range', () => {
    const detector = new StuckProcessDetector({ checkIntervalMs: 100 });
    const stuckHandler = vi.fn();
    detector.on('process:stuck', stuckHandler);

    detector.startTracking('inst-1', 'busy');
    const tracker = (detector as any).trackers.get('inst-1')!;
    tracker.lastOutputAt = Date.now() - 120_000;

    // Normal check gap
    (detector as any).lastCheckTime = Date.now() - 100;

    (detector as any).check();
    expect(stuckHandler).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/instance/stuck-process-detector.spec.ts`
Expected: FAIL -- `lastCheckTime` property does not exist

- [ ] **Step 3: Implement sleep/wake detection**

In `src/main/instance/stuck-process-detector.ts`:

Add constant near existing constants at the top:

```typescript
/** If wall-clock gap between checks exceeds this, assume system slept */
const SLEEP_DETECTION_THRESHOLD_MS = 60_000;
```

Add property to the class (near `private trackers`):

```typescript
private lastCheckTime = Date.now();
```

At the top of the `check()` method, before the existing `for` loop over trackers, add:

```typescript
const now = Date.now();
const checkGap = now - this.lastCheckTime;
this.lastCheckTime = now;

if (checkGap > SLEEP_DETECTION_THRESHOLD_MS) {
  logger.info('System sleep detected -- resetting stuck-process timers', {
    gapMs: checkGap,
    trackerCount: this.trackers.size,
  });
  for (const tracker of this.trackers.values()) {
    tracker.lastOutputAt = now;
    tracker.softWarningEmitted = false;
    tracker.aliveDeferrals = 0;
  }
  return;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/instance/stuck-process-detector.spec.ts`
Expected: PASS (all tests including new ones)

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`

```bash
git add src/main/instance/stuck-process-detector.ts src/main/instance/stuck-process-detector.spec.ts
git commit -m "fix: add sleep/wake detection to prevent false stuck-process kills"
```

---

## Task 5: Task Notification Deduplication + Failed Dependency Propagation (P1)

**Files:**
- Modify: `src/main/tasks/background-task-manager.ts`
- Create: `src/main/tasks/__tests__/background-task-manager.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/tasks/__tests__/background-task-manager.spec.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BackgroundTaskManager } from '../background-task-manager';

describe('BackgroundTaskManager', () => {
  let manager: BackgroundTaskManager;

  beforeEach(() => {
    BackgroundTaskManager._resetForTesting();
    manager = BackgroundTaskManager.getInstance();
    manager.registerExecutor('test', async () => 'ok');
  });

  describe('notification deduplication', () => {
    it('emits task-completed only once even if timeout races with completion', async () => {
      const completedHandler = vi.fn();
      const cancelledHandler = vi.fn();
      manager.on('task-completed', completedHandler);
      manager.on('task-cancelled', cancelledHandler);

      manager.registerExecutor('fast', async () => 'done');

      manager.submit({
        type: 'fast',
        description: 'dedup test',
        timeout: 50,
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      const totalEvents = completedHandler.mock.calls.length + cancelledHandler.mock.calls.length;
      expect(totalEvents).toBe(1);
    });
  });

  describe('failed dependency propagation', () => {
    it('fails a task when its dependency has failed', async () => {
      const failedHandler = vi.fn();
      manager.on('task-failed', failedHandler);

      manager.registerExecutor('failing', async () => { throw new Error('boom'); });

      const depId = manager.submit({
        type: 'failing',
        description: 'dependency task',
        maxRetries: 0,
      });

      manager.submit({
        type: 'test',
        description: 'dependent task',
        dependsOn: [depId],
      });

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(failedHandler.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('fails a task when its dependency was cancelled', async () => {
      const failedHandler = vi.fn();
      manager.on('task-failed', failedHandler);

      manager.registerExecutor('slow', async (_task, ctx) => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (ctx.isCancelled()) throw new Error('cancelled');
        return 'done';
      });

      const depId = manager.submit({
        type: 'slow',
        description: 'cancellable dep',
      });

      const dependentId = manager.submit({
        type: 'test',
        description: 'dependent task',
        dependsOn: [depId],
      });

      await new Promise(resolve => setTimeout(resolve, 50));
      manager.cancel(depId);

      await new Promise(resolve => setTimeout(resolve, 300));

      const failedIds = failedHandler.mock.calls.map((c: any[]) => c[0].id);
      expect(failedIds).toContain(dependentId);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/tasks/__tests__/background-task-manager.spec.ts`
Expected: FAIL -- dependent tasks never fail when dependencies fail

- [ ] **Step 3: Add notified flag to Task interface**

In `src/main/tasks/background-task-manager.ts`, add to the Task interface (near `completedAt`):

```typescript
/** @internal Prevents duplicate completion events */
notified?: boolean;
```

- [ ] **Step 4: Guard event emission with notified flag**

In `executeTask()`, wrap both completion event emissions with the guard. In the try block (around line 444-455):

```typescript
      if (this.cancelledTasks.has(task.id)) {
        task.status = 'cancelled';
        task.completedAt = Date.now();
        if (!task.notified) {
          task.notified = true;
          this.emit('task-cancelled', task);
        }
      } else {
        task.status = 'completed';
        task.result = result;
        task.progress = 100;
        task.completedAt = Date.now();
        if (!task.notified) {
          task.notified = true;
          this.emit('task-completed', task);
        }
      }
```

In the catch block (around line 468-471), guard the failure emission:

```typescript
        task.status = 'failed';
        task.completedAt = Date.now();
        if (!task.notified) {
          task.notified = true;
          this.emit('task-failed', task);
        }
```

- [ ] **Step 5: Replace areDependenciesMet with checkDependencies**

Replace the `areDependenciesMet` method (lines 386-393) with:

```typescript
  private checkDependencies(task: Task): 'ready' | 'blocked' | 'failed' {
    if (!task.dependsOn || task.dependsOn.length === 0) return 'ready';

    for (const depId of task.dependsOn) {
      const depTask = this.tasks.get(depId) || this.taskHistory.find(t => t.id === depId);
      if (!depTask) return 'blocked';
      if (depTask.status === 'failed' || depTask.status === 'cancelled') return 'failed';
      if (depTask.status !== 'completed') return 'blocked';
    }
    return 'ready';
  }
```

Update `getNextTask()` to use `checkDependencies()` -- replace the `.filter(t => this.areDependenciesMet(t))` with:

```typescript
      .filter(t => {
        const depStatus = this.checkDependencies(t);
        if (depStatus === 'failed') {
          t.status = 'failed';
          t.error = 'Dependency failed or was cancelled';
          t.completedAt = Date.now();
          if (!t.notified) {
            t.notified = true;
            this.emit('task-failed', t);
          }
          this.moveToHistory(t);
          return false;
        }
        return depStatus === 'ready';
      })
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/main/tasks/__tests__/background-task-manager.spec.ts`
Expected: PASS

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`

```bash
git add src/main/tasks/background-task-manager.ts src/main/tasks/__tests__/background-task-manager.spec.ts
git commit -m "fix: add task notification dedup and failed dependency propagation"
```

---

## Task 6: Prefix-Based Secret Scanning (P1)

**Files:**
- Modify: `src/main/security/secret-detector.ts`
- Create: `src/main/security/__tests__/secret-detector.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/security/__tests__/secret-detector.spec.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { detectSecrets, redactSecrets } from '../secret-detector';

describe('SecretDetector', () => {
  describe('prefix-based value scanning', () => {
    it('detects GitHub PAT (ghp_)', () => {
      const results = detectSecrets('token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(results.some(s => s.type === 'token' && s.name === 'github_pat')).toBe(true);
    });

    it('detects GitHub fine-grained token (github_pat_)', () => {
      const results = detectSecrets('GITHUB_TOKEN=github_pat_11ABCDEF0123456789abcdef');
      expect(results.some(s => s.type === 'token')).toBe(true);
    });

    it('detects AWS access key (AKIA)', () => {
      const results = detectSecrets('aws_key=AKIAIOSFODNN7EXAMPLE');
      expect(results.some(s => s.type === 'api_key' && s.name === 'aws_access_key')).toBe(true);
    });

    it('detects Anthropic API key (sk-ant-api03-)', () => {
      const results = detectSecrets('key: sk-ant-api03-xxxxxxxxxxxxxxxxxxxx');
      expect(results.some(s => s.type === 'api_key' && s.name === 'anthropic_api_key')).toBe(true);
    });

    it('detects Slack bot token (xoxb-)', () => {
      const results = detectSecrets('SLACK=xoxb-123456789-123456789-abcdef');
      expect(results.some(s => s.type === 'token' && s.name === 'slack_token')).toBe(true);
    });

    it('detects Stripe secret key (sk_test_)', () => {
      const results = detectSecrets('STRIPE_KEY=sk_test_EXAMPLE_REDACTED_KEY');
      expect(results.some(s => s.type === 'api_key' && s.name === 'stripe_key')).toBe(true);
    });

    it('detects Google API key (AIza)', () => {
      const results = detectSecrets('gcp_key=AIzaSyA1234567890abcdefghijklmnop');
      expect(results.some(s => s.type === 'api_key' && s.name === 'google_api_key')).toBe(true);
    });

    it('does not false-positive on normal text', () => {
      const results = detectSecrets('The skiing trip was amazing');
      expect(results.length).toBe(0);
    });
  });

  describe('redactSecrets', () => {
    it('replaces detected secrets with redaction markers', () => {
      const input = 'key=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const result = redactSecrets(input);
      expect(result).not.toContain('ghp_');
      expect(result).toContain('[REDACTED');
    });

    it('does not store raw secret value in DetectedSecret', () => {
      const results = detectSecrets('token: ghp_abcdefghijklmnopqrstuvwxyz123456');
      for (const secret of results) {
        expect(secret.redactedValue).toBeDefined();
        expect(secret.redactedValue).toMatch(/^\*+$/);
      }
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/security/__tests__/secret-detector.spec.ts`
Expected: FAIL

- [ ] **Step 3: Add prefix-based patterns and refactor DetectedSecret**

In `src/main/security/secret-detector.ts`:

1. Change `DetectedSecret.value` to `redactedValue`:
```typescript
export interface DetectedSecret {
  type: SecretType;
  name: string;
  /** Redacted representation -- never stores the raw secret value */
  redactedValue: string;
  line?: number;
  startIndex: number;
  endIndex: number;
  confidence: 'high' | 'medium' | 'low';
}
```

2. Add `VALUE_PREFIX_PATTERNS` array after `SECRET_PATTERNS`:
```typescript
const VALUE_PREFIX_PATTERNS: Array<{
  type: SecretType;
  name: string;
  pattern: RegExp;
  confidence: 'high' | 'medium';
}> = [
  { type: 'token', name: 'github_pat', pattern: /ghp_[A-Za-z0-9_]{36,}/, confidence: 'high' },
  { type: 'token', name: 'github_fine_grained', pattern: /github_pat_[A-Za-z0-9_]{22,}/, confidence: 'high' },
  { type: 'token', name: 'github_oauth', pattern: /gho_[A-Za-z0-9_]{36,}/, confidence: 'high' },
  { type: 'api_key', name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/, confidence: 'high' },
  { type: 'api_key', name: 'anthropic_api_key', pattern: /sk-ant-api03-[A-Za-z0-9\-_]{20,}/, confidence: 'high' },
  { type: 'token', name: 'slack_token', pattern: /xox[bprs]-[0-9a-zA-Z\-]{10,}/, confidence: 'high' },
  { type: 'api_key', name: 'stripe_key', pattern: /sk_(test|live)_[A-Za-z0-9]{20,}/, confidence: 'high' },
  { type: 'api_key', name: 'stripe_restricted', pattern: /rk_(test|live)_[A-Za-z0-9]{20,}/, confidence: 'high' },
  { type: 'api_key', name: 'google_api_key', pattern: /AIza[A-Za-z0-9\-_]{35}/, confidence: 'high' },
  { type: 'token', name: 'npm_token', pattern: /npm_[A-Za-z0-9]{36,}/, confidence: 'high' },
  { type: 'token', name: 'pypi_token', pattern: /pypi-[A-Za-z0-9\-_]{50,}/, confidence: 'high' },
  { type: 'private_key', name: 'pem_private_key', pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, confidence: 'high' },
  { type: 'token', name: 'gitlab_token', pattern: /glpat-[A-Za-z0-9\-_]{20,}/, confidence: 'high' },
  { type: 'api_key', name: 'sendgrid_key', pattern: /SG\.[A-Za-z0-9\-_]{22,}\.[A-Za-z0-9\-_]{22,}/, confidence: 'high' },
];
```

3. In `detectSecrets()`, add prefix scanning after existing name-based loop:
```typescript
  // Phase 2: Prefix-based value scanning
  for (const vp of VALUE_PREFIX_PATTERNS) {
    const re = new RegExp(vp.pattern.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      results.push({
        type: vp.type,
        name: vp.name,
        redactedValue: '*'.repeat(match[0].length),
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        confidence: vp.confidence,
      });
    }
  }
```

4. Update all existing `value:` assignments to `redactedValue: '*'.repeat(...)`.

5. Add `redactSecrets()` export:
```typescript
export function redactSecrets(content: string): string {
  const secrets = detectSecrets(content);
  if (secrets.length === 0) return content;

  const sorted = [...secrets].sort((a, b) => b.startIndex - a.startIndex);
  let result = content;
  for (const secret of sorted) {
    result = result.slice(0, secret.startIndex)
      + `[REDACTED:${secret.name}]`
      + result.slice(secret.endIndex);
  }
  return result;
}
```

- [ ] **Step 4: Fix callers referencing DetectedSecret.value**

Run: `npx tsc --noEmit` -- update any caller using `.value` to use `.redactedValue`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/security/__tests__/secret-detector.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/security/secret-detector.ts src/main/security/__tests__/secret-detector.spec.ts
git commit -m "feat: add prefix-based secret scanning, stop storing raw secret values"
```

---

## Task 7: Plugin/Skill Path Traversal Protection (P1)

**Files:**
- Modify: `src/main/plugins/plugin-manager.ts` (walkJsFiles method, lines 98-121)
- Modify: `src/main/skills/skill-loader.ts` (discoverSkills and loadSkillBundle methods)

- [ ] **Step 1: Add isPathSafe helper to plugin-manager.ts**

After imports in `src/main/plugins/plugin-manager.ts`, add:

```typescript
/**
 * Reject paths containing '..' segments to prevent directory escape.
 */
function isPathSafe(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);
  return resolved.startsWith(resolvedBase + path.sep) || resolved === resolvedBase;
}
```

- [ ] **Step 2: Add guards in walkJsFiles**

In `walkJsFiles()`, after `const full = path.join(current, entry.name)` (line 111), add:

```typescript
        if (!isPathSafe(full, dir)) {
          logger.warn('Blocked path traversal attempt in plugin directory', { path: full, baseDir: dir });
          continue;
        }
```

Update the file check to also reject symlinks:

```typescript
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) {
          if (entry.isSymbolicLink()) {
            logger.warn('Skipping symlinked plugin file', { path: full });
            continue;
          }
          out.push(full);
        }
```

- [ ] **Step 3: Add the same guard to skill-loader.ts**

In `src/main/skills/skill-loader.ts`, in `discoverSkills()` where skill paths are constructed from directory entries, add after building the path:

```typescript
    const resolvedPath = path.resolve(skillPath);
    if (!resolvedPath.startsWith(path.resolve(searchPath) + path.sep)) {
      logger.warn('Blocked path traversal in skill directory', { skillPath, searchPath });
      continue;
    }
```

In `loadSkillBundle()` where files are read, add before each `fs.readFileSync`:

```typescript
    const resolvedFile = path.resolve(filePath);
    if (!resolvedFile.startsWith(path.resolve(skillDir) + path.sep)) {
      throw new Error(`Path traversal blocked: ${filePath}`);
    }
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add src/main/plugins/plugin-manager.ts src/main/skills/skill-loader.ts
git commit -m "fix: add path traversal protection to plugin and skill loaders"
```

---

## Task 8: NDJSON U+2028/U+2029 Safety (P2)

**Files:**
- Modify: `src/main/cli/adapters/base-cli-adapter.ts`

- [ ] **Step 1: Add safe stringify helper**

After imports in `src/main/cli/adapters/base-cli-adapter.ts`, add:

```typescript
/**
 * JSON.stringify that escapes U+2028 and U+2029.
 * These are valid JSON but act as line terminators in JavaScript,
 * silently splitting NDJSON messages when present in string values.
 */
function ndjsonSafeStringify(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
```

- [ ] **Step 2: Replace JSON.stringify on stdin write paths**

Search for `JSON.stringify` calls that write to stdin in `base-cli-adapter.ts` and `claude-cli-adapter.ts`. Replace with `ndjsonSafeStringify`. Typical pattern:

```typescript
// Before
this.process.stdin.write(JSON.stringify(message) + '\n');
// After
this.process.stdin.write(ndjsonSafeStringify(message) + '\n');
```

- [ ] **Step 3: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/main/cli/adapters/base-cli-adapter.ts src/main/cli/adapters/claude-cli-adapter.ts
git commit -m "fix: escape U+2028/U+2029 in NDJSON writes to prevent silent message splitting"
```

---

## Task 9: Orphan Process Detection (P2)

**Files:**
- Modify: `src/main/cli/adapters/base-cli-adapter.ts` (spawnProcess method + static tracking)
- Modify: `src/main/index.ts` (shutdown)

- [ ] **Step 1: Add static process tracking to BaseCliAdapter**

In `src/main/cli/adapters/base-cli-adapter.ts`, add static members to the class:

```typescript
private static activeProcesses = new Set<ChildProcess>();

/**
 * Kill all active child processes. Called during app shutdown
 * to prevent orphans when Electron exits.
 */
static killAllActiveProcesses(): void {
  for (const proc of BaseCliAdapter.activeProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // Process may have already exited
    }
  }
  BaseCliAdapter.activeProcesses.clear();
}
```

- [ ] **Step 2: Wire tracking into spawnProcess**

In `spawnProcess()`, after spawning the child process, add:

```typescript
BaseCliAdapter.activeProcesses.add(child);
child.on('exit', () => {
  BaseCliAdapter.activeProcesses.delete(child);
});
```

- [ ] **Step 3: Wire into shutdown in index.ts**

In the cleanup/shutdown section of `src/main/index.ts`, add before existing cleanup calls:

```typescript
import { BaseCliAdapter } from './cli/adapters/base-cli-adapter';

// In the cleanup function:
BaseCliAdapter.killAllActiveProcesses();
```

- [ ] **Step 4: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/main/cli/adapters/base-cli-adapter.ts src/main/index.ts
git commit -m "fix: track and kill orphan CLI processes on shutdown"
```

---

## Task 10: Session Migration Runner (P2)

**Files:**
- Modify: `src/main/session/session-continuity.ts`

- [ ] **Step 1: Add migration framework**

In `src/main/session/session-continuity.ts`, after `SCHEMA_VERSION = 1` (line 26), add:

```typescript
const CURRENT_SCHEMA_VERSION = 2;

interface SessionMigration {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate: (state: Record<string, unknown>) => Record<string, unknown>;
}

const SESSION_MIGRATIONS: SessionMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Add schemaVersion field to session state',
    migrate: (state) => ({ ...state, schemaVersion: 2 }),
  },
];

function migrateSessionState(state: Record<string, unknown>): Record<string, unknown> {
  let version = (state.schemaVersion as number) || 1;
  let current = { ...state };

  for (const migration of SESSION_MIGRATIONS) {
    if (version === migration.fromVersion) {
      logger.info('Running session migration', {
        from: migration.fromVersion,
        to: migration.toVersion,
        description: migration.description,
      });
      current = migration.migrate(current);
      version = migration.toVersion;
    }
  }

  if (version !== CURRENT_SCHEMA_VERSION) {
    logger.warn('Session state version mismatch after migration', {
      expected: CURRENT_SCHEMA_VERSION,
      actual: version,
    });
  }

  return current;
}
```

- [ ] **Step 2: Wire into snapshot loading**

In the method that loads/parses snapshots from disk, after `JSON.parse(data)`, add:

```typescript
const rawState = JSON.parse(data);
const migratedState = migrateSessionState(rawState);
```

Use `migratedState` instead of `rawState` from that point forward.

- [ ] **Step 3: Update snapshot creation to write CURRENT_SCHEMA_VERSION**

Replace references to `SCHEMA_VERSION` in snapshot creation with `CURRENT_SCHEMA_VERSION`.

- [ ] **Step 4: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/main/session/session-continuity.ts
git commit -m "feat: add session migration runner for forward-compatible state evolution"
```

---

## Task 11: Write Backpressure on Child Stdin (P2)

**Files:**
- Modify: `src/main/cli/adapters/base-cli-adapter.ts`

- [ ] **Step 1: Add safe write helper**

In `base-cli-adapter.ts`, add a protected method:

```typescript
/**
 * Write to child stdin with backpressure handling.
 * Waits for drain if the kernel buffer is full.
 */
protected async safeStdinWrite(data: string): Promise<void> {
  if (!this.process?.stdin?.writable) return;

  const canContinue = this.process.stdin.write(data);
  if (!canContinue) {
    await new Promise<void>((resolve) => {
      this.process!.stdin!.once('drain', resolve);
    });
  }
}
```

- [ ] **Step 2: Replace direct stdin.write calls**

Search for `this.process.stdin.write(` in `base-cli-adapter.ts` and `claude-cli-adapter.ts`. Replace synchronous writes with `await this.safeStdinWrite(data)` where the containing method is already async (or can be made async).

- [ ] **Step 3: Typecheck and commit**

Run: `npx tsc --noEmit`

```bash
git add src/main/cli/adapters/base-cli-adapter.ts src/main/cli/adapters/claude-cli-adapter.ts
git commit -m "fix: add write backpressure handling for child stdin"
```

---

## Task 12: Full Verification

- [ ] **Step 1: TypeScript compilation**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: Clean

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: All files pass linting

- [ ] **Step 3: Tests**

Run: `npm test`
Expected: All tests pass (existing + new)

- [ ] **Step 4: Fix any issues discovered**

If any compilation, lint, or test errors: fix, re-run, repeat.

---

## Execution Order & Dependencies

```
Phase 1 (P0) -- parallel, no overlap:
+-- Task 1: Unicode sanitizer (new file)
+-- Task 2: AbortController tree (new file)

Phase 2 (P1) -- parallel, no overlap:
+-- Task 3: Cleanup registry (new file)
+-- Task 4: Sleep/wake detection (stuck-process-detector)
+-- Task 5: Task notification dedup (background-task-manager)
+-- Task 6: Prefix secret scanning (secret-detector)
+-- Task 7: Plugin/skill path traversal (plugin-manager + skill-loader)

Phase 3 (P2) -- sequential on base-cli-adapter.ts:
+-- Task 8: NDJSON safety
+-- Task 9: Orphan process detection (+ index.ts)
+-- Task 10: Session migration runner (independent)
+-- Task 11: Write backpressure (after Task 8)

Phase 4: Task 12 -- full verification
```

## Parallelization

- **Tasks 1-2**: Fully parallel (different directories)
- **Tasks 3-7**: Fully parallel (all different files)
- **Tasks 8, 9, 11**: Share `base-cli-adapter.ts` -- run sequentially or batch carefully
- **Task 10**: Independent
