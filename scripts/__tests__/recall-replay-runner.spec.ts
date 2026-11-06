import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const subprocess = { spawn: vi.fn() };
import { makeRecallRunner, RecallProcessNotRetiredError } from '../../src/main/context/recall-replay/recall-cli-runner';
import { recordingRunner } from '../audit/recall-replay';

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn((_signal?: NodeJS.Signals) => true),
  });
}

describe('recall CLI retirement', () => {
  beforeEach(() => { vi.useFakeTimers(); subprocess.spawn.mockReset(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('escalates a timed-out call that ignores TERM and settles after exit even if pipes stay open', async () => {
    const child = fakeChild(); subprocess.spawn.mockReturnValue(child);
    child.kill.mockImplementation(signal => {
      if (signal === 'SIGKILL') { child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL'); }
      return true;
    });
    const run = makeRecallRunner('synthetic-cli', {}, subprocess.spawn as unknown as typeof spawn)({ args: [], cwd: '.', timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(12_100);
    expect(child.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
    await expect(run).resolves.toMatchObject({ exitCode: null, timedOut: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a deadline even when TERM causes an exit-zero success result', async () => {
    const child = fakeChild(); subprocess.spawn.mockReturnValue(child);
    child.kill.mockImplementation(() => { child.exitCode = 0; child.emit('close', 0); return true; });
    const run = makeRecallRunner('synthetic-cli', {}, subprocess.spawn as unknown as typeof spawn)({ args: [], cwd: '.', timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(run).resolves.toMatchObject({ exitCode: 0, timedOut: true });
  });

  it('rejects within the retirement grace when even KILL yields no proof of exit', async () => {
    const child = fakeChild(); subprocess.spawn.mockReturnValue(child);
    const run = makeRecallRunner('synthetic-cli', {}, subprocess.spawn as unknown as typeof spawn)({ args: [], cwd: '.', timeoutMs: 100 });
    const checked = expect(run).rejects.toMatchObject({ name: 'RecallProcessNotRetiredError' });
    await vi.advanceTimersByTimeAsync(20_100);
    await checked;
    expect(child.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([new RecallProcessNotRetiredError(), new Error('synthetic-private-transport-detail')])(
    'records an unsuccessful attempt with unknown output and cost when transport rejects: %s', async failure => {
      const receipts: Parameters<typeof recordingRunner>[1] = [];
      const run = recordingRunner(async () => { throw failure; }, receipts);
      await expect(run({ args: ['--session-id', 'allocated-id-placeholder', '--resume', 'source-id-placeholder'],
        cwd: '.', timeoutMs: 100, stdin: 'synthetic-private-question' })).rejects.toBe(failure);
      expect(receipts).toEqual([expect.objectContaining({ n: 1, exitCode: null, stdoutBytes: null,
        stdoutSha256: null, stderrBytes: null, costUsd: null, isError: null,
        timedOut: failure instanceof RecallProcessNotRetiredError,
        transportError: failure instanceof RecallProcessNotRetiredError ? 'not-retired' : 'runner-error' })]);
      expect(JSON.stringify(receipts)).not.toMatch(/synthetic-private|source-id-placeholder|allocated-id-placeholder/);
    },
  );
});

it.runIf(process.platform !== 'win32')('retires a real synthetic Node process which ignores TERM, without a provider call', async () => {
  const result = await makeRecallRunner(process.execPath, {})({
    args: ['-e', "process.on('SIGTERM',()=>process.stdout.write('term-ignored\\n'));process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
    cwd: process.cwd(), timeoutMs: 1_000,
  });
  expect(result).toMatchObject({ exitCode: null, timedOut: true });
  expect(result.stdout).toContain('ready');
  expect(result.stdout).toContain('term-ignored');
}, 15_000);
