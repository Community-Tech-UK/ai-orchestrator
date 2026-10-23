import * as path from 'path';
import { listStorageFiles, type StorageFile } from './storage-files';
import type { StorageCleanupDependencies } from './storage-cleanup-service';
import type { StorageCleanupProgress, StorageUsage, StorageUsageRow } from '../../shared/types/storage.types';
import type { LedgerStorageStats } from '../conversation-ledger/ledger-space-reclaim';
import { recordStorageUsage } from './storage-usage-history';

interface StorageUsageDependencies {
  userDataRoot: string;
  getLedgerStats(): Promise<LedgerStorageStats>;
  listBackups: StorageCleanupDependencies['listBackups'];
  listRecords: StorageCleanupDependencies['listRecords'];
  getProgress(): StorageCleanupProgress | null;
  now?: () => number;
}
export class StorageUsageService {
  private cached: StorageUsage | null = null;
  private pending: Promise<StorageUsage> | null = null;
  private generation = 0;
  private pendingGeneration = -1;
  private readonly now: () => number;
  constructor(private readonly deps: StorageUsageDependencies) { this.now = deps.now ?? Date.now; }
  invalidate(): void { this.generation++; this.cached = null; }
  async getUsage(force = false): Promise<StorageUsage> {
    const progress = this.deps.getProgress();
    if (progress?.running) {
      const stats = await this.deps.getLedgerStats();
      const rows = (this.cached?.rows ?? []).map(row => row.id === 'event-record' ? this.eventRow(stats) : row);
      return { measuredAt: this.now(), rows, totalBytes: this.cached?.totalBytes, weeklyGrowthBytes: this.cached?.weeklyGrowthBytes ?? null, reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes + (row.diskReclaimableBytes ?? 0), 0), progress };
    }
    if (!force && this.cached && this.now() - this.cached.measuredAt < 60_000) return { ...this.cached, progress };
    if (!this.pending || this.pendingGeneration !== this.generation) {
      const generation = this.generation;
      this.pendingGeneration = generation;
      this.pending = this.scan(generation).finally(() => { if (this.pendingGeneration === generation) this.pending = null; });
    }
    return this.pending;
  }
  private eventRow(stats: LedgerStorageStats): StorageUsageRow {
    const estimatedBytes = Math.min(stats.liveBytes, stats.providerEvents.estimatedBytes);
    return { id: 'event-record', label: 'Debug record of AI messages', bytes: estimatedBytes,
      reclaimableBytes: estimatedBytes, diskReclaimableBytes: stats.freeBytes,
      target: 'event-record', shrinkAvailable: stats.freePages > 0 && stats.freePages * 2 >= stats.pageCount,
      note: 'Estimate. Clear the record first, then shrink the conversation file to hand space back to the disk.' };
  }
  private async scan(generation: number): Promise<StorageUsage> {
    const stats = await this.deps.getLedgerStats();
    // One bounded, link-safe walk instead of overlapping scans of 15,000+ files.
    const files = await listStorageFiles(this.deps.userDataRoot);
    const relative = (file: StorageFile) => path.relative(this.deps.userDataRoot, file.path).split(path.sep).join('/');
    const bytesAt = (prefix: string) => files.filter(file => relative(file) === prefix || relative(file).startsWith(prefix + '/') || relative(file) === prefix + '-wal' || relative(file) === prefix + '-shm').reduce((sum, file) => sum + file.bytes, 0);
    const now = this.now();
    const backups = await this.deps.listBackups();
    const oldBackupBytes = backups.slice(1).filter(set => set.createdAt < now - 30 * 86_400_000).reduce((sum, set) => sum + set.bytes, 0);
    const records = await this.deps.listRecords('session-records', now);
    const logs = await this.deps.listRecords('activity-logs', now);
    const logBytes = files.filter(file => /^projects\/[^/]+\/session-events\/[^/]+\.jsonl$/.test(relative(file))).reduce((sum, file) => sum + file.bytes, 0);
    const rows: StorageUsageRow[] = [this.eventRow(stats),
      { id: 'conversation-history', label: 'Conversation history (kept)', bytes: Math.max(0, stats.liveBytes - stats.providerEvents.estimatedBytes), reclaimableBytes: 0, note: 'Harness keeps this conversation history.' },
      { id: 'rlm-backups', label: 'Learning database backups', bytes: backups.reduce((sum, set) => sum + set.bytes, 0), reclaimableBytes: backups.slice(1).reduce((sum, set) => sum + set.bytes, 0), target: 'rlm-backups', note: `Review the old learning database copies to free space; your newest backup stays. Older than 30 days: ${oldBackupBytes.toLocaleString()} bytes.` },
      { id: 'learning-database', label: 'Learning database', bytes: bytesAt('rlm/rlm.db'), reclaimableBytes: 0, note: 'Harness tidies this itself.' },
      { id: 'session-records', label: 'Saved session records', bytes: bytesAt('session-continuity/states') + bytesAt('session-continuity/recovery-metadata'), reclaimableBytes: records.reduce((sum, file) => sum + file.bytes, 0), target: 'session-records', note: 'Only records older than 30 days, no longer in History, outside every live, hibernated or unsaved session.' },
      { id: 'activity-logs', label: 'Session activity logs', bytes: logBytes, reclaimableBytes: logs.reduce((sum, file) => sum + file.bytes, 0), target: 'activity-logs', note: 'Only logs older than 30 days, outside every live or hibernated session.' },
      { id: 'code-index', label: 'Code index', bytes: bytesAt('codemem.sqlite'), reclaimableBytes: 0, note: 'Harness tidies this itself.' },
      { id: 'evidence-store', label: 'Evidence store', bytes: bytesAt('conversation-evidence'), reclaimableBytes: 0, note: 'Harness tidies this itself.' },
      { id: 'codex-command-output', label: 'Codex command output', bytes: bytesAt('codex-command-output'), reclaimableBytes: 0, note: 'Harness tidies this itself.' },
    ];
    const accounted = bytesAt('conversation-ledger') + bytesAt('rlm/backups') + bytesAt('rlm/rlm.db') + bytesAt('session-continuity/states') + bytesAt('session-continuity/recovery-metadata') + logBytes + bytesAt('codemem.sqlite') + bytesAt('conversation-evidence') + bytesAt('codex-command-output');
    rows.push({ id: 'other', label: 'Everything else', bytes: Math.max(0, files.reduce((sum, file) => sum + file.bytes, 0) - accounted), reclaimableBytes: 0, note: 'Other Harness files; no clean-up offered here.' });
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const weeklyGrowthBytes = await recordStorageUsage(this.deps.userDataRoot, now, totalBytes);
    if (generation !== this.generation) return this.getUsage(true);
    this.cached = { measuredAt: now, rows, totalBytes, weeklyGrowthBytes, reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes + (row.diskReclaimableBytes ?? 0), 0), progress: this.deps.getProgress() };
    return this.cached;
  }
}
