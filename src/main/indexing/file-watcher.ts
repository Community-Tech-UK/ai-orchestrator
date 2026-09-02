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
import { getCodebaseIndexingLaneGateway } from './codebase-indexing-lane-gateway';
import {
  MAX_INDEXING_LANE_BATCH_FILES,
  type CodebaseIndexingFileOperation,
  type CodebaseIndexingSyncFilesResult,
} from './codebase-indexing-lane-protocol';
import { buildWatchIgnoredMatchers } from '../workspace/watcher/watch-ignore';

// ============================================================================
// Types
// ============================================================================

interface PendingChange {
  path: string;
  type: 'add' | 'change' | 'unlink';
  timestamp: number;
}

interface WatcherRecord {
  storeId: string;
  rootPath: string;
  registrationId: symbol;
  watcher: FSWatcher;
}

export interface CodebaseFileWatcherRegistration {
  dispose(): Promise<void>;
}

export interface CodebaseFileIndexingTarget {
  syncFiles(
    storeId: string,
    deletions: string[],
    upserts: string[],
  ): Promise<CodebaseIndexingSyncFilesResult>;
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
  private readonly indexingTarget: CodebaseFileIndexingTarget;

  private watchers = new Map<string, WatcherRecord>();
  private ownedWatchers = new Map<symbol, WatcherRecord>();
  private watcherClosures = new Map<symbol, Promise<void>>();
  private latestStartIds = new Map<string, symbol>();
  private rootPaths = new Map<string, string>();
  private pendingChanges = new Map<string, Map<string, PendingChange>>();
  private processTimers = new Map<string, NodeJS.Timeout>();
  private recoveryTimers = new Map<string, NodeJS.Timeout>();
  private lastProcessedAt = new Map<string, number>();
  private watcherModes = new Map<string, WatchMode>();
  private recovering = new Set<string>();

  constructor(
    config: Partial<FileWatcherConfig> = {},
    indexingTarget: CodebaseFileIndexingTarget = getCodebaseIndexingLaneGateway(),
  ) {
    super();
    this.config = { ...DEFAULT_FILE_WATCHER_CONFIG, ...config };
    this.indexingTarget = indexingTarget;
  }

  /**
   * Start watching a directory for a store.
   */
  async startWatching(
    storeId: string,
    rootPath: string,
  ): Promise<CodebaseFileWatcherRegistration> {
    const registrationId = Symbol(storeId);
    this.latestStartIds.set(storeId, registrationId);
    const registration = this.createRegistration(storeId, registrationId);
    const existing = this.watchers.get(storeId);
    try {
      if (existing) {
        await this.disposeRegistration(storeId, existing.registrationId);
      }
    } catch (error) {
      if (this.latestStartIds.get(storeId) === registrationId) {
        this.latestStartIds.delete(storeId);
      }
      throw error;
    }
    if (this.latestStartIds.get(storeId) !== registrationId) {
      return registration;
    }

    const absolutePath = path.resolve(rootPath);

    // Initialize pending changes map for this store
    this.pendingChanges.set(storeId, new Map());

    try {
      this.startWatcher(storeId, absolutePath, 'native', registrationId);
    } catch (error) {
      if (this.latestStartIds.get(storeId) === registrationId) {
        this.latestStartIds.delete(storeId);
      }
      throw error;
    }

    this.emit('watcher:started', { storeId, rootPath: absolutePath });
    return registration;
  }

  private startWatcher(
    storeId: string,
    absolutePath: string,
    mode: WatchMode,
    registrationId: symbol,
  ): void {
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

    watcher.on('add', (filePath) => this.handleChange(storeId, registrationId, filePath, 'add'));
    watcher.on('change', (filePath) => this.handleChange(storeId, registrationId, filePath, 'change'));
    watcher.on('unlink', (filePath) => this.handleChange(storeId, registrationId, filePath, 'unlink'));

    watcher.on('error', (error) => {
      this.handleWatcherError(storeId, absolutePath, mode, registrationId, error);
    });

    watcher.on('ready', () => {
      if (this.watchers.get(storeId)?.registrationId === registrationId) {
        this.emit('watcher:ready', { storeId, rootPath: absolutePath });
      }
    });

    const record = { storeId, rootPath: absolutePath, registrationId, watcher };
    this.watchers.set(storeId, record);
    this.ownedWatchers.set(registrationId, record);
    this.rootPaths.set(storeId, absolutePath);
    this.watcherModes.set(storeId, mode);
  }

  /**
   * Stop watching a directory for a store.
   */
  async stopWatching(storeId: string): Promise<void> {
    this.latestStartIds.delete(storeId);
    const owned = Array.from(this.ownedWatchers.values()).filter(
      (record) => record.storeId === storeId,
    );
    if (owned.length > 0) {
      await Promise.all(owned.map((record) => (
        this.disposeRegistration(storeId, record.registrationId)
      )));
      return;
    }
    this.clearStoreState(storeId);
    this.emit('watcher:stopped', { storeId, rootPath: undefined });
  }

  private createRegistration(
    storeId: string,
    registrationId: symbol,
  ): CodebaseFileWatcherRegistration {
    return {
      dispose: () => this.disposeRegistration(storeId, registrationId),
    };
  }

  private async disposeRegistration(storeId: string, registrationId: symbol): Promise<void> {
    const record = this.ownedWatchers.get(registrationId);
    if (record?.storeId !== storeId) return;
    if (this.watchers.get(storeId)?.registrationId === registrationId) {
      this.watchers.delete(storeId);
      this.clearStoreState(storeId);
    }
    if (this.latestStartIds.get(storeId) === registrationId) {
      this.latestStartIds.delete(storeId);
    }
    const existingClosure = this.watcherClosures.get(registrationId);
    if (existingClosure) {
      await existingClosure;
      return;
    }
    const closure = this.closeOwnedWatcher(record);
    this.watcherClosures.set(registrationId, closure);
    await closure;
  }

  private async closeOwnedWatcher(record: WatcherRecord): Promise<void> {
    try {
      await record.watcher.close();
      if (this.ownedWatchers.get(record.registrationId) === record) {
        this.ownedWatchers.delete(record.registrationId);
      }
      this.emit('watcher:stopped', { storeId: record.storeId, rootPath: record.rootPath });
    } finally {
      this.watcherClosures.delete(record.registrationId);
    }
  }

  private clearStoreState(storeId: string): void {
    const recoveryTimer = this.recoveryTimers.get(storeId);
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      this.recoveryTimers.delete(storeId);
    }
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
  }

  /**
   * Stop all watchers.
   */
  async stopAll(): Promise<void> {
    const storeIds = Array.from(new Set([
      ...this.watchers.keys(),
      ...Array.from(this.ownedWatchers.values(), (record) => record.storeId),
      ...this.latestStartIds.keys(),
    ]));
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

  private handleChange(
    storeId: string,
    registrationId: symbol,
    filePath: string,
    type: 'add' | 'change' | 'unlink',
  ): void {
    if (this.watchers.get(storeId)?.registrationId !== registrationId) return;
    // Check if file should be included
    if (type !== 'unlink' && !shouldIncludeFile(filePath, DEFAULT_INDEXING_CONFIG)) {
      return;
    }

    const pending = this.pendingChanges.get(storeId);
    if (!pending) {
      return;
    }

    // Check max pending limit
    if (!pending.has(filePath) && pending.size >= this.config.maxPendingChanges) {
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
    registrationId: symbol,
    error: unknown,
  ): void {
    if (this.watchers.get(storeId)?.registrationId !== registrationId) return;
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
      void this.recoverWithPolling(storeId, rootPath, registrationId);
    }, WATCHER_RECOVERY_BACKOFF_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.recoveryTimers.set(storeId, timer);
  }

  private async recoverWithPolling(
    storeId: string,
    rootPath: string,
    registrationId: symbol,
  ): Promise<void> {
    try {
      const current = this.watchers.get(storeId);
      if (current?.registrationId !== registrationId) return;
      await current.watcher.close();
      if (
        this.watchers.get(storeId)?.registrationId !== registrationId
        || this.latestStartIds.get(storeId) !== registrationId
      ) {
        return;
      }
      this.startWatcher(storeId, rootPath, 'polling', registrationId);
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

    const filesToIndex = [...additions, ...modifications];
    const upserts = this.config.autoIndex ? filesToIndex : [];
    if (!this.config.autoIndex) {
      for (const filePath of filesToIndex) {
        this.emit('file:pending', { storeId, filePath });
      }
    }

    if (deletions.length > 0 || upserts.length > 0) {
      await this.processSyncFileChunks(storeId, deletions, 'removed');
      await this.processSyncFileChunks(storeId, upserts, 'indexed');
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

  private async processSyncFileChunks(
    storeId: string,
    filePaths: string[],
    operation: CodebaseIndexingFileOperation,
  ): Promise<void> {
    for (let offset = 0; offset < filePaths.length; offset += MAX_INDEXING_LANE_BATCH_FILES) {
      const chunk = filePaths.slice(offset, offset + MAX_INDEXING_LANE_BATCH_FILES);
      const deletions = operation === 'removed' ? chunk : [];
      const upserts = operation === 'indexed' ? chunk : [];
      await this.processSyncFileChunk(storeId, deletions, upserts);
    }
  }

  private async processSyncFileChunk(
    storeId: string,
    deletions: string[],
    upserts: string[],
  ): Promise<void> {
    try {
      const result = await this.indexingTarget.syncFiles(storeId, deletions, upserts);
      this.emitSyncFileOutcomes(storeId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const filePath of [...deletions, ...upserts]) {
        this.emit('file:error', { storeId, filePath, error: message });
      }
    }
  }

  private emitSyncFileOutcomes(
    storeId: string,
    result: CodebaseIndexingSyncFilesResult,
  ): void {
    for (const outcome of result.outcomes) {
      if (!outcome.success) {
        this.emit('file:error', {
          storeId,
          filePath: outcome.filePath,
          error: outcome.error ?? 'Indexing lane file operation failed',
        });
      } else if (outcome.operation === 'removed') {
        this.emit('file:removed', { storeId, filePath: outcome.filePath });
      } else {
        this.emit('file:indexed', { storeId, filePath: outcome.filePath });
      }
    }
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
