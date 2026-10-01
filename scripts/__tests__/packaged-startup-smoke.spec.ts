import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  STARTUP_SMOKE_PID_MARKER,
  STARTUP_SMOKE_READY_MARKER,
} from '../../src/main/app/startup-smoke-markers';

type Kill = (pid: number, signal?: string | number) => boolean;

const require = createRequire(import.meta.url);
const {
  PID_MARKER,
  READY_MARKER,
  classifyStartupLog,
  getLaunchCommand,
  getPackagedExecutableCandidates,
  getStartupPollDecision,
  isProcessAlive,
  readAppPid,
  removeTempDirectory,
  terminateProcess,
} = require('../packaged-startup-smoke.js') as {
  PID_MARKER: string;
  READY_MARKER: string;
  classifyStartupLog: (content: string) => 'pending' | 'ready' | 'failed';
  getLaunchCommand: (options: {
    executablePath: string;
    platform: string;
    env: Record<string, string | undefined>;
  }) => { command: string; args: string[] };
  getPackagedExecutableCandidates: (root: string, platform: string) => string[];
  getStartupPollDecision?: (
    status: 'pending' | 'ready' | 'failed',
    exitResult: { code: number | null; signal: NodeJS.Signals | null } | null,
    appExited?: boolean,
  ) => 'wait' | 'ready' | 'failed';
  isProcessAlive: (pid: number, kill?: Kill) => boolean;
  readAppPid: (markerPath: string, readFileSync?: (path: string, encoding: string) => string) => number | null;
  terminateProcess: (pid: number, deps?: {
    kill?: Kill;
    isAlive?: (pid: number) => boolean;
    delay?: (ms: number) => Promise<void>;
    graceMs?: number;
    killWaitMs?: number;
  }) => Promise<'not-running' | 'terminated' | 'killed' | 'survived'>;
  removeTempDirectory: (
    directoryPath: string,
    rmSync?: (path: string, options: Record<string, unknown>) => void,
  ) => boolean;
};

describe('packaged startup smoke helpers', () => {
  it('locates unpacked executables for every release platform', () => {
    expect(getPackagedExecutableCandidates('/repo', 'darwin')).toContain(
      '/repo/release/mac-arm64/Harness.app/Contents/MacOS/Harness',
    );
    expect(getPackagedExecutableCandidates('/repo', 'win32')).toContain(
      '/repo/release/win-unpacked/Harness.exe',
    );
    expect(getPackagedExecutableCandidates('/repo', 'linux')).toContain(
      '/repo/release/linux-unpacked/harness',
    );
  });

  it('uses xvfb for a headless Linux launch', () => {
    expect(getLaunchCommand({
      executablePath: '/repo/release/linux-unpacked/harness',
      platform: 'linux',
      env: {},
    })).toEqual({
      command: 'xvfb-run',
      args: ['-a', '/repo/release/linux-unpacked/harness', '--no-sandbox'],
    });
  });

  it('requires the completed startup marker and rejects critical initialization failures', () => {
    expect(classifyStartupLog('{"level":"info","message":"Initializing Harness"}\n'))
      .toBe('pending');
    expect(classifyStartupLog('{"level":"info","message":"Harness initialized"}\n'))
      .toBe('ready');
    expect(classifyStartupLog(
      '{"level":"error","message":"Failed to initialize: IPC handlers"}\n',
    )).toBe('failed');
    expect(classifyStartupLog(
      '{"level":"warn","message":"Context-evidence IPC registered in unavailable mode"}\n',
    )).toBe('failed');
  });

  it('fails on a Chromium fatal error line instead of waiting out the startup timeout', () => {
    expect(classifyStartupLog(
      '[30310:0930/160301.649402:FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:415]'
      + ' GPU process isn\'t usable. Goodbye.\n',
    )).toBe('failed');
    expect(classifyStartupLog(
      '[30310:0930/160300.751422:ERROR:content/browser/gpu/gpu_process_host.cc:1004]'
      + ' GPU process exited unexpectedly: exit_code=6\n',
    )).toBe('pending');
    expect(classifyStartupLog('[INFO] [App] a message that merely mentions :FATAL: text\n'))
      .toBe('pending');
  });

  it('keeps polling after the bootstrap process exits cleanly for a relaunch', () => {
    expect(getStartupPollDecision?.('pending', { code: 0, signal: null })).toBe('wait');
    expect(getStartupPollDecision?.('ready', { code: 0, signal: null })).toBe('ready');
    expect(getStartupPollDecision?.('pending', { code: 1, signal: null })).toBe('failed');
  });

  it('fails as soon as the relaunched app dies before it is ready', () => {
    expect(getStartupPollDecision?.('pending', { code: 0, signal: null }, true)).toBe('failed');
    expect(getStartupPollDecision?.('pending', { code: 0, signal: null }, false)).toBe('wait');
    // An app that wrote its ready marker and then quit is a pass, not a death.
    expect(getStartupPollDecision?.('ready', { code: 0, signal: null }, true)).toBe('ready');
  });

  it('uses the same marker file names the app writes', () => {
    expect(READY_MARKER).toBe(STARTUP_SMOKE_READY_MARKER);
    expect(PID_MARKER).toBe(STARTUP_SMOKE_PID_MARKER);
  });

  it('reads the published app pid and ignores a missing or malformed marker', () => {
    expect(readAppPid('/p', () => '4242\n')).toBe(4242);
    expect(readAppPid('/p', () => 'garbage')).toBeNull();
    expect(readAppPid('/p', () => '0')).toBeNull();
    expect(readAppPid('/p', () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    })).toBeNull();
  });

  it('treats EPERM as alive and ESRCH as gone', () => {
    const failWith = (code: string): Kill => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(isProcessAlive(1, () => true)).toBe(true);
    expect(isProcessAlive(1, failWith('EPERM'))).toBe(true);
    expect(isProcessAlive(1, failWith('ESRCH'))).toBe(false);
  });

  it('escalates to SIGKILL when the app ignores SIGTERM', async () => {
    let alive = true;
    const signals: (string | number | undefined)[] = [];
    const kill: Kill = (_pid, signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') alive = false;
      return true;
    };

    const outcome = await terminateProcess(4242, {
      kill,
      isAlive: () => alive,
      delay: async () => undefined,
      graceMs: 5,
      killWaitMs: 5,
    });

    expect(outcome).toBe('killed');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stops at SIGTERM when the app honours it, and skips a process that is already gone', async () => {
    let alive = true;
    const signals: (string | number | undefined)[] = [];
    const kill: Kill = (_pid, signal) => {
      signals.push(signal);
      alive = false;
      return true;
    };
    const deps = { kill, isAlive: () => alive, delay: async () => undefined, graceMs: 5, killWaitMs: 5 };

    expect(await terminateProcess(4242, deps)).toBe('terminated');
    expect(signals).toEqual(['SIGTERM']);
    expect(await terminateProcess(4242, deps)).toBe('not-running');
    expect(signals).toEqual(['SIGTERM']);
  });

  it('does not turn a successful startup into a failure when temp cleanup races', () => {
    const cleanup = vi.fn(() => {
      throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    });

    expect(removeTempDirectory('/tmp/harness-smoke', cleanup)).toBe(false);
    expect(cleanup).toHaveBeenCalledWith('/tmp/harness-smoke', {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
});
