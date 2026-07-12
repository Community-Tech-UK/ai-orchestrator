import { describe, expect, it, vi } from 'vitest';
import {
  RLM_STALE_STORE_RETENTION_MS,
  RLM_STORAGE_HARD_LIMIT_BYTES,
  RLM_STORAGE_WARNING_BYTES,
} from '../../shared/types/rlm-maintenance.types';
import {
  RlmStorageMaintenanceService,
  type RlmMaintenanceDatabasePort,
} from './rlm-storage-maintenance';

const NOW = Date.UTC(2026, 6, 11, 12);

describe('RlmStorageMaintenanceService', () => {
  it.each([
    [RLM_STORAGE_WARNING_BYTES - 1, 'healthy'],
    [RLM_STORAGE_WARNING_BYTES, 'warning'],
    [RLM_STORAGE_HARD_LIMIT_BYTES, 'critical'],
  ] as const)('classifies %i database bytes as %s', (databaseSizeBytes, level) => {
    const { service } = makeService({ databaseSizeBytes });

    expect(service.getHealth()).toMatchObject({ level, databaseSizeBytes });
  });

  it('previews the exact 60-day cutoff and protects live and codebase-auto stores', () => {
    const { service, database } = makeService();
    database.inspect.mockReturnValue({
      eligibleStoreCount: 1,
      protectedLiveStoreCount: 2,
      protectedCodebaseAutoStoreCount: 3,
    });

    const preview = service.preview({ loopRunId: 'loop-1' });

    expect(database.inspect).toHaveBeenCalledWith(
      NOW - RLM_STALE_STORE_RETENTION_MS,
      new Set(['live-session']),
    );
    expect(preview).toMatchObject({
      cutoffTimestamp: NOW - RLM_STALE_STORE_RETENTION_MS,
      retentionDays: 60,
      eligibleStoreCount: 1,
      protectedLiveStoreCount: 2,
      protectedCodebaseAutoStoreCount: 3,
      canRun: true,
    });
  });

  it('allows compaction-only maintenance only when free pages are reclaimable', () => {
    const empty = makeService({ reclaimableDatabaseBytes: 0 });
    empty.database.inspect.mockReturnValue({
      eligibleStoreCount: 0,
      protectedLiveStoreCount: 0,
      protectedCodebaseAutoStoreCount: 0,
    });
    expect(empty.service.preview({}).canRun).toBe(false);

    const compactable = makeService({ reclaimableDatabaseBytes: 4096 });
    compactable.database.inspect.mockReturnValue({
      eligibleStoreCount: 0,
      protectedLiveStoreCount: 0,
      protectedCodebaseAutoStoreCount: 0,
    });
    expect(compactable.service.preview({}).canRun).toBe(true);
  });

  it('creates and verifies a content-inclusive backup before pruning', async () => {
    const { service, database, lifecycle } = makeService();

    const result = await service.run({ loopRunId: 'loop-1' });

    expect(result.status).toBe('success');
    expect(database.backup).toHaveBeenCalledWith(
      expect.stringMatching(/rlm-maintenance-20260711T120000000Z-op-1\.db$/),
      { includeContent: true },
    );
    expect(database.verifyBackup).toHaveBeenCalledBefore(database.prune);
    expect(database.prune).toHaveBeenCalledWith(
      NOW - RLM_STALE_STORE_RETENTION_MS,
      new Set(['live-session']),
    );
    expect(lifecycle.gateStates).toEqual([true, false]);
  });

  it('recomputes protected IDs immediately before transactional pruning', async () => {
    const protectedIds = [
      new Set(['preview-live']),
      new Set(['pre-backup-live']),
      new Set(['execution-live']),
    ];
    const { service, database } = makeService({}, {
      getProtectedSessionIds: vi.fn(() => protectedIds.shift() ?? new Set()),
    });

    service.preview({});
    await service.run({});

    expect(database.prune).toHaveBeenCalledWith(
      NOW - RLM_STALE_STORE_RETENTION_MS,
      new Set(['execution-live']),
    );
  });

  it('does not prune when backup creation or verification fails', async () => {
    const backupFailure = makeService();
    backupFailure.database.backup.mockRejectedValue(new Error('backup unavailable'));

    await expect(backupFailure.service.run({})).resolves.toMatchObject({
      status: 'failed',
      failedStage: 'backing-up',
      error: 'backup unavailable',
    });
    expect(backupFailure.database.prune).not.toHaveBeenCalled();

    const verifyFailure = makeService();
    verifyFailure.database.verifyBackup.mockImplementation(() => {
      throw new Error('integrity check failed');
    });
    const result = await verifyFailure.service.run({});
    expect(result).toMatchObject({ status: 'failed', failedStage: 'backing-up' });
    expect(result).not.toHaveProperty('backupPath');
    expect(verifyFailure.database.prune).not.toHaveBeenCalled();
  });

  it('returns the active operation without starting a second backup', async () => {
    let releaseBackup!: () => void;
    const backupBlocked = new Promise<void>((resolve) => { releaseBackup = resolve; });
    const { service, database } = makeService();
    database.backup.mockImplementation(async () => {
      await backupBlocked;
      return { dbBackupPath: '/backups/verified.db' };
    });

    const first = service.run({});
    await vi.waitFor(() => expect(database.backup).toHaveBeenCalledOnce());
    const second = await service.run({});

    expect(second).toMatchObject({ status: 'running', operationId: 'op-1' });
    expect(database.backup).toHaveBeenCalledOnce();
    releaseBackup();
    await first;
  });

  it.each([
    ['preparing', 'checkpoint'],
    ['pruning', 'prune'],
    ['compacting', 'vacuum'],
    ['reloading', 'reload'],
  ] as const)('reports a %s failure and releases the gate', async (stage, method) => {
    const { service, database, lifecycle } = makeService();
    if (method === 'reload') {
      lifecycle.reload.mockImplementation(() => { throw new Error(`${stage} failed`); });
    } else {
      database[method].mockImplementation(() => { throw new Error(`${stage} failed`); });
    }

    const result = await service.run({});

    expect(result).toMatchObject({ status: 'failed', failedStage: stage });
    expect(lifecycle.gateStates).toEqual([true, false]);
    expect(service.isRunning()).toBe(false);
  });

  it('does not claim reclaimed bytes when compaction fails', async () => {
    const { service, database } = makeService();
    database.vacuum.mockImplementation(() => { throw new Error('disk full'); });

    const result = await service.run({});

    expect(result).toMatchObject({ status: 'failed', failedStage: 'compacting' });
    expect(result).not.toHaveProperty('verifiedBytesReclaimed');
  });

  it('resumes the initiating loop only after a below-limit final measurement', async () => {
    const healthy = makeService();
    const healthyResult = await healthy.service.run({ loopRunId: 'loop-1' });
    expect(healthy.lifecycle.resumeLoop).toHaveBeenCalledWith('loop-1');
    expect(healthyResult).toMatchObject({ status: 'success', loopResumed: true, databaseHealthy: true });

    const critical = makeService({ databaseSizeBytes: RLM_STORAGE_HARD_LIMIT_BYTES });
    const criticalResult = await critical.service.run({ loopRunId: 'loop-1' });
    expect(critical.lifecycle.resumeLoop).not.toHaveBeenCalled();
    expect(criticalResult).toMatchObject({ status: 'success', loopResumed: false, databaseHealthy: false });
  });

  it('retains the verified terminal result for status recovery', async () => {
    const { service } = makeService();
    await service.run({});
    expect(service.getStatus()).toMatchObject({ status: 'success', operationId: 'op-1' });
  });

  it('does not begin another stage after shutdown is requested', async () => {
    const { service, database, lifecycle } = makeService();
    service.requestShutdown();
    const result = await service.run({});
    expect(result).toMatchObject({ status: 'failed', failedStage: 'preparing' });
    expect(database.checkpoint).not.toHaveBeenCalled();
    expect(lifecycle.gateStates).toEqual([true, false]);
  });
});

function makeService(
  measurementOverrides: Partial<ReturnType<RlmMaintenanceDatabasePort['measure']>> = {},
  dependencyOverrides: Partial<ConstructorParameters<typeof RlmStorageMaintenanceService>[0]> = {},
) {
  const measurement = {
    databaseSizeBytes: 1000,
    externalContentSizeBytes: 200,
    reclaimableDatabaseBytes: 100,
    ...measurementOverrides,
  };
  const database = {
    measure: vi.fn(() => measurement),
    inspect: vi.fn(() => ({
      eligibleStoreCount: 1,
      protectedLiveStoreCount: 0,
      protectedCodebaseAutoStoreCount: 0,
    })),
    checkpoint: vi.fn(),
    backup: vi.fn(async (targetPath: string) => ({ dbBackupPath: targetPath })),
    verifyBackup: vi.fn(),
    prune: vi.fn(() => ({ storesDeleted: 1, externalContentFiles: ['/content/a.txt'] })),
    deleteExternalContent: vi.fn(() => ({
      deleted: 1,
      missing: 0,
      refused: 0,
      failed: 0,
    })),
    vacuum: vi.fn(),
  } satisfies RlmMaintenanceDatabasePort;
  const gateStates: boolean[] = [];
  const lifecycle = {
    gateStates,
    reload: vi.fn(),
    resumeLoop: vi.fn(() => true),
  };
  const service = new RlmStorageMaintenanceService({
    database,
    getProtectedSessionIds: () => new Set(['live-session']),
    setMaintenanceGate: (active) => gateStates.push(active),
    reload: lifecycle.reload,
    loopExists: (loopRunId) => loopRunId === 'loop-1',
    resumeLoop: lifecycle.resumeLoop,
    now: () => NOW,
    createOperationId: () => 'op-1',
    backupDirectory: '/backups',
    ...dependencyOverrides,
  });
  return { service, database, lifecycle };
}
