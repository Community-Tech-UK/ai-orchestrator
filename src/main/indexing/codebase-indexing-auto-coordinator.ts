/**
 * CodebaseIndexingAutoCoordinator — auto-runs the heavier
 * `CodebaseIndexingService` (BM25 + vector + Merkle + hybrid search) whenever
 * a workspace enters the app's knowledge.
 *
 * This is the second of two indexers that subscribe to
 * `RecentDirectoriesManager`'s `'directory-added'` event. The other —
 * `CodememPrewarmCoordinator` — fires fast AST/LSP indexing. This one runs
 * the embedding-based pipeline, which is much heavier, so it has a stricter
 * concurrency cap (1 at a time), a longer debounce, and a size-based
 * preflight that gates whether we touch the workspace at all.
 *
 * Design doc: docs/plans/2026-05-26-codebase-indexing-auto-start.md
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import {
  createDefaultContextManagerTarget,
  createDefaultFileWatcherTarget,
  createDefaultIndexingTarget,
  createDefaultRegistryTarget,
  createDefaultSettingsTarget,
  defaultPreflight,
  defaultStoreIdResolver,
} from './codebase-indexing-auto-defaults';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import type { RecentDirectoryEntry } from '../../shared/types/recent-directories.types';
import type {
  CodebaseAutoIndexStatus,
  IndexingProgress,
} from '../../shared/types/codebase.types';
import type { ContextStore } from '../../shared/types/rlm.types';
import { DEFAULT_INDEXING_CONFIG, shouldIncludeFile } from './config';
import type {
  AutoIndexContextManagerTarget,
  AutoIndexFileWatcherTarget,
  AutoIndexingTarget,
  AutoIndexProjectRegistryTarget,
  AutoIndexSettingsTarget,
  CodebaseAutoStatusEvent,
  CodebaseAutoStatusPartial,
  CodebaseIndexingAutoCoordinatorOptions,
  PreflightResult,
} from './codebase-indexing-auto.types';

export type {
  AutoIndexContextManagerTarget,
  AutoIndexFileWatcherTarget,
  AutoIndexingTarget,
  AutoIndexProjectRegistryTarget,
  AutoIndexSettingsTarget,
  CodebaseAutoStatusEvent,
  CodebaseIndexingAutoCoordinatorOptions,
  PreflightResult,
} from './codebase-indexing-auto.types';

const logger = getLogger('CodebaseAutoIndex');

const DEFAULT_MAX_FILES = 3_000;
const DEFAULT_MAX_BYTES = 150 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_DEBOUNCE_MS = 15_000;

interface QueueEntry {
  rootPath: string;
  storeId: string;
}

export class CodebaseIndexingAutoCoordinator extends EventEmitter {
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly queue: QueueEntry[] = [];
  private readonly queuedPaths = new Set<string>();
  private readonly active = new Set<string>();
  private readonly statuses = new Map<string, CodebaseAutoIndexStatus>();
  private listenerBound: ((entry: RecentDirectoryEntry) => void) | null = null;
  private started = false;
  private recentDirsManager: EventEmitter | null = null;

  private readonly indexingService: AutoIndexingTarget;
  private readonly fileWatcher: AutoIndexFileWatcherTarget;
  private readonly contextManager: AutoIndexContextManagerTarget;
  private readonly registry: AutoIndexProjectRegistryTarget;
  private readonly settings: AutoIndexSettingsTarget;
  private readonly storeIdResolver: (rootPath: string) => string;
  private readonly preflightFn: (
    rootPath: string,
    limits: { maxFiles: number; maxBytes: number },
  ) => Promise<PreflightResult>;
  private readonly now: () => number;
  private readonly options: CodebaseIndexingAutoCoordinatorOptions;

  constructor(options: CodebaseIndexingAutoCoordinatorOptions = {}) {
    super();
    this.options = options;
    this.indexingService = options.indexingService ?? createDefaultIndexingTarget();
    this.fileWatcher = options.fileWatcher ?? createDefaultFileWatcherTarget();
    this.contextManager = options.contextManager ?? createDefaultContextManagerTarget();
    this.registry = options.registry ?? createDefaultRegistryTarget();
    this.settings = options.settings ?? createDefaultSettingsTarget();
    this.storeIdResolver = options.storeIdResolver ?? defaultStoreIdResolver;
    this.preflightFn = options.preflight ?? defaultPreflight;
    this.now = options.now ?? (() => Date.now());
  }

  /** Idempotent — attach the listener once. */
  start(): void {
    if (this.started) return;
    const manager = this.options.recentDirectoriesManager ?? getRecentDirectoriesManager();
    this.recentDirsManager = manager;
    this.listenerBound = (entry: RecentDirectoryEntry) => this.onDirectoryAdded(entry);
    manager.on('directory-added', this.listenerBound);
    this.started = true;
    void this.restorePersistedWatchers();
    logger.info('CodebaseIndexingAutoCoordinator started');
  }

  /** Detach the listener and clear pending debounce timers. */
  stop(): void {
    if (!this.started) return;
    if (this.recentDirsManager && this.listenerBound) {
      this.recentDirsManager.off('directory-added', this.listenerBound);
    }
    this.listenerBound = null;
    this.recentDirsManager = null;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.started = false;
    logger.info('CodebaseIndexingAutoCoordinator stopped');
  }

  /**
   * Renderer-driven hint that this workspace is the user's current focus.
   * Cancels any debounce, jumps to the front of the queue, or fires immediately
   * if no run is currently in progress for it.
   */
  hintActiveWorkspace(workspacePath: string | null | undefined): void {
    const normalized = this.normalizePath(workspacePath);
    if (!normalized) return;

    if (!this.isEnabled()) return;
    if (!this.pathExistsAsDirectory(normalized)) return;
    if (!this.registry.canAutoMine(normalized)) {
      this.recordStatus(normalized, {
        state: 'skipped',
        reason: 'excluded',
      });
      return;
    }

    // Cancel any pending debounce — we'll act immediately.
    const timer = this.debounceTimers.get(normalized);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(normalized);
    }

    if (this.active.has(normalized)) {
      // Already running — nothing to do.
      return;
    }

    // Remove from queue (if pending) so we can move it to the front.
    this.removeFromQueue(normalized);

    const storeId = this.storeIdResolver(normalized);
    this.queue.unshift({ rootPath: normalized, storeId });
    this.queuedPaths.add(normalized);
    this.recordStatus(normalized, { state: 'queued', storeId });

    void this.drainQueue();
  }

  /** Read the current status for a workspace (immutable copy). */
  getStatus(rootPath: string): CodebaseAutoIndexStatus | undefined {
    const normalized = this.normalizePath(rootPath);
    if (!normalized) return undefined;
    const existing = this.statuses.get(normalized);
    return existing ? { ...existing } : undefined;
  }

  /** Read all known statuses (immutable copies). */
  listStatuses(): CodebaseAutoIndexStatus[] {
    return Array.from(this.statuses.values()).map((status) => ({ ...status }));
  }

  /** Test seam — wipe state so each test starts clean. */
  _resetForTesting(): void {
    if (this.started) {
      this.stop();
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.queue.length = 0;
    this.queuedPaths.clear();
    this.active.clear();
    this.statuses.clear();
  }

  /** Test seam — snapshot of internal state. */
  _inspectForTesting(): {
    queue: QueueEntry[];
    active: string[];
    debouncedPaths: string[];
    statuses: CodebaseAutoIndexStatus[];
  } {
    return {
      queue: [...this.queue],
      active: [...this.active],
      debouncedPaths: [...this.debounceTimers.keys()],
      statuses: this.listStatuses(),
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private onDirectoryAdded(entry: RecentDirectoryEntry): void {
    // Remote paths live on another machine; those nodes own their own indices.
    if (entry.nodeId) {
      const normalized = this.normalizePath(entry.path);
      if (normalized) {
        this.recordStatus(normalized, { state: 'skipped', reason: 'remote' });
      }
      return;
    }

    if (!this.isEnabled()) {
      const normalized = this.normalizePath(entry.path);
      if (normalized) {
        this.recordStatus(normalized, { state: 'skipped', reason: 'disabled' });
      }
      return;
    }

    const normalized = this.normalizePath(entry.path);
    if (!normalized) return;

    if (!this.pathExistsAsDirectory(normalized)) return;
    if (!this.registry.canAutoMine(normalized)) {
      this.recordStatus(normalized, { state: 'skipped', reason: 'excluded' });
      return;
    }

    this.scheduleDebounce(normalized);
  }

  private async restorePersistedWatchers(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    const stores = this.contextManager.listStores?.() ?? [];
    for (const store of stores) {
      const config = store.config;
      if (config?.['kind'] !== 'codebase-auto') {
        continue;
      }
      const rootPath = config['rootPath'];
      if (typeof rootPath !== 'string') {
        continue;
      }
      const normalized = this.normalizePath(rootPath);
      if (!normalized || !this.pathExistsAsDirectory(normalized)) {
        continue;
      }
      if (!this.registry.canAutoMine(normalized)) {
        this.recordStatus(normalized, {
          state: 'skipped',
          reason: 'excluded',
          storeId: store.id,
        });
        continue;
      }
      try {
        await this.fileWatcher.startWatching(store.id, normalized);
        this.recordStatus(normalized, {
          state: 'complete',
          storeId: store.id,
        });
        if (this.storeNeedsReindexForCurrentFilters(store)) {
          logger.info('Persisted codebase store contains stale excluded sections; scheduling repair reindex', {
            rootPath: normalized,
            storeId: store.id,
          });
          this.enqueue(normalized);
        }
      } catch (error) {
        logger.warn('Failed to restore codebase file watcher', {
          rootPath: normalized,
          storeId: store.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private scheduleDebounce(rootPath: string): void {
    const existing = this.debounceTimers.get(rootPath);
    if (existing) {
      clearTimeout(existing);
    }
    const delay = this.getDebounceMs();
    if (delay <= 0) {
      this.debounceTimers.delete(rootPath);
      this.enqueue(rootPath);
      return;
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(rootPath);
      this.enqueue(rootPath);
    }, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.debounceTimers.set(rootPath, timer);
  }

  private enqueue(rootPath: string): void {
    if (this.active.has(rootPath) || this.queuedPaths.has(rootPath)) {
      return;
    }
    const storeId = this.storeIdResolver(rootPath);
    this.queue.push({ rootPath, storeId });
    this.queuedPaths.add(rootPath);
    this.recordStatus(rootPath, { state: 'queued', storeId });
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    const cap = this.getMaxConcurrent();
    while (this.active.size < cap && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.queuedPaths.delete(next.rootPath);
      this.active.add(next.rootPath);
      void this.runOne(next).finally(() => {
        this.active.delete(next.rootPath);
        void this.drainQueue();
      });
    }
  }

  private async runOne(entry: QueueEntry): Promise<void> {
    const { rootPath, storeId } = entry;

    if (!this.isEnabled()) {
      // Settings flipped between enqueue and dispatch.
      this.recordStatus(rootPath, { state: 'skipped', reason: 'disabled', storeId });
      return;
    }

    // Preflight — count files + bytes. Skip if exceeds limits.
    const limits = {
      maxFiles: this.getMaxFiles(),
      maxBytes: this.getMaxBytes(),
    };

    let preflight: PreflightResult;
    try {
      preflight = await this.preflightFn(rootPath, limits);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Codebase auto-index preflight failed', { rootPath, error: message });
      this.recordStatus(rootPath, {
        state: 'failed',
        reason: 'error',
        storeId,
        errorMessage: message,
      });
      return;
    }

    if (preflight.exceeded) {
      logger.info('Codebase auto-index skipped — workspace too large', {
        rootPath,
        exceeded: preflight.exceeded,
        files: preflight.fileCount,
        bytes: preflight.totalBytes,
      });
      this.recordStatus(rootPath, {
        state: 'skipped',
        reason: 'too_large',
        storeId,
        filesProcessed: preflight.fileCount,
      });
      return;
    }

    // Ensure the RLM context store exists. createStore is idempotent on
    // `instanceId`, so repeated calls per workspace return the same store.
    let resolvedStoreId = storeId;
    try {
      const store = this.contextManager.createStore(storeId, {
        kind: 'codebase-auto',
        rootPath,
      });
      resolvedStoreId = store.id;
    } catch (err) {
      logger.warn('Failed to ensure RLM store for codebase auto-index', {
        rootPath,
        storeId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through using the original storeId — `indexCodebase` will surface
      // any persistence errors as a failed status below.
    }

    const startedAt = this.now();
    let progressListener: ((progress: IndexingProgress) => void) | null = null;
    this.recordStatus(rootPath, {
      state: 'running',
      storeId: resolvedStoreId,
      startedAt,
      filesProcessed: 0,
      chunksProcessed: 0,
    });

    try {
      progressListener = (progress: IndexingProgress) => {
        this.updateRunningProgress(rootPath, resolvedStoreId, progress);
      };
      this.indexingService.on('progress', progressListener);

      logger.info('Codebase auto-index starting', { rootPath, storeId: resolvedStoreId });
      const stats = await this.indexingService.indexCodebase(resolvedStoreId, rootPath, {
        force: false,
      });

      this.recordStatus(rootPath, {
        state: 'complete',
        storeId: resolvedStoreId,
        startedAt,
        completedAt: this.now(),
        filesProcessed: stats.filesIndexed,
        chunksProcessed: stats.chunksCreated,
      });

      // Start the file watcher so subsequent local changes are picked up
      // incrementally. Failures here are non-fatal — the index itself is
      // already up-to-date.
      try {
        await this.fileWatcher.startWatching(resolvedStoreId, rootPath);
      } catch (watcherErr) {
        logger.warn('Failed to start codebase file watcher after auto-index', {
          rootPath,
          error: watcherErr instanceof Error ? watcherErr.message : String(watcherErr),
        });
      }

      logger.info('Codebase auto-index complete', {
        rootPath,
        filesIndexed: stats.filesIndexed,
        chunksCreated: stats.chunksCreated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Codebase auto-index failed', { rootPath, error: message });
      this.recordStatus(rootPath, {
        state: 'failed',
        reason: 'error',
        storeId: resolvedStoreId,
        startedAt,
        completedAt: this.now(),
        errorMessage: message,
      });
    } finally {
      if (progressListener) {
        this.indexingService.off('progress', progressListener);
      }
    }
  }

  private updateRunningProgress(
    rootPath: string,
    storeId: string,
    progress: IndexingProgress,
  ): void {
    const existing = this.statuses.get(rootPath);
    if (!existing || existing.state !== 'running' || existing.storeId !== storeId) {
      // The status moved on (cancelled, replaced) — ignore this progress tick.
      return;
    }
    this.recordStatus(rootPath, {
      state: 'running',
      storeId,
      startedAt: existing.startedAt,
      filesProcessed: progress.processedFiles,
      chunksProcessed: progress.totalChunks,
    });
  }

  private recordStatus(
    rootPath: string,
    partial: CodebaseAutoStatusPartial,
  ): void {
    const previous = this.statuses.get(rootPath);
    const storeId = partial.storeId ?? previous?.storeId ?? this.storeIdResolver(rootPath);

    const cleaned: CodebaseAutoIndexStatus = {
      rootPath,
      storeId,
      state: partial.state,
    };
    if (partial.reason !== undefined) cleaned.reason = partial.reason;
    if (partial.startedAt !== undefined) cleaned.startedAt = partial.startedAt;
    if (partial.completedAt !== undefined) cleaned.completedAt = partial.completedAt;
    if (partial.filesProcessed !== undefined) cleaned.filesProcessed = partial.filesProcessed;
    if (partial.chunksProcessed !== undefined) cleaned.chunksProcessed = partial.chunksProcessed;
    if (partial.errorMessage !== undefined) cleaned.errorMessage = partial.errorMessage;

    this.statuses.set(rootPath, cleaned);
    this.emit('status', { ...cleaned } satisfies CodebaseAutoStatusEvent);
  }

  private removeFromQueue(rootPath: string): void {
    if (!this.queuedPaths.has(rootPath)) return;
    const idx = this.queue.findIndex((entry) => entry.rootPath === rootPath);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
    this.queuedPaths.delete(rootPath);
  }

  private isEnabled(): boolean {
    const enabled = this.settings.get('codebaseAutoIndexEnabled');
    return enabled !== false;
  }

  private getMaxConcurrent(): number {
    const raw = this.settings.get('codebaseAutoIndexConcurrent');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.max(1, Math.floor(raw));
    }
    return DEFAULT_MAX_CONCURRENT;
  }

  private getDebounceMs(): number {
    const raw = this.settings.get('codebaseAutoIndexDebounceMs');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return Math.floor(raw);
    }
    return DEFAULT_DEBOUNCE_MS;
  }

  private getMaxFiles(): number {
    const raw = this.settings.get('codebaseAutoIndexMaxFiles');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.floor(raw);
    }
    return DEFAULT_MAX_FILES;
  }

  private getMaxBytes(): number {
    const raw = this.settings.get('codebaseAutoIndexMaxBytes');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.floor(raw);
    }
    return DEFAULT_MAX_BYTES;
  }

  private normalizePath(workspacePath: string | null | undefined): string | null {
    if (!workspacePath) return null;
    const trimmed = workspacePath.trim();
    if (!trimmed) return null;
    try {
      return path.resolve(trimmed);
    } catch {
      return null;
    }
  }

  private pathExistsAsDirectory(workspacePath: string): boolean {
    try {
      const stat = fs.statSync(workspacePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private storeNeedsReindexForCurrentFilters(store: ContextStore): boolean {
    return store.sections.some((section) => (
      section.type === 'file'
      && typeof section.filePath === 'string'
      && !shouldIncludeFile(section.filePath, DEFAULT_INDEXING_CONFIG)
    ));
  }
}

// ── Singleton accessor ──────────────────────────────────────────────────────

let coordinatorInstance: CodebaseIndexingAutoCoordinator | null = null;

export function getCodebaseIndexingAutoCoordinator(): CodebaseIndexingAutoCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new CodebaseIndexingAutoCoordinator();
  }
  return coordinatorInstance;
}

export function resetCodebaseIndexingAutoCoordinatorForTesting(): void {
  if (coordinatorInstance) {
    coordinatorInstance._resetForTesting();
  }
  coordinatorInstance = null;
}
