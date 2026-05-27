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
import { buildWatchIgnoredMatchers } from '../workspace/watcher/watch-ignore';

// ============================================================================
// Types
// ============================================================================

interface PendingChange {
  path: string;
  type: 'add' | 'change' | 'unlink';
  timestamp: number;
}

type WatchMode = 'native' | 'polling';

const WATCHER_RECOVERY_BACKOFF_MS = 5_000;
const POLLING_INTERVAL_MS = 30_000;
const RECOVERABLE_WATCH_ERROR_CODES = new Set(['EMFILE', 'ENFILE', 'ENOSPC', 'EPERM']);

// ============================================================================
// CodebaseFileWatcher Class
// ============================================================================

export class CodebaseFileWatcher extends EventEmitter {
  private config: FileWatcherConfig;
  private indexingService: CodebaseIndexingService;

  private watchers = new Map<string, FSWatcher>();
  private rootPaths = new Map<string, string>();
  private pendingChanges = new Map<string, Map<string, PendingChange>>();
  private processTimers = new Map<string, NodeJS.Timeout>();
  private recoveryTimers = new Map<string, NodeJS.Timeout>();
  private lastProcessedAt = new Map<string, number>();
  private watcherModes = new Map<string, WatchMode>();
  private recovering = new Set<string>();

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

    // Initialize pending changes map for this store
    this.pendingChanges.set(storeId, new Map());

    this.startWatcher(storeId, absolutePath, 'native');

    this.emit('watcher:started', { storeId, rootPath: absolutePath });
  }

  private startWatcher(storeId: string, absolutePath: string, mode: WatchMode): void {
    const usePolling = mode === 'polling';
    const watcher = watch(absolutePath, {
      ignored: buildWatchIgnoredMatchers(absolutePath, this.config.ignorePatterns),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
      usePolling,
      ...(usePolling
        ? {
          interval: POLLING_INTERVAL_MS,
          binaryInterval: POLLING_INTERVAL_MS,
        }
        : {}),
      followSymlinks: false,
    });

    watcher.on('add', (filePath) => this.handleChange(storeId, filePath, 'add'));
    watcher.on('change', (filePath) => this.handleChange(storeId, filePath, 'change'));
    watcher.on('unlink', (filePath) => this.handleChange(storeId, filePath, 'unlink'));

    watcher.on('error', (error) => {
      this.handleWatcherError(storeId, absolutePath, mode, error);
    });

    watcher.on('ready', () => {
      this.emit('watcher:ready', { storeId, rootPath: absolutePath });
    });

    this.watchers.set(storeId, watcher);
    this.rootPaths.set(storeId, absolutePath);
    this.watcherModes.set(storeId, mode);
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
    const recoveryTimer = this.recoveryTimers.get(storeId);
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      this.recoveryTimers.delete(storeId);
    }
    const rootPath = this.rootPaths.get(storeId);
    this.rootPaths.delete(storeId);
    this.lastProcessedAt.delete(storeId);
    this.watcherModes.delete(storeId);
    this.recovering.delete(storeId);

    // Clear pending changes
    this.pendingChanges.delete(storeId);

    // Clear timer
    const timer = this.processTimers.get(storeId);
    if (timer) {
      clearTimeout(timer);
      this.processTimers.delete(storeId);
    }

    this.emit('watcher:stopped', { storeId, rootPath });
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
      rootPath: this.rootPaths.get(storeId) ?? '',
      isWatching: true,
      pendingChanges: pending?.size || 0,
      lastProcessedAt: this.lastProcessedAt.get(storeId),
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
    this.emit('change:detected', {
      storeId,
      rootPath: this.rootPaths.get(storeId),
      path: filePath,
      type,
      timestamp: Date.now(),
    });

    // Debounce processing
    this.scheduleProcessing(storeId);
  }

  private handleWatcherError(
    storeId: string,
    rootPath: string,
    mode: WatchMode,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.emit('watcher:error', { storeId, rootPath, error: message });

    if (!this.isRecoverableWatchError(error)) {
      this.emit('warning', {
        storeId,
        message: `File watcher error: ${message}`,
      });
      return;
    }

    this.emit('warning', {
      storeId,
      message: `Recoverable file watcher error (${message}); switching to polling`,
    });

    if (mode === 'polling' || this.recovering.has(storeId)) {
      return;
    }

    this.recovering.add(storeId);
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(storeId);
      void this.recoverWithPolling(storeId, rootPath);
    }, WATCHER_RECOVERY_BACKOFF_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.recoveryTimers.set(storeId, timer);
  }

  private async recoverWithPolling(storeId: string, rootPath: string): Promise<void> {
    try {
      const current = this.watchers.get(storeId);
      if (current) {
        await current.close();
      }
      if (!this.rootPaths.has(storeId)) {
        return;
      }
      this.startWatcher(storeId, rootPath, 'polling');
      this.emit('watcher:recovered', { storeId, rootPath, mode: 'polling' });
    } catch (error) {
      this.emit('watcher:error', {
        storeId,
        rootPath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.recovering.delete(storeId);
    }
  }

  private isRecoverableWatchError(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    return RECOVERABLE_WATCH_ERROR_CODES.has(code);
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

    const rootPath = this.rootPaths.get(storeId);
    this.emit('changes:processing', { storeId, rootPath, count: changes.length });

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

    const processedAt = Date.now();
    this.lastProcessedAt.set(storeId, processedAt);
    this.emit('changes:processed', {
      storeId,
      rootPath,
      additions: additions.length,
      modifications: modifications.length,
      deletions: deletions.length,
      processedAt,
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
