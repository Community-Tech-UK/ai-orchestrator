import { describe, expect, it, vi } from 'vitest';
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
