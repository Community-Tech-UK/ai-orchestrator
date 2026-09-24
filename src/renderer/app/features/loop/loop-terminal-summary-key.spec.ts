import { describe, expect, it } from 'vitest';
import { terminalSummaryRefreshKey } from './loop-terminal-summary-key';

// LT-640: a finished run's worktree outcome arrives as later state broadcasts
// for the SAME loopRunId (harvesting → harvested → blocked/promoted). Keying the
// past-runs refresh on the run id alone pulled history once and left the panel
// on the stale "saving session work" caption.
describe('terminalSummaryRefreshKey', () => {
  it('is null when no summary is shown', () => {
    expect(terminalSummaryRefreshKey(null)).toBeNull();
  });

  it('changes when the same run moves to a new worktree lifecycle phase', () => {
    const harvesting = terminalSummaryRefreshKey({
      loopRunId: 'loop-1',
      worktreeLifecycle: { phase: 'harvesting', baseBranch: 'main', sessionBranch: 's', updatedAt: 1 },
    });
    const blocked = terminalSummaryRefreshKey({
      loopRunId: 'loop-1',
      worktreeLifecycle: { phase: 'blocked', baseBranch: 'main', sessionBranch: 's', updatedAt: 2 },
    });
    expect(harvesting).not.toBeNull();
    expect(blocked).not.toBe(harvesting);
  });

  it('stays stable for a run without worktree isolation', () => {
    expect(terminalSummaryRefreshKey({ loopRunId: 'loop-2' }))
      .toBe(terminalSummaryRefreshKey({ loopRunId: 'loop-2' }));
  });
});
