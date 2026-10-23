import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationInput } from '../notifications/notification-service';
import type { ScratchEntryDecision } from './scratch-sweep';

const mocks = vi.hoisted(() => ({
  notify: vi.fn((_input: NotificationInput) => ({ delivery: 'desktop' })),
  retentionDays: 14,
  directories: [] as { path: string; nodeId?: string }[],
  decisions: [] as ScratchEntryDecision[],
  sweep: vi.fn(),
}));

vi.mock('../notifications/notification-service', () => ({
  getNotificationService: () => ({ notify: mocks.notify }),
}));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => mocks.retentionDays }),
}));
vi.mock('../core/config/recent-directories-manager', () => ({
  getRecentDirectoriesManager: () => ({ getDirectories: async () => mocks.directories }),
}));
vi.mock('../workspace/git/git-exec', () => ({
  gitExec: async (_args: string[], cwd: string) => `${cwd}-repo`,
}));
vi.mock('./scratch-sweep', () => ({
  sweepScratchFolders: mocks.sweep,
}));

import { _resetForTesting, runScratchSweep, startScratchSweepScheduler } from './scratch-sweep-scheduler';

describe('runScratchSweep', () => {
  beforeEach(() => {
    _resetForTesting();
    mocks.notify.mockReset();
    mocks.notify.mockImplementation(() => ({ delivery: 'desktop' }));
    mocks.retentionDays = 14;
    mocks.directories = [];
    mocks.decisions = [];
    mocks.sweep.mockReset();
    mocks.sweep.mockImplementation(async () => mocks.decisions);
  });

  afterEach(() => {
    _resetForTesting();
  });

  it('sweeps the repositories of local recent folders only', async () => {
    mocks.directories = [
      { path: '/work/app' },
      { path: '/work/app' },
      { path: 'C:\\remote\\project', nodeId: 'windows-pc' },
    ];

    await runScratchSweep();

    expect(mocks.sweep).toHaveBeenCalledWith({ projectRoots: ['/work/app-repo'], retentionDays: 14 });
  });

  it('first sweeps ten minutes after startup, then daily, until reset', async () => {
    vi.useFakeTimers();
    try {
      startScratchSweepScheduler();
      startScratchSweepScheduler();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
      expect(mocks.sweep).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.sweep).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(mocks.sweep).toHaveBeenCalledTimes(2);

      _resetForTesting();
      await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60 * 1000);
      expect(mocks.sweep).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers a held-back unsaved-work notice again on the next sweep', async () => {
    mocks.decisions = [
      { kind: 'kept-unsaved-work', path: '/work/app/_scratch/gate-1', reason: 'uncommitted changes in …' },
    ];
    mocks.notify.mockImplementationOnce(() => ({ delivery: 'quiet-hours' }));

    await runScratchSweep();
    await runScratchSweep();
    await runScratchSweep();

    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it('does not sweep when retention is turned off', async () => {
    mocks.retentionDays = 0;

    await runScratchSweep();

    expect(mocks.sweep).not.toHaveBeenCalled();
  });

  it('reports folders kept for unsaved work once, not on every sweep', async () => {
    mocks.decisions = [
      { kind: 'kept-unsaved-work', path: '/work/app/_scratch/gate-1', reason: '1 commit(s) in … are not in …' },
      { kind: 'removed', path: '/work/app/_scratch/gate-2' },
    ];

    await runScratchSweep();
    await runScratchSweep();

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0]![0]).toMatchObject({
      kind: 'scratch-unsaved-work',
      body: expect.stringContaining('/work/app/_scratch/gate-1'),
    });
  });
});
