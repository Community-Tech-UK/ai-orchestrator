import { beforeEach, describe, expect, it, vi } from 'vitest';
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
