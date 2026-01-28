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
  IndexingProgress,
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
              (click)="dismissToast(toast.id)"
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
        <label class="directory-label">Root Directory</label>
        <div class="directory-input-wrapper">
          <input
            type="text"
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
          (cancel)="cancelIndexing()"
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
            (search)="onSearch($event)"
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
  }

  ngOnDestroy(): void {
    // Cleanup handled by Angular
  }

  async startIndexing(): Promise<void> {
    const path = this.rootPath().trim();
    if (!path) {
      this.showToast('Please select a directory', 'error');
      return;
    }

    const response = await this.ipcService.indexCodebase(this.storeId(), path);

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
    // This would integrate with Electron's dialog API
    // For now, show a message
    this.showToast('Directory browsing via IPC not yet implemented', 'info');
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
