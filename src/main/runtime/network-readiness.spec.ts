import { describe, expect, it, vi } from 'vitest';
import { isNetworkReachable, waitForNetworkReady } from './network-readiness';

const offline = () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED'));

describe('isNetworkReachable', () => {
  it('fails open when no resolver is available (outside Electron)', async () => {
    await expect(isNetworkReachable({ resolver: null })).resolves.toBe(true);
  });

  it('is true when any probe host resolves', async () => {
    const resolver = vi.fn((host: string) => (host === 'b.test' ? Promise.resolve({}) : offline()));
    await expect(isNetworkReachable({ resolver, hosts: ['a.test', 'b.test', 'c.test'] })).resolves.toBe(true);
    expect(resolver.mock.calls.map(([host]) => host)).toEqual(['a.test', 'b.test', 'c.test']);
  });

  it('is false when every probe host fails to resolve', async () => {
    await expect(isNetworkReachable({ resolver: offline, hosts: ['a.test', 'b.test'] })).resolves.toBe(false);
  });

  it('treats a resolver that throws synchronously as a failed host', async () => {
    const resolver = (host: string) => {
      if (host === 'a.test') throw new Error('boom');
      return Promise.resolve({});
    };
    await expect(isNetworkReachable({ resolver, hosts: ['a.test', 'b.test'] })).resolves.toBe(true);
  });

  it('bounds a probe of hung lookups by one shared timeout, not one per host', async () => {
    vi.useFakeTimers();
    try {
      const hung = () => new Promise(() => undefined);
      const settled = vi.fn();
      void isNetworkReachable({ resolver: hung, hosts: ['a.test', 'b.test', 'c.test'], probeTimeoutMs: 1_000 })
        .then(settled);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('waitForNetworkReady', () => {
  function clock() {
    let now = 0;
    return {
      now: () => now,
      sleep: vi.fn(async (ms: number) => { now += ms; }),
    };
  }

  it('returns at once when the network is already up', async () => {
    const { now, sleep } = clock();
    await expect(waitForNetworkReady({ resolver: () => Promise.resolve({}), now, sleep }))
      .resolves.toEqual({ ready: true, waitedMs: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('polls until DNS comes back', async () => {
    const { now, sleep } = clock();
    let calls = 0;
    const resolver = () => (++calls >= 3 ? Promise.resolve({}) : offline());
    await expect(waitForNetworkReady({ resolver, hosts: ['a.test'], pollMs: 10_000, now, sleep }))
      .resolves.toEqual({ ready: true, waitedMs: 20_000 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the maximum wait without throwing', async () => {
    const { now, sleep } = clock();
    await expect(waitForNetworkReady({
      resolver: offline,
      hosts: ['a.test'],
      pollMs: 10_000,
      maxWaitMs: 25_000,
      now,
      sleep,
    })).resolves.toEqual({ ready: false, waitedMs: 25_000 });
    // The last sleep is trimmed so the wait never overshoots the cap.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000, 5_000]);
  });
});
