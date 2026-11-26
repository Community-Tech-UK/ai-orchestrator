import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCleanupService, type StorageCleanupDependencies } from './storage-cleanup-service';
import { listLegacyAppData, trashLegacyAppData } from './legacy-app-data';
import { listAttachmentFolders, removeAttachmentSessions } from './attachments-folders';
import { listStorageFiles, removeStorageFilesWithReceipt } from './storage-files';
import type { LedgerStorageStats } from '../conversation-ledger/ledger-space-reclaim';
import { waitForChangeClockTick } from '../testing/change-clock.test-helpers';
function fixture() {
  const stats: LedgerStorageStats = { pageSize: 4096, pageCount: 10, freePages: 0, autoVacuum: 0, databaseBytes: 40960, freeBytes: 0, liveBytes: 40960, providerEvents: { lowestRowid: 1, highestRowid: 2, oldestCreatedAt: 1, newestCreatedAt: 2, estimatedRows: 2, averageRowBytes: 100, estimatedBytes: 200 } };
  const backups = [{ name: 'new.db', bytes: 10, createdAt: 20 }, { name: 'old.db', bytes: 20, createdAt: 10 }];
  const removeBackup = vi.fn(() => ({ deleted: 1, bytesFreed: 20, failed: 0 }));
  let now = 100;
  const deps: StorageCleanupDependencies = {
    getLedgerStats: async () => stats,
    pruneEvents: vi.fn(async () => 0), rebuildLedger: vi.fn(async () => ({ bytesFreed: 10 })),
    listBackups: () => backups, removeBackup, isRlmMaintenanceRunning: () => false,
    listRecords: async () => [], removeRecords: async () => ({ removed: 0, bytesFreed: 0 }),
    listLegacyAppData: async () => null, trashLegacyAppData: vi.fn(async () => undefined),
    listAttachmentFolders: async () => [], removeAttachmentSessions: vi.fn(async () => ({ removed: 0, bytesFreed: 0 })),
    getCodexStateOverview: async () => ({ backupBytes: 0, backupCount: 0, copies: [], sessionsBytes: 0 }),
    removeCodexSafetyCopies: vi.fn(async () => ({ removed: 0, bytesFreed: 0 })),
    getRtkHistoryPreview: async () => ({ available: false, dbPath: '/rtk/history.db', fileBytes: 0, commandsToRemove: 0, failuresToRemove: 0, oldestAt: null, newestAt: null, cutoffAt: 0, estimatedBytes: 0 }),
    trimRtkHistory: vi.fn(async () => ({ removedCommands: 0, removedFailures: 0, stoppedEarly: false })),
   
    getAvailableDiskBytes: async () => 10 ** 12, now: () => now,
  };
  return { service: new StorageCleanupService(deps), deps, stats, backups, removeBackup, advance: () => { now += 600_000; } };
}
describe('ask-first disk cleanup', () => {
  it('reports zero bytes when a previewed attachment copy is moved before deletion', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'storage-attachment-race-')));
    try {
      const project = join(root, 'project');
      const folder = join(project, '.claude-attachments');
      const copy = join(folder, 'old-copy');
      const retained = join(root, 'retained');
      await fs.mkdir(copy, { recursive: true });
      await fs.mkdir(retained);
      await fs.writeFile(join(copy, 'paste.txt'), Buffer.alloc(11));
      await fs.utimes(join(copy, 'paste.txt'), new Date(1), new Date(1));
      const f = fixture();
      f.deps.listAttachmentFolders = () => listAttachmentFolders([project], 100 * 86_400_000);
      f.deps.removeAttachmentSessions = async sessions => {
        await fs.rename(copy, join(retained, 'old-copy'));
        return removeAttachmentSessions(sessions);
      };
      const preview = await f.service.preview('claude-attachments');
      expect(preview.bytes).toBe(11);
      const result = await f.service.run('claude-attachments', preview.previewId);
      expect(result).toEqual({ target: 'claude-attachments', removed: 0, bytesFreed: 0 });
      expect((await fs.stat(join(retained, 'old-copy', 'paste.txt'))).size).toBe(11);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('counts only an unchanged attachment copy when another copy changed after review', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'storage-attachment-partial-')));
    try {
      const project = join(root, 'project');
      const folder = join(project, '.claude-attachments');
      for (const [name, bytes] of [['eligible', 7], ['changed', 11]] as const) {
        const copy = join(folder, name);
        await fs.mkdir(copy, { recursive: true });
        await fs.writeFile(join(copy, 'paste.txt'), Buffer.alloc(bytes));
        await fs.utimes(join(copy, 'paste.txt'), new Date(1), new Date(1));
      }
      const f = fixture();
      f.deps.listAttachmentFolders = () => listAttachmentFolders([project], 100 * 86_400_000);
      f.deps.removeAttachmentSessions = async sessions => {
        await fs.writeFile(join(folder, 'changed', 'paste.txt'), Buffer.alloc(13));
        return removeAttachmentSessions(sessions);
      };
      const preview = await f.service.preview('claude-attachments');
      expect(preview.bytes).toBe(18);
      const result = await f.service.run('claude-attachments', preview.previewId);
      expect(result).toEqual({ target: 'claude-attachments', removed: 1, bytesFreed: 7 });
      await expect(fs.stat(join(folder, 'eligible'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.stat(join(folder, 'changed', 'paste.txt'))).size).toBe(13);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('offers shrink for a small ledger once half its pages are free', async () => {
    const f = fixture();
    Object.assign(f.stats, { freeBytes: 20_480, freePages: 5 });
    const preview = await f.service.preview('event-record-shrink');
    expect(preview.bytes).toBe(20_480);
    expect(f.deps.rebuildLedger).not.toHaveBeenCalled();
  });
  it('rejects calls without a valid preview', async () => {
    const f = fixture();
    await expect(f.service.run('rlm-backups', '')).rejects.toThrow();
    await expect(f.service.run('rlm-backups', 'unknown')).rejects.toThrow();
    expect(f.removeBackup).not.toHaveBeenCalled();
  });
  it('removes only earlier backups and consumes the ticket once', async () => {
    const f = fixture();
    const preview = await f.service.preview('rlm-backups');
    expect(preview.items.map(item => item.name)).toEqual(['old.db']);
    expect(preview.keptBackup?.name).toBe('new.db');
    await f.service.run('rlm-backups', preview.previewId);
    expect(f.removeBackup).toHaveBeenCalledExactlyOnceWith('old.db');
    await expect(f.service.run('rlm-backups', preview.previewId)).rejects.toThrow();
  });
  it('rejects expiry, target mismatch, changed candidates and an active database cleanup', async () => {
    for (const kind of ['expiry', 'target', 'changed', 'running']) {
      const f = fixture();
      const preview = await f.service.preview('rlm-backups');
      if (kind === 'expiry') f.advance();
      if (kind === 'changed') f.backups[1].bytes++;
      if (kind === 'running') f.deps.isRlmMaintenanceRunning = () => true;
      await expect(f.service.run(kind === 'target' ? 'event-record' : 'rlm-backups', preview.previewId)).rejects.toThrow();
      expect(f.removeBackup).not.toHaveBeenCalled();
    }
  });
  it('returns busy for a concurrent cleanup and reports direct progress', async () => {
    const f = fixture();
    let release!: () => void;
    f.deps.pruneEvents = vi.fn(() => new Promise<number>(resolve => { release = () => resolve(0); }));
    const preview = await f.service.preview('event-record');
    const running = f.service.run('event-record', preview.previewId);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(f.service.getProgress()?.running).toBe(true);
    await expect(f.service.run('event-record', preview.previewId)).rejects.toThrow(/busy/);
    release();
    await running;
  });
  it('only offers rebuild with half the pages free and enough disk', async () => {
    const f = fixture();
    await expect(f.service.preview('event-record-shrink')).rejects.toThrow();
    Object.assign(f.stats, { freeBytes: 6 * 1024 ** 3, freePages: 6, pageCount: 10 });
    const preview = await f.service.preview('event-record-shrink');
    expect(preview.requiredDiskBytes).toBe(2 * f.stats.liveBytes + 1024 ** 3);
    f.deps.getAvailableDiskBytes = async () => 0;
    await expect(f.service.run('event-record-shrink', preview.previewId)).rejects.toThrow();
  });
  it('distinguishes identical filenames in different cleanup directories', async () => {
    const f = fixture();
    f.deps.listRecords = async () => [
      { path: '/fixture/states/old.json', bytes: 1, modifiedAt: 1, changedAt: 1, inode: 1 },
      { path: '/fixture/recovery-metadata/old.json', bytes: 1, modifiedAt: 1, changedAt: 1, inode: 2 },
    ];
    const preview = await f.service.preview('session-records');
    expect(new Set(preview.items.map(item => item.name)).size).toBe(2);
  });
  it.each(['session-records', 'activity-logs'] as const)('counts %s files consistently with the list and progress', async target => {
    const f = fixture(); const files = [
      { path: '/fixture/state.json', instanceId: 'fixture-session', bytes: 1, modifiedAt: 1, changedAt: 1, inode: 1 },
      { path: '/fixture/metadata.json', instanceId: 'fixture-session', bytes: 1, modifiedAt: 1, changedAt: 1, inode: 2 },
    ];
    f.deps.listRecords = async () => files; f.deps.removeRecords = async (_target, files, onRemoved) => { files.forEach(() => onRemoved(1)); return { removed: files.length, bytesFreed: 2 }; };
    const preview = await f.service.preview(target);
    expect(preview.estimatedCount).toBe(2); expect(preview.items).toHaveLength(2);
    await f.service.run(target, preview.previewId);
    expect(f.service.getProgress()).toMatchObject({ removed: 2, estimatedTotal: 2, running: false });
  });
  it.each(['session-records', 'activity-logs'] as const)('rechecks %s candidates before deleting', async target => {
    const f = fixture();
    const item = { path: '/fixture/old.json', bytes: 7, modifiedAt: 1, changedAt: 1, inode: 1 };
    f.deps.listRecords = async () => [item];
    f.deps.removeRecords = vi.fn(async () => ({ removed: 1, bytesFreed: 7 }));
    const preview = await f.service.preview(target);
    item.bytes++;
    await expect(f.service.run(target, preview.previewId)).rejects.toThrow();
    expect(f.deps.removeRecords).not.toHaveBeenCalled();
  });
  it('uses actual file deletion bytes for old record cleanup', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'storage-record-receipt-')));
    try {
      await fs.writeFile(join(root, 'record.jsonl'), Buffer.alloc(7));
      await fs.writeFile(join(root, 'empty.jsonl'), '');
      const f = fixture();
      f.deps.listRecords = () => listStorageFiles(root, false);
      f.deps.removeRecords = (_target, files) => removeStorageFilesWithReceipt(files, [root], () => new Set());
      const preview = await f.service.preview('activity-logs');
      expect(preview.estimatedCount).toBe(2);
      expect(preview.bytes).toBe(7);
      const result = await f.service.run('activity-logs', preview.previewId);
      expect(result).toEqual({ target: 'activity-logs', removed: 2, bytesFreed: 7 });
      expect(await fs.readdir(root)).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('reports a partial old-record receipt without assigning preview bytes to an unknown file', async () => {
    const f = fixture();
    f.deps.listRecords = async () => [
      { path: '/fixture/first.jsonl', bytes: 7, modifiedAt: 1, changedAt: 1, inode: 1 },
      { path: '/fixture/second.jsonl', bytes: 11, modifiedAt: 1, changedAt: 1, inode: 2 },
    ];
    f.deps.removeRecords = async () => ({ removed: 1, bytesFreed: 7 });
    const preview = await f.service.preview('activity-logs');
    expect(preview.bytes).toBe(18);
    expect(await f.service.run('activity-logs', preview.previewId))
      .toEqual({ target: 'activity-logs', removed: 1, bytesFreed: 7 });
  });
  it('offers the legacy data folder and moves it to the Bin only through a ticket', async () => {
    const f = fixture();
    const trashLegacyAppData = vi.fn(async () => undefined);
    f.deps.listLegacyAppData = async () => ({ path: '/appData/claude-orchestrator', name: 'claude-orchestrator', bytes: 11, files: 2, newestModified: 50, generation: 'fixture-generation' });
    f.deps.trashLegacyAppData = trashLegacyAppData;
    const preview = await f.service.preview('legacy-app-data');
    expect(preview.items.map(item => item.name)).toEqual(['claude-orchestrator']);
    expect(preview.bytes).toBe(11);
    await f.service.run('legacy-app-data', preview.previewId);
    expect(trashLegacyAppData).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: '/appData/claude-orchestrator' }));
    await expect(f.service.run('legacy-app-data', preview.previewId)).rejects.toThrow();
  });
  it.each(['directory', 'nested-file', 'in-place'] as const)('rejects a same-aggregate legacy %s replacement through service and executor', async kind => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'storage-legacy-identity-')));
    try {
      const live = join(root, 'harness');
      const legacy = join(root, 'claude-orchestrator');
      const content = join(legacy, 'nested', 'settings.json');
      await fs.mkdir(join(legacy, 'nested'), { recursive: true });
      await fs.writeFile(content, 'aaaa');
      await fs.utimes(content, new Date(1000), new Date(1000));
      const f = fixture();
      const bin = vi.fn(async () => undefined);
      f.deps.listLegacyAppData = () => listLegacyAppData(root, live);
      f.deps.trashLegacyAppData = target => trashLegacyAppData(target, bin);
      const preview = await f.service.preview('legacy-app-data');
      expect(preview.bytes).toBe(4);
      waitForChangeClockTick();
      if (kind === 'directory') {
        await fs.rename(legacy, join(root, 'retained'));
        await fs.mkdir(join(legacy, 'nested'), { recursive: true });
      } else if (kind === 'nested-file') {
        await fs.rename(content, join(root, 'retained-file'));
      }
      await fs.writeFile(content, 'bbbb');
      await fs.utimes(content, new Date(1000), new Date(1000));
      await expect(f.service.run('legacy-app-data', preview.previewId)).rejects.toThrow(/Review again/);
      expect(bin).not.toHaveBeenCalled();
      expect(await fs.readFile(content, 'utf8')).toBe('bbbb');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('revalidates legacy contents at the final Bin boundary after ticket validation', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'storage-legacy-dispatch-')));
    try {
      const legacy = join(root, 'claude-orchestrator');
      await fs.mkdir(legacy);
      const content = join(legacy, 'settings.json');
      await fs.writeFile(content, 'aaaa');
      await fs.utimes(content, new Date(1000), new Date(1000));
      const f = fixture();
      const bin = vi.fn(async () => undefined);
      f.deps.listLegacyAppData = () => listLegacyAppData(root, join(root, 'harness'));
      f.deps.trashLegacyAppData = async target => {
        waitForChangeClockTick();
        await fs.writeFile(content, 'bbbb');
        await fs.utimes(content, new Date(1000), new Date(1000));
        return trashLegacyAppData(target, bin);
      };
      const preview = await f.service.preview('legacy-app-data');
      await expect(f.service.run('legacy-app-data', preview.previewId)).rejects.toThrow(/Review again/);
      expect(bin).not.toHaveBeenCalled();
      expect(await fs.readFile(content, 'utf8')).toBe('bbbb');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('reports no physical bytes freed when the legacy folder is retained in the Bin', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'storage-legacy-bin-')));
    try {
      const appData = join(root, 'app-data');
      const bin = join(root, 'Bin');
      const live = join(appData, 'harness');
      const legacy = join(appData, 'claude-orchestrator');
      await fs.mkdir(live, { recursive: true });
      await fs.mkdir(bin);
      await fs.mkdir(legacy);
      await fs.writeFile(join(legacy, 'settings.json'), Buffer.alloc(11));
      const f = fixture();
      f.deps.listLegacyAppData = () => listLegacyAppData(appData, live);
      f.deps.trashLegacyAppData = target => trashLegacyAppData(target, source => fs.rename(source, join(bin, 'claude-orchestrator')));

      const preview = await f.service.preview('legacy-app-data');
      expect(preview.bytes).toBe(11);
      const result = await f.service.run('legacy-app-data', preview.previewId);

      expect(result).toEqual({ target: 'legacy-app-data', removed: 1, bytesFreed: 0 });
      expect((await fs.stat(join(bin, 'claude-orchestrator', 'settings.json'))).size).toBe(11);
      await expect(fs.stat(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('reports a failed Bin move and removes nothing', async () => {
    const f = fixture();
    f.deps.listLegacyAppData = async () => ({ path: '/appData/claude-orchestrator', name: 'claude-orchestrator', bytes: 11, files: 2, newestModified: 50, generation: 'fixture-generation' });
    f.deps.trashLegacyAppData = vi.fn(async () => { throw new Error('trash failed'); });
    const preview = await f.service.preview('legacy-app-data');
    await expect(f.service.run('legacy-app-data', preview.previewId)).rejects.toThrow(/trash failed/);
  });
  it('lists attachment folders with session counts and clears only the listed copies', async () => {
    const f = fixture();
    const sessions = [
      { path: '/proj/.claude-attachments/old-1', bytes: 5, createdAt: 1, inode: 1, changedAt: 1 },
      { path: '/proj/.claude-attachments/old-2', bytes: 6, createdAt: 2, inode: 2, changedAt: 2 },
    ];
    f.deps.listAttachmentFolders = async () => [{ path: '/proj/.claude-attachments', bytes: 21, totalSessions: 3, clearable: sessions }];
    f.deps.removeAttachmentSessions = vi.fn(async (list) => ({ removed: list.length, bytesFreed: 11 }));
    const preview = await f.service.preview('claude-attachments');
    expect(preview.items).toEqual([{ name: '/proj/.claude-attachments', bytes: 11, createdAt: 2, sessions: 2 }]);
    expect(preview.estimatedCount).toBe(2);
    await f.service.run('claude-attachments', preview.previewId);
    expect(f.deps.removeAttachmentSessions).toHaveBeenCalledExactlyOnceWith(sessions);
  });
});

describe('codex, rtk and trace card targets (October follow-ups 5a-5c)', () => {
  it('accepts a fixed-date RTK cleanup after RTK has pruned older history itself', async () => {
    const f = fixture();
    const previewData = { available: true, dbPath: '/rtk/history.db', fileBytes: 600, commandsToRemove: 400, failuresToRemove: 100, oldestAt: 10, newestAt: 90, cutoffAt: 50, estimatedBytes: 240 };
    f.deps.getRtkHistoryPreview = async () => previewData;
    const preview = await f.service.preview('rtk-history');
    f.deps.getRtkHistoryPreview = async () => ({ ...previewData, commandsToRemove: 300, failuresToRemove: 50 });
    await expect(f.service.run('rtk-history', preview.previewId)).resolves.toMatchObject({ target: 'rtk-history', removed: 0 });
    expect(f.deps.trimRtkHistory).toHaveBeenCalledOnce();
  });
  it('rejects a codex-state-backups run without a preview and refuses a changed list', async () => {
    const f = fixture();
    await expect(f.service.run('codex-state-backups', 'unknown')).rejects.toThrow();
    const copies = [{ name: 'state_5-before-rollout-reconcile-20260101T000000000Z.sqlite', bytes: 10, createdAt: 1, group: 'old-reconcile' as const,
      identity: { device: 1, inode: 1, changedAt: 1, links: 1 } }];
    f.deps.getCodexStateOverview = async () => ({ backupBytes: 10, backupCount: 1, copies, sessionsBytes: 0 });
    const preview = await f.service.preview('codex-state-backups');
    expect(preview.items.map(item => item.name)).toEqual([copies[0].name]);
    f.deps.getCodexStateOverview = async () => ({ backupBytes: 10, backupCount: 1, copies: [], sessionsBytes: 0 });
    await expect(f.service.run('codex-state-backups', preview.previewId)).rejects.toThrow();
    expect(f.deps.removeCodexSafetyCopies).not.toHaveBeenCalled();
    f.deps.getCodexStateOverview = async () => ({ backupBytes: 10, backupCount: 1, copies, sessionsBytes: 0 });
    const again = await f.service.preview('codex-state-backups');
    await f.service.run('codex-state-backups', again.previewId);
    expect(f.deps.removeCodexSafetyCopies).toHaveBeenCalledExactlyOnceWith(copies);
  });
  it.each(['dbPath', 'cutoffAt', 'available'] as const)('rejects an rtk-history run without a preview and refuses a changed %s', async field => {
    const f = fixture();
    await expect(f.service.run('rtk-history', 'unknown')).rejects.toThrow();
    const previewData = { available: true, dbPath: '/rtk/history.db', fileBytes: 600, commandsToRemove: 400, failuresToRemove: 100, oldestAt: 10, newestAt: 90, cutoffAt: 50, estimatedBytes: 240 };
    f.deps.getRtkHistoryPreview = async () => previewData;
    const preview = await f.service.preview('rtk-history');
    expect(preview.estimatedCount).toBe(500);
    f.deps.getRtkHistoryPreview = async () => ({ ...previewData,
      ...(field === 'dbPath' ? { dbPath: '/rtk/other.db' }
        : field === 'cutoffAt' ? { cutoffAt: 51 } : { available: false }),
    });
    await expect(f.service.run('rtk-history', preview.previewId)).rejects.toThrow();
    expect(f.deps.trimRtkHistory).not.toHaveBeenCalled();
    f.deps.getRtkHistoryPreview = async () => previewData;
    const again = await f.service.preview('rtk-history');
    await f.service.run('rtk-history', again.previewId);
    expect(f.deps.trimRtkHistory).toHaveBeenCalledExactlyOnceWith(100, previewData.dbPath);
    await expect(f.service.run('rtk-history', again.previewId)).rejects.toThrow();
    const expired = await f.service.preview('rtk-history');
    f.advance();
    await expect(f.service.run('rtk-history', expired.previewId)).rejects.toThrow(/expired/);
    expect(f.deps.trimRtkHistory).toHaveBeenCalledOnce();
  });
  it('keeps the RTK preview cutoff fixed while the operator considers it', async () => {
    const f = fixture();
    let clock = Date.UTC(2026, 9, 20);
    const originalClock = clock;
    f.deps.now = () => clock;
    f.deps.getRtkHistoryPreview = vi.fn(async (at) => ({
      available: true, dbPath: '/fixture/history.db', fileBytes: 100,
      commandsToRemove: 1, failuresToRemove: 0, oldestAt: 0, newestAt: 1,
      cutoffAt: at - 30 * 86_400_000, estimatedBytes: 10,
    }));
    const service = new StorageCleanupService(f.deps);
    const preview = await service.preview('rtk-history');
    clock += 1000;
    await expect(service.run('rtk-history', preview.previewId)).resolves.toMatchObject({ removed: 0 });
    expect(f.deps.getRtkHistoryPreview).toHaveBeenNthCalledWith(1, originalClock);
    expect(f.deps.getRtkHistoryPreview).toHaveBeenNthCalledWith(2, originalClock);
    expect(f.deps.trimRtkHistory).toHaveBeenCalledExactlyOnceWith(originalClock, '/fixture/history.db');
  });
});
