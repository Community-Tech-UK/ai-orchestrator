import { afterEach, expect, it, vi } from 'vitest';
import { PlanQueueWorktreeService, type PlanQueueWorktreeCreator } from './plan-queue-worktree';

afterEach(() => vi.restoreAllMocks());

it.each([0, 5])('gives concurrent base checkouts distinct branches with folder limit %s even in the same millisecond', async maxConcurrent => {
  vi.spyOn(Date, 'now').mockReturnValue(123);
  const options: Parameters<PlanQueueWorktreeCreator['createWorktree']>[2][] = [];
  const stopped = new Error('Fixture stops before creating a checkout');
  const creator: PlanQueueWorktreeCreator = {
    getAllSessions: () => [], getConfig: () => ({ maxConcurrent }),
    createWorktree: async (_id, _task, input) => { options.push(input); throw stopped; },
    cleanupWorktree: async () => { throw new Error('No checkout was created'); },
  };
  const service = new PlanQueueWorktreeService({ repoRootForItem: () => '/repo', creator, saveItem: () => undefined, skipInstall: true });
  const results = await Promise.allSettled([
    service.withBaseline('/repo', 'immutable-base-a', async () => undefined),
    service.withBaseline('/repo', 'immutable-base-b', async () => undefined),
  ]);
  expect(results).toEqual([{ status: 'rejected', reason: stopped }, { status: 'rejected', reason: stopped }]);
  expect(options.map(option => option?.baseBranch)).toEqual(['immutable-base-a', 'immutable-base-b']);
  expect(options.map(option => option?.countsTowardLimit)).toEqual([false, false]);
  expect(options[0]?.branchName).toMatch(/^base-gate-checks-/);
  expect(options[1]?.branchName).toMatch(/^base-gate-checks-/);
  expect(options.map(option => option?.branchName?.startsWith('queue/'))).toEqual([false, false]);
  expect(options[0]?.branchName).not.toBe(options[1]?.branchName);
});
