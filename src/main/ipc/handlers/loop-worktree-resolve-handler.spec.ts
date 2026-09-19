import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import type { LoopWorktreeLifecycle } from '../../../shared/types/loop.types';
import type { LoopWorktreeResolveStore } from '../../orchestration/loop-worktree-resolve';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { registerLoopWorktreeResolveHandler } from './loop-worktree-resolve-handler';

type RegisteredHandler = (event: unknown, payload: unknown) => Promise<unknown>;

function resolveHandler(): RegisteredHandler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.LOOP_RESOLVE_BLOCKED_WORKTREE,
  );
  if (!call) throw new Error('resolve handler not registered');
  return call[1] as RegisteredHandler;
}

const blocked: LoopWorktreeLifecycle = {
  managedByAio: true,
  phase: 'blocked',
  baseBranch: 'main',
  sessionBranch: 'task-loop',
  updatedAt: 1,
};

describe('LOOP_RESOLVE_BLOCKED_WORKTREE handler', () => {
  let updates: LoopWorktreeLifecycle[];

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    updates = [];
  });

  function register(lifecycle?: LoopWorktreeLifecycle): void {
    const store: LoopWorktreeResolveStore = {
      getWorktreeRecord: () => ({ worktreePath: null, lifecycle }),
      updateWorktreeLifecycle: (_id, next) => {
        updates.push(next);
      },
    };
    registerLoopWorktreeResolveHandler(store);
  }

  it('resolves a blocked run and returns the updated lifecycle', async () => {
    register(blocked);

    const response = await resolveHandler()({}, { loopRunId: 'loop-1' });

    expect(response).toEqual({ success: true, data: { lifecycle: updates[0] } });
    expect(updates[0]).toMatchObject({ phase: 'cleaned' });
  });

  it('reports a refusal with its reason and changes nothing', async () => {
    register({ ...blocked, phase: 'integrating' });

    const response = await resolveHandler()({}, { loopRunId: 'loop-1' });

    expect(response).toMatchObject({
      success: false,
      error: {
        code: 'LOOP_RESOLVE_BLOCKED_WORKTREE_REFUSED',
        message: 'Only a blocked managed worktree can be marked resolved',
      },
    });
    expect(updates).toEqual([]);
  });

  it('rejects a malformed payload', async () => {
    register(blocked);

    const response = await resolveHandler()({}, { loopRunId: '' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'LOOP_RESOLVE_BLOCKED_WORKTREE_FAILED' },
    });
    expect(updates).toEqual([]);
  });
});
