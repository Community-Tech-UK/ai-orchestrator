import { describe, expect, it, vi } from 'vitest';
import { stopProviderAutoContinuation } from './provider-auto-continuation';

describe('stopProviderAutoContinuation', () => {
  it('asks the adapter to stop resuming work for every stop, but not for a steer', () => {
    const adapter = { stopProviderAutoContinuation: vi.fn(async () => true) };

    for (const origin of ['renderer-ipc', 'mobile-gateway', 'pause', 'tool-loop-auto', 'usage-overage', 'unknown'] as const) {
      stopProviderAutoContinuation(adapter, origin);
    }
    stopProviderAutoContinuation(adapter, 'steer');

    expect(adapter.stopProviderAutoContinuation).toHaveBeenCalledTimes(6);
  });

  it('ignores adapters without the hook and contains a failing hook', async () => {
    expect(() => stopProviderAutoContinuation(undefined, 'renderer-ipc')).not.toThrow();
    expect(() => stopProviderAutoContinuation({}, 'renderer-ipc')).not.toThrow();
    const failing = { stopProviderAutoContinuation: vi.fn(async () => { throw new Error('rpc down'); }) };
    stopProviderAutoContinuation(failing, 'renderer-ipc');
    await Promise.resolve();
    expect(failing.stopProviderAutoContinuation).toHaveBeenCalledOnce();
  });
});
