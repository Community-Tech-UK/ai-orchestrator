import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkerModeRuntimeService,
  readWorkerModePairing,
  resolveWorkerModeRuntimeCommand,
} from './worker-mode-runtime-service';

type FakeChild = EventEmitter & {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
};

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.kill = vi.fn();
  child.killed = false;
  return child;
}

describe('WorkerModeRuntimeService', () => {
  it('resolves packaged aio-worker before dev-built binaries', () => {
    const command = resolveWorkerModeRuntimeCommand({
      resourcesPath: '/Applications/Harness.app/Contents/Resources',
      cwd: '/repo',
      platform: 'darwin',
      existsSync: (candidate) =>
        candidate === '/Applications/Harness.app/Contents/Resources/worker-agent-cli/aio-worker',
    });

    expect(command).toEqual({
      command: '/Applications/Harness.app/Contents/Resources/worker-agent-cli/aio-worker',
      args: [],
    });
  });

  it('starts aio-worker under supervision without putting credentials in spawn args', () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
    child.pid = 1234;
    child.kill = vi.fn();
    child.killed = false;
    const spawn = vi.fn(() => child);
    const service = new WorkerModeRuntimeService({
      spawn,
      resolveCommand: () => ({ command: '/bin/aio-worker', args: [] }),
    });

    const result = service.start({ configPath: '/Users/james/.orchestrator/worker-node.json' });

    expect(result).toEqual({
      state: 'running',
      pid: 1234,
      command: '/bin/aio-worker',
    });
    expect(spawn).toHaveBeenCalledWith(
      '/bin/aio-worker',
      ['--config', '/Users/james/.orchestrator/worker-node.json', '--supervise'],
      expect.objectContaining({
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(JSON.stringify(spawn.mock.calls[0]?.slice(0, 2))).not.toMatch(/token|secret|credential/i);
  });

  it('reuses the existing live runtime instead of spawning duplicates', () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
    child.pid = 4321;
    child.kill = vi.fn();
    child.killed = false;
    const spawn = vi.fn(() => child);
    const service = new WorkerModeRuntimeService({
      spawn,
      resolveCommand: () => ({ command: '/bin/aio-worker', args: [] }),
    });

    service.start({ configPath: '/config.json' });
    const second = service.start({ configPath: '/config.json' });

    expect(second.pid).toBe(4321);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('installs the service with the pairing credential in environment only', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
      killed: boolean;
    };
    child.pid = 2468;
    child.kill = vi.fn();
    child.killed = false;
    const spawn = vi.fn((_command: string, _args: string[], _options: unknown) => child);
    const service = new WorkerModeRuntimeService({
      spawn,
      resolveCommand: () => ({ command: '/bin/aio-worker', args: [] }),
    });

    const install = service.installService({
      configPath: '/Users/james/.orchestrator/worker-node.json',
      config: {
        nodeId: 'node-1',
        name: 'Noah PC',
        coordinatorUrl: 'ws://mac:4878',
        authToken: 'one-time-token',
        namespace: 'default',
        maxConcurrentInstances: 10,
        workingDirectories: [],
        reconnectIntervalMs: 5_000,
        heartbeatIntervalMs: 10_000,
      },
    });
    child.emit('exit', 0, null);
    const result = await install;

    expect(result).toEqual({
      state: 'service-installed',
      command: '/bin/aio-worker',
    });
    expect(spawn).toHaveBeenCalledWith(
      '/bin/aio-worker',
      [
        '--install-service',
        '--coordinator-url',
        'ws://mac:4878',
        '--token-env',
        'AIO_WORKER_INSTALL_TOKEN',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          AIO_WORKER_INSTALL_TOKEN: 'one-time-token',
        }),
      }),
    );
    expect(JSON.stringify(spawn.mock.calls[0][1])).not.toContain('one-time-token');
  });

  it('stops the whole worker tree and reports stopped', () => {
    const child = fakeChild(1111);
    const killTree = vi.fn();
    const service = new WorkerModeRuntimeService({
      spawn: vi.fn(() => child),
      resolveCommand: () => ({ command: '/bin/aio-worker', args: [] }),
      killTree,
    });
    service.start({ configPath: '/config.json' });

    const result = service.stop();

    expect(killTree).toHaveBeenCalledWith(child);
    expect(result).toEqual({ state: 'stopped' });
    // The exit that follows our own stop is not an error.
    child.emit('exit', null, 'SIGTERM');
    expect(service.status()).toEqual({ state: 'stopped' });
  });

  it('reports a worker that exits on its own with a failure code', () => {
    const child = fakeChild(2222);
    const service = new WorkerModeRuntimeService({
      spawn: vi.fn(() => child),
      resolveCommand: () => ({ command: '/bin/aio-worker', args: [] }),
      killTree: vi.fn(),
    });
    service.start({ configPath: '/config.json' });

    child.emit('exit', 1, null);

    expect(service.status()).toEqual({
      state: 'stopped',
      error: 'The worker stopped unexpectedly (exit code 1).',
    });
  });

  it('waits for the worker to exit before stopAndWait resolves', async () => {
    const child = fakeChild(4444);
    const killTree = vi.fn(() => {
      setTimeout(() => child.emit('exit', null, 'SIGTERM'), 10);
    });
    const service = new WorkerModeRuntimeService({
      spawn: vi.fn(() => child),
      resolveCommand: () => ({ command: '/bin/aio-worker', args: [] }),
      killTree,
    });
    service.start({ configPath: '/config.json' });
    let exited = false;
    child.once('exit', () => { exited = true; });

    const result = await service.stopAndWait(1_000);

    expect(exited).toBe(true);
    expect(result).toEqual({ state: 'stopped' });
  });

  it('gives up waiting after the timeout when the worker does not exit', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(5555);
      const service = new WorkerModeRuntimeService({
        spawn: vi.fn(() => child),
        resolveCommand: () => ({ command: '/bin/aio-worker', args: [] }),
        killTree: vi.fn(),
      });
      service.start({ configPath: '/config.json' });

      const pending = service.stopAndWait(2_000);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toEqual({ state: 'stopped' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves stopAndWait immediately when nothing is running', async () => {
    const service = new WorkerModeRuntimeService({
      spawn: vi.fn(),
      resolveCommand: () => ({ command: '/bin/aio-worker', args: [] }),
      killTree: vi.fn(),
    });

    await expect(service.stopAndWait()).resolves.toEqual({ state: 'stopped' });
  });

  it('treats a clean supervisor exit as a plain stop', () => {
    const child = fakeChild(3333);
    const service = new WorkerModeRuntimeService({
      spawn: vi.fn(() => child),
      resolveCommand: () => ({ command: '/bin/aio-worker', args: [] }),
      killTree: vi.fn(),
    });
    service.start({ configPath: '/config.json' });

    child.emit('exit', 0, null);

    expect(service.status()).toEqual({ state: 'stopped' });
  });
});

describe('readWorkerModePairing', () => {
  function reader(contents: string | null) {
    return {
      existsSync: () => contents !== null,
      readFileSync: () => contents ?? '',
    };
  }

  it('reports unpaired when the config is missing or has no coordinator', () => {
    const unpaired = { paired: false, enrolled: false, config: null };
    expect(readWorkerModePairing('/c.json', reader(null))).toEqual(unpaired);
    expect(readWorkerModePairing('/c.json', reader(JSON.stringify({
      nodeId: 'node-1',
      authToken: '',
      namespace: 'default',
    })))).toEqual(unpaired);
  });

  it('throws instead of reporting unpaired when the file is caught mid-write', () => {
    expect(() => readWorkerModePairing('/c.json', reader('{"nodeId": "node-1", "coordinatorUrl'))).toThrow();
  });

  it('does not echo config contents in the parse error', () => {
    expect(() => readWorkerModePairing('/c.json', reader('{"nodeToken": placeholdervalue}')))
      .toThrow(/^The worker config could not be read/);
    expect(() => readWorkerModePairing('/c.json', reader('{"nodeToken": placeholdervalue}')))
      .not.toThrow(/placeholde|Unexpected token/);
  });

  it('reports paired but not yet accepted while only the pairing pass is saved', () => {
    const result = readWorkerModePairing('/c.json', reader(`\uFEFF${JSON.stringify({
      nodeId: 'node-1',
      name: 'Noah PC',
      coordinatorUrl: 'ws://mac:4878',
      authToken: 'placeholder-pairing-pass',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: ['C:/work'],
    })}`));

    expect(result).toEqual({
      paired: true,
      enrolled: false,
      config: {
        nodeId: 'node-1',
        name: 'Noah PC',
        coordinatorUrl: 'ws://mac:4878',
        namespace: 'default',
        maxConcurrentInstances: 10,
        workingDirectories: ['C:/work'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('placeholder-pairing-pass');
  });

  it('reports accepted once the coordinator has issued a node credential', () => {
    const result = readWorkerModePairing('/c.json', reader(JSON.stringify({
      nodeId: 'node-1',
      coordinatorUrls: ['ws://mac:4878'],
      authToken: 'placeholder-pairing-pass',
      nodeToken: 'placeholder-node-credential',
    })));

    expect(result.paired).toBe(true);
    expect(result.enrolled).toBe(true);
    expect(result.config?.coordinatorUrl).toBe('ws://mac:4878');
    expect(JSON.stringify(result)).not.toMatch(/placeholder-(pairing-pass|node-credential)/);
  });
});
