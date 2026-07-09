import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkerModeRuntimeService,
  resolveWorkerModeRuntimeCommand,
} from './worker-mode-runtime-service';

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
      }),
    );
    expect(JSON.stringify(spawn.mock.calls[0])).not.toMatch(/token|secret|credential/i);
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
});
