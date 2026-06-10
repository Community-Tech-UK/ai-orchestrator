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

  it('uses utilityProcess when provided and sanitizes Electron run-as-node env', async () => {
    const previousRunAsNode = process.env['ELECTRON_RUN_AS_NODE'];
    process.env['ELECTRON_RUN_AS_NODE'] = '1';

    const child = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
    });
    const childProcessFork = vi.fn();
    const utilityProcessFork = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({
      default: { fork: childProcessFork },
      fork: childProcessFork,
    }));

    try {
      const { createIsolatedWorkerProcess } = await import('./isolated-worker-process');
      const handle = createIsolatedWorkerProcess<{ type: 'ping' }, { type: 'pong' }>({
        name: 'utility-worker',
        entrypoint: '/tmp/utility-worker.ts',
        args: ['--tenant', 'test'],
        env: { AIO_USER_DATA_PATH: '/tmp/aio' },
        execArgv: ['--max-old-space-size=512'],
      }, { utilityProcessFork });

      handle.postMessage({ type: 'ping' });

      expect(child.postMessage).toHaveBeenCalledWith({ type: 'ping' });
      expect(childProcessFork).not.toHaveBeenCalled();
      expect(utilityProcessFork).toHaveBeenCalledWith('/tmp/utility-worker.ts', ['--tenant', 'test'], {
        serviceName: 'utility-worker',
        env: expect.objectContaining({
          AIO_USER_DATA_PATH: '/tmp/aio',
        }),
        execArgv: ['--import', 'tsx', '--max-old-space-size=512'],
        stdio: 'inherit',
      });
      const utilityOptions = utilityProcessFork.mock.calls[0]?.[2] as {
        env?: Record<string, string | undefined>;
      };
      expect(utilityOptions.env?.['ELECTRON_RUN_AS_NODE']).toBeUndefined();

      const received: unknown[] = [];
      handle.on('message', (message) => received.push(message));
      child.emit('message', { type: 'pong' });
      expect(received).toEqual([{ type: 'pong' }]);
    } finally {
      if (previousRunAsNode === undefined) {
        delete process.env['ELECTRON_RUN_AS_NODE'];
      } else {
        process.env['ELECTRON_RUN_AS_NODE'] = previousRunAsNode;
      }
    }
  });

  it('waits for utilityProcess exit during termination', async () => {
    const child = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
    });
    const childProcessFork = vi.fn();
    const utilityProcessFork = vi.fn(() => child);
    vi.doMock('node:child_process', () => ({
      default: { fork: childProcessFork },
      fork: childProcessFork,
    }));

    const { createIsolatedWorkerProcess } = await import('./isolated-worker-process');
    const handle = createIsolatedWorkerProcess({
      name: 'utility-worker',
      entrypoint: '/tmp/utility-worker.js',
    }, { utilityProcessFork });

    const termination = handle.terminate();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('exit', 5);

    await expect(termination).resolves.toBe(5);
  });
});
