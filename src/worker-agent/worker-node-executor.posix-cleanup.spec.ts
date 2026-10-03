import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessFixtureRegistry } from '../tests/fixtures/process-fixture';
import { ExecFileError } from './service/exec-file';
import { execFileCaptureWithBoundedTermination, type NodeExecRuntime } from './worker-node-executor';
import { NODE_EXEC_OWNERSHIP_MARKER_ENV } from './worker-node-process-tree';

const fixtures = new ProcessFixtureRegistry();
afterEach(() => fixtures.cleanup());

function inspectionFailure(mode: 'callback' | 'throw' | 'hang' | 'empty'): typeof execFile {
  return ((...args: unknown[]) => {
    if (args[0] !== 'ps') throw new Error('Unexpected inspection command');
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    const error = Object.assign(new Error('fixture ps unavailable'), { code: 'ENOENT' });
    if (mode === 'throw') throw error;
    if (mode !== 'hang') queueMicrotask(() => callback(mode === 'empty' ? null : error, '', ''));
    return { kill: vi.fn(), unref: vi.fn() };
  }) as unknown as typeof execFile;
}

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 91_001,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: vi.fn(),
  }) as unknown as ChildProcess;
}

describe.skipIf(process.platform === 'win32')('POSIX node.exec direct-child cleanup', () => {
  it('does not deliver TERM twice when the validated tree already signalled the root', async () => {
    const child = fakeChild();
    const marker = 'a'.repeat(32);
    const error = await execFileCaptureWithBoundedTermination('fixture', [], { timeoutMs: 10 }, {
      platform: process.platform,
      spawnProcess: (() => child) as typeof spawn,
      createOwnershipMarker: () => marker,
      execFileProcess: ((...args: unknown[]) => {
        const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
        const record = `${child.pid} 1 ${child.pid} node ${NODE_EXEC_OWNERSHIP_MARKER_ENV}=${marker}`;
        queueMicrotask(() => callback(null, record, ''));
        return { kill: vi.fn(), unref: vi.fn() };
      }) as unknown as typeof execFile,
      killProcess: (_pid, signal) => {
        if (signal === 'SIGTERM') child.stdout!.emit('data', 'term');
        else child.emit('exit', null, 'SIGKILL');
        return true;
      },
    }).catch((error: unknown) => error);

    expect(error).toMatchObject({ stdout: 'term', stderr: '' });
  });

  it.each(['callback', 'hang', 'empty'] as const)(
    'kills a real signal-ignoring child when inspection returns %s',
    async (mode) => {
      const children: ChildProcess[] = [];
      const signals: [number, string | number | undefined][] = [];
      const runtime: NodeExecRuntime = {
        platform: process.platform,
        spawnProcess: ((...args: Parameters<typeof spawn>) => {
          const child = fixtures.spawn(...args);
          children.push(child);
          return child;
        }) as typeof spawn,
        execFileProcess: inspectionFailure(mode),
        killProcess: (pid, signal) => {
          signals.push([pid, signal]);
          return process.kill(pid, signal);
        },
      };
      const error = await execFileCaptureWithBoundedTermination(process.execPath, [
        '-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)',
      ], { timeoutMs: 2_000 }, runtime).catch((error: unknown) => error);

      expect(error).toBeInstanceOf(ExecFileError);
      expect(error).toMatchObject({ exitCode: null, stdout: 'ready', stderr: expect.stringContaining('cleanupIncomplete') });
      await fixtures.waitForExit();
      expect(signals).toEqual([[children[0]!.pid, 'SIGTERM'], [children[0]!.pid, 'SIGKILL']]);
    }, 10_000,
  );

  it.each(['', 'invalid-marker'])('kills its child even with unusable marker %j', async (marker) => {
    const error = await execFileCaptureWithBoundedTermination(process.execPath, [
      '-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)',
    ], { timeoutMs: 2_000 }, {
      platform: process.platform,
      spawnProcess: fixtures.spawn,
      execFileProcess: inspectionFailure('empty'),
      killProcess: (pid, signal) => process.kill(pid, signal),
      createOwnershipMarker: () => marker,
    }).catch((error: unknown) => error);

    expect(error).toMatchObject({ stdout: 'ready', stderr: expect.stringContaining('cleanupIncomplete') });
    await fixtures.waitForExit();
  });

  it.each(['event', 'exitCode', 'signalCode'] as const)(
    'does not signal the root when %s reports exit during ownership inspection',
    async (exitEvidence) => {
      const child = fakeChild();
      const signals = vi.fn(() => true);
      const execFileProcess = ((...args: unknown[]) => {
        const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
        const ownershipScan = (args[1] as string[]).includes('axeww');
        queueMicrotask(() => {
          if (ownershipScan) {
            if (exitEvidence === 'event') child.emit('exit', 0, null);
            else Object.defineProperty(child, exitEvidence, {
              value: exitEvidence === 'exitCode' ? 0 : 'SIGTERM',
            });
          }
          callback(Object.assign(new Error('fixture no ps'), { code: 'EPERM' }), '', '');
        });
        return { kill: vi.fn(), unref: vi.fn() };
      }) as unknown as typeof execFile;

      const error = await execFileCaptureWithBoundedTermination('fixture', [], { timeoutMs: 10 }, {
        platform: process.platform,
        spawnProcess: (() => child) as typeof spawn,
        execFileProcess,
        killProcess: signals,
      }).catch((error: unknown) => error);

      expect(error).toMatchObject({ stderr: expect.stringContaining('cleanupIncomplete') });
      expect(signals).not.toHaveBeenCalled();
    },
  );

  it('does not escalate a child that exits during the TERM grace period', async () => {
    const child = fakeChild();
    const signals = vi.fn((_pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM') child.emit('exit', 0, null);
      return true;
    });
    await execFileCaptureWithBoundedTermination('fixture', [], { timeoutMs: 10 }, {
      platform: process.platform,
      spawnProcess: (() => child) as typeof spawn,
      execFileProcess: inspectionFailure('throw'),
      killProcess: signals,
    }).catch((error: unknown) => expect(error).toBeInstanceOf(ExecFileError));

    expect(signals.mock.calls).toEqual([[child.pid, 'SIGTERM']]);
  });

  it.each(['false', 'EPERM'] as const)('reports %s when direct signals cannot kill its child', async (failure) => {
    const child = fakeChild();
    const signals = vi.fn(() => {
      if (failure === 'EPERM') throw Object.assign(new Error('fixture denied'), { code: 'EPERM' });
      return false;
    });
    const error = await execFileCaptureWithBoundedTermination('fixture', [], { timeoutMs: 10 }, {
      platform: process.platform,
      spawnProcess: (() => child) as typeof spawn,
      execFileProcess: inspectionFailure('throw'),
      killProcess: signals,
    }).catch((error: unknown) => error);

    expect(error).toMatchObject({
      stderr: expect.stringMatching(/cleanupIncomplete: POSIX SIGTERM direct-child fallback failed[\s\S]*cleanupIncomplete: POSIX SIGKILL direct-child fallback failed/u),
    });
    expect(signals.mock.calls).toEqual([[child.pid, 'SIGTERM'], [child.pid, 'SIGKILL']]);
  });
});
