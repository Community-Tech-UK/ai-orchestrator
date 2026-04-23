import { describe, expect, it, vi } from 'vitest';
import { StaleBranchPolicy } from './stale-branch-policy';

describe('StaleBranchPolicy', () => {
  it('warns on stale branches and attaches canonical recovery context', () => {
    const policy = new StaleBranchPolicy();

    const decision = policy.evaluate({
      state: 'stale',
      branch: 'feature/stale',
      upstream: 'origin/main',
      ahead: 0,
      behind: 2,
      summary: 'Branch feature/stale is behind origin/main by 2 commit(s).',
    }, {
      workingDirectory: '/repo',
      surface: 'workflow',
      requiresWrite: true,
    });

    expect(decision).toEqual(expect.objectContaining({
      action: 'warn',
      recommendedRemediation: 'merge-forward',
      requiresManualResolution: true,
    }));
    expect(decision.failure).toEqual(expect.objectContaining({
      category: 'stale_branch',
      context: expect.objectContaining({
        workingDirectory: '/repo',
        surface: 'workflow',
        recommendedRemediation: 'merge-forward',
      }),
    }));
  });

  it('blocks diverged branches and emits a lifecycle decision event', () => {
    const policy = new StaleBranchPolicy();
    const listener = vi.fn();
    policy.on('decision', listener);

    const decision = policy.evaluate({
      state: 'diverged',
      branch: 'feature/diverged',
      upstream: 'origin/main',
      ahead: 3,
      behind: 1,
      summary: 'Branch feature/diverged has diverged from origin/main (3 ahead, 1 behind).',
    }, {
      surface: 'repo-job',
    });

    expect(decision).toEqual(expect.objectContaining({
      action: 'block',
      recommendedRemediation: 'rebase',
    }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ surface: 'repo-job' }),
      decision: expect.objectContaining({
        action: 'block',
        state: 'diverged',
      }),
    }));
  });
});
