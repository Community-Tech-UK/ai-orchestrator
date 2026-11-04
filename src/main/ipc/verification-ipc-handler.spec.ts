import { describe, expect, it, vi } from 'vitest';

const electronHarness = vi.hoisted(() => {
  // require(+.ts) avoids ESM TDZ: vi.hoisted runs before import bindings initialize
  const { createElectronHarness } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before imports initialize; a static import would hit the TDZ
    require('../testing/electron-mock.ts') as typeof import('../testing/electron-mock');
  return createElectronHarness({ ipc: 'registry' });
});
vi.mock('electron', () => electronHarness.module);

const createWorktree = vi.hoisted(() => vi.fn(async () => ({ id: 'wt-1' })));
vi.mock('../workspace/git/worktree-manager', () => ({ getWorktreeManager: () => ({ createWorktree }) }));

import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { registerVerificationHandlers } from './verification-ipc-handler';

describe('WORKTREE_CREATE', () => {
  it('always counts a Worktrees-page checkout toward the shared limit, whatever the payload asks', async () => {
    registerVerificationHandlers();
    const handler = electronHarness.ipcHandlers.get(IPC_CHANNELS.WORKTREE_CREATE)!;

    const response = await handler({} as never, {
      instanceId: 'instance-1',
      taskDescription: 'manual checkout',
      config: { countsTowardLimit: false, skipInstall: true },
    });

    expect(response).toMatchObject({ success: true });
    expect(createWorktree).toHaveBeenCalledWith('instance-1', 'manual checkout', expect.objectContaining({
      countsTowardLimit: true,
      skipInstall: true,
    }));
  });
});
