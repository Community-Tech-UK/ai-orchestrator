import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { Writable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { hasActiveStdinWrite, writeChildStdin } from './child-stdin-write';

function fixture(stdin: Writable) {
  const proc = Object.assign(new EventEmitter(), { stdin, killed: false, exitCode: null, signalCode: null });
  return { proc, child: proc as unknown as ChildProcess };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('native stdin acceptance', () => {
  it.each([1, 16384])('waits for the callback even after drain at highWaterMark %s', async (highWaterMark) => {
    let complete!: (error?: Error | null) => void;
    const stdin = new Writable({ highWaterMark, write(_chunk, _encoding, callback) { complete = callback; } });
    const { child } = fixture(stdin);
    const accepted = vi.fn();
    let settled = false;
    const pending = writeChildStdin(child, 'synthetic input', accepted).then(() => { settled = true; });
    stdin.emit('drain');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(accepted).not.toHaveBeenCalled();
    complete();
    await pending;
    expect(accepted).toHaveBeenCalledOnce();
    expect(hasActiveStdinWrite(stdin)).toBe(false);
    expect(stdin.listenerCount('error')).toBe(0);
  });

  it.each([1, 16384])('rejects an asynchronous EPIPE at highWaterMark %s', async (highWaterMark) => {
    const failure = Object.assign(new Error('synthetic async pipe failure'), { code: 'EPIPE' });
    const stdin = new Writable({ highWaterMark, write(_chunk, _encoding, callback) { queueMicrotask(() => callback(failure)); } });
    const { child, proc } = fixture(stdin);
    const accepted = vi.fn();
    await expect(writeChildStdin(child, 'synthetic input', accepted)).rejects.toBe(failure);
    expect(accepted).not.toHaveBeenCalled();
    expect(hasActiveStdinWrite(stdin)).toBe(false);
    expect(stdin.listenerCount('error')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
    expect(proc.listenerCount('close')).toBe(0);
  });

  it('cleans the captured stream when the process stdin changes before completion', async () => {
    let complete!: (error?: Error | null) => void;
    const oldPipe = new Writable({ write(_chunk, _encoding, callback) { complete = callback; } });
    const { child, proc } = fixture(oldPipe);
    const pending = writeChildStdin(child, 'synthetic input');
    const replacement = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    proc.stdin = replacement;
    complete();
    await pending;
    expect(oldPipe.listenerCount('error')).toBe(0);
    expect(oldPipe.listenerCount('close')).toBe(0);
    expect(replacement.listenerCount('error')).toBe(0);
    expect(hasActiveStdinWrite(oldPipe)).toBe(false);
    expect(proc.listenerCount('exit')).toBe(0);
  });

  it('fails when the process exits before acknowledgement and ignores a late callback', async () => {
    let complete!: (error?: Error | null) => void;
    const stdin = new Writable({ write(_chunk, _encoding, callback) { complete = callback; } });
    const { child, proc } = fixture(stdin);
    const accepted = vi.fn();
    const pending = writeChildStdin(child, 'synthetic input', accepted);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'EPIPE' });
    proc.emit('exit', 1, null);
    complete();
    await rejection;
    expect(accepted).not.toHaveBeenCalled();
    expect(hasActiveStdinWrite(stdin)).toBe(false);
  });

  it('preserves acceptance when a successful callback precedes synchronous process exit', async () => {
    const stdin = new Writable();
    const { child, proc } = fixture(stdin);
    stdin.write = ((_chunk: unknown, callback?: unknown) => { if (typeof callback === 'function') callback(); proc.emit('exit', 1, null); return false; }) as typeof stdin.write;
    const accepted = vi.fn();
    await expect(writeChildStdin(child, 'synthetic input', accepted)).resolves.toBeUndefined();
    expect(accepted).toHaveBeenCalledOnce();
  });

  it('does not accept a synchronous success callback followed by a thrown write', async () => {
    const stdin = new Writable();
    const { child } = fixture(stdin);
    const failure = new Error('synthetic thrown write');
    stdin.write = ((_chunk: unknown, callback?: unknown) => { if (typeof callback === 'function') callback(); throw failure; }) as typeof stdin.write;
    const accepted = vi.fn();
    await expect(writeChildStdin(child, 'synthetic input', accepted)).rejects.toBe(failure);
    expect(accepted).not.toHaveBeenCalled();
  });

  it('rejects a synchronous stream error before write returns', async () => {
    const stdin = new Writable();
    const { child } = fixture(stdin);
    const failure = new Error('synthetic synchronous stream failure');
    stdin.write = (() => { stdin.emit('error', failure); return true; }) as typeof stdin.write;
    await expect(writeChildStdin(child, 'synthetic input')).rejects.toBe(failure);
    expect(hasActiveStdinWrite(stdin)).toBe(false);
  });

  it('does not accept a synchronous callback when the stream errors before write returns', async () => {
    const stdin = new Writable();
    const { child } = fixture(stdin);
    const failure = new Error('synthetic synchronous stream failure after callback');
    stdin.write = ((_chunk: unknown, callback?: unknown) => {
      if (typeof callback === 'function') callback();
      stdin.emit('error', failure);
      return true;
    }) as typeof stdin.write;
    const accepted = vi.fn();
    await expect(writeChildStdin(child, 'synthetic input', accepted)).rejects.toBe(failure);
    expect(accepted).not.toHaveBeenCalled();
  });

  it('retains the first native failure when a failed callback is followed by a throw', async () => {
    const stdin = new Writable();
    const { child } = fixture(stdin);
    const failure = new Error('synthetic original callback failure');
    stdin.write = ((_chunk: unknown, callback?: unknown) => {
      if (typeof callback === 'function') callback(failure);
      throw new Error('synthetic secondary thrown failure');
    }) as typeof stdin.write;
    await expect(writeChildStdin(child, 'synthetic input')).rejects.toBe(failure);
  });

  it('rejects a closed pipe without submitting bytes', async () => {
    const stdin = new Writable();
    stdin.destroy();
    const write = vi.spyOn(stdin, 'write');
    await expect(writeChildStdin(fixture(stdin).child, 'synthetic input')).rejects.toMatchObject({ code: 'EPIPE' });
    expect(write).not.toHaveBeenCalled();
  });

  it('bounds the wait for a pipe that never acknowledges', async () => {
    const stdin = new Writable({ write() { /* native completion never arrives */ } });
    const { child, proc } = fixture(stdin);
    const accepted = vi.fn();
    await expect(writeChildStdin(child, 'synthetic input', accepted, 20)).rejects.toThrow(/stdin write timeout/);
    expect(accepted).not.toHaveBeenCalled();
    expect(hasActiveStdinWrite(stdin)).toBe(false);
    expect(proc.listenerCount('exit')).toBe(0);
    await nextTurn();
  });

  it('rejects the actual process error before waiting for the write timeout', async () => {
    const stdin = new Writable({ write() { /* native completion never arrives */ } });
    const { child, proc } = fixture(stdin);
    const failure = new Error('synthetic process failure');
    proc.on('error', () => undefined);
    const pending = writeChildStdin(child, 'synthetic input', undefined, 20);
    proc.emit('error', failure);
    await expect(pending).rejects.toBe(failure);
  });
});
