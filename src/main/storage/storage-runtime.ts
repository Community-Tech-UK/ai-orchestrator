import { app, shell } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { getConversationLedgerService } from '../conversation-ledger/conversation-ledger-service';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import { listBackupSetsAsync, removeBackupSetByName } from '../rlm/rlm-backup-retention';
import { getRlmStorageMaintenance } from '../rlm/rlm-storage-maintenance-runtime';
import { getSessionContinuityManager } from '../session/session-continuity';
import { getHistoryManager } from '../history/history-manager';
import { listSessionStateCandidates, sessionStateHistoryIds, sessionStateIsAbsentFromHistory } from '../session/session-state-retention';
import { listSessionActivityLogCandidates } from '../session/session-activity-log-retention';
import { getSessionMutex } from '../session/session-mutex';
import { listLegacyAppData, trashLegacyAppData } from './legacy-app-data';
import { listAttachmentFolders, removeAttachmentSessions } from './attachments-folders';
import { listCodexStateOverview, removeCodexSafetyCopies } from './codex-safety-copies';
import { getAioCodexSessionsDir, getAioCodexStateDir } from '../cli/adapters/codex/codex-home-manager';
import { previewRtkHistoryTrim, trimRtkHistory } from '../cli/rtk/rtk-history-trim';
import { StorageCleanupService, type StorageCleanupDependencies } from './storage-cleanup-service';
import { removeStorageFilesWithReceipt, type StorageUnlinkState } from './storage-files';
import { StorageUsageService } from './storage-usage-service';

export function createStorageRuntime(getLiveIds: () => ReadonlySet<string>) {
  const root = app.getPath('userData');
  const backupDirectory = path.join(root, 'rlm/backups');
  const projectsRoot = path.join(root, 'projects');
  const codexBackupsDir = path.join(getAioCodexStateDir(), 'backups');
  const codexSessionsDir = getAioCodexSessionsDir();
  const protectedIds = () => new Set([...getLiveIds(), ...getSessionContinuityManager().getRetentionContext().dirtyIds]);
  const deps: StorageCleanupDependencies = {
    getLedgerStats: () => getConversationLedgerService().getLedgerStorageStats(),
    pruneEvents: (cutoff, limit) => getConversationLedgerService().pruneProviderEventCapturesBefore(cutoff, limit),
    rebuildLedger: () => getConversationLedgerService().rebuildLedgerStorage(),
    listBackups: () => listBackupSetsAsync(backupDirectory),
    removeBackup: name => removeBackupSetByName(backupDirectory, name),
    isRlmMaintenanceRunning: () => getRlmStorageMaintenance().isRunning(),
    getAvailableDiskBytes: async () => { const disk = await fs.statfs(root); return disk.bavail * disk.bsize; },
    listLegacyAppData: () => listLegacyAppData(app.getPath('appData'), root),
    trashLegacyAppData: target => trashLegacyAppData(target, targetPath => shell.trashItem(targetPath)),
    listAttachmentFolders: async now =>
      listAttachmentFolders(
        (await getRecentDirectoriesManager().getDirectories()).map(entry => entry.path),
        now, protectedIds,
      ),
    removeAttachmentSessions: sessions => removeAttachmentSessions(sessions, { getProtectedIds: protectedIds }),
    getCodexStateOverview: async () => listCodexStateOverview(codexBackupsDir, codexSessionsDir),
    removeCodexSafetyCopies: async copies => removeCodexSafetyCopies(codexBackupsDir, copies),
    getRtkHistoryPreview: async now => previewRtkHistoryTrim(undefined, { now: () => now }),
    trimRtkHistory: (now, dbPath) => trimRtkHistory(undefined, { dbPath, now: () => now }),
    listRecords: async (target, now) => {
      const continuity = getSessionContinuityManager();
      await continuity.waitForRecoveryDiscoveryReady();
      const { stateDir, metadataDir } = continuity.getRetentionContext();
      const history = getHistoryManager();
      await history.startupTasks;
      return target === 'session-records' ? listSessionStateCandidates(stateDir, metadataDir, protectedIds(), now, history.getEntries())
        : listSessionActivityLogCandidates(projectsRoot, protectedIds(), now);
    },
    removeRecords: async (target, files, onRemoved) => {
      const continuity = getSessionContinuityManager();
      const { stateDir, metadataDir } = continuity.getRetentionContext();
      const allowedRoots = target === 'session-records' ? [stateDir, metadataDir] : [projectsRoot];
      const receipt = { removed: 0, bytesFreed: 0 };
      const unlinkState: StorageUnlinkState = new Map();
      const groups = new Map<string, typeof files>();
      for (const file of files) {
        const id = file.instanceId!;
        const group = groups.get(id) ?? []; group.push(file); groups.set(id, group);
      }
      for (const [id, group] of groups) {
        const release = await getSessionMutex().acquire(id, 'storage-cleanup');
        try {
          if (target === 'session-records') {
            const stateFile = group.find(file => path.dirname(file.path) === stateDir);
            const sidecar = group.find(file => path.dirname(file.path) === metadataDir);
            if (!stateFile || !await sessionStateIsAbsentFromHistory(stateFile, sidecar, sessionStateHistoryIds(getHistoryManager().getEntries()))) throw new Error('A session is now in history. Review again.');
          }
          for (const file of group) {
            const result = await removeStorageFilesWithReceipt([file], allowedRoots, protectedIds, unlinkState);
            receipt.removed += result.removed;
            receipt.bytesFreed += result.bytesFreed;
            onRemoved(result.removed);
          }
          if (target === 'session-records') continuity.forgetRetainedSession(id);
        } finally { release(); }
      }
      return receipt;
    },
  };
  const cleanup = new StorageCleanupService(deps);
  const usage = new StorageUsageService({ ...deps, userDataRoot: root, getProgress: () => cleanup.getProgress() });
  return { cleanup, usage };
}
export type StorageRuntime = ReturnType<typeof createStorageRuntime>;
