import { describe, expect, it } from 'vitest';
import { managedWorktreeStatus } from './managed-worktree-status.util';

describe('managedWorktreeStatus', () => {
  it('makes a blocked promotion and its durable branches explicit', () => {
    expect(managedWorktreeStatus({
      phase: 'blocked',
      baseBranch: 'main',
      sessionBranch: 'task-loop',
      integrationBranch: 'integration/main',
      lastError: 'root checkout has uncommitted changes',
      updatedAt: 1,
    }, 'completed')).toEqual({
      tone: 'blocked',
      label: 'promotion blocked',
      detail: 'root checkout has uncommitted changes · saved on task-loop and integration/main',
    });
  });

  it('does not claim a failed harvest was saved on its session branch', () => {
    expect(managedWorktreeStatus({
      phase: 'blocked',
      baseBranch: 'main',
      sessionBranch: 'task-loop',
      lastError: 'Harvest failed with uncommitted work',
      updatedAt: 1,
    }, 'completed-needs-review')).toEqual({
      tone: 'blocked',
      label: 'workspace blocked',
      detail: 'Harvest failed with uncommitted work · uncommitted in the task-loop worktree folder, not saved on a branch',
    });
  });

  it.each([
    'Session adds active plan/spec/livetest documents; land it manually',
    'Session branch changed outside AIO; review it before landing',
  ])('shows the landing-guard reason "%s" with the saved branch', (reason) => {
    expect(managedWorktreeStatus({
      phase: 'blocked',
      baseBranch: 'main',
      sessionBranch: 'task-loop',
      lastError: reason,
      updatedAt: 1,
    }, 'completed')?.detail).toBe(`${reason} · saved on task-loop`);
  });

  it('names the overlapping repository path when promotion collides with root work', () => {
    const reason = 'root checkout has uncommitted changes to a promoted path: src/app/feature.ts';
    expect(managedWorktreeStatus({
      phase: 'blocked',
      baseBranch: 'main',
      sessionBranch: 'task-loop',
      integrationBranch: 'integration/main',
      lastError: reason,
      updatedAt: 1,
    }, 'completed')?.detail).toBe(`${reason} · saved on task-loop and integration/main`);
  });

  it('hides an absolute path in an overlap reason', () => {
    expect(managedWorktreeStatus({
      phase: 'blocked',
      baseBranch: 'main',
      sessionBranch: 'task-loop',
      lastError: 'root checkout has uncommitted changes to a promoted path: /Users/someone/x',
      updatedAt: 1,
    }, 'completed')?.detail).toBe(
      'manual attention required; inspect AIO logs · saved on task-loop',
    );
  });

  it('shows an operator-resolved workspace as resolved rather than promoted', () => {
    expect(managedWorktreeStatus({
      phase: 'cleaned',
      baseBranch: 'main',
      sessionBranch: 'task-loop',
      integrationBranch: 'integration/main',
      resolvedByOperatorAt: 5,
      updatedAt: 5,
    }, 'completed')).toEqual({
      tone: 'preserved',
      label: 'marked resolved',
      detail: 'you resolved this workspace by hand; AIO no longer manages task-loop',
    });
  });

  it('does not render arbitrary persisted Git output as operator-facing detail', () => {
    const view = managedWorktreeStatus({
      phase: 'blocked',
      baseBranch: 'main',
      sessionBranch: 'task-loop',
      integrationBranch: 'integration/main',
      lastError: 'fatal: could not read /Users/james/private/repo/.git/worktrees/task',
      updatedAt: 1,
    }, 'completed');

    expect(view?.detail).toBe(
      'manual attention required; inspect AIO logs · saved on task-loop and integration/main',
    );
    expect(view?.detail).not.toContain('/Users/');
    expect(view?.detail).not.toContain('fatal:');
  });

  it('labels successful cleanup as promoted instead of merely cleaned', () => {
    expect(managedWorktreeStatus({
      phase: 'cleaned',
      baseBranch: 'main',
      sessionBranch: 'task-loop',
      integrationBranch: 'integration/main',
      updatedAt: 1,
    }, 'completed')).toEqual({
      tone: 'success',
      label: 'promoted to main',
      detail: 'managed workspace cleaned',
    });
  });

  it('labels non-integrated cleanup as preserved on the session branch', () => {
    expect(managedWorktreeStatus({
      phase: 'cleaned',
      baseBranch: 'main',
      sessionBranch: 'task-loop',
      updatedAt: 1,
    }, 'cancelled')).toEqual({
      tone: 'preserved',
      label: 'work preserved',
      detail: 'saved on task-loop · managed workspace cleaned',
    });
  });
});
