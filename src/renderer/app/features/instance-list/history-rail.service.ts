import { Injectable, signal } from '@angular/core';
import {
  getConversationHistoryTitle,
  type ConversationHistoryEntry,
} from '../../../../shared/types/history.types';

const PINNED_HISTORY_STORAGE_KEY = 'instance-list-pinned-history';
const SEEN_HISTORY_THREADS_STORAGE_KEY = 'instance-list-seen-history-threads';
type HistorySortMode = 'last-interacted' | 'created';

interface RailChangeSummary {
  additions: number;
  deletions: number;
}

interface ProjectGroupForHistory {
  key: string;
  historyItems: ConversationHistoryEntry[];
}

@Injectable({ providedIn: 'root' })
export class HistoryRailService {
  readonly pinnedHistoryIds = signal<Set<string>>(this.loadPinnedHistoryIds());
  readonly seenHistoryThreads = signal<Record<string, number>>(this.loadSeenHistoryThreads());
  readonly expandedHistoryKeys = signal<Set<string>>(new Set());
  readonly restoringHistoryIds = signal<Set<string>>(new Set());

  private readonly HISTORY_DISPLAY_LIMIT = 10;

  // -------------------------------------------------------------------------
  // localStorage persistence
  // -------------------------------------------------------------------------

  loadPinnedHistoryIds(): Set<string> {
    try {
      const saved = localStorage.getItem(PINNED_HISTORY_STORAGE_KEY);
      if (!saved) {
        return new Set();
      }
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) {
        return new Set();
      }
      return new Set(parsed.filter((value): value is string => typeof value === 'string'));
    } catch {
      return new Set();
    }
  }

  savePinnedHistoryIds(ids: Set<string>): void {
    try {
      localStorage.setItem(PINNED_HISTORY_STORAGE_KEY, JSON.stringify(Array.from(ids)));
    } catch {
      // Ignore storage errors.
    }
  }

  loadSeenHistoryThreads(): Record<string, number> {
    try {
      const saved = localStorage.getItem(SEEN_HISTORY_THREADS_STORAGE_KEY);
      if (!saved) {
        return {};
      }

      const parsed = JSON.parse(saved);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }

      const next: Record<string, number> = {};
      for (const [threadId, endedAt] of Object.entries(parsed)) {
        if (!threadId.trim()) {
          continue;
        }
        if (typeof endedAt === 'number' && Number.isFinite(endedAt)) {
          next[threadId] = endedAt;
        }
      }

      return next;
    } catch {
      return {};
    }
  }

  saveSeenHistoryThreads(seenThreads: Record<string, number>): void {
    try {
      const entries = Object.entries(seenThreads).filter(
        ([threadId, endedAt]) => threadId.trim().length > 0 && Number.isFinite(endedAt)
      );
      if (entries.length === 0) {
        localStorage.removeItem(SEEN_HISTORY_THREADS_STORAGE_KEY);
        return;
      }

      localStorage.setItem(
        SEEN_HISTORY_THREADS_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(entries))
      );
    } catch {
      // Ignore storage errors.
    }
  }

  // -------------------------------------------------------------------------
  // Seen-entry tracking
  // -------------------------------------------------------------------------

  markHistoryEntriesSeen(
    entries: readonly Pick<ConversationHistoryEntry, 'historyThreadId' | 'sessionId' | 'id' | 'endedAt'>[]
  ): void {
    if (entries.length === 0) {
      return;
    }

    this.seenHistoryThreads.update((current) => {
      let next: Record<string, number> | null = null;

      for (const entry of entries) {
        const threadId = this.getHistoryThreadId(entry);
        if (!threadId.trim() || !Number.isFinite(entry.endedAt)) {
          continue;
        }

        const seenEndedAt = (next ?? current)[threadId] ?? 0;
        if (seenEndedAt >= entry.endedAt) {
          continue;
        }

        next ??= { ...current };
        next[threadId] = entry.endedAt;
      }

      if (!next) {
        return current;
      }

      this.saveSeenHistoryThreads(next);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Restore state
  // -------------------------------------------------------------------------

  isRestoringHistory(entryId: string): boolean {
    return this.restoringHistoryIds().has(entryId);
  }

  // -------------------------------------------------------------------------
  // Visible items / expand state
  // -------------------------------------------------------------------------

  getVisibleHistoryItems(group: ProjectGroupForHistory): ConversationHistoryEntry[] {
    if (this.expandedHistoryKeys().has(group.key)) {
      return group.historyItems;
    }
    return group.historyItems.slice(0, this.HISTORY_DISPLAY_LIMIT);
  }

  toggleHistoryExpanded(key: string): void {
    this.expandedHistoryKeys.update((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Pin management
  // -------------------------------------------------------------------------

  isPinnedHistory(entryId: string): boolean {
    return this.pinnedHistoryIds().has(entryId);
  }

  togglePinnedHistory(entryId: string, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.pinnedHistoryIds.update((current) => {
      const next = new Set(current);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      this.savePinnedHistoryIds(next);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Display helpers
  // -------------------------------------------------------------------------

  getHistoryTitle(entry: ConversationHistoryEntry): string {
    return getConversationHistoryTitle(entry);
  }

  getHistoryPreviewTitle(entry: ConversationHistoryEntry): string {
    return this.truncateRailText(this.getHistoryTitle(entry));
  }

  getHistoryChangeSummary(entry: ConversationHistoryEntry): RailChangeSummary | null {
    if (this.isHistoryThreadSeen(entry)) {
      return null;
    }

    if (!entry.changeSummary) {
      return null;
    }

    const additions = Number(entry.changeSummary.additions ?? 0);
    const deletions = Number(entry.changeSummary.deletions ?? 0);

    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
      return null;
    }
    if (additions === 0 && deletions === 0) {
      return null;
    }

    return {
      additions,
      deletions,
    };
  }

  getHistoryProviderVisual(entry: ConversationHistoryEntry): {
    icon: 'anthropic' | 'openai' | 'google' | 'github' | 'generic';
    color: string;
    label: string;
  } {
    switch (entry.provider) {
      case 'claude':
        return { icon: 'anthropic', color: '#D97706', label: 'Claude' };
      case 'codex':
        return { icon: 'openai', color: '#10A37F', label: 'Codex' };
      case 'gemini':
        return { icon: 'google', color: '#4285F4', label: 'Gemini' };
      case 'copilot':
        return { icon: 'github', color: '#6e40c9', label: 'Copilot' };
      default:
        return { icon: 'generic', color: 'rgba(214, 221, 208, 0.76)', label: 'AI session' };
    }
  }

  formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;

    if (diff < hour) {
      return `${Math.max(1, Math.round(diff / minute))}m`;
    }
    if (diff < day) {
      return `${Math.round(diff / hour)}h`;
    }
    if (diff < week) {
      return `${Math.round(diff / day)}d`;
    }
    return `${Math.round(diff / week)}w`;
  }

  formatHistoryTime(entry: ConversationHistoryEntry, sortMode: HistorySortMode): string {
    return this.formatRelativeTime(this.getHistorySortTimestamp(entry, sortMode));
  }

  getHistoryThreadId(
    entry: Pick<ConversationHistoryEntry, 'historyThreadId' | 'sessionId' | 'id'>
  ): string {
    const historyThreadId = entry.historyThreadId?.trim();
    if (historyThreadId) {
      return historyThreadId;
    }

    const sessionId = entry.sessionId.trim();
    if (sessionId) {
      return sessionId;
    }

    return entry.id;
  }

  getHistorySortTimestamp(entry: ConversationHistoryEntry, mode: HistorySortMode): number {
    return mode === 'created' ? entry.createdAt : entry.endedAt;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private isHistoryThreadSeen(
    entry: Pick<ConversationHistoryEntry, 'historyThreadId' | 'sessionId' | 'id' | 'endedAt'>
  ): boolean {
    const seenEndedAt = this.seenHistoryThreads()[this.getHistoryThreadId(entry)] ?? 0;
    return seenEndedAt >= entry.endedAt;
  }

  private truncateRailText(value: string, maxLength = 42): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
  }
}
