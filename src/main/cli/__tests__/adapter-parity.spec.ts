import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../security/env-filter', () => ({
  getSafeEnvForTrustedProcess: () => ({ ...process.env }),
}));

vi.mock('../../context/output-persistence', () => ({
  getOutputPersistenceManager: () => ({
    maybeExternalize: (_name: string, content: string) => Promise.resolve(content),
  }),
}));

import { ClaudeCliAdapter } from '../adapters/claude-cli-adapter';
import { GeminiCliAdapter } from '../adapters/gemini-cli-adapter';
import type { BaseCliAdapter, CliStatus } from '../adapters/base-cli-adapter';
import { MockCliHarness, type MockChildProcess } from './cli-mock-harness';

type TargetAdapter = BaseCliAdapter & {
  spawn(): Promise<number>;
};

interface AdapterFixture {
  name: string;
  create: () => TargetAdapter;
  spawn: (adapter: TargetAdapter, harness: MockCliHarness) => Promise<number>;
}

const AVAILABLE_GEMINI_STATUS: CliStatus = {
  available: true,
  authenticated: true,
  path: 'gemini',
  version: '1.0.0',
};

const AVAILABLE_CLAUDE_STATUS: CliStatus = {
  available: true,
  authenticated: true,
  path: 'claude',
  version: '1.0.0',
};

const FIXTURES: AdapterFixture[] = [
  {
    name: 'ClaudeCliAdapter',
    create: () => new ClaudeCliAdapter() as unknown as TargetAdapter,
    spawn: async (adapter, harness) => {
      vi.spyOn(
        adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess },
        'spawnProcess',
      ).mockImplementation(() => {
        const proc = harness.createProcess();
        adapter.emit('spawned', proc.pid!);
        return proc as unknown as ChildProcess;
      });
      return adapter.spawn();
    },
  },
  {
    name: 'GeminiCliAdapter',
    create: () => new GeminiCliAdapter() as unknown as TargetAdapter,
    spawn: async (adapter) => {
      vi.spyOn(adapter, 'checkStatus').mockResolvedValue(AVAILABLE_GEMINI_STATUS);
      return adapter.spawn();
    },
  },
];

function setRunningProcess(adapter: TargetAdapter, proc: MockChildProcess): void {
  (adapter as unknown as { process: ChildProcess }).process = proc as unknown as ChildProcess;
  if ('isSpawned' in (adapter as unknown as Record<string, unknown>)) {
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;
  }
}

describe.each(FIXTURES)('$name lifecycle parity', ({ create, spawn }) => {
  let adapter: TargetAdapter;
  let harness: MockCliHarness;

  beforeEach(() => {
    adapter = create();
    harness = new MockCliHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits spawned from the public spawn() path', async () => {
    const onSpawned = vi.fn();
    adapter.on('spawned', onSpawned);

    const pid = await spawn(adapter, harness);

    expect(pid).toBeGreaterThan(0);
    expect(onSpawned).toHaveBeenCalledTimes(1);
  });

  it('gracefully terminates an attached process', async () => {
    const proc = harness.createProcess();
    setRunningProcess(adapter, proc);

    vi.spyOn(process, 'kill').mockImplementation(
      ((pid: number) => {
        expect(Math.abs(pid)).toBe(proc.pid);
        harness.exit();
        return true;
      }) as typeof process.kill,
    );

    await expect(adapter.terminate(true)).resolves.toBeUndefined();
  });

  it('force-kills an attached process', async () => {
    const proc = harness.createProcess();
    setRunningProcess(adapter, proc);

    vi.spyOn(process, 'kill').mockImplementation(
      ((pid: number, signal?: NodeJS.Signals | number) => {
        expect(Math.abs(pid)).toBe(proc.pid);
        expect(signal).toBe('SIGKILL');
        harness.crash(137);
        return true;
      }) as typeof process.kill,
    );

    await expect(adapter.terminate(false)).resolves.toBeUndefined();
  });

  it('rejects cleanly when the child exits non-zero during sendMessage()', async () => {
    if (adapter instanceof ClaudeCliAdapter) {
      vi.spyOn(adapter, 'checkStatus').mockResolvedValue(AVAILABLE_CLAUDE_STATUS);
    }

    const spawnProcessSpy = vi.spyOn(
      adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess },
      'spawnProcess',
    ).mockImplementation(() => harness.createProcess() as unknown as ChildProcess);

    const sendPromise = adapter.sendMessage({
      role: 'user',
      content: 'hello',
    });

    await Promise.resolve();
    expect(spawnProcessSpy).toHaveBeenCalled();
    harness.crash(137);
    await expect(sendPromise).rejects.toThrow(/137/);
  });

  it('returns accepted from interrupt() when a process is running', () => {
    const proc = harness.createProcess();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(
      ((pid: number | string, signal?: NodeJS.Signals | number) => {
        expect(pid).toBe(-proc.pid);
        expect(signal).toBe('SIGINT');
        return true;
      }) as typeof process.kill,
    );
    setRunningProcess(adapter, proc);

    expect(adapter.interrupt()).toEqual({ status: 'accepted' });
    expect(killSpy).toHaveBeenCalledWith(-proc.pid, 'SIGINT');
  });

  it('returns already-idle from interrupt() when no process is running', () => {
    expect(adapter.interrupt().status).toBe('already-idle');
  });
});

describe('GeminiCliAdapter one-shot errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw an uncaught EventEmitter error when stderr reports an error without listeners', async () => {
    const adapter = new GeminiCliAdapter();
    const harness = new MockCliHarness();
    let proc: MockChildProcess | null = null;
    vi.spyOn(
      adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess },
      'spawnProcess',
    ).mockImplementation(() => {
      proc = harness.createProcess();
      return proc as unknown as ChildProcess;
    });

    const sendPromise = adapter.sendMessage({
      role: 'user',
      content: 'hello',
    });

    expect(proc).not.toBeNull();
    expect(() => {
      proc!.stderr.write('Error executing tool run_shell_command: Tool "run_shell_command" not found.');
    }).not.toThrow();
    harness.crash(1);

    await expect(sendPromise).rejects.toThrow(/1/);
  });
});
