/**
 * Codebase Panel Component
 *
 * Main container component for codebase indexing and search:
 * - Coordinates child components
 * - Handles indexing start/cancel via IPC
 * - Subscribes to indexingProgress signal from service
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  inject,
  effect,
  ChangeDetectionStrategy,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { IndexingProgressComponent } from './indexing-progress.component';
import { CodebaseSearchComponent } from './codebase-search.component';
import { SearchResultsComponent } from './search-results.component';
import { CodebaseStatsComponent } from './codebase-stats.component';
import type {
  CodebaseAutoIndexStatus,
  IndexStats,
  HybridSearchOptions,
  HybridSearchResult,
  WatcherStatus,
} from '../../../../shared/types/codebase.types';

/** Toast notification interface */
interface ToastNotification {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

@Component({
  selector: 'app-codebase-panel',
  standalone: true,
  imports: [
    FormsModule,
    IndexingProgressComponent,
    CodebaseSearchComponent,
    SearchResultsComponent,
    CodebaseStatsComponent,
  ],
  templateUrl: './codebase-panel.component.html',
  styleUrl: './codebase-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodebasePanelComponent implements OnInit, OnDestroy {
  private readonly ipcService = inject(CodebaseIpcService);

  /** Store ID for indexing operations */
  storeId = input<string>('default');

  /** Initial root path */
  initialPath = input<string>('');

  /** Result selected event */
  resultSelected = output<HybridSearchResult>();

  /** Open file request event */
  openFileRequest = output<{ filePath: string; line?: number }>();

  // Local state
  rootPath = signal('');
  indexStats = signal<IndexStats | null>(null);
  watcherStatus = signal<WatcherStatus | null>(null);
  searchResults = signal<HybridSearchResult[]>([]);
  selectedResultId = signal<string | null>(null);
  isSearching = signal(false);
  hasSearched = signal(false);
  toasts = signal<ToastNotification[]>([]);

  // Computed state from IPC service
  indexingProgress = computed(() => this.ipcService.indexingProgress());

  isIndexing = computed(() => {
    const status = this.indexingProgress()?.status;
    return status === 'scanning' || status === 'chunking' || status === 'embedding';
  });

  hasIndex = computed(() => {
    return (this.indexStats()?.totalFiles || 0) > 0;
  });

  /**
   * Current auto-index status for the workspace this panel is bound to. We
   * pick the entry whose rootPath matches the user-entered path, falling back
   * to "any status" when there's only one tracked workspace (the common case
   * for a single-workspace app session).
   */
  autoStatus = computed<CodebaseAutoIndexStatus | null>(() => {
    const statuses = this.ipcService.autoStatusByPath();
    const path = this.rootPath().trim();
    if (path && statuses[path]) {
      return statuses[path];
    }
    const all = Object.values(statuses);
    if (all.length === 1) {
      return all[0];
    }
    return null;
  });

  /**
   * Rendered representation of the current auto-status: short label, tooltip,
   * and visual tone. Returns `null` when nothing relevant to show (no status
   * known, or the run is already complete and the panel has its own stats).
   */
  autoStatusBadge = computed<{ label: string; title: string; tone: 'info' | 'progress' | 'success' | 'warn' | 'error' } | null>(() => {
    const status = this.autoStatus();
    if (!status) return null;

    switch (status.state) {
      case 'queued':
        return { label: 'Queued', title: 'Auto-index queued — will start shortly.', tone: 'info' };
      case 'running': {
        const filesText = typeof status.filesProcessed === 'number'
          ? ` (${status.filesProcessed} files)`
          : '';
        return {
          label: 'Indexing…',
          title: `Auto-index running${filesText}.`,
          tone: 'progress',
        };
      }
      case 'complete':
        return { label: 'Indexed', title: 'Auto-index complete.', tone: 'success' };
      case 'skipped': {
        if (status.reason === 'too_large') {
          return {
            label: 'Too large — index manually',
            title: 'This workspace exceeds the auto-index size limits. Use the Index Codebase button to force a full run.',
            tone: 'warn',
          };
        }
        if (status.reason === 'disabled') {
          return { label: 'Auto-index off', title: 'Auto-index disabled in settings.', tone: 'warn' };
        }
        if (status.reason === 'excluded') {
          return { label: 'Excluded', title: 'Workspace marked as excluded from auto-indexing.', tone: 'warn' };
        }
        if (status.reason === 'remote') {
          return { label: 'Remote workspace', title: 'Remote workspaces manage their own indices.', tone: 'info' };
        }
        return { label: 'Skipped', title: 'Auto-index skipped.', tone: 'warn' };
      }
      case 'failed':
        return {
          label: 'Failed',
          title: status.errorMessage ?? 'Auto-index failed.',
          tone: 'error',
        };
      case 'idle':
      default:
        return null;
    }
  });

  constructor() {
    // Sync initial path
    effect(() => {
      const initial = this.initialPath();
      if (initial && !this.rootPath()) {
        this.rootPath.set(initial);
      }
    });

    // Watch for watcher changes
    effect(() => {
      const changes = this.ipcService.watcherChanges();
      if (changes && changes.storeId === this.storeId()) {
        this.showToast(`${changes.count} files changed`, 'info');
      }
    });
  }

  ngOnInit(): void {
    this.loadStats();
    this.loadWatcherStatus();
    void this.loadAutoStatus();
  }

  async loadAutoStatus(): Promise<void> {
    const response = await this.ipcService.getAutoStatus();
    if (!response.success || !response.data) return;
    const list = Array.isArray(response.data) ? response.data : [response.data];
    // Seed the IPC service signal so the badge has data before any push events arrive.
    if (list.length > 0) {
      const seed: Record<string, CodebaseAutoIndexStatus> = {};
      for (const status of list) {
        seed[status.rootPath] = status;
      }
      this.ipcService.autoStatusByPath.update((current) => ({ ...seed, ...current }));
    }
  }

  ngOnDestroy(): void {
    // Clear any pending toasts
    if (this.toasts().length > 0) {
      this.toasts.set([]);
    }
  }

  async startIndexing(): Promise<void> {
    const path = this.rootPath().trim();
    if (!path) {
      this.showToast('Please select a directory', 'error');
      return;
    }

    // The manual button is the "re-index from scratch" affordance — the
    // auto-coordinator already runs incremental Merkle scans on workspace
    // open, so the only reason a user would click this button is to force a
    // full re-index (e.g. after switching branches or noticing stale results).
    const response = await this.ipcService.indexCodebase(this.storeId(), path, {
      force: true,
    });

    if (response.success) {
      this.showToast('Indexing started', 'info');
      // Stats will be updated via progress events
    } else {
      this.showToast(response.error?.message || 'Failed to start indexing', 'error');
    }
  }

  async cancelIndexing(): Promise<void> {
    const response = await this.ipcService.cancelIndexing();

    if (response.success) {
      this.showToast('Indexing cancelled', 'info');
    } else {
      this.showToast(response.error?.message || 'Failed to cancel', 'error');
    }
  }

  async browseDirectory(): Promise<void> {
    const api = (window as unknown as { electronAPI?: { selectFolder: () => Promise<{ success: boolean; data?: string }> } }).electronAPI;
    if (!api) {
      this.showToast('Not available outside Electron', 'info');
      return;
    }
    const result = await api.selectFolder();
    if (result.success && result.data) {
      this.rootPath.set(result.data as string);
    }
  }

  async loadStats(): Promise<void> {
    const response = await this.ipcService.getIndexStats(this.storeId());
    if (response.success && response.data) {
      this.indexStats.set(response.data);
    }
  }

  async loadWatcherStatus(): Promise<void> {
    const response = await this.ipcService.getWatcherStatus(this.storeId());
    if (response.success && response.data) {
      this.watcherStatus.set(response.data);
    }
  }

  async onSearch(options: HybridSearchOptions): Promise<void> {
    this.isSearching.set(true);
    this.hasSearched.set(true);

    const response = await this.ipcService.search(options);

    this.isSearching.set(false);

    if (response.success && response.data) {
      this.searchResults.set(response.data);
    } else {
      this.searchResults.set([]);
      this.showToast(response.error?.message || 'Search failed', 'error');
    }
  }

  onResultSelected(result: HybridSearchResult): void {
    this.selectedResultId.set(result.sectionId);
    this.resultSelected.emit(result);
  }

  onOpenFile(result: HybridSearchResult): void {
    this.openFileRequest.emit({
      filePath: result.filePath,
      line: result.startLine,
    });
  }

  clearResults(): void {
    this.searchResults.set([]);
    this.selectedResultId.set(null);
    this.hasSearched.set(false);
  }

  showToast(message: string, type: ToastNotification['type'] = 'info'): void {
    const toast: ToastNotification = {
      id: `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      message,
      type,
    };

    this.toasts.update(toasts => [...toasts, toast]);

    setTimeout(() => {
      this.dismissToast(toast.id);
    }, 3000);
  }

  dismissToast(toastId: string): void {
    this.toasts.update(toasts => toasts.filter(t => t.id !== toastId));
  }
}
