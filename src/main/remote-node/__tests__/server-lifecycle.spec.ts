import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Logger mock carried over from the merged server-lifecycle.test.ts; no test here reads the log.
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  ServerLifecycle,
  _resetServerLifecycleForTesting,
  configureServerLifecycle,
  getServerLifecycle,
} from '../server-lifecycle';

describe('ServerLifecycle', () => {
  beforeEach(() => {
    _resetServerLifecycleForTesting();
  });

  it('tracks running config returned by the start function', async () => {
    const startFn = vi.fn(async () => ({ port: 4878, host: '127.0.0.1', namespace: 'default' }));
    const stopFn = vi.fn(async () => undefined);
    const lifecycle = new ServerLifecycle(startFn, stopFn);

    await lifecycle.start();

    expect(lifecycle.state).toBe('running');
    expect(lifecycle.runningConfig).toEqual({
      port: 4878,
      host: '127.0.0.1',
      namespace: 'default',
    });
    expect(lifecycle.lastError).toBeNull();
  });

  it('records startup failures and clears the running config', async () => {
    const lifecycle = new ServerLifecycle(
      async () => {
        throw new Error('bind failed');
      },
      async () => undefined,
    );

    await expect(lifecycle.start()).rejects.toThrow('bind failed');

    expect(lifecycle.state).toBe('failed');
    expect(lifecycle.runningConfig).toBeNull();
    expect(lifecycle.lastError).toBe('bind failed');
  });

  it('exposes the configured singleton lifecycle', async () => {
    const startFn = vi.fn(async () => ({ port: 9999 }));
    const stopFn = vi.fn(async () => undefined);

    configureServerLifecycle(startFn, stopFn);

    const lifecycle = getServerLifecycle();
    await lifecycle.start();
    await lifecycle.stop();

    expect(startFn).toHaveBeenCalledTimes(1);
    expect(stopFn).toHaveBeenCalledTimes(1);
    expect(lifecycle.state).toBe('stopped');
  });
});

// Moved from server-lifecycle.test.ts. Its "transitions to running on successful start" and
// "transitions to failed when start throws" repeated the two state tests above and were dropped.
describe('ServerLifecycle transitions', () => {
  let lifecycle: ServerLifecycle;
  let startFn: Mock<() => Promise<void>>;
  let stopFn: Mock<() => Promise<void>>;

  beforeEach(() => {
    startFn = vi.fn().mockResolvedValue(undefined);
    stopFn = vi.fn().mockResolvedValue(undefined);
    lifecycle = new ServerLifecycle(startFn, stopFn);
  });

  it('starts in stopped state', () => {
    expect(lifecycle.state).toBe('stopped');
  });

  it('transitions to stopped on stop', async () => {
    await lifecycle.start();
    await lifecycle.stop();
    expect(lifecycle.state).toBe('stopped');
    expect(stopFn).toHaveBeenCalledOnce();
  });

  it('ignores start when already running', async () => {
    await lifecycle.start();
    await lifecycle.start();
    expect(startFn).toHaveBeenCalledOnce();
  });

  it('ignores stop when already stopped', async () => {
    await lifecycle.stop();
    expect(stopFn).not.toHaveBeenCalled();
  });

  it('can restart after failure', async () => {
    startFn.mockRejectedValueOnce(new Error('fail'));
    await expect(lifecycle.start()).rejects.toThrow();
    expect(lifecycle.state).toBe('failed');

    startFn.mockResolvedValue(undefined);
    await lifecycle.start();
    expect(lifecycle.state).toBe('running');
  });

  it('serializes concurrent start/stop', async () => {
    const order: string[] = [];
    startFn.mockImplementation(async () => {
      order.push('start-begin');
      await new Promise((r) => setTimeout(r, 10));
      order.push('start-end');
    });
    stopFn.mockImplementation(async () => {
      order.push('stop-begin');
      await new Promise((r) => setTimeout(r, 10));
      order.push('stop-end');
    });

    await lifecycle.start();
    const stopPromise = lifecycle.stop();
    const startPromise = lifecycle.start();

    await stopPromise;
    await startPromise;

    expect(order).toEqual([
      'start-begin', 'start-end',
      'stop-begin', 'stop-end',
      'start-begin', 'start-end',
    ]);
  });
});
