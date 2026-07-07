import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  registerCleanup,
  runCleanupFunctions,
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

    await runCleanupFunctions();
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('returns unregister function', async () => {
    const fn = vi.fn();
    const unregister = registerCleanup(fn);

    unregister();
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
    const fn = vi.fn();
    registerCleanup(fn);
    await runCleanupFunctions();
    await runCleanupFunctions();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('handles double unregister gracefully', () => {
    const fn = vi.fn();
    const unregister = registerCleanup(fn);
    unregister();
    unregister();
    expect(fn).not.toHaveBeenCalled();
  });
});
