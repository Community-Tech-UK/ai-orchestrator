import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import { createInstanceDomain } from '../domains/instance.preload';

describe('instance preload domain', () => {
  it('stamps the Computer Use override request through the preload auth wrapper', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const withAuth = vi.fn((payload: Record<string, unknown> = {}) => ({
      ...payload,
      ipcAuthToken: 'auth-token',
    }));
    const domain = createInstanceDomain(ipcRenderer, IPC_CHANNELS, withAuth);

    await domain.setComputerUseMode({
      instanceId: 'inst-1',
      mode: 'unrestricted',
    });

    expect(withAuth).toHaveBeenCalledOnce();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.INSTANCE_SET_COMPUTER_USE_MODE,
      {
        instanceId: 'inst-1',
        mode: 'unrestricted',
        ipcAuthToken: 'auth-token',
      },
    );
  });

  it('invokes compaction context recovery on the contract channel', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createInstanceDomain(ipcRenderer, IPC_CHANNELS);

    await domain.recoverCompactionContext({
      instanceId: 'inst-1',
      markerId: 'marker-1',
    });

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.INSTANCE_RECOVER_COMPACTION_CONTEXT,
      { instanceId: 'inst-1', markerId: 'marker-1' },
    );
  });
});
