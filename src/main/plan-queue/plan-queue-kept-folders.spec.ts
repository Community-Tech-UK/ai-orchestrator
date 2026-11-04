import { describe, expect, it, vi } from 'vitest';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { KEPT_FOLDER_RETRY_MS, PlanQueueKeptFolders } from './plan-queue-kept-folders';
import type { PlanQueueItem } from './plan-queue.types';

const kept = (id: string, patch: Partial<PlanQueueItem> = {}) =>
  ({ id, state: 'parked', worktreePath: `/repo/.worktrees/queue/${id}`, workerInstanceId: null, verifierInstanceId: null, ...patch }) as PlanQueueItem;

describe('PlanQueueKeptFolders.retryDue', () => {
  it('tries each kept folder at once, then again only once the hour has passed', () => {
    const lock = vi.fn(async (_itemId: string, _action: () => Promise<void>) => undefined);
    const folders = new PlanQueueKeptFolders({} as PlanQueueFlowHost, lock);
    const items = [kept('a'), kept('b', { state: 'landed' })];

    folders.retryDue(items, 1_000);
    folders.retryDue(items, 1_000 + KEPT_FOLDER_RETRY_MS - 1);
    expect(lock.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);

    folders.retryDue(items, 1_000 + KEPT_FOLDER_RETRY_MS);
    expect(lock.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('leaves items that keep no folder, and landed items whose own clean-up is still running', () => {
    const lock = vi.fn(async (_itemId: string, _action: () => Promise<void>) => undefined);
    new PlanQueueKeptFolders({} as PlanQueueFlowHost, lock).retryDue([
      kept('working', { state: 'working' }),
      kept('no-folder', { worktreePath: null }),
      kept('landing-cleanup', { state: 'landed', workerInstanceId: 'worker' }),
    ], 1_000);
    expect(lock).not.toHaveBeenCalled();
  });
});
