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
  template: `
    <div class="codebase-container">
      <!-- Header -->
      <div class="codebase-header">
        <div class="header-left">
          <span class="codebase-icon">📚</span>
          <span class="codebase-title">Codebase Index</span>
          @if (autoStatusBadge(); as badge) {
            <span
              class="auto-status-badge"
              [class]="'auto-status-' + badge.tone"
              [title]="badge.title"
            >
              {{ badge.label }}
            </span>
          }
        </div>
        <div class="header-actions">
          @if (isIndexing()) {
            <button class="action-btn danger" (click)="cancelIndexing()">
              Cancel
            </button>
          } @else {
            <button
              class="action-btn primary"
              (click)="startIndexing()"
              [disabled]="!rootPath()"
            >
              Index Codebase
            </button>
          }
        </div>
      </div>

      <!-- Toast Notifications -->
      @if (toasts().length > 0) {
        <div class="toast-container">
          @for (toast of toasts(); track toast.id) {
            <div
              class="toast"
              [class]="'toast-' + toast.type"
              role="button"
              tabindex="0"
              (click)="dismissToast(toast.id)"
              (keyup.enter)="dismissToast(toast.id)"
              (keyup.space)="dismissToast(toast.id)"
            >
              <span class="toast-message">{{ toast.message }}</span>
              <button class="toast-close" (click)="dismissToast(toast.id); $event.stopPropagation()">
                ✕
              </button>
            </div>
          }
        </div>
      }

      <!-- Directory Selection -->
      <div class="directory-section">
        <label class="directory-label" for="root-path-input">Root Directory</label>
        <div class="directory-input-wrapper">
          <input
            type="text"
            id="root-path-input"
            class="directory-input"
            [ngModel]="rootPath()"
            (ngModelChange)="rootPath.set($event)"
            placeholder="/path/to/codebase"
          />
          <button class="browse-btn" (click)="browseDirectory()">
            Browse
          </button>
        </div>
      </div>

      <!-- Indexing Progress -->
      @if (indexingProgress()) {
        <app-indexing-progress
          [progress]="indexingProgress()"
          (cancelIndexing)="cancelIndexing()"
        />
      }

      <!-- Stats Display -->
      @if (indexStats()) {
        <app-codebase-stats
          [stats]="indexStats()"
          [watcherStatus]="watcherStatus()"
        />
      }

      <!-- Search Section -->
      @if (hasIndex()) {
        <div class="search-section">
          <app-codebase-search
            [storeId]="storeId()"
            [disabled]="isIndexing()"
            [isSearching]="isSearching()"
            (searchTriggered)="onSearch($event)"
          />

          @if (searchResults().length > 0 || hasSearched()) {
            <app-search-results
              [results]="searchResults()"
              [selectedId]="selectedResultId()"
              (resultSelected)="onResultSelected($event)"
              (clearResults)="clearResults()"
              (openFile)="onOpenFile($event)"
              (copySuccess)="showToast($event, 'success')"
            />
          }
        </div>
      }

      <!-- No Index State -->
      @if (!hasIndex() && !isIndexing()) {
        <div class="no-index">
          <span class="no-index-icon">📂</span>
          <span class="no-index-title">No Index Available</span>
          <span class="no-index-text">
            Select a directory and click "Index Codebase" to enable semantic search
          </span>
        </div>
      }
    </div>
  `,
  styles: [`
    .codebase-container {
      position: relative;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      padding: var(--spacing-md);
      max-height: 100%;
      overflow: hidden;
    }

    .codebase-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .codebase-icon {
      font-size: 18px;
    }

    .codebase-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .auto-status-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 500;
      line-height: 1.4;
      letter-spacing: 0.02em;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      border: 1px solid var(--border-color);
    }

    .auto-status-info {
      background: rgba(59, 130, 246, 0.15);
      color: rgb(59, 130, 246);
      border-color: rgba(59, 130, 246, 0.4);
    }

    .auto-status-progress {
      background: rgba(245, 158, 11, 0.15);
      color: rgb(245, 158, 11);
      border-color: rgba(245, 158, 11, 0.4);
    }

    .auto-status-success {
      background: rgba(16, 185, 129, 0.15);
      color: rgb(16, 185, 129);
      border-color: rgba(16, 185, 129, 0.4);
    }

    .auto-status-warn {
      background: rgba(234, 179, 8, 0.15);
      color: rgb(202, 138, 4);
      border-color: rgba(234, 179, 8, 0.4);
    }

    .auto-status-error {
      background: rgba(239, 68, 68, 0.15);
      color: rgb(239, 68, 68);
      border-color: rgba(239, 68, 68, 0.4);
    }

    .header-actions {
      display: flex;
      gap: var(--spacing-sm);
    }

    .action-btn {
      padding: 6px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: white;

        &:hover:not(:disabled) {
          opacity: 0.9;
        }
      }

      &.danger {
        background: transparent;
        border-color: #ef4444;
        color: #ef4444;

        &:hover:not(:disabled) {
          background: rgba(239, 68, 68, 0.1);
        }
      }
    }

    .directory-section {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .directory-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .directory-input-wrapper {
      display: flex;
      gap: var(--spacing-sm);
    }

    .directory-input {
      flex: 1;
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 13px;
      font-family: monospace;

      &::placeholder {
        color: var(--text-muted);
      }

      &:focus {
        border-color: var(--primary-color);
        outline: none;
      }
    }

    .browse-btn {
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .search-section {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      flex: 1;
      overflow: hidden;
    }

    .no-index {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xl);
    }

    .no-index-icon {
      font-size: 48px;
      opacity: 0.5;
    }

    .no-index-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .no-index-text {
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
    }

    /* Toast Notifications */
    .toast-container {
      position: absolute;
      top: 60px;
      right: var(--spacing-md);
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      max-width: 280px;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      animation: slideIn 0.3s ease;
      cursor: pointer;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    .toast-success {
      background: rgba(16, 185, 129, 0.95);
      color: white;
    }

    .toast-error {
      background: rgba(239, 68, 68, 0.95);
      color: white;
    }

    .toast-info {
      background: rgba(59, 130, 246, 0.95);
      color: white;
    }

    .toast-message {
      flex: 1;
      font-size: 12px;
    }

    .toast-close {
      background: transparent;
      border: none;
      color: inherit;
      opacity: 0.7;
      cursor: pointer;
      font-size: 12px;

      &:hover {
        opacity: 1;
      }
    }
  `],
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
