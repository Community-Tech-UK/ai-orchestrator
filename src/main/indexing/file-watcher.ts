/**
 * Codebase File Watcher
 *
 * Real-time file watching for incremental indexing using chokidar.
 * Debounces rapid changes and batches updates for efficiency.
 */

import * as path from 'path';
import { EventEmitter } from 'events';
import { watch, type FSWatcher } from 'chokidar';
import type {
  FileWatcherConfig,
  WatcherStatus,
} from '../../shared/types/codebase.types';
import { DEFAULT_FILE_WATCHER_CONFIG, shouldIncludeFile, DEFAULT_INDEXING_CONFIG } from './config';
import { CodebaseIndexingService, getCodebaseIndexingService } from './indexing-service';

// ============================================================================
// Types
// ============================================================================

interface PendingChange {
  path: string;
  type: 'add' | 'change' | 'unlink';
  timestamp: number;
}

// ============================================================================
// CodebaseFileWatcher Class
// ============================================================================

export class CodebaseFileWatcher extends EventEmitter {
  private config: FileWatcherConfig;
  private indexingService: CodebaseIndexingService;

  private watchers: Map<string, FSWatcher> = new Map();
  private pendingChanges: Map<string, Map<string, PendingChange>> = new Map();
  private processTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: Partial<FileWatcherConfig> = {}) {
    super();
    this.config = { ...DEFAULT_FILE_WATCHER_CONFIG, ...config };
    this.indexingService = getCodebaseIndexingService();
  }

  /**
   * Start watching a directory for a store.
   */
  async startWatching(storeId: string, rootPath: string): Promise<void> {
    if (this.watchers.has(storeId)) {
      await this.stopWatching(storeId);
    }

    const absolutePath = path.resolve(rootPath);

    const watcher = watch(absolutePath, {
      ignored: this.config.ignorePatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
      usePolling: false,
      followSymlinks: false,
    });

    // Initialize pending changes map for this store
    this.pendingChanges.set(storeId, new Map());

    watcher.on('add', (filePath) => this.handleChange(storeId, filePath, 'add'));
    watcher.on('change', (filePath) => this.handleChange(storeId, filePath, 'change'));
    watcher.on('unlink', (filePath) => this.handleChange(storeId, filePath, 'unlink'));

    watcher.on('error', (error) => {
      this.emit('error', { storeId, error });
    });

    watcher.on('ready', () => {
      this.emit('watcher:ready', { storeId, rootPath: absolutePath });
    });

    this.watchers.set(storeId, watcher);

    this.emit('watcher:started', { storeId, rootPath: absolutePath });
  }

  /**
   * Stop watching a directory for a store.
   */
  async stopWatching(storeId: string): Promise<void> {
    const watcher = this.watchers.get(storeId);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(storeId);
    }

    // Clear pending changes
    this.pendingChanges.delete(storeId);

    // Clear timer
    const timer = this.processTimers.get(storeId);
    if (timer) {
      clearTimeout(timer);
      this.processTimers.delete(storeId);
    }

    this.emit('watcher:stopped', { storeId });
  }

  /**
   * Stop all watchers.
   */
  async stopAll(): Promise<void> {
    const storeIds = Array.from(this.watchers.keys());
    await Promise.all(storeIds.map((id) => this.stopWatching(id)));
  }

  /**
   * Get watcher status for a store.
   */
  getStatus(storeId: string): WatcherStatus | null {
    const watcher = this.watchers.get(storeId);
    if (!watcher) {
      return null;
    }

    const pending = this.pendingChanges.get(storeId);

    return {
      storeId,
      rootPath: '', // chokidar doesn't expose the watched path easily
      isWatching: true,
      pendingChanges: pending?.size || 0,
    };
  }

  /**
   * Get all active watchers.
   */
  getActiveWatchers(): string[] {
    return Array.from(this.watchers.keys());
  }

  /**
   * Process pending changes immediately for a store.
   */
  async flushChanges(storeId: string): Promise<void> {
    await this.processPendingChanges(storeId);
  }

  /**
   * Configure the watcher.
   */
  configure(config: Partial<FileWatcherConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ==========================================================================
  // Private: Change Handling
  // ==========================================================================

  private handleChange(storeId: string, filePath: string, type: 'add' | 'change' | 'unlink'): void {
    // Check if file should be included
    if (type !== 'unlink' && !shouldIncludeFile(filePath, DEFAULT_INDEXING_CONFIG)) {
      return;
    }

    const pending = this.pendingChanges.get(storeId);
    if (!pending) {
      return;
    }

    // Check max pending limit
    if (pending.size >= this.config.maxPendingChanges) {
      this.emit('warning', {
        storeId,
        message: 'Max pending changes reached, some changes may be dropped',
      });
      return;
    }

    // Add to pending changes
    pending.set(filePath, {
      path: filePath,
      type,
      timestamp: Date.now(),
    });

    // Emit event
    this.emit('change:detected', { storeId, path: filePath, type, timestamp: Date.now() });

    // Debounce processing
    this.scheduleProcessing(storeId);
  }

  private scheduleProcessing(storeId: string): void {
    // Clear existing timer
    const existingTimer = this.processTimers.get(storeId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new processing
    const timer = setTimeout(
      () => this.processPendingChanges(storeId),
      this.config.debounceMs
    );

    this.processTimers.set(storeId, timer);
  }

  private async processPendingChanges(storeId: string): Promise<void> {
    const pending = this.pendingChanges.get(storeId);
    if (!pending || pending.size === 0) {
      return;
    }

    // Copy and clear pending changes
    const changes = Array.from(pending.values());
    pending.clear();

    // Clear timer
    const timer = this.processTimers.get(storeId);
    if (timer) {
      clearTimeout(timer);
      this.processTimers.delete(storeId);
    }

    this.emit('changes:processing', { storeId, count: changes.length });

    // Group changes by type
    const additions: string[] = [];
    const modifications: string[] = [];
    const deletions: string[] = [];

    for (const change of changes) {
      switch (change.type) {
        case 'add':
          additions.push(change.path);
          break;
        case 'change':
          modifications.push(change.path);
          break;
        case 'unlink':
          deletions.push(change.path);
          break;
      }
    }

    // Process deletions first
    for (const filePath of deletions) {
      try {
        await this.indexingService.removeFile(storeId, filePath);
        this.emit('file:removed', { storeId, filePath });
      } catch (error) {
        this.emit('file:error', {
          storeId,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Process additions and modifications
    const filesToIndex = [...additions, ...modifications];
    for (const filePath of filesToIndex) {
      if (!this.config.autoIndex) {
        this.emit('file:pending', { storeId, filePath });
        continue;
      }

      try {
        await this.indexingService.indexFile(storeId, filePath);
        this.emit('file:indexed', { storeId, filePath });
      } catch (error) {
        this.emit('file:error', {
          storeId,
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.emit('changes:processed', {
      storeId,
      additions: additions.length,
      modifications: modifications.length,
      deletions: deletions.length,
    });
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let codebaseFileWatcherInstance: CodebaseFileWatcher | null = null;

export function getCodebaseFileWatcher(
  config?: Partial<FileWatcherConfig>
): CodebaseFileWatcher {
  if (!codebaseFileWatcherInstance) {
    codebaseFileWatcherInstance = new CodebaseFileWatcher(config);
  }
  return codebaseFileWatcherInstance;
}

export function resetCodebaseFileWatcher(): void {
  if (codebaseFileWatcherInstance) {
    codebaseFileWatcherInstance.stopAll();
  }
  codebaseFileWatcherInstance = null;
}
