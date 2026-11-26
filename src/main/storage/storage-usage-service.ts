import * as path from 'path';
import { listStorageFiles, type StorageFile } from './storage-files';
import type { StorageCleanupDependencies } from './storage-cleanup-service';
import type { StorageCleanupProgress, StorageUsage, StorageUsageRow } from '../../shared/types/storage.types';
import { formatStorageBytes } from '../../shared/utils/storage-format';
import type { LedgerStorageStats } from '../conversation-ledger/ledger-space-reclaim';
import { recordStorageUsage } from './storage-usage-history';
import { getLogger } from '../logging/logger';

const logger = getLogger('StorageUsageService');

interface StorageUsageDependencies {
  userDataRoot: string;
  getLedgerStats(): Promise<LedgerStorageStats>;
  listBackups: StorageCleanupDependencies['listBackups'];
  listRecords: StorageCleanupDependencies['listRecords'];
  listLegacyAppData: StorageCleanupDependencies['listLegacyAppData'];
  listAttachmentFolders: StorageCleanupDependencies['listAttachmentFolders'];
  getCodexStateOverview: StorageCleanupDependencies['getCodexStateOverview'];
  getRtkHistoryPreview: StorageCleanupDependencies['getRtkHistoryPreview'];
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
  private async legacyRow(): Promise<StorageUsageRow | null> {
    try {
      const legacy = await this.deps.listLegacyAppData();
      return legacy ? { id: 'legacy-app-data', label: `Older Harness data folder (${legacy.name})`, bytes: legacy.bytes, reclaimableBytes: legacy.bytes,
        target: 'legacy-app-data', note: 'From before Harness was renamed; Harness no longer reads it. Moving it to the Bin is offered below; your current data is not touched.' } : null;
    } catch (error) {
      logger.warn('Could not measure the legacy app data folder', { error: error instanceof Error ? error.message : String(error) });
      return { id: 'legacy-app-data', label: 'Older Harness data folder', bytes: 0, reclaimableBytes: 0,
        note: 'The old data folder could not be measured. Its size is unknown and no clean-up is available. Refresh to try again.' };
    }
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
    const legacy = await this.legacyRow();
    const attachments = await this.deps.listAttachmentFolders(now);
    const rows: StorageUsageRow[] = [this.eventRow(stats),
      { id: 'conversation-history', label: 'Conversation history (kept)', bytes: Math.max(0, stats.liveBytes - stats.providerEvents.estimatedBytes), reclaimableBytes: 0, note: 'Harness keeps this conversation history.' },
      { id: 'rlm-backups', label: 'Learning database backups', bytes: backups.reduce((sum, set) => sum + set.bytes, 0), reclaimableBytes: backups.slice(1).reduce((sum, set) => sum + set.bytes, 0), target: 'rlm-backups', note: `Review the old learning database copies to free space; your newest backup stays. Older than 30 days: ${oldBackupBytes.toLocaleString()} bytes.` },
      { id: 'learning-database', label: 'Learning database', bytes: bytesAt('rlm/rlm.db'), reclaimableBytes: 0, note: 'Harness tidies this itself.' },
      { id: 'session-records', label: 'Saved session records', bytes: bytesAt('session-continuity/states') + bytesAt('session-continuity/recovery-metadata'), reclaimableBytes: records.reduce((sum, file) => sum + file.bytes, 0), target: 'session-records', note: 'Only records older than 30 days, no longer in History and outside running, sleeping or unsaved sessions.' },
      { id: 'activity-logs', label: 'Session activity logs', bytes: logBytes, reclaimableBytes: logs.reduce((sum, file) => sum + file.bytes, 0), target: 'activity-logs', note: 'Only logs older than 30 days and outside running, sleeping or unsaved sessions.' },
      { id: 'code-index', label: 'Code index', bytes: bytesAt('codemem.sqlite'), reclaimableBytes: 0, note: 'Harness tidies this itself.' },
      { id: 'evidence-store', label: 'Evidence store', bytes: bytesAt('conversation-evidence'), reclaimableBytes: 0, note: 'Harness tidies this itself.' },
      { id: 'codex-command-output', label: 'Codex command output', bytes: bytesAt('codex-command-output'), reclaimableBytes: 0, note: 'Harness tidies this itself.' },
    ];
    if (legacy) rows.push(legacy);
    rows.push({ id: 'claude-attachments', label: 'Pasted attachments',
      bytes: attachments.reduce((sum, folder) => sum + folder.bytes, 0),
      reclaimableBytes: attachments.reduce((sum, folder) => sum + folder.clearable.reduce((inner, session) => inner + session.bytes, 0), 0),
      target: 'claude-attachments',
      note: 'Copies Harness saved for files you attached or pasted into chats, inside your project folders. Only copies last changed more than 30 days ago are offered.' });
    const codex = await this.deps.getCodexStateOverview();
    rows.push({ id: 'codex-state-backups', label: 'Codex safety copies', bytes: codex.backupBytes,
      reclaimableBytes: codex.copies.reduce((sum, copy) => sum + copy.bytes, 0), target: 'codex-state-backups',
      note: `${codex.backupCount.toLocaleString()} full copies Harness saved before fixing Codex's private session list. The older ones can be given back after a review; Harness keeps the 3 newest of the older ones and manages its new copies itself.` });
    rows.push({ id: 'codex-session-files', label: 'Codex session files', bytes: codex.sessionsBytes, reclaimableBytes: 0,
      note: 'Harness needs these to resume Codex chats.' });
    const rtk = await this.deps.getRtkHistoryPreview(now);
    rows.push({ id: 'rtk-history', label: 'RTK command history', bytes: rtk.fileBytes,
      reclaimableBytes: 0,
      ...(rtk.available && rtk.commandsToRemove + rtk.failuresToRemove > 0 ? { target: 'rtk-history' as const } : {}),
      note: rtk.available
        ? `Entries from ${rtk.oldestAt === null ? 'an earlier day' : new Date(rtk.oldestAt).toLocaleDateString()} to ${rtk.newestAt === null ? 'today' : new Date(rtk.newestAt).toLocaleDateString()}. RTK removes entries after 90 days by itself; a trim can remove those older than 30 days, roughly ${formatStorageBytes(rtk.estimatedBytes)}. The file on disk keeps its size; RTK reuses the freed pages.`
        : 'RTK keeps its own 90-day history; the file is not available to trim.' });
    const accounted = bytesAt('conversation-ledger') + bytesAt('rlm/backups') + bytesAt('rlm/rlm.db') + bytesAt('session-continuity/states') + bytesAt('session-continuity/recovery-metadata') + logBytes + bytesAt('codemem.sqlite') + bytesAt('conversation-evidence') + bytesAt('codex-command-output');
    rows.push({ id: 'other', label: 'Everything else', bytes: Math.max(0, files.reduce((sum, file) => sum + file.bytes, 0) - accounted), reclaimableBytes: 0, note: 'Other Harness files; no clean-up offered here.' });
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const weeklyGrowthBytes = await recordStorageUsage(this.deps.userDataRoot, now, totalBytes);
    if (generation !== this.generation) return this.getUsage(true);
    this.cached = { measuredAt: now, rows, totalBytes, weeklyGrowthBytes, reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes + (row.diskReclaimableBytes ?? 0), 0), progress: this.deps.getProgress() };
    return this.cached;
  }
}
