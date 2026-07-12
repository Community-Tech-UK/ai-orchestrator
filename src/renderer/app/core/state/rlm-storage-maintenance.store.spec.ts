import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RLM_STORAGE_HARD_LIMIT_BYTES,
  RLM_STORAGE_WARNING_BYTES,
  type RlmMaintenanceProgress,
} from '../../../../shared/types/rlm-maintenance.types';
import { RlmStorageMaintenanceStore } from './rlm-storage-maintenance.store';

describe('RlmStorageMaintenanceStore', () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('loads health and keeps warning dismissal renderer-session local', async () => {
    const store = new RlmStorageMaintenanceStore();
    await store.refreshHealth();
    expect(store.health()?.databaseSizeBytes).toBe(RLM_STORAGE_WARNING_BYTES);
    expect(store.visible()).toBe(true);
    store.dismiss();
    expect(store.visible()).toBe(false);
    expect(api.rlmStorageGetHealth).toHaveBeenCalledOnce();
  });

  it('does not let warning dismissal hide critical storage health', async () => {
    const store = new RlmStorageMaintenanceStore();
    await store.refreshHealth();
    store.dismiss();
    api.rlmStorageGetHealth.mockResolvedValueOnce({
      success: true,
      data: { ...health(), level: 'critical', databaseSizeBytes: RLM_STORAGE_HARD_LIMIT_BYTES },
    });
    await store.refreshHealth();
    expect(store.visible()).toBe(true);
  });

  it('previews, runs once, receives progress, and refreshes final health', async () => {
    let release!: () => void;
    api.rlmStorageRunMaintenance.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ success: true, data: successResult() });
    }));
    const store = new RlmStorageMaintenanceStore();
    await store.openPreview('loop-1');
    expect(store.modalOpen()).toBe(true);
    expect(store.preview()?.eligibleStoreCount).toBe(2);

    const first = store.run('loop-1');
    void store.run('loop-1');
    api.emitProgress({ operationId: 'op-1', stage: 'pruning' } as RlmMaintenanceProgress);
    expect(store.progress()?.stage).toBe('pruning');
    expect(api.rlmStorageRunMaintenance).toHaveBeenCalledOnce();
    release();
    await first;
    expect(store.result()?.status).toBe('success');
    expect(api.rlmStorageGetHealth).toHaveBeenCalledOnce();
  });

  it('surfaces failed IPC and restores an active operation', async () => {
    api.rlmStoragePreviewMaintenance.mockResolvedValue({
      success: false,
      error: { code: 'FAILED', message: 'preview unavailable', timestamp: 1 },
    });
    api.rlmStorageGetMaintenanceStatus.mockResolvedValue({
      success: true,
      data: { status: 'running', operationId: 'op-1', stage: 'backing-up', startedAt: 1 },
    });
    const store = new RlmStorageMaintenanceStore();
    await store.openPreview();
    expect(store.error()).toBe('preview unavailable');
    await store.restoreStatus();
    expect(store.result()?.status).toBe('running');
    expect(store.busy()).toBe(true);
    expect(store.modalOpen()).toBe(true);
  });
});

function makeApi() {
  let progress: ((value: RlmMaintenanceProgress) => void) | null = null;
  return {
    rlmStorageGetHealth: vi.fn(async () => ({ success: true, data: health() })),
    rlmStoragePreviewMaintenance: vi.fn(async () => ({ success: true, data: preview() })),
    rlmStorageRunMaintenance: vi.fn(async () => ({ success: true, data: successResult() })),
    rlmStorageGetMaintenanceStatus: vi.fn(async () => ({ success: true, data: null })),
    onRlmStorageMaintenanceProgress: vi.fn((callback: (value: RlmMaintenanceProgress) => void) => {
      progress = callback;
      return () => { progress = null; };
    }),
    emitProgress: (value: RlmMaintenanceProgress) => progress?.(value),
  };
}

function health() {
  return {
    level: 'warning' as const,
    databaseSizeBytes: RLM_STORAGE_WARNING_BYTES,
    externalContentSizeBytes: 10,
    reclaimableDatabaseBytes: 20,
    warningThresholdBytes: RLM_STORAGE_WARNING_BYTES,
    hardLimitBytes: RLM_STORAGE_HARD_LIMIT_BYTES,
    maintenanceRunning: false,
    checkedAt: 1,
  };
}

function preview() {
  return {
    databaseSizeBytes: RLM_STORAGE_WARNING_BYTES,
    externalContentSizeBytes: 10,
    reclaimableDatabaseBytes: 20,
    eligibleStoreCount: 2,
    protectedLiveStoreCount: 1,
    protectedCodebaseAutoStoreCount: 1,
    cutoffTimestamp: 1,
    retentionDays: 60,
    backupDirectory: '/backups',
    canRun: true,
    generatedAt: 1,
  };
}

function successResult() {
  return {
    status: 'success' as const,
    operationId: 'op-1',
    storesDeleted: 2,
    databaseSizeBeforeBytes: 100,
    databaseSizeAfterBytes: 50,
    externalContentSizeBeforeBytes: 10,
    externalContentSizeAfterBytes: 0,
    verifiedBytesReclaimed: 60,
    backupPath: '/backups/verified.db',
    externalContentCleanupFailures: 0,
    loopResumed: true,
    databaseHealthy: true,
    completedAt: 2,
  };
}
