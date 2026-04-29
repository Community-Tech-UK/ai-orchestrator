/**
 * History Store - Angular Signals-based state management for conversation history
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { HistoryIpcService } from '../services/ipc/history-ipc.service';
import type {
  AdvancedHistorySearchInput,
  AdvancedHistorySearchResult,
  ConversationHistoryEntry,
  ConversationData,
  HistorySnippet,
  HistoryRestoreMode,
} from '../../../../shared/types/history.types';
import { normalizeConversationHistoryEntryProvider as normalizeHistoryEntryProvider } from '../../../../shared/types/history.types';

interface HistoryState {
  entries: ConversationHistoryEntry[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  selectedEntryId: string | null;
  selectedConversation: ConversationData | null;
  advancedSearchResult: AdvancedHistorySearchResult | null;
  advancedSearchLoading: boolean;
  advancedSearchError: string | null;
  expandedSnippets: Record<string, HistorySnippet[]>;
}

@Injectable({ providedIn: 'root' })
export class HistoryStore {
  private ipc = inject(HistoryIpcService);

  // Private mutable state
  private state = signal<HistoryState>({
    entries: [],
    loading: false,
    error: null,
    searchQuery: '',
    selectedEntryId: null,
    selectedConversation: null,
    advancedSearchResult: null,
    advancedSearchLoading: false,
    advancedSearchError: null,
    expandedSnippets: {},
  });

  // ============================================
  // Public Computed Selectors
  // ============================================

  /** All history entries */
  readonly entries = computed(() => this.state().entries);

  /** Loading state */
  readonly loading = computed(() => this.state().loading);

  /** Error state */
  readonly error = computed(() => this.state().error);

  /** Current search query */
  readonly searchQuery = computed(() => this.state().searchQuery);

  /** Selected entry ID */
  readonly selectedEntryId = computed(() => this.state().selectedEntryId);

  /** Selected conversation data */
  readonly selectedConversation = computed(() => this.state().selectedConversation);

  /** Latest advanced history search result */
  readonly advancedSearchResult = computed(() => this.state().advancedSearchResult);

  readonly advancedSearchLoading = computed(() => this.state().advancedSearchLoading);

  readonly advancedSearchError = computed(() => this.state().advancedSearchError);

  readonly expandedSnippets = computed(() => this.state().expandedSnippets);

  /** Entry count */
  readonly entryCount = computed(() => this.state().entries.length);

  /** Filtered entries based on search query */
  readonly filteredEntries = computed(() => {
    const query = this.state().searchQuery.toLowerCase().trim();
    const entries = this.state().entries;

    if (!query) return entries;

    return entries.filter(entry =>
      entry.displayName.toLowerCase().includes(query) ||
      entry.firstUserMessage.toLowerCase().includes(query) ||
      entry.lastUserMessage.toLowerCase().includes(query) ||
      entry.workingDirectory.toLowerCase().includes(query)
    );
  });

  /** Check if there are any entries */
  readonly hasEntries = computed(() => this.state().entries.length > 0);

  // ============================================
  // Public Actions
  // ============================================

  /**
   * Load history entries from main process
   */
  async loadHistory(): Promise<void> {
    this.state.update(s => ({ ...s, loading: true, error: null }));

    try {
      const response = await this.ipc.listHistory() as {
        success: boolean;
        data?: ConversationHistoryEntry[];
        error?: { message: string };
      };

      if (response.success && response.data) {
        const normalizedEntries = response.data.map(entry => normalizeHistoryEntryProvider(entry));
        this.state.update(s => ({
          ...s,
          entries: normalizedEntries,
          loading: false,
        }));
      } else {
        this.state.update(s => ({
          ...s,
          loading: false,
          error: response.error?.message || 'Failed to load history',
        }));
      }
    } catch {
      this.state.update(s => ({
        ...s,
        loading: false,
        error: 'Failed to load history',
      }));
    }
  }

  /**
   * Load full conversation data for an entry
   */
  async loadConversation(entryId: string): Promise<ConversationData | null> {
    this.state.update(s => ({ ...s, loading: true, selectedEntryId: entryId }));

    try {
      const response = await this.ipc.loadHistoryEntry(entryId) as {
        success: boolean;
        data?: ConversationData;
        error?: { message: string };
      };

      if (response.success && response.data) {
        const normalizedConversation: ConversationData = {
          ...response.data,
          entry: normalizeHistoryEntryProvider(response.data.entry),
        };
        this.state.update(s => ({
          ...s,
          loading: false,
          selectedConversation: normalizedConversation,
        }));
        return normalizedConversation;
      } else {
        this.state.update(s => ({
          ...s,
          loading: false,
          error: response.error?.message || 'Failed to load conversation',
        }));
        return null;
      }
    } catch {
      this.state.update(s => ({
        ...s,
        loading: false,
        error: 'Failed to load conversation',
      }));
      return null;
    }
  }

  /**
   * Archive a history entry from the primary workspace index
   */
  async archiveEntry(entryId: string): Promise<boolean> {
    try {
      const response = await this.ipc.archiveHistoryEntry(entryId) as {
        success: boolean;
        error?: { message: string };
      };

      if (response.success) {
        this.state.update(s => ({
          ...s,
          entries: s.entries.map((entry) =>
            entry.id === entryId
              ? { ...entry, archivedAt: Date.now() }
              : entry
          ),
        }));
        return true;
      }

      this.state.update(s => ({
        ...s,
        error: response.error?.message || 'Failed to archive entry',
      }));
      return false;
    } catch {
      this.state.update(s => ({
        ...s,
        error: 'Failed to archive entry',
      }));
      return false;
    }
  }

  /**
   * Delete a history entry
   */
  async deleteEntry(entryId: string): Promise<boolean> {
    try {
      const response = await this.ipc.deleteHistoryEntry(entryId) as {
        success: boolean;
        error?: { message: string };
      };

      if (response.success) {
        this.state.update(s => ({
          ...s,
          entries: s.entries.filter(e => e.id !== entryId),
          selectedEntryId: s.selectedEntryId === entryId ? null : s.selectedEntryId,
          selectedConversation: s.selectedEntryId === entryId ? null : s.selectedConversation,
        }));
        return true;
      } else {
        this.state.update(s => ({
          ...s,
          error: response.error?.message || 'Failed to delete entry',
        }));
        return false;
      }
    } catch {
      this.state.update(s => ({
        ...s,
        error: 'Failed to delete entry',
      }));
      return false;
    }
  }

  /**
   * Restore a conversation as a new instance
   */
  async restoreEntry(entryId: string, workingDirectory?: string): Promise<{
    success: boolean;
    instanceId?: string;
    restoredMessages?: unknown[];
    restoreMode?: HistoryRestoreMode;
    error?: string;
  }> {
    this.state.update(s => ({ ...s, loading: true }));

    try {
      const response = await this.ipc.restoreHistory(entryId, workingDirectory) as {
        success: boolean;
        data?: {
          instanceId: string;
          restoredMessages: unknown[];
          restoreMode?: HistoryRestoreMode;
        };
        error?: { message: string };
      };

      this.state.update(s => ({ ...s, loading: false }));

      if (response.success && response.data) {
        return {
          success: true,
          instanceId: response.data.instanceId,
          restoredMessages: response.data.restoredMessages,
          restoreMode: response.data.restoreMode,
        };
      } else {
        return {
          success: false,
          error: response.error?.message || 'Failed to restore conversation',
        };
      }
    } catch {
      this.state.update(s => ({ ...s, loading: false }));
      return {
        success: false,
        error: 'Failed to restore conversation',
      };
    }
  }

  async searchAdvanced(input: AdvancedHistorySearchInput): Promise<AdvancedHistorySearchResult | null> {
    this.state.update(s => ({
      ...s,
      advancedSearchLoading: true,
      advancedSearchError: null,
    }));

    try {
      const response = await this.ipc.searchHistoryAdvanced(input) as {
        success: boolean;
        data?: AdvancedHistorySearchResult;
        error?: { message: string };
      };

      if (response.success && response.data) {
        const normalized: AdvancedHistorySearchResult = {
          ...response.data,
          entries: response.data.entries.map(entry => normalizeHistoryEntryProvider(entry)),
        };
        this.state.update(s => ({
          ...s,
          advancedSearchResult: normalized,
          advancedSearchLoading: false,
        }));
        return normalized;
      }

      this.state.update(s => ({
        ...s,
        advancedSearchLoading: false,
        advancedSearchError: response.error?.message || 'Failed to search history',
      }));
      return null;
    } catch {
      this.state.update(s => ({
        ...s,
        advancedSearchLoading: false,
        advancedSearchError: 'Failed to search history',
      }));
      return null;
    }
  }

  async expandSnippets(entryId: string, query: string): Promise<HistorySnippet[]> {
    try {
      const response = await this.ipc.expandHistorySnippets(entryId, query) as {
        success: boolean;
        data?: HistorySnippet[];
        error?: { message: string };
      };

      if (response.success && response.data) {
        this.state.update(s => ({
          ...s,
          expandedSnippets: {
            ...s.expandedSnippets,
            [entryId]: response.data!,
          },
        }));
        return response.data;
      }

      this.state.update(s => ({
        ...s,
        advancedSearchError: response.error?.message || 'Failed to expand snippets',
      }));
      return [];
    } catch {
      this.state.update(s => ({
        ...s,
        advancedSearchError: 'Failed to expand snippets',
      }));
      return [];
    }
  }

  /**
   * Clear all history
   */
  async clearAll(): Promise<boolean> {
    try {
      const response = await this.ipc.clearHistory() as {
        success: boolean;
        error?: { message: string };
      };

      if (response.success) {
        this.state.update(s => ({
          ...s,
          entries: [],
          selectedEntryId: null,
          selectedConversation: null,
        }));
        return true;
      } else {
        this.state.update(s => ({
          ...s,
          error: response.error?.message || 'Failed to clear history',
        }));
        return false;
      }
    } catch {
      this.state.update(s => ({
        ...s,
        error: 'Failed to clear history',
      }));
      return false;
    }
  }

  /**
   * Set search query
   */
  setSearchQuery(query: string): void {
    this.state.update(s => ({ ...s, searchQuery: query }));
  }

  /**
   * Clear search query
   */
  clearSearch(): void {
    this.state.update(s => ({ ...s, searchQuery: '' }));
  }

  /**
   * Clear selection
   */
  clearSelection(): void {
    this.state.update(s => ({
      ...s,
      selectedEntryId: null,
      selectedConversation: null,
    }));
  }

  /**
   * Clear error
   */
  clearError(): void {
    this.state.update(s => ({ ...s, error: null }));
  }
}
