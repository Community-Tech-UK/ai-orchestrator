import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StorageUsageService } from './storage-usage-service';
import { mapStorageFiles } from './storage-files';
const stats = { pageSize: 4096, pageCount: 10, freePages: 0, autoVacuum: 0, databaseBytes: 40960, freeBytes: 0, liveBytes: 40960, providerEvents: { lowestRowid: 1, highestRowid: 2, oldestCreatedAt: 1, newestCreatedAt: 2, estimatedRows: 2, averageRowBytes: 100, estimatedBytes: 200 } };
let root: string;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
describe('disk usage measurement', () => {
  it('measures fixture files and caches normal scans for sixty seconds', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    await fs.mkdir(join(root, 'conversation-ledger'));
    await fs.writeFile(join(root, 'conversation-ledger/conversation-ledger.db'), Buffer.alloc(40960));
    await fs.writeFile(join(root, 'codemem.sqlite'), Buffer.alloc(8192));
    await fs.mkdir(join(root, 'rlm/backups'), { recursive: true });
    await fs.writeFile(join(root, 'rlm/backups/fixture.db'), Buffer.alloc(4096));
    let now = 0;
    const getStats = vi.fn(async () => stats);
    const service = new StorageUsageService({ userDataRoot: root, getLedgerStats: getStats, listBackups: () => [{ name: 'fixture.db', bytes: 4096, createdAt: 1 }], listRecords: async () => [], getProgress: () => null, now: () => now });
    const first = await service.getUsage();
    expect(first.rows.find(row => row.id === 'code-index')?.bytes).toBe(8192);
    expect(first.rows.find(row => row.id === 'rlm-backups')?.bytes).toBe(4096);
    await service.getUsage();
    expect(getStats).toHaveBeenCalledTimes(1);
    now = 60_000;
    await service.getUsage();
    expect(getStats).toHaveBeenCalledTimes(2);
  });
  it('does not repopulate an invalidated cache with a scan started before cleanup', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    let release!: () => void;
    let reads = 0;
    const changedStats = { ...stats, providerEvents: { ...stats.providerEvents, estimatedBytes: 0 } };
    const service = new StorageUsageService({ userDataRoot: root,
      getLedgerStats: async () => { reads++; if (reads === 1) { await new Promise<void>(done => { release = done; }); return stats; } return changedStats; },
      listBackups: () => [], listRecords: async () => [], getProgress: () => null });
    const oldScan = service.getUsage();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    service.invalidate();
    release();
    await oldScan;
    const current = await service.getUsage();
    expect(current.rows.find(row => row.id === 'event-record')?.bytes).toBe(0);
  });

  it('reads running progress and ledger numbers without using the sixty-second cache', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    let running = false;
    const getStats = vi.fn(async () => running ? { ...stats, providerEvents: { ...stats.providerEvents, estimatedBytes: 50 } } : stats);
    const service = new StorageUsageService({ userDataRoot: root, getLedgerStats: getStats,
      listBackups: () => [], listRecords: async () => [], getProgress: () => running ? { target: 'event-record', running: true, removed: 150, estimatedTotal: 200 } : null });
    await service.getUsage();
    running = true;
    const progress = await service.getUsage();
    expect(progress.progress?.removed).toBe(150);
    expect(progress.rows.find(row => row.id === 'event-record')?.bytes).toBe(50);
    expect(getStats).toHaveBeenCalledTimes(2);
  });

  it('counts existing freed pages in the amount that can be handed back', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    const freed = 6 * 1024 ** 3;
    const service = new StorageUsageService({ userDataRoot: root,
      getLedgerStats: async () => ({ ...stats, freeBytes: freed, providerEvents: { ...stats.providerEvents, estimatedBytes: 0 } }),
      listBackups: () => [], listRecords: async () => [], getProgress: () => null });
    expect((await service.getUsage()).reclaimableBytes).toBe(freed);
  });

  it('caps filesystem work concurrency', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapStorageFiles(Array.from({ length: 32 }, (_, i) => i), async value => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--; return value;
    }, 4);
    expect(peak).toBe(4);
    expect(result).toHaveLength(32);
  });
});
