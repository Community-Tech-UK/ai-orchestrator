import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('createIsolatedWorkerProcess', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  it('forks a node child process with IPC, env, and tsx support for TypeScript entrypoints', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
      connected: true,
      exitCode: null,
    });
    const fork = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({ default: { fork }, fork }));

    const { createIsolatedWorkerProcess } = await import('./isolated-worker-process');
    const handle = createIsolatedWorkerProcess<{ type: 'ping' }, { type: 'pong' }>({
      name: 'test-worker',
      entrypoint: '/tmp/test-worker.ts',
      env: { AIO_USER_DATA_PATH: '/tmp/aio' },
    });

    handle.postMessage({ type: 'ping' });
    expect(child.send).toHaveBeenCalledWith({ type: 'ping' });
    expect(fork).toHaveBeenCalledWith('/tmp/test-worker.ts', [], expect.objectContaining({
      env: expect.objectContaining({
        AIO_USER_DATA_PATH: '/tmp/aio',
        ELECTRON_RUN_AS_NODE: '1',
      }),
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }));

    const received: unknown[] = [];
    handle.on('message', (message) => received.push(message));
    child.emit('message', { type: 'pong' });
    expect(received).toEqual([{ type: 'pong' }]);
  });

  it('terminate resolves immediately for already-exited children', async () => {
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      kill: vi.fn(),
      connected: false,
      exitCode: 7,
    });
    const fork = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({ default: { fork }, fork }));

    const { createIsolatedWorkerProcess } = await import('./isolated-worker-process');
    const handle = createIsolatedWorkerProcess({ name: 'done', entrypoint: '/tmp/done.js' });

    await expect(handle.terminate()).resolves.toBe(7);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
