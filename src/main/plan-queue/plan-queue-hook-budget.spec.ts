import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTesting as resetCleanups } from '../util/cleanup-registry';
import { commitWithHooks } from './plan-queue-squash';

const MINUTE = 60_000;
let child: ChildProcess & { stdout: PassThrough; stderr: PassThrough };
const children: ChildProcess[] = [];

function finish(code: number | null): void {
  child.emit('exit', code);
  child.emit('close', code);
}

beforeEach(() => {
  resetCleanups();
  vi.useFakeTimers();
  // Intercept the native launch method, as the process-fixture helper does.
  // Builtin export mocks can miss a spawn already bound by another import.
  const prototype = ChildProcess.prototype as unknown as {
    spawn(this: ChildProcess, options: unknown): number;
  };
  vi.spyOn(prototype, 'spawn').mockImplementation(function (this: ChildProcess) {
    child = Object.assign(this, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        void Promise.resolve().then(() => finish(null));
        return true;
      }),
    });
    children.push(child);
    return 0;
  });
});

afterEach(() => {
  for (const launched of children.splice(0)) {
    launched.stdout?.destroy();
    launched.stderr?.destroy();
  }
  resetCleanups();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('landing hook budget', () => {
  it('lets a broad related-test run finish beyond the old fifteen-minute deadline', async () => {
    const pending = commitWithHooks('/unused-hook-fixture', 'fixture', null);
    await vi.advanceTimersByTimeAsync(50 * MINUTE);
    expect(child.kill).not.toHaveBeenCalled();

    child.stdout.write('related tests passed');
    finish(0);
    const result = await pending;
    expect(result, result.output).toEqual({ exitCode: 0, output: 'related tests passed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still stops a stuck hook at the one-hour ceiling', async () => {
    const pending = commitWithHooks('/unused-hook-fixture', 'fixture', null);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await pending).toEqual({
      exitCode: 1,
      output: '\n[plan queue] the pre-commit hook timed out after 3600000ms',
      timedOut: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves explicit shorter deadlines', async () => {
    const short = commitWithHooks('/unused-hook-fixture', 'fixture', null, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect((await short).exitCode).toBe(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('returns an early hook failure without waiting for the deadline', async () => {
    const pending = commitWithHooks('/unused-hook-fixture', 'fixture', null);
    child.stderr.write('related test failed');
    finish(2);

    expect(await pending).toEqual({ exitCode: 2, output: 'related test failed' });
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
