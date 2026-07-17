/**
 * WS13 — hardened (Seatbelt) spawn wrap at the BaseCliAdapter choke point.
 *
 * Uses the same intercepted-spawn harness as the cwd-guard spec so no child
 * process is ever created. The macOS-only wrap test is gated with runIf; the
 * fail-closed behavior is covered platform-independently in seatbelt.spec.ts.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const mocked = {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
  return { ...mocked, default: mocked };
});

import { BaseCliAdapter } from './base-cli-adapter';
import type {
  CliAdapterConfig,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliStatus,
} from './base-cli-adapter';
import { SANDBOX_EXEC_PATH } from '../../sandbox/seatbelt';
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

describe('BaseCliAdapter hardened spawn wrap', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('spawns the raw command when hardened mode is not configured', () => {
    spawnMock.mockReturnValue(makeFakeProc());
    const adapter = new TestAdapter({ command: 'fake-cli', cwd: tmpdir() });

    adapter.spawnForTest(['--print']);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('fake-cli');
    expect(spawnMock.mock.calls[0][1]).toEqual(['--print']);
  });

  it.runIf(process.platform === 'darwin')(
    'wraps the spawn in sandbox-exec when hardened mode is configured',
    () => {
      spawnMock.mockReturnValue(makeFakeProc());
      const adapter = new TestAdapter({ command: 'fake-cli', cwd: tmpdir() });
      adapter.configureHardenedMode({ writableRoots: [tmpdir()] });

      adapter.spawnForTest(['--print']);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][0]).toBe(SANDBOX_EXEC_PATH);
      const args = spawnMock.mock.calls[0][1] as string[];
      // The real CLI rides after the `--` separator, untouched.
      expect(args.slice(args.indexOf('--') + 1)).toEqual(['fake-cli', '--print']);
      // Writable roots ride -D params, never the policy text.
      expect(args).toContain(`WRITABLE_ROOT_0=${tmpdir()}`);
      const policy = args[args.indexOf('-p') + 1];
      expect(policy).toContain('(deny default)');
      expect(policy).not.toContain(tmpdir());
    },
  );

  it.runIf(process.platform !== 'darwin')(
    'fails closed on non-macOS platforms when hardened mode is configured',
    () => {
      const adapter = new TestAdapter({ command: 'fake-cli', cwd: tmpdir() });
      adapter.configureHardenedMode({ writableRoots: [tmpdir()] });

      expect(() => adapter.spawnForTest(['--print'])).toThrow(/refusing to spawn unsandboxed/);
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );
});
