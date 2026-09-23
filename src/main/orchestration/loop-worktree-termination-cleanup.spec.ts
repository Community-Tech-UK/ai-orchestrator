import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./loop-worktree-lifecycle', () => ({ finalizeLoopWorktree: vi.fn() }));
vi.mock('../workspace/git/worktree-manager', () => ({ getWorktreeManager: vi.fn(() => ({})) }));
vi.mock('./loop-store', () => ({ getLoopStore: vi.fn(() => ({})) }));

import type { LoopState } from '../../shared/types/loop.types';
import { finalizeLoopWorktree } from './loop-worktree-lifecycle';
import {
  awaitLoopWorktreeFinalization,
  cleanupLoopWorktreeAfterTerminate,
} from './loop-worktree-termination-cleanup';

function terminate(id: string, worktreeSessionId: string | undefined): void {
  cleanupLoopWorktreeAfterTerminate({
    state: { id } as LoopState,
    status: 'completed',
    worktreeSessionId,
    getTerminalCleanup: () => undefined,
  });
}

describe('awaitLoopWorktreeFinalization', () => {
  beforeEach(() => {
    vi.mocked(finalizeLoopWorktree).mockReset();
  });

  it('resolves immediately when the loop has no worktree finalization in flight', async () => {
    terminate('loop-plain', undefined);
    await expect(awaitLoopWorktreeFinalization('loop-plain')).resolves.toBeUndefined();
    expect(finalizeLoopWorktree).not.toHaveBeenCalled();
  });

  it('waits for the in-flight finalization, including a failed one, then forgets it', async () => {
    let finish!: (error?: Error) => void;
    vi.mocked(finalizeLoopWorktree).mockReturnValue(new Promise<void>((resolve, reject) => {
      finish = (error) => (error ? reject(error) : resolve());
    }));
    terminate('loop-isolated', 'wt-1');

    let settled = false;
    const waiting = awaitLoopWorktreeFinalization('loop-isolated').then(() => { settled = true; });
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    finish(new Error('git exploded'));
    await waiting;
    expect(settled).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(awaitLoopWorktreeFinalization('loop-isolated')).resolves.toBeUndefined();
  });
});
