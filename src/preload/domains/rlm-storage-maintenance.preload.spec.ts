import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../generated/channels';
import { createRlmStorageMaintenanceDomain } from './rlm-storage-maintenance.preload';

describe('RLM maintenance preload', () => {
  it('passes only set fields and optional selected backup names', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    const api = createRlmStorageMaintenanceDomain({ invoke } as never, IPC_CHANNELS);
    await api.rlmStorageRunMaintenance();
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.RLM_STORAGE_RUN_MAINTENANCE, {});
    await api.rlmStorageRunMaintenance('loop-1', ['old.db']);
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.RLM_STORAGE_RUN_MAINTENANCE, { loopRunId: 'loop-1', deleteOldBackups: ['old.db'] });
  });
});
