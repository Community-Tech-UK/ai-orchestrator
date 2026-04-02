import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminateProcessTree, checkAppServerAvailability, ProtocolError } from './app-server-client';

// ─── terminateProcessTree ───────────────────────────────────────────────────

describe('terminateProcessTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when pid is undefined', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    terminateProcessTree(undefined);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('sends SIGTERM to the process group on Unix', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    terminateProcessTree(12345);

    // Should attempt process group kill with negative PID
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('falls back to single-process kill when process group kill fails', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (typeof pid === 'number' && pid < 0) {
        const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return true;
    });

    terminateProcessTree(42);

    // Should try group kill first, then single kill
    expect(killSpy).toHaveBeenCalledWith(-42, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(42, 'SIGTERM');

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('silently ignores ESRCH (no such process)', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    // Should not throw
    expect(() => terminateProcessTree(999)).not.toThrow();
    expect(killSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
});

// ─── checkAppServerAvailability ─────────────────────────────────────────────

describe('checkAppServerAvailability', () => {
  it('returns a boolean', () => {
    // This test just verifies the function doesn't throw and returns a boolean.
    // In CI, codex may not be installed, so we just check the return type.
    const result = checkAppServerAvailability();
    expect(typeof result).toBe('boolean');
  });
});

// ─── ProtocolError ──────────────────────────────────────────────────────────

describe('ProtocolError', () => {
  it('creates an error with message and data', () => {
    const error = new ProtocolError('test error', { code: -32001, detail: 'busy' });
    expect(error.message).toBe('test error');
    expect(error.data).toEqual({ code: -32001, detail: 'busy' });
    expect(error.rpcCode).toBe(-32001);
    expect(error.name).toBe('ProtocolError');
  });

  it('creates an error without rpcCode when data has no code', () => {
    const error = new ProtocolError('basic error', { detail: 'info' });
    expect(error.rpcCode).toBeUndefined();
  });

  it('creates an error without data', () => {
    const error = new ProtocolError('bare error');
    expect(error.data).toBeUndefined();
    expect(error.rpcCode).toBeUndefined();
  });
});
