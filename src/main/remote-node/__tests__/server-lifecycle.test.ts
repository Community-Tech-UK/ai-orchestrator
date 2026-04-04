import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ServerLifecycle } from '../server-lifecycle';

describe('ServerLifecycle', () => {
  let lifecycle: ServerLifecycle;
  let startFn: ReturnType<typeof vi.fn>;
  let stopFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    startFn = vi.fn().mockResolvedValue(undefined);
    stopFn = vi.fn().mockResolvedValue(undefined);
    lifecycle = new ServerLifecycle(startFn, stopFn);
  });

  it('starts in stopped state', () => {
    expect(lifecycle.state).toBe('stopped');
  });

  it('transitions to running on successful start', async () => {
    await lifecycle.start();
    expect(lifecycle.state).toBe('running');
    expect(startFn).toHaveBeenCalledOnce();
  });

  it('transitions to failed when start throws', async () => {
    startFn.mockRejectedValue(new Error('EADDRINUSE'));
    await expect(lifecycle.start()).rejects.toThrow('EADDRINUSE');
    expect(lifecycle.state).toBe('failed');
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
