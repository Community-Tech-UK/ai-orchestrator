/**
 * Codebase Indexing IPC Service
 * Handles codebase indexing, search, and file watching operations
 */

import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type {
  IndexingProgress,
  IndexingStats,
  IndexStats,
  HybridSearchOptions,
  HybridSearchResult,
  WatcherStatus
} from '../../../../../shared/types/codebase.types';

@Injectable({ providedIn: 'root' })
export class CodebaseIpcService implements OnDestroy {
  private base = inject(ElectronIpcService);
  private unsubscribeProgress: (() => void) | null = null;
  private unsubscribeWatcher: (() => void) | null = null;

  private get api() {
    return this.base.getApi();
  }

  // Reactive signals for UI binding
  readonly indexingProgress = signal<IndexingProgress | null>(null);
  readonly watcherChanges = signal<{ storeId: string; count: number } | null>(null);

  constructor() {
    this.setupEventListeners();
  }

  ngOnDestroy(): void {
    this.unsubscribeProgress?.();
    this.unsubscribeWatcher?.();
  }

  private setupEventListeners(): void {
    if (!this.api) return;

    // Listen for indexing progress updates
    if (this.api.onCodebaseIndexProgress) {
      this.unsubscribeProgress = this.api.onCodebaseIndexProgress((progress) => {
        this.base.getNgZone().run(() => {
          this.indexingProgress.set(progress as IndexingProgress);
        });
      });
    }

    // Listen for watcher change events
    if (this.api.onCodebaseWatcherChanges) {
      this.unsubscribeWatcher = this.api.onCodebaseWatcherChanges((data) => {
        this.base.getNgZone().run(() => {
          this.watcherChanges.set(data as { storeId: string; count: number });
        });
      });
    }
  }

  // ============================================
  // Indexing Operations
  // ============================================

  /**
   * Index a codebase (full or incremental)
   */
  async indexCodebase(
    storeId: string,
    rootPath: string,
    options?: { force?: boolean; filePatterns?: string[] }
  ): Promise<IpcResponse<IndexingStats>> {
    if (!this.api?.codebaseIndexStore) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseIndexStore(storeId, rootPath, options) as Promise<IpcResponse<IndexingStats>>;
  }

  /**
   * Index a single file
   */
  async indexFile(storeId: string, filePath: string): Promise<IpcResponse<void>> {
    if (!this.api?.codebaseIndexFile) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseIndexFile(storeId, filePath) as Promise<IpcResponse<void>>;
  }

  /**
   * Cancel ongoing indexing
   */
  async cancelIndexing(): Promise<IpcResponse<void>> {
    if (!this.api?.codebaseIndexCancel) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseIndexCancel() as Promise<IpcResponse<void>>;
  }

  /**
   * Get current indexing status
   */
  async getIndexingStatus(): Promise<IpcResponse<IndexingProgress>> {
    if (!this.api?.codebaseIndexStatus) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseIndexStatus() as Promise<IpcResponse<IndexingProgress>>;
  }

  /**
   * Get index stats for a store
   */
  async getIndexStats(storeId: string): Promise<IpcResponse<IndexStats>> {
    if (!this.api?.codebaseIndexStats) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseIndexStats(storeId) as Promise<IpcResponse<IndexStats>>;
  }

  // ============================================
  // Search Operations
  // ============================================

  /**
   * Perform hybrid search (BM25 + vector + reranking)
   */
  async search(options: HybridSearchOptions): Promise<IpcResponse<HybridSearchResult[]>> {
    if (!this.api?.codebaseSearch) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseSearch(options) as Promise<IpcResponse<HybridSearchResult[]>>;
  }

  /**
   * Search for symbols
   */
  async searchSymbols(
    storeId: string,
    query: string
  ): Promise<IpcResponse<HybridSearchResult[]>> {
    if (!this.api?.codebaseSearchSymbols) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseSearchSymbols(storeId, query) as Promise<IpcResponse<HybridSearchResult[]>>;
  }

  // ============================================
  // File Watcher Operations
  // ============================================

  /**
   * Start file watcher for a store
   */
  async startWatcher(storeId: string, rootPath: string): Promise<IpcResponse<void>> {
    if (!this.api?.codebaseWatcherStart) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseWatcherStart(storeId, rootPath) as Promise<IpcResponse<void>>;
  }

  /**
   * Stop file watcher for a store
   */
  async stopWatcher(storeId: string): Promise<IpcResponse<void>> {
    if (!this.api?.codebaseWatcherStop) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseWatcherStop(storeId) as Promise<IpcResponse<void>>;
  }

  /**
   * Get watcher status
   */
  async getWatcherStatus(storeId: string): Promise<IpcResponse<WatcherStatus>> {
    if (!this.api?.codebaseWatcherStatus) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.codebaseWatcherStatus(storeId) as Promise<IpcResponse<WatcherStatus>>;
  }
}
