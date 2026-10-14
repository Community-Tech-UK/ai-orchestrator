import { createHash } from 'crypto';
import { setImmediate as yieldToMain } from 'timers/promises';
import { CleanupTicketStore } from './cleanup-ticket';
import type { StorageFile } from './storage-files';
import type { LedgerStorageStats } from '../conversation-ledger/ledger-space-reclaim';
import type { StorageCleanupItem, StorageCleanupPreview, StorageCleanupProgress, StorageCleanupResult, StorageCleanupTarget } from '../../shared/types/storage.types';
import { getLogger } from '../logging/logger';
const logger = getLogger('StorageCleanup');

export interface StorageCleanupDependencies {
  getLedgerStats(): Promise<LedgerStorageStats>;
  pruneEvents(before: number, limit: number): Promise<number>;
  rebuildLedger(): Promise<{ bytesFreed: number }>;
  listBackups(): { name: string; bytes: number; createdAt: number }[] | Promise<{ name: string; bytes: number; createdAt: number }[]>;
  removeBackup(name: string): { deleted: number; bytesFreed: number; failed: number };
  isRlmMaintenanceRunning(): boolean;
  listRecords(target: 'session-records' | 'activity-logs', now: number): Promise<StorageFile[]>;
  removeRecords(target: 'session-records' | 'activity-logs', files: StorageFile[], now: number): Promise<number>;
  getAvailableDiskBytes(): Promise<number>;
  now?: () => number;
}
interface CandidateSnapshot {
  items: StorageCleanupItem[];
  binding: unknown;
  files?: StorageFile[];
  stats?: LedgerStorageStats;
  keptBackup?: StorageCleanupItem;
}
export class StorageCleanupService {
  private readonly now: () => number;
  private readonly tickets: CleanupTicketStore;
  private readonly previews = new Map<string, { target: StorageCleanupTarget; cutoff: number }>();
  private progress: StorageCleanupProgress | null = null;
  constructor(private readonly deps: StorageCleanupDependencies) {
    this.now = deps.now ?? Date.now;
    this.tickets = new CleanupTicketStore(this.now);
  }
  getProgress(): StorageCleanupProgress | null { return this.progress ? { ...this.progress } : null; }

  async preview(target: StorageCleanupTarget): Promise<StorageCleanupPreview> {
    const cutoff = this.now();
    const snapshot = await this.snapshot(target, cutoff);
    const bytes = target === 'event-record-shrink' ? snapshot.stats!.freeBytes : snapshot.items.reduce((sum, item) => sum + item.bytes, 0);
    const estimatedCount = target === 'event-record' ? snapshot.stats!.providerEvents.estimatedRows
      : snapshot.files ? new Set(snapshot.files.map(file => file.instanceId ?? file.path)).size : snapshot.items.length;
    const dates = snapshot.items.map(item => item.createdAt);
    const consequence = {
      'event-record': 'This removes the detailed debug record of AI messages. Harness does not use it. Developer scripts that replay captured messages will find nothing until you switch the record on again. This cannot be undone. The conversation file stays the same size until you also choose Shrink the file.',
      'event-record-shrink': 'Harness will rebuild the conversation file. While it runs, Harness cannot save new conversation records; your sessions keep running and the records are saved afterwards. Nothing in your conversation history is removed.',
      'rlm-backups': 'These are copies Harness made before earlier clean-ups. Your newest backup stays. Deleted backups cannot be brought back.',
      'session-records': 'These are saved states of sessions last saved more than 30 days ago. Harness could use them to put a session back exactly where it was. After removal, those sessions cannot be restored from these records. This cannot be undone.',
      'activity-logs': 'These are logs last changed more than 30 days ago. Harness does not read them. This cannot be undone.',
    }[target];
    for (const [id, old] of this.previews) if (old.cutoff + 600_000 <= cutoff) this.previews.delete(id);
    if (this.previews.size >= 1000) this.previews.delete(this.previews.keys().next().value!);
    const previewId = this.tickets.issueTicket({ target, itemsHash: hash(snapshot.binding) });
    this.previews.set(previewId, { target, cutoff });
    const stats = snapshot.stats;
    return { previewId, target, items: snapshot.items, bytes, estimatedCount,
      oldestAt: target === 'event-record' ? stats!.providerEvents.oldestCreatedAt : dates.length ? Math.min(...dates) : null,
      newestAt: target === 'event-record' ? stats!.providerEvents.newestCreatedAt : dates.length ? Math.max(...dates) : null,
      consequence, reversible: false, keptBackup: snapshot.keptBackup,
      ...(target === 'event-record-shrink' ? { liveBytes: stats!.liveBytes,
        requiredDiskBytes: stats!.liveBytes * 2 + 1024 ** 3, availableDiskBytes: await this.deps.getAvailableDiskBytes() } : {}),
    };
  }

  async run(target: StorageCleanupTarget, previewId: string): Promise<StorageCleanupResult> {
    if (this.progress?.running) throw new Error('Harness is busy with another clean-up.');
    const preview = this.previews.get(previewId);
    if (!preview || preview.target !== target) throw new Error('Review this clean-up first.');
    this.progress = { target, removed: 0, estimatedTotal: 0, running: true };
    try {
      const snapshot = await this.snapshot(target, preview.cutoff);
      this.tickets.consumeTicket(previewId, { target, itemsHash: hash(snapshot.binding) });
      this.previews.delete(previewId);
      this.progress.estimatedTotal = target === 'event-record' ? snapshot.stats!.providerEvents.estimatedRows : snapshot.items.length;
      let bytesFreed = 0;
      if (target === 'event-record') {
        let removed: number;
        do {
          removed = await this.deps.pruneEvents(preview.cutoff, 20_000);
          this.progress.removed += removed;
          await yieldToMain();
        } while (removed > 0);
      } else if (target === 'event-record-shrink') {
        bytesFreed = (await this.deps.rebuildLedger()).bytesFreed;
      } else if (target === 'rlm-backups') {
        // Synchronous removal and running check share the main-process turn with maintenance start.
        if (this.deps.isRlmMaintenanceRunning()) throw new Error('The learning database is being cleaned up. Try later.');
        for (const item of snapshot.items) {
          const result = this.deps.removeBackup(item.name);
          if (result.failed) throw new Error('A backup could not be removed. Check the backup paths before trying again.');
          this.progress.removed += result.deleted;
          bytesFreed += result.bytesFreed;
        }
      } else {
        this.progress.removed = await this.deps.removeRecords(target, snapshot.files!, preview.cutoff);
        bytesFreed = snapshot.items.reduce((sum, item) => sum + item.bytes, 0);
      }
      logger.info('Harness disk clean-up finished', { target, items: this.progress.removed, bytes: bytesFreed });
      return { target, removed: this.progress.removed, bytesFreed };
    } finally { this.progress.running = false; }
  }

  private async snapshot(target: StorageCleanupTarget, cutoff: number): Promise<CandidateSnapshot> {
    if (target === 'rlm-backups') {
      if (this.deps.isRlmMaintenanceRunning()) throw new Error('The learning database is being cleaned up. Try later.');
      const backups = await this.deps.listBackups();
      return { items: backups.slice(1), keptBackup: backups[0], binding: backups };
    }
    if (target === 'session-records' || target === 'activity-logs') {
      const files = await this.deps.listRecords(target, cutoff);
      return { files, items: files.map(file => ({ name: file.path, bytes: file.bytes, createdAt: file.modifiedAt })), binding: files };
    }
    const stats = await this.deps.getLedgerStats();
    if (target === 'event-record-shrink') {
      if (stats.freeBytes <= 5 * 1024 ** 3 || stats.freePages * 2 < stats.pageCount) throw new Error('Clear the old debug record first; more than 5 GiB and half the file must be free.');
      if (await this.deps.getAvailableDiskBytes() < stats.liveBytes * 2 + 1024 ** 3) throw new Error('There is not enough free disk space to shrink the file.');
      return { stats, items: [], binding: { pageCount: stats.pageCount, freePages: stats.freePages, autoVacuum: stats.autoVacuum } };
    }
    return { stats, items: [{ name: 'Debug record of AI messages', bytes: stats.providerEvents.estimatedBytes, createdAt: stats.providerEvents.oldestCreatedAt ?? cutoff }],
      binding: { low: stats.providerEvents.lowestRowid, high: stats.providerEvents.highestRowid, oldest: stats.providerEvents.oldestCreatedAt, newest: stats.providerEvents.newestCreatedAt } };
  }
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
