import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureOpenCodeModelList } from './opencode-model-lister-process';

const mocks = vi.hoisted(() => ({ killGroup: vi.fn() }));
vi.mock('../cli/adapters/base-cli-process-utils', () => ({ killProcessGroup: mocks.killGroup }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('OpenCode model subprocess shutdown budget', () => {
  it('confirms close at 28 seconds when both Windows kill attempts block for their five-second maximum', async () => {
    // Advance a single event-loop clock. Unlike tick(), synchronous helper
    // time cannot run another callback inside the currently blocked callback.
    let elapsed = 0;
    const timers = new Map<ReturnType<typeof setTimeout>, { due: number; callback: () => void }>();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay = 0) => {
      const token = {} as ReturnType<typeof setTimeout>;
      timers.set(token, { due: elapsed + delay, callback });
      return token;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((token) => {
      timers.delete(token as ReturnType<typeof setTimeout>);
    });
    const signals: Array<[NodeJS.Signals, number]> = [];
    mocks.killGroup.mockImplementation((_pid: number, signal: NodeJS.Signals) => {
      signals.push([signal, elapsed]);
      elapsed += 5_000;
      return false;
    });
    const proc = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242,
      kill: (signal: NodeJS.Signals) => { if (signal === 'SIGKILL') proc.emit('close', null); return true; },
    });
    const reading = captureOpenCodeModelList(() => proc as unknown as ChildProcess, {
      timeout: 'Synthetic timeout', process: 'Synthetic process failure',
    }).then(() => undefined, (error: Error) => error);
    for (let count = 0; count < 2; count++) {
      const [token, timer] = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0]!;
      timers.delete(token);
      elapsed = Math.max(elapsed, timer.due);
      timer.callback();
    }
    expect(await reading).toMatchObject({ message: 'Synthetic timeout' });
    expect(signals).toEqual([['SIGTERM', 18_000], ['SIGKILL', 23_000]]);
    expect(elapsed).toBe(28_000);
    expect(timers.size).toBe(0);
    expect(proc.listenerCount('close')).toBe(0);
  });
});
