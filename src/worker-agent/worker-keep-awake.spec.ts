import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerKeepAwake } from './worker-keep-awake';

describe('worker keep-awake lease', () => {
  afterEach(() => vi.useRealTimers());
  function setup() {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const spawn = vi.fn(() => child);
    const lease = new WorkerKeepAwake({ platform: 'win32', spawn });
    return { child, spawn, lease };
  }
  it('renews one assertion, expires after coordinator silence and releases on stop', async () => {
    const { child, spawn, lease } = setup();
    const enabled = lease.setEnabled(true);
    child.stdout!.emit('data', Buffer.from('READY\n'));
    expect(await enabled).toEqual({ active: true });
    vi.advanceTimersByTime(60_000);
    await lease.setEnabled(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(89_999);
    expect(child.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(await lease.setEnabled(false)).toEqual({ active: false });
  });
  it('releases immediately on disconnect even while the helper is starting', async () => {
    const { child, lease } = setup();
    const enabling = lease.setEnabled(true);
    await lease.setEnabled(false);
    child.stdout!.emit('data', Buffer.from('READY\n'));
    expect(await enabling).toEqual({ active: false });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
  it('reports a native helper failure and permits a later retry', async () => {
    const { child, spawn, lease } = setup();
    const enabling = lease.setEnabled(true);
    child.emit('error', new Error('PowerShell missing'));
    await expect(enabling).rejects.toThrow('PowerShell missing');
    const retry = lease.setEnabled(true);
    child.stdout!.emit('data', Buffer.from('READY\n'));
    await expect(retry).resolves.toEqual({ active: true });
    expect(spawn).toHaveBeenCalledTimes(2);
    lease.shutdown();
  });
  it('does not claim native support on other platforms', async () => {
    const spawn = vi.fn();
    const lease = new WorkerKeepAwake({ platform: 'linux', spawn });
    await expect(lease.setEnabled(true)).rejects.toThrow('Windows');
    expect(spawn).not.toHaveBeenCalled();
  });
});
