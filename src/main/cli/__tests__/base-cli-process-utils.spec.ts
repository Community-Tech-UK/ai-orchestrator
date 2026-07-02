/**
 * Coverage for the platform-specific process-group kill mechanics. The
 * adapter-parity tests mock `killProcessGroup`, so this is the only place the
 * POSIX (`process.kill(-pid, …)`) vs Windows (`taskkill /T /F`) branches and
 * their fallbacks are exercised. `process.platform` is overridden per-case so
 * both branches run regardless of the host the suite is executed on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('child_process', () => ({
  default: { spawnSync: spawnSyncMock },
  spawnSync: spawnSyncMock,
}));

import { killProcessGroup } from '../adapters/base-cli-process-utils';

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('killProcessGroup', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
    vi.restoreAllMocks();
  });

  it('returns false for an undefined pid without touching the OS', () => {
    setPlatform('linux');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(killProcessGroup(undefined, 'SIGTERM')).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  describe('posix', () => {
    beforeEach(() => setPlatform('linux'));

    it('signals the whole process group via the negated pid', () => {
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(killProcessGroup(1234, 'SIGINT')).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGINT');
    });

    it('falls back to the lone pid when the group is gone (non-ESRCH error)', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
        if (pid < 0) {
          const err = new Error('no such group') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        return true;
      }) as typeof process.kill);
      expect(killProcessGroup(1234, 'SIGTERM')).toBe(true);
      expect(killSpy).toHaveBeenNthCalledWith(1, -1234, 'SIGTERM');
      expect(killSpy).toHaveBeenNthCalledWith(2, 1234, 'SIGTERM');
    });

    it('returns false when the process group no longer exists (ESRCH)', () => {
      vi.spyOn(process, 'kill').mockImplementation((() => {
        const err = new Error('no such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }) as typeof process.kill);
      expect(killProcessGroup(1234, 'SIGTERM')).toBe(false);
    });
  });

  describe('win32', () => {
    beforeEach(() => setPlatform('win32'));

    it('uses taskkill to terminate the process tree', () => {
      spawnSyncMock.mockReturnValue({ status: 0 });
      expect(killProcessGroup(1234, 'SIGTERM')).toBe(true);
      expect(spawnSyncMock).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '1234', '/T', '/F'],
        expect.objectContaining({ windowsHide: true }),
      );
    });

    it('returns false when taskkill exits non-zero', () => {
      spawnSyncMock.mockReturnValue({ status: 128 });
      expect(killProcessGroup(1234, 'SIGTERM')).toBe(false);
    });

    it('falls back to process.kill when taskkill is missing (ENOENT)', () => {
      spawnSyncMock.mockReturnValue({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(killProcessGroup(1234, 'SIGKILL')).toBe(true);
      expect(killSpy).toHaveBeenCalledWith(1234, 'SIGKILL');
    });
  });
});
