import { describe, expect, it, vi } from 'vitest';
import { StorageCleanupService, type StorageCleanupDependencies } from './storage-cleanup-service';
import type { LedgerStorageStats } from '../conversation-ledger/ledger-space-reclaim';
function fixture() {
  const stats: LedgerStorageStats = { pageSize: 4096, pageCount: 10, freePages: 0, autoVacuum: 0, databaseBytes: 40960, freeBytes: 0, liveBytes: 40960, providerEvents: { lowestRowid: 1, highestRowid: 2, oldestCreatedAt: 1, newestCreatedAt: 2, estimatedRows: 2, averageRowBytes: 100, estimatedBytes: 200 } };
  const backups = [{ name: 'new.db', bytes: 10, createdAt: 20 }, { name: 'old.db', bytes: 20, createdAt: 10 }];
  const removeBackup = vi.fn(() => ({ deleted: 1, bytesFreed: 20, failed: 0 }));
  let now = 100;
  const deps: StorageCleanupDependencies = {
    getLedgerStats: async () => stats,
    pruneEvents: vi.fn(async () => 0), rebuildLedger: vi.fn(async () => ({ bytesFreed: 10 })),
    listBackups: () => backups, removeBackup, isRlmMaintenanceRunning: () => false,
    listRecords: async () => [], removeRecords: async () => 0,
    getAvailableDiskBytes: async () => 10 ** 12, now: () => now,
  };
  return { service: new StorageCleanupService(deps), deps, stats, backups, removeBackup, advance: () => { now += 600_000; } };
}
describe('ask-first disk cleanup', () => {
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
  it.each(['session-records', 'activity-logs'] as const)('rechecks %s candidates before deleting', async target => {
    const f = fixture();
    const item = { path: '/fixture/old.json', bytes: 7, modifiedAt: 1, changedAt: 1, inode: 1 };
    f.deps.listRecords = async () => [item];
    f.deps.removeRecords = vi.fn(async () => 1);
    const preview = await f.service.preview(target);
    item.bytes++;
    await expect(f.service.run(target, preview.previewId)).rejects.toThrow();
    expect(f.deps.removeRecords).not.toHaveBeenCalled();
  });
});
