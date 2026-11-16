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

    describe('descendants outside the process group (LT-1093)', () => {
      /** pgrep -P output keyed by parent pid, for a comma-separated parent list as the real pgrep takes. */
      function childrenOf(table: Record<number, number[]>): void {
        spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
          const kids = args[1]!.split(',').flatMap(parent => table[Number(parent)] ?? []);
          return { status: kids.length ? 0 : 1, stdout: kids.map(String).join('\n') };
        });
      }

      it('lists a wide tree with one pgrep call per level, not one per process', () => {
        childrenOf({ 1234: [2000, 2001, 2002], 2000: [3000], 2002: [3002] });
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        killProcessGroup(1234, 'SIGTERM');
        expect(spawnSyncMock.mock.calls.map(call => call[1])).toEqual([['-P', '1234'], ['-P', '2000,2001,2002'], ['-P', '3000,3002']]);
        for (const pid of [2000, 2001, 2002, 3000, 3002]) expect(killSpy).toHaveBeenCalledWith(pid, 'SIGTERM');
      });

      it('signals every descendant, however deep, as well as the group', () => {
        childrenOf({ 1234: [2000], 2000: [3000] });
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        expect(killProcessGroup(1234, 'SIGTERM')).toBe(true);
        expect(killSpy).toHaveBeenCalledWith(2000, 'SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(3000, 'SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGTERM');
        // The descendants are listed before the group is signalled, while they still have the CLI as parent.
        const order = killSpy.mock.calls.map(call => call[0]);
        expect(order.indexOf(-1234)).toBeGreaterThan(order.indexOf(2000));
      });

      it('remembers the tree so SIGKILL still reaches a descendant after the CLI has gone', () => {
        childrenOf({ 4321: [5000] });
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        killProcessGroup(4321, 'SIGTERM');
        childrenOf({});
        killSpy.mockClear();
        killProcessGroup(4321, 'SIGKILL');
        expect(killSpy).toHaveBeenCalledWith(5000, 'SIGKILL');
        killSpy.mockClear();
        killProcessGroup(4321, 'SIGKILL');
        expect(killSpy).not.toHaveBeenCalledWith(5000, 'SIGKILL');
      });

      it('leaves descendants alone for an interrupt', () => {
        childrenOf({ 1234: [2000] });
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        killProcessGroup(1234, 'SIGINT');
        expect(killSpy).toHaveBeenCalledTimes(1);
        expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGINT');
      });

      it('still signals the group when the process listing fails or a descendant is already gone', () => {
        spawnSyncMock.mockImplementation(() => { throw new Error('spawn pgrep EPERM'); });
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        expect(() => killProcessGroup(1234, 'SIGTERM')).not.toThrow();
        expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGTERM');
      });
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
