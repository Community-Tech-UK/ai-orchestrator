import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { listBackupSets, pruneOldBackups } from './rlm-backup-retention';
import { RlmStorageMaintenanceService } from './rlm-storage-maintenance';

describe('RLM maintenance scratch backup protection', () => {
  it.each([false, true])('removes only the named older set when selected=%s', async (selected) => {
    const directory = mkdtempSync(join(tmpdir(), 'aio-maintenance-backups-'));
    const older = 'rlm-maintenance-20260712T113225474Z-old.db';
    const newer = 'rlm-maintenance-20260712T170553550Z-new.db';
    try {
      writeFileSync(join(directory, older), 'old');
      writeFileSync(join(directory, newer), 'new');
      const content = join(directory, older.replace(/\.db$/, '_content'));
      mkdirSync(content);
      writeFileSync(join(content, 'section.txt'), 'content');
      const measurement = { databaseSizeBytes: 100, externalContentSizeBytes: 0, reclaimableDatabaseBytes: 50 };
      const service = new RlmStorageMaintenanceService({
        database: {
          measure: () => measurement,
          inspect: () => ({ eligibleStoreCount: 0, protectedLiveStoreCount: 0, protectedCodebaseAutoStoreCount: 0 }),
          checkpoint: () => undefined,
          backup: async (targetPath) => { writeFileSync(targetPath, 'verified'); return { dbBackupPath: targetPath }; },
          verifyBackup: () => undefined,
          prune: () => ({ storesDeleted: 0, externalContentFiles: [] }),
          deleteExternalContent: () => ({ deleted: 0, missing: 0, refused: 0, failed: 0 }),
          vacuum: () => undefined,
        },
        getProtectedSessionIds: () => new Set(), setMaintenanceGate: () => undefined,
        reload: () => undefined, loopExists: () => false, resumeLoop: () => false,
        now: () => Date.UTC(2026, 9, 13), createOperationId: () => 'scratch', backupDirectory: directory,
        listBackups: () => listBackupSets(directory),
        pruneBackups: (keep, names) => pruneOldBackups(directory, keep, names),
      });
      expect(service.preview({}).backups.map((backup) => backup.wouldBeRemoved)).toEqual([false, true]);
      const result = await service.run(selected ? { deleteOldBackups: [older] } : {});
      expect(result).toMatchObject({ status: 'success', backupsPruned: selected ? 1 : 0, backupsKept: selected ? 1 : 2 });
      expect(listBackupSets(directory)).toHaveLength(selected ? 2 : 3);
      expect(existsSync(join(directory, older))).toBe(!selected);
      expect(existsSync(content)).toBe(!selected);
      expect(existsSync(join(directory, newer))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
