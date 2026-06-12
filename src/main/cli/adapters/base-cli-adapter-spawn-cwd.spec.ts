import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

// Intercept the real spawn so no child process is ever created. The guard
// under test must throw BEFORE spawn() is reached for a missing cwd.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mocked = {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
  // CJS interop — base-cli-adapter uses named imports; vitest also needs
  // default when running modules through its own loader.
  return { ...mocked, default: mocked };
});

import { BaseCliAdapter, CliSpawnCwdError } from './base-cli-adapter';
import type {
  CliAdapterConfig,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliStatus,
} from './base-cli-adapter';
import type { ChildProcess } from 'child_process';

function makeFakeProc(): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 4242;
  return proc as unknown as ChildProcess;
}

/** Minimal concrete adapter — only spawnProcess() is exercised here. */
class TestAdapter extends BaseCliAdapter {
  constructor(config: CliAdapterConfig) {
    super(config);
  }
  getName(): string { return 'test'; }
  getCapabilities(): CliCapabilities {
    return {
      streaming: false, toolUse: false, fileAccess: false, shellExecution: false,
      multiTurn: false, vision: false, codeExecution: false, contextWindow: 0, outputFormats: [],
    };
  }
  async checkStatus(): Promise<CliStatus> { return { available: true }; }
  async sendMessage(): Promise<CliResponse> { throw new Error('not used'); }
  sendMessageStream(): AsyncIterable<string> { throw new Error('not used'); }
  parseOutput(): CliResponse { throw new Error('not used'); }
  protected buildArgs(_message: CliMessage): string[] { return []; }
  protected async sendInputImpl(): Promise<void> { /* not used */ }

  spawnForTest(args: string[]): ChildProcess {
    return this.spawnProcess(args);
  }
}

describe('BaseCliAdapter.spawnProcess cwd guard', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('throws CliSpawnCwdError before spawning when the cwd does not exist', () => {
    const adapter = new TestAdapter({ command: 'fake-cli', cwd: '/definitely/not/a/real/dir' });

    expect(() => adapter.spawnForTest(['--version'])).toThrow(CliSpawnCwdError);
    expect(() => adapter.spawnForTest(['--version'])).toThrow(
      /Working directory does not exist: \/definitely\/not\/a\/real\/dir \(cannot spawn fake-cli\)/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('throws for a remote-style Windows path on this platform', () => {
    const adapter = new TestAdapter({ command: 'codex', cwd: 'C:\\definitely\\not\\a\\real\\aio-dir' });
    expect(() => adapter.spawnForTest([])).toThrow(CliSpawnCwdError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not fire when cwd is undefined (spawn falls back to process cwd)', () => {
    spawnMock.mockReturnValue(makeFakeProc());
    const adapter = new TestAdapter({ command: 'fake-cli' });

    expect(() => adapter.spawnForTest(['--version'])).not.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: undefined });
  });

  it('does not fire for an existing directory', () => {
    spawnMock.mockReturnValue(makeFakeProc());
    const adapter = new TestAdapter({ command: 'fake-cli', cwd: tmpdir() });

    expect(() => adapter.spawnForTest(['--version'])).not.toThrow();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ cwd: tmpdir() });
  });
});
