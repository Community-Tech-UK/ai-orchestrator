import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { registerWorktreeLeftoverHandlers } from './worktree-leftover-handlers';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
type Handler = (event: unknown, payload: unknown) => Promise<unknown>;
const channels = [IPC_CHANNELS.WORKTREE_LEFTOVERS_LIST, IPC_CHANNELS.WORKTREE_LEFTOVERS_PREVIEW,
  IPC_CHANNELS.WORKTREE_LEFTOVERS_REMOVE];
function handler(channel: string): Handler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error('Handler was not registered');
  return call[1] as Handler;
}
beforeEach(() => vi.clearAllMocks());
describe('leftover IPC boundary', () => {
  it('rejects untrusted senders before reading folders or executing any action', async () => {
    const owners = vi.fn(() => { throw new Error('Untrusted caller reached ownership read'); });
    registerWorktreeLeftoverHandlers({ getLiveSessions: () => [],
      reportDependencies: { owners, liveSessions: () => [] },
      ensureTrustedSender: () => ({ success: false, error: { code: 'UNTRUSTED_SENDER', message: 'Blocked', timestamp: 1 } }),
    });
    for (const channel of channels) {
      expect(await handler(channel)({}, undefined)).toMatchObject({ success: false, error: { code: 'UNTRUSTED_SENDER' } });
    }
    expect(owners).not.toHaveBeenCalled();
  });
  it('rejects malformed payloads and removal without a preview', async () => {
    registerWorktreeLeftoverHandlers({ getLiveSessions: () => [], reportDependencies: { owners: () => [], liveSessions: () => [] } });
    expect(await handler(IPC_CHANNELS.WORKTREE_LEFTOVERS_PREVIEW)({}, { repoRoot: '/repo', path: '/repo/old', action: 'all' }))
      .toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await handler(IPC_CHANNELS.WORKTREE_LEFTOVERS_REMOVE)({}, { repoRoot: '/repo', path: '/repo/old', action: 'remove-folder' }))
      .toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
  });
});
