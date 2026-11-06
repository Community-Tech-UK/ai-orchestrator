import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeWorkerStderrActivity } from './worker-stderr-activity';

afterEach(() => vi.useRealTimers());

describe('worker stderr activity', () => {
  it('never forwards stderr bytes, bounds repeated activity, and removes the listener', () => {
    vi.useFakeTimers();
    const adapter = new EventEmitter();
    const emit = vi.fn();
    const cleanup = observeWorkerStderrActivity(adapter, emit);
    adapter.emit('stderr', 'PRIVATE_VALUE_PLACEHOLDER');
    expect(emit).toHaveBeenCalledExactlyOnceWith();
    for (let i = 0; i < 100; i++) adapter.emit('stderr', 'more output');
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    adapter.emit('stderr');
    expect(emit).toHaveBeenCalledTimes(2);
    cleanup();
    expect(adapter.listenerCount('stderr')).toBe(0);
    adapter.emit('stderr');
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
