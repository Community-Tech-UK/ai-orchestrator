import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import { createMemoryDomain } from '../domains/memory.preload';

describe('RLM storage maintenance preload surface', () => {
  it('uses validated request shapes and removes the progress listener', async () => {
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createMemoryDomain(ipcRenderer, IPC_CHANNELS);
    const progress = vi.fn();

    await domain.rlmStorageGetHealth();
    await domain.rlmStoragePreviewMaintenance('loop-1');
    await domain.rlmStorageRunMaintenance('loop-1');
    await domain.rlmStorageGetMaintenanceStatus();
    const unsubscribe = domain.onRlmStorageMaintenanceProgress(progress);

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.RLM_STORAGE_GET_HEALTH, {});
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.RLM_STORAGE_PREVIEW_MAINTENANCE,
      { loopRunId: 'loop-1' },
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      3,
      IPC_CHANNELS.RLM_STORAGE_RUN_MAINTENANCE,
      { loopRunId: 'loop-1' },
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      4,
      IPC_CHANNELS.RLM_STORAGE_GET_MAINTENANCE_STATUS,
      {},
    );
    const listener = vi.mocked(ipcRenderer.on).mock.calls[0][1];
    listener({} as never, { operationId: 'op-1', stage: 'pruning' });
    expect(progress).toHaveBeenCalledWith({ operationId: 'op-1', stage: 'pruning' });
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.RLM_STORAGE_MAINTENANCE_PROGRESS,
      listener,
    );
  });
});
