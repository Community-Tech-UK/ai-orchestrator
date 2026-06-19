import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAntiThrottle, type AntiThrottlePage } from './browser-anti-throttle';

interface SendCall {
  method: string;
  params?: Record<string, unknown>;
}

function makeSession() {
  const calls: SendCall[] = [];
  const detach = vi.fn(async () => undefined);
  const session = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, ...(params ? { params } : {}) });
    }),
    detach,
  };
  return { session, calls, detach };
}

describe('BrowserAntiThrottle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enables focus emulation and an active lifecycle on register', async () => {
    const { session, calls } = makeSession();
    const page: AntiThrottlePage = { createCDPSession: vi.fn(async () => session) };
    const antiThrottle = new BrowserAntiThrottle({ heartbeatMs: 1_000 });

    await antiThrottle.register('profile-1:0', page);

    expect(calls).toContainEqual({
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: true },
    });
    expect(calls.map((c) => c.method)).toContain('Page.enable');
    expect(calls).toContainEqual({
      method: 'Page.setWebLifecycleState',
      params: { state: 'active' },
    });
    await antiThrottle.stop('profile-1:0');
  });

  it('re-asserts the active lifecycle on each heartbeat', async () => {
    vi.useFakeTimers();
    const { session, calls } = makeSession();
    const page: AntiThrottlePage = { createCDPSession: vi.fn(async () => session) };
    const antiThrottle = new BrowserAntiThrottle({ heartbeatMs: 1_000 });

    await antiThrottle.register('profile-1:0', page);
    const before = calls.filter((c) => c.method === 'Page.setWebLifecycleState').length;
    await vi.advanceTimersByTimeAsync(2_000);
    const after = calls.filter((c) => c.method === 'Page.setWebLifecycleState').length;

    expect(after).toBe(before + 2);
    await antiThrottle.stopForProfile('profile-1');
  });

  it('stops the heartbeat and detaches when the session dies', async () => {
    vi.useFakeTimers();
    const { session, detach } = makeSession();
    let alive = true;
    session.send.mockImplementation(async (method: string) => {
      if (!alive && method === 'Page.setWebLifecycleState') {
        throw new Error('Session closed');
      }
    });
    const page: AntiThrottlePage = { createCDPSession: vi.fn(async () => session) };
    const antiThrottle = new BrowserAntiThrottle({ heartbeatMs: 1_000 });

    await antiThrottle.register('profile-1:0', page);
    alive = false;
    await vi.advanceTimersByTimeAsync(1_000);
    const detachCount = detach.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);

    // Once the session dies the timer is cleared, so no further heartbeats fire.
    expect(detachCount).toBe(1);
    expect(detach.mock.calls.length).toBe(1);
  });

  it('is a no-op when disabled', async () => {
    const { session, calls } = makeSession();
    const page: AntiThrottlePage = { createCDPSession: vi.fn(async () => session) };
    const antiThrottle = new BrowserAntiThrottle({ enabled: false });

    await antiThrottle.register('profile-1:0', page);

    expect(calls).toHaveLength(0);
    expect(page.createCDPSession).not.toHaveBeenCalled();
  });

  it('skips pages that cannot open a CDP session', async () => {
    const antiThrottle = new BrowserAntiThrottle();
    await expect(antiThrottle.register('profile-1:0', {})).resolves.toBeUndefined();
  });

  it('flags a target wedged after consecutive renderer-probe timeouts and recovers', async () => {
    vi.useFakeTimers();
    const onWedged = vi.fn();
    const onRecovered = vi.fn();
    let rendererResponsive = false;
    const session = {
      send: vi.fn((method: string) => {
        if (method === 'Runtime.evaluate' && !rendererResponsive) {
          // Wedged renderer: the probe never returns, so withTimeout fires.
          return new Promise<void>(() => undefined);
        }
        return Promise.resolve();
      }),
      detach: vi.fn(async () => undefined),
    };
    const page: AntiThrottlePage = { createCDPSession: vi.fn(async () => session) };
    const antiThrottle = new BrowserAntiThrottle({
      heartbeatMs: 1_000,
      probeTimeoutMs: 500,
      wedgedThreshold: 2,
      onWedged,
      onRecovered,
    });

    await antiThrottle.register('p:0', page);

    // Two heartbeats, each probe times out → wedged after the threshold.
    await vi.advanceTimersByTimeAsync(2_600);
    expect(onWedged).toHaveBeenCalledTimes(1);
    expect(onWedged).toHaveBeenCalledWith('p:0');
    expect(antiThrottle.isWedged('p:0')).toBe(true);
    expect(antiThrottle.wedgedTargets()).toEqual(['p:0']);

    // Renderer recovers: the next successful probe clears the flag exactly once.
    rendererResponsive = true;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(antiThrottle.isWedged('p:0')).toBe(false);
    expect(antiThrottle.wedgedTargets()).toEqual([]);

    await antiThrottle.stop('p:0');
  });

  it('does not probe the renderer when probing is disabled', async () => {
    vi.useFakeTimers();
    const { session, calls } = makeSession();
    const page: AntiThrottlePage = { createCDPSession: vi.fn(async () => session) };
    const antiThrottle = new BrowserAntiThrottle({
      heartbeatMs: 1_000,
      probeRenderer: false,
    });

    await antiThrottle.register('p:0', page);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(calls.some((c) => c.method === 'Runtime.evaluate')).toBe(false);
    await antiThrottle.stop('p:0');
  });

  it('only registers a target once', async () => {
    const { session } = makeSession();
    const createCDPSession = vi.fn(async () => session);
    const page: AntiThrottlePage = { createCDPSession };
    const antiThrottle = new BrowserAntiThrottle({ heartbeatMs: 1_000 });

    await antiThrottle.register('profile-1:0', page);
    await antiThrottle.register('profile-1:0', page);

    expect(createCDPSession).toHaveBeenCalledTimes(1);
    await antiThrottle.stop('profile-1:0');
  });
});
