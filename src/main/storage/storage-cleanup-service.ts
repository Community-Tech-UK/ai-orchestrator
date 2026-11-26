import { createHash } from 'crypto';
import { setImmediate as yieldToMain } from 'timers/promises';
import { CleanupTicketStore } from './cleanup-ticket';
import type { StorageFile } from './storage-files';
import type { LegacyAppDataInfo } from './legacy-app-data';
import type { AttachmentFolderUsage, AttachmentSessionCopy } from './attachments-folders';
import { MAX_ATTACHMENT_TREE_ENTRIES } from './attachment-tree';
import type { CodexSafetyCopy, CodexStateOverview } from './codex-safety-copies';
import { codexCopyItems } from './codex-safety-copies';
import type { RtkHistoryTrimPreview, RtkHistoryTrimResult } from '../cli/rtk/rtk-history-trim';
import type { LedgerStorageStats } from '../conversation-ledger/ledger-space-reclaim';
import type { StorageCleanupItem, StorageCleanupPreview, StorageCleanupProgress, StorageCleanupResult, StorageCleanupTarget, StorageRemovalReceipt } from '../../shared/types/storage.types';
import { formatStorageBytes } from '../../shared/utils/storage-format';
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
  removeRecords(target: 'session-records' | 'activity-logs', files: StorageFile[], onRemoved: (count: number) => void): Promise<StorageRemovalReceipt>;
  listLegacyAppData(): Promise<LegacyAppDataInfo | null>;
  trashLegacyAppData(target: LegacyAppDataInfo): Promise<void>;
  listAttachmentFolders(now: number): Promise<AttachmentFolderUsage[]>;
  removeAttachmentSessions(sessions: readonly AttachmentSessionCopy[]): Promise<StorageRemovalReceipt>;
  getCodexStateOverview(): Promise<CodexStateOverview>;
  removeCodexSafetyCopies(copies: readonly CodexSafetyCopy[]): Promise<{ removed: number; bytesFreed: number }>;
  getRtkHistoryPreview(now: number): Promise<RtkHistoryTrimPreview>;
  trimRtkHistory(now: number, dbPath: string): Promise<RtkHistoryTrimResult>;
  getAvailableDiskBytes(): Promise<number>;
  now?: () => number;
}
interface CandidateSnapshot {
  items: StorageCleanupItem[];
  binding: unknown;
  files?: StorageFile[];
  stats?: LedgerStorageStats;
  keptBackup?: StorageCleanupItem;
  legacy?: LegacyAppDataInfo;
  sessions?: AttachmentSessionCopy[];
  copies?: CodexSafetyCopy[];
  rtk?: RtkHistoryTrimPreview;
}
export class StorageCleanupService {
  private readonly now: () => number;
  private readonly tickets: CleanupTicketStore;
  private readonly previews = new Map<string, { target: StorageCleanupTarget; cutoff: number; legacy?: LegacyAppDataInfo; sessions?: AttachmentSessionCopy[] }>();
  private progress: StorageCleanupProgress | null = null;
  constructor(private readonly deps: StorageCleanupDependencies) {
    this.now = deps.now ?? Date.now;
    this.tickets = new CleanupTicketStore(this.now);
  }
  getProgress(): StorageCleanupProgress | null { return this.progress ? { ...this.progress } : null; }

  async preview(target: StorageCleanupTarget): Promise<StorageCleanupPreview> {
    const cutoff = this.now();
    const snapshot = await this.snapshot(target, cutoff);
    if (snapshot.sessions && snapshot.sessions.reduce((sum, session) => sum + (session.tree?.entries.length ?? 0), 0) > MAX_ATTACHMENT_TREE_ENTRIES) {
      throw new Error('This attachment selection is too large to review at once. Review a smaller batch.');
    }
    const bytes = target === 'event-record-shrink' ? snapshot.stats!.freeBytes : snapshot.items.reduce((sum, item) => sum + item.bytes, 0);
    const estimatedCount = target === 'event-record' ? snapshot.stats!.providerEvents.estimatedRows
      : target === 'rtk-history' ? (snapshot.rtk?.commandsToRemove ?? 0) + (snapshot.rtk?.failuresToRemove ?? 0)
      : target === 'claude-attachments' ? snapshot.sessions?.length ?? 0 : snapshot.items.length;
    const dates = snapshot.items.map(item => item.createdAt);
    const day = (timestamp: number | null): string => timestamp === null ? 'an earlier day' : new Date(timestamp).toLocaleDateString();
    const consequence = {
      'event-record': 'This removes the detailed debug record of AI messages. Harness does not use it. Developer scripts that replay captured messages will find nothing until you switch the record on again. This cannot be undone. The conversation file stays the same size until you also choose Shrink the file.',
      'event-record-shrink': 'Harness will rebuild the conversation file. While it runs, Harness cannot save new conversation records; your sessions keep running and the records are saved afterwards. Nothing in your conversation history is removed.',
      'rlm-backups': 'These are copies Harness made before earlier clean-ups. Your newest backup stays. Deleted backups cannot be brought back.',
      'session-records': 'These are saved states more than 30 days old, no longer in History and outside running, sleeping or unsaved sessions. After removal, those sessions cannot be restored from these records. This cannot be undone.',
      'activity-logs': 'These are logs last changed more than 30 days ago. Harness does not read them. This cannot be undone.',
      'legacy-app-data': 'This folder is from before Harness was renamed. Harness no longer reads it: it holds old settings and old saved records. Your current Harness data is not touched. The folder goes to the Bin, so you can put it back from there.',
      'claude-attachments': 'These are copies Harness saved when you attached or pasted files into chats. Only copies last changed more than 30 days ago are listed; files for recent chats stay. A chat that refers to a removed copy will not find it. This cannot be undone.',
      'codex-state-backups': 'Before it fixes Codex\'s private session list at start-up, Harness saves a full copy of it. '
        + `These are ${snapshot.copies?.filter(copy => copy.group === 'old-reconcile').length ?? 0} older copies from ${day(dates.length ? Math.min(...dates) : null)}, ${formatStorageBytes(bytes)}, `
        + `and ${snapshot.copies?.filter(copy => copy.group === 'other').length ?? 0} smaller copies from other clean-ups. `
        + 'Harness no longer adds to them and keeps the 3 newest of the older ones. Newer copies are managed by Harness itself and are not listed here. '
        + 'Deleted copies cannot be brought back. Your Codex session files, which Harness needs to resume Codex chats, are not touched.',
      'rtk-history': 'RTK keeps a log of every command it shortens or passes through. '
        + `Harness will remove the entries older than 30 days: about ${estimatedCount.toLocaleString()} entries, roughly ${formatStorageBytes(bytes)}. `
        + "RTK's totals, and the Savings tab, will then count the last 30 days only. This cannot be undone. "
        + 'The file on disk keeps its size, but RTK reuses the space, so it grows more slowly afterwards.',
    }[target];
    for (const [id, old] of this.previews) {
      // The renderer replaces its attachment review; do not retain abandoned full trees.
      if (old.cutoff + 600_000 <= cutoff || (target === 'claude-attachments' && old.target === target)) this.previews.delete(id);
    }
    if (this.previews.size >= 1000) this.previews.delete(this.previews.keys().next().value!);
    const previewId = this.tickets.issueTicket({ target, itemsHash: hash(snapshot.binding) });
    this.previews.set(previewId, { target, cutoff, legacy: snapshot.legacy ? { ...snapshot.legacy } : undefined,
      sessions: snapshot.sessions ? structuredClone(snapshot.sessions) : undefined });
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
    const progress = { target, removed: 0, estimatedTotal: 0, running: true };
    this.progress = progress;
    try {
      const snapshot = await this.snapshot(target, preview.cutoff);
      // Attachment tickets authorize the retained preview, never a new inventory.
      // Current eligibility is intersected below; changed copies require a fresh ticket.
      this.tickets.consumeTicket(previewId, { target, itemsHash: hash(target === 'claude-attachments' ? preview.sessions : snapshot.binding) });
      this.previews.delete(previewId);
      progress.estimatedTotal = target === 'event-record' ? snapshot.stats!.providerEvents.estimatedRows
        : target === 'rtk-history' ? (snapshot.rtk?.commandsToRemove ?? 0) + (snapshot.rtk?.failuresToRemove ?? 0)
        : target === 'claude-attachments' ? snapshot.sessions?.length ?? 0
          : snapshot.items.length;
      let bytesFreed = 0;
      let stoppedEarly = false;
      if (target === 'event-record') {
        let removed: number;
        do {
          removed = await this.deps.pruneEvents(preview.cutoff, 20_000);
          progress.removed += removed;
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
          progress.removed += result.deleted;
          bytesFreed += result.bytesFreed;
        }
      } else if (target === 'legacy-app-data') {
        // The Bin retains the bytes. A failed move reports the error and removes nothing.
        if (!preview.legacy) throw new Error('That folder is gone. Review again.');
        await this.deps.trashLegacyAppData(preview.legacy);
        progress.removed = 1;
      } else if (target === 'claude-attachments') {
        const current = new Map((snapshot.sessions ?? []).map(session => [session.path, hash(session)]));
        const sessions = (preview.sessions ?? []).filter(session => current.get(session.path) === hash(session));
        const result = await this.deps.removeAttachmentSessions(sessions);
        progress.removed = result.removed;
        bytesFreed = result.bytesFreed;
      } else if (target === 'codex-state-backups') {
        const result = await this.deps.removeCodexSafetyCopies(snapshot.copies ?? []);
        progress.removed = result.removed;
        bytesFreed = result.bytesFreed;
      } else if (target === 'rtk-history') {
        const result = await this.deps.trimRtkHistory(preview.cutoff, snapshot.rtk!.dbPath);
        progress.removed = result.removedCommands + result.removedFailures;
        stoppedEarly = result.stoppedEarly;
      } else {
        const result = await this.deps.removeRecords(target, snapshot.files!, removed => { progress.removed += removed; });
        progress.removed = result.removed;
        bytesFreed = result.bytesFreed;
      }
      logger.info('Harness disk clean-up finished', { target, items: progress.removed, bytes: bytesFreed, stoppedEarly });
      return { target, removed: progress.removed, bytesFreed,
        ...(target === 'rtk-history' ? { stoppedEarly } : {}) };
    } finally { progress.running = false; }
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
    if (target === 'legacy-app-data') {
      const legacy = await this.deps.listLegacyAppData();
      if (!legacy) return { items: [], binding: null };
      return {
        items: [{ name: legacy.name, bytes: legacy.bytes, createdAt: legacy.newestModified }],
        binding: legacy,
        legacy,
      };
    }
    if (target === 'claude-attachments') {
      const folders = (await this.deps.listAttachmentFolders(cutoff)).filter(folder => folder.clearable.length > 0);
      return {
        items: folders.map(folder => ({
          name: folder.path,
          bytes: folder.clearable.reduce((sum, session) => sum + session.bytes, 0),
          createdAt: folder.clearable.reduce((newest, session) => Math.max(newest, session.createdAt), 0),
          sessions: folder.clearable.length,
        })),
        binding: folders.flatMap(folder => folder.clearable),
        sessions: folders.flatMap(folder => folder.clearable),
      };
    }
    if (target === 'codex-state-backups') {
      const overview = await this.deps.getCodexStateOverview();
      return {
        items: codexCopyItems(overview.copies),
        binding: overview.copies,
        copies: overview.copies,
      };
    }
    if (target === 'rtk-history') {
      const rtk = await this.deps.getRtkHistoryPreview(cutoff);
      return {
        items: [{
          name: 'RTK command history',
          bytes: rtk.estimatedBytes,
          createdAt: rtk.oldestAt ?? rtk.cutoffAt,
          group: `${rtk.commandsToRemove.toLocaleString()} command and ${rtk.failuresToRemove.toLocaleString()} failure entries older than 30 days`,
        }],
        // RTK prunes its own history while this preview is open. Approval is
        // for this database and fixed date; changing live counts is expected.
        binding: { dbPath: rtk.dbPath, cutoffAt: rtk.cutoffAt, available: rtk.available },
        rtk,
      };
    }
    const stats = await this.deps.getLedgerStats();
    if (target === 'event-record-shrink') {
      if (stats.freePages <= 0 || stats.freePages * 2 < stats.pageCount) throw new Error('At least half the conversation file must be free before shrinking.');
      if (await this.deps.getAvailableDiskBytes() < stats.liveBytes * 2 + 1024 ** 3) throw new Error('There is not enough free disk space to shrink the file.');
      return { stats, items: [], binding: { pageCount: stats.pageCount, freePages: stats.freePages, autoVacuum: stats.autoVacuum } };
    }
    return { stats, items: [{ name: 'Debug record of AI messages', bytes: stats.providerEvents.estimatedBytes, createdAt: stats.providerEvents.oldestCreatedAt ?? cutoff }],
      binding: { low: stats.providerEvents.lowestRowid, high: stats.providerEvents.highestRowid, oldest: stats.providerEvents.oldestCreatedAt, newest: stats.providerEvents.newestCreatedAt } };
  }
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
