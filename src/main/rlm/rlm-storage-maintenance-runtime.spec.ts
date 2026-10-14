import { describe, expect, it, vi } from 'vitest';
import { RlmStorageMaintenanceService } from './rlm-storage-maintenance';
import { listBackupSets, pruneOldBackups } from './rlm-backup-retention';
import { initializeRlmStorageMaintenance, _resetRlmStorageMaintenanceForTesting, getProtectedRlmSessionIds } from './rlm-storage-maintenance-runtime';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-test-user-data' } }));
vi.mock('./rlm-storage-maintenance', () => ({ RlmStorageMaintenanceService: vi.fn(() => ({})) }));
vi.mock('./rlm-storage-maintenance-database', () => ({ RlmMaintenanceDatabaseAdapter: vi.fn(() => ({})) }));
vi.mock('./rlm-backup-retention', () => ({ listBackupSets: vi.fn(() => []), pruneOldBackups: vi.fn() }));
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: vi.fn() }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => ({ setMaintenanceGate: vi.fn() }) }));

describe('getProtectedRlmSessionIds', () => {
  it('wires backup enumeration and selected names to the managed backup folder', () => {
    _resetRlmStorageMaintenanceForTesting();
    initializeRlmStorageMaintenance({ getAllInstances: () => [] } as never);
    const deps = vi.mocked(RlmStorageMaintenanceService).mock.calls[0][0];
    deps.listBackups();
    const selected = new Set(['old.db']);
    deps.pruneBackups(2, selected);
    expect(listBackupSets).toHaveBeenCalledWith(deps.backupDirectory);
    expect(pruneOldBackups).toHaveBeenCalledWith(deps.backupDirectory, 2, selected);
    _resetRlmStorageMaintenanceForTesting();
  });

  it('retains the identity used to create a live RLM store after provider session rotation', () => {
    const protectedIds = getProtectedRlmSessionIds([{
      rlmStoreSessionId: 'store-session-original',
      sessionId: 'provider-session-current',
      providerSessionId: 'provider-session-current',
    }]);

    expect([...protectedIds]).toEqual([
      'store-session-original',
      'provider-session-current',
    ]);
  });
});
