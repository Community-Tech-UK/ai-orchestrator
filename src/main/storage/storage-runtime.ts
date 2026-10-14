import { app } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { getConversationLedgerService } from '../conversation-ledger/conversation-ledger-service';
import { listBackupSetsAsync, removeBackupSetByName } from '../rlm/rlm-backup-retention';
import { getRlmStorageMaintenance } from '../rlm/rlm-storage-maintenance-runtime';
import { getSessionContinuityManager } from '../session/session-continuity';
import { listSessionStateCandidates } from '../session/session-state-retention';
import { listSessionActivityLogCandidates } from '../session/session-activity-log-retention';
import { getSessionMutex } from '../session/session-mutex';
import { StorageCleanupService, type StorageCleanupDependencies } from './storage-cleanup-service';
import { removeStorageFiles } from './storage-files';
import { StorageUsageService } from './storage-usage-service';

export function createStorageRuntime(getLiveIds: () => ReadonlySet<string>) {
  const root = app.getPath('userData');
  const backupDirectory = path.join(root, 'rlm/backups');
  const projectsRoot = path.join(root, 'projects');
  const protectedIds = () => new Set([...getLiveIds(), ...getSessionContinuityManager().getRetentionContext().dirtyIds]);
  const deps: StorageCleanupDependencies = {
    getLedgerStats: () => getConversationLedgerService().getLedgerStorageStats(),
    pruneEvents: (cutoff, limit) => getConversationLedgerService().pruneProviderEventCapturesBefore(cutoff, limit),
    rebuildLedger: () => getConversationLedgerService().rebuildLedgerStorage(),
    listBackups: () => listBackupSetsAsync(backupDirectory),
    removeBackup: name => removeBackupSetByName(backupDirectory, name),
    isRlmMaintenanceRunning: () => getRlmStorageMaintenance().isRunning(),
    getAvailableDiskBytes: async () => { const disk = await fs.statfs(root); return disk.bavail * disk.bsize; },
    listRecords: async (target, now) => {
      const continuity = getSessionContinuityManager();
      await continuity.waitForRecoveryDiscoveryReady();
      const { stateDir, metadataDir } = continuity.getRetentionContext();
      return target === 'session-records' ? listSessionStateCandidates(stateDir, metadataDir, protectedIds(), now)
        : listSessionActivityLogCandidates(projectsRoot, protectedIds(), now);
    },
    removeRecords: async (target, files) => {
      const continuity = getSessionContinuityManager();
      const { stateDir, metadataDir } = continuity.getRetentionContext();
      let removed = 0;
      const groups = new Map<string, typeof files>();
      for (const file of files) {
        const id = file.instanceId!;
        const group = groups.get(id) ?? []; group.push(file); groups.set(id, group);
      }
      for (const [id, group] of groups) {
        const release = await getSessionMutex().acquire(id, 'storage-cleanup');
        try {
          removed += await removeStorageFiles(group, target === 'session-records' ? [stateDir, metadataDir] : [projectsRoot], protectedIds);
          if (target === 'session-records') continuity.forgetRetainedSession(id);
        } finally { release(); }
      }
      return removed;
    },
  };
  const cleanup = new StorageCleanupService(deps);
  const usage = new StorageUsageService({ ...deps, userDataRoot: root, getProgress: () => cleanup.getProgress() });
  return { cleanup, usage };
}
export type StorageRuntime = ReturnType<typeof createStorageRuntime>;
