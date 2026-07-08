import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { createProviderDomain } from '../domains/provider.preload';
import { IPC_CHANNELS } from '../generated/channels';

describe('providerDomain local model inventory', () => {
  it('invokes the local model inventory channel', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, data: { models: [] } });
    const ipcRenderer = { invoke } as unknown as IpcRenderer;
    const domain = createProviderDomain(ipcRenderer, IPC_CHANNELS);

    await domain.getLocalModelInventory();

    expect(invoke).toHaveBeenCalledWith('models:local-model-inventory');
  });

  it('subscribes to local model inventory update pushes', () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const ipcRenderer = { on, removeListener } as unknown as IpcRenderer;
    const domain = createProviderDomain(ipcRenderer, IPC_CHANNELS);

    const cb = vi.fn();
    const unsubscribe = domain.onLocalModelInventoryUpdated(cb);

    expect(on).toHaveBeenCalledWith('models:local-model-inventory-updated', expect.any(Function));
    const handler = on.mock.calls[0][1] as (event: unknown, payload: { models: unknown[] }) => void;
    handler({}, { models: [] });
    expect(cb).toHaveBeenCalledWith({ models: [] });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('models:local-model-inventory-updated', handler);
  });
});
