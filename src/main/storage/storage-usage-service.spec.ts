import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StorageUsageService } from './storage-usage-service';
import { listCodexStateOverview } from './codex-safety-copies';
import { mapStorageFiles } from './storage-files';
const stats = { pageSize: 4096, pageCount: 10, freePages: 0, autoVacuum: 0, databaseBytes: 40960, freeBytes: 0, liveBytes: 40960, providerEvents: { lowestRowid: 1, highestRowid: 2, oldestCreatedAt: 1, newestCreatedAt: 2, estimatedRows: 2, averageRowBytes: 100, estimatedBytes: 200 } };
let root: string;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
describe('disk usage measurement', () => {
  it('reports total size and a measured weekly change across restarts', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    const file = join(root, 'fixture');
    await fs.writeFile(file, Buffer.alloc(100));
    let now = 1;
    const create = () => new StorageUsageService({ userDataRoot: root, getLedgerStats: async () => stats, listBackups: () => [], listRecords: async () => [], listLegacyAppData: async () => null, listAttachmentFolders: async () => [], getCodexStateOverview: async () => ({ backupBytes: 0, backupCount: 0, copies: [], sessionsBytes: 0 }), getRtkHistoryPreview: async () => ({ available: false, dbPath: '/rtk/history.db', fileBytes: 0, commandsToRemove: 0, failuresToRemove: 0, oldestAt: null, newestAt: null, cutoffAt: 0, estimatedBytes: 0 }), getProgress: () => null, now: () => now });
    const first = await create().getUsage();
    expect(first.totalBytes).toBe(100);
    expect(first.weeklyGrowthBytes).toBeNull();
    await fs.writeFile(file, Buffer.alloc(300));
    now += 7 * 86_400_000;
    const weekly = await create().getUsage();
    expect(weekly.totalBytes).toBeGreaterThanOrEqual(300);
    expect(weekly.weeklyGrowthBytes).toBe(weekly.totalBytes! - 100);
  });
  it('measures fixture files and caches normal scans for sixty seconds', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    await fs.mkdir(join(root, 'conversation-ledger'));
    await fs.writeFile(join(root, 'conversation-ledger/conversation-ledger.db'), Buffer.alloc(40960));
    await fs.writeFile(join(root, 'codemem.sqlite'), Buffer.alloc(8192));
    await fs.mkdir(join(root, 'rlm/backups'), { recursive: true });
    await fs.writeFile(join(root, 'rlm/backups/fixture.db'), Buffer.alloc(4096));
    let now = 0;
    const getStats = vi.fn(async () => stats);
    const service = new StorageUsageService({ userDataRoot: root, getLedgerStats: getStats, listBackups: () => [{ name: 'fixture.db', bytes: 4096, createdAt: 1 }], listRecords: async () => [], listLegacyAppData: async () => null, listAttachmentFolders: async () => [], getCodexStateOverview: async () => ({ backupBytes: 0, backupCount: 0, copies: [], sessionsBytes: 0 }), getRtkHistoryPreview: async () => ({ available: false, dbPath: '/rtk/history.db', fileBytes: 0, commandsToRemove: 0, failuresToRemove: 0, oldestAt: null, newestAt: null, cutoffAt: 0, estimatedBytes: 0 }), getProgress: () => null, now: () => now });
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
      listBackups: () => [], listRecords: async () => [], listLegacyAppData: async () => null, listAttachmentFolders: async () => [], getCodexStateOverview: async () => ({ backupBytes: 0, backupCount: 0, copies: [], sessionsBytes: 0 }), getRtkHistoryPreview: async () => ({ available: false, dbPath: '/rtk/history.db', fileBytes: 0, commandsToRemove: 0, failuresToRemove: 0, oldestAt: null, newestAt: null, cutoffAt: 0, estimatedBytes: 0 }), getProgress: () => null });
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
      listBackups: () => [], listRecords: async () => [], listLegacyAppData: async () => null, listAttachmentFolders: async () => [], getCodexStateOverview: async () => ({ backupBytes: 0, backupCount: 0, copies: [], sessionsBytes: 0 }), getRtkHistoryPreview: async () => ({ available: false, dbPath: '/rtk/history.db', fileBytes: 0, commandsToRemove: 0, failuresToRemove: 0, oldestAt: null, newestAt: null, cutoffAt: 0, estimatedBytes: 0 }), getProgress: () => running ? { target: 'event-record', running: true, removed: 150, estimatedTotal: 200 } : null });
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
      listBackups: () => [], listRecords: async () => [], listLegacyAppData: async () => null, listAttachmentFolders: async () => [], getCodexStateOverview: async () => ({ backupBytes: 0, backupCount: 0, copies: [], sessionsBytes: 0 }), getRtkHistoryPreview: async () => ({ available: false, dbPath: '/rtk/history.db', fileBytes: 0, commandsToRemove: 0, failuresToRemove: 0, oldestAt: null, newestAt: null, cutoffAt: 0, estimatedBytes: 0 }), getProgress: () => null });
    expect((await service.getUsage()).reclaimableBytes).toBe(freed);
  });

  it('shows the legacy data folder and pasted attachments rows with their clearable bytes', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    const service = new StorageUsageService({ userDataRoot: root,
      getLedgerStats: async () => stats,
      listBackups: () => [], listRecords: async () => [],
      listLegacyAppData: async () => ({ path: '/appData/claude-orchestrator', name: 'claude-orchestrator', bytes: 11, files: 2, newestModified: 5, generation: 'fixture-generation' }),
      listAttachmentFolders: async () => [{ path: '/proj/.claude-attachments', bytes: 21, totalSessions: 3, clearable: [{ path: '/proj/.claude-attachments/old', bytes: 6, createdAt: 1, inode: 1, changedAt: 1 }] }],
      getCodexStateOverview: async () => ({ backupBytes: 0, backupCount: 0, copies: [], sessionsBytes: 0 }),
      getRtkHistoryPreview: async () => ({ available: false, dbPath: '/rtk/history.db', fileBytes: 0, commandsToRemove: 0, failuresToRemove: 0, oldestAt: null, newestAt: null, cutoffAt: 0, estimatedBytes: 0 }),
      getProgress: () => null });
    const usage = await service.getUsage();
    expect(usage.rows.find(row => row.id === 'legacy-app-data')).toMatchObject({ bytes: 11, reclaimableBytes: 11, target: 'legacy-app-data' });
    expect(usage.rows.find(row => row.id === 'claude-attachments')).toMatchObject({ bytes: 21, reclaimableBytes: 6, target: 'claude-attachments' });
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
  it('keeps the disk card available and refuses legacy cleanup after a scan error', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    await fs.writeFile(join(root, 'fixture'), 'kept');
    const service = new StorageUsageService({ userDataRoot: root,
      getLedgerStats: async () => stats, listBackups: () => [], listRecords: async () => [],
      listLegacyAppData: async () => { throw new Error('The old data folder could not be fully checked. Review again.'); },
      listAttachmentFolders: async () => [],
      getCodexStateOverview: async () => ({ backupBytes: 0, backupCount: 0, copies: [], sessionsBytes: 0 }),
      getRtkHistoryPreview: async () => ({ available: false, dbPath: '/fixture/history.db', fileBytes: 0,
        commandsToRemove: 0, failuresToRemove: 0, oldestAt: null, newestAt: null, cutoffAt: 0, estimatedBytes: 0 }), getProgress: () => null });
    const usage = await service.getUsage();
    expect(usage.totalBytes).toBe(4);
    expect(usage.rows.find(row => row.id === 'event-record')?.bytes).toBe(200);
    expect(usage.rows.find(row => row.id === 'legacy-app-data')).toMatchObject({ reclaimableBytes: 0, note: expect.stringContaining('could not be measured') });
    expect(usage.rows.find(row => row.id === 'legacy-app-data')?.target).toBeUndefined();
  });
});

describe('codex and rtk rows (October follow-ups 5a-5c)', () => {
  it('measures nested Codex session files without following links', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    const backups = join(root, 'backups');
    const sessions = join(root, 'sessions');
    await fs.mkdir(backups);
    await fs.mkdir(join(sessions, '2026/10/20'), { recursive: true });
    await fs.writeFile(join(sessions, '2026/10/20/session.jsonl'), 'test');
    await fs.writeFile(join(root, 'outside.jsonl'), 'not counted');
    await fs.symlink(join(root, 'outside.jsonl'), join(sessions, 'linked.jsonl'));
    const service = new StorageUsageService({ userDataRoot: root,
      getLedgerStats: async () => stats, listBackups: () => [], listRecords: async () => [],
      listLegacyAppData: async () => null, listAttachmentFolders: async () => [],
      getCodexStateOverview: async () => listCodexStateOverview(backups, sessions),
      getRtkHistoryPreview: async () => ({ available: false, dbPath: '/fixture/history.db',
        fileBytes: 0, commandsToRemove: 0, failuresToRemove: 0, oldestAt: null,
        newestAt: null, cutoffAt: 0, estimatedBytes: 0 }), getProgress: () => null });
    const row = (await service.getUsage()).rows.find(entry => entry.id === 'codex-session-files');
    expect(row).toMatchObject({ bytes: 4, reclaimableBytes: 0 });
    expect(row?.target).toBeUndefined();
  });
  it('shows Codex safety copies with clearable bytes, session files with no button, and the RTK range', async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'harness-usage-')));
    const service = new StorageUsageService({ userDataRoot: root,
      getLedgerStats: async () => stats, listBackups: () => [], listRecords: async () => [],
      listLegacyAppData: async () => null, listAttachmentFolders: async () => [],
      getCodexStateOverview: async () => ({
        backupBytes: 40_000, backupCount: 428,
        copies: [{ name: 'state_5-before-rollout-reconcile-20260101T000000000Z.sqlite', bytes: 300, createdAt: 1, group: 'old-reconcile',
          identity: { device: 1, inode: 1, changedAt: 1, links: 1 } }],
        sessionsBytes: 18_000,
      }),
      getRtkHistoryPreview: async () => ({ available: true, dbPath: '/rtk/history.db', fileBytes: 600_000_000, commandsToRemove: 400, failuresToRemove: 100, oldestAt: 10, newestAt: 90, cutoffAt: 50, estimatedBytes: 240_000_000 }),
      getProgress: () => null });
    const usage = await service.getUsage();
    const copiesRow = usage.rows.find(row => row.id === 'codex-state-backups');
    expect(usage.reclaimableBytes).toBe(200 + 300);
    expect(copiesRow).toMatchObject({ bytes: 40_000, reclaimableBytes: 300, target: 'codex-state-backups' });
    expect(copiesRow?.note).toContain('428');
    const sessionsRow = usage.rows.find(row => row.id === 'codex-session-files');
    expect(sessionsRow).toMatchObject({ bytes: 18_000, reclaimableBytes: 0 });
    expect(sessionsRow?.target).toBeUndefined();
    expect(sessionsRow?.note).toContain('resume Codex chats');
    const rtkRow = usage.rows.find(row => row.id === 'rtk-history');
    expect(rtkRow).toMatchObject({ bytes: 600_000_000, reclaimableBytes: 0, target: 'rtk-history' });
    expect(rtkRow?.note).toContain('90 days');
    expect(rtkRow?.note).toContain('file on disk keeps its size');
  });
});
