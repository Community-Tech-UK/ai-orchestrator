/**
 * CodememPrewarmCoordinator — auto-warm codemem indexes the moment a workspace
 * enters the app's knowledge.
 *
 * Today codemem only warms on instance spawn (see
 * `src/main/instance/instance-lifecycle.ts`'s `warmCodememWorkspace`). That
 * means a freshly-opened folder gets indexed lazily and the first spawn pays
 * the full cold-index cost on the critical path.
 *
 * This coordinator subscribes to `RecentDirectoriesManager`'s
 * `'directory-added'` event — the canonical chokepoint for "a workspace path
 * entered the app" — and fires `getCodemem().warmWorkspace(path)` in the
 * background with debouncing, deduplication, and a concurrency cap, so the
 * index is already warm (or warming) by the time the user actually launches
 * an instance.
 *
 * Designed to be best-effort and non-fatal: spawn-time warm-up stays in
 * place as the safety net (see plan
 * `docs/plans/2026-05-26-codemem-auto-warm-on-workspace-open.md`).
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import { getCodemem, type CodememService } from './index';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import { getSettingsManager } from '../core/config/settings-manager';
import type { AppSettings } from '../../shared/types/settings.types';
import type { RecentDirectoryEntry } from '../../shared/types/recent-directories.types';

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_WARM_TIMEOUT_MS = 60_000;
const DEFAULT_RECENT_INDEX_SKIP_MS = 30_000;

const logger = getLogger('CodememPrewarm');

/**
 * Minimal interface around the codemem service so tests can stand in a fake
 * without spinning up the full subsystem (sqlite, worker thread, MCP server,
 * etc.).
 */
export interface PrewarmCodememTarget {
  isEnabled(): boolean;
  isIndexingEnabled(): boolean;
  warmWorkspace(workspacePath: string, timeoutMs?: number): Promise<{ ready: boolean; filePath: string | null }>;
  /**
   * Last successful cold-index timestamp for the workspace, or null if it has
   * never been indexed. Used to skip re-warms when the file watcher is already
   * keeping the index live.
   */
  getLastIndexedAt(workspacePath: string): number | null;
}

/**
 * Minimal interface for settings access so tests can inject a fake without
 * standing up the full settings manager + electron-store backing.
 */
export interface PrewarmSettingsTarget {
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
}

export interface CodememPrewarmCoordinatorOptions {
  /**
   * Source of `directory-added` events. Defaults to the singleton.
   * Typed as the base `EventEmitter` so tests can pass a plain emitter without
   * importing the real `RecentDirectoriesManager` (which pulls in
   * `electron-store` and would noisily try to write to disk under vitest).
   */
  recentDirectoriesManager?: EventEmitter;
  /** Codemem service. Defaults to a lazy adapter over `getCodemem()`. */
  codemem?: PrewarmCodememTarget;
  /** Settings provider. Defaults to a lazy adapter over `getSettingsManager()`. */
  settings?: PrewarmSettingsTarget;
  /** Override per-warm timeout (ms). Defaults to 60s — we're off the critical path. */
  warmTimeoutMs?: number;
  /** Override the "skip if already warmed recently" window (ms). */
  recentIndexSkipMs?: number;
  /**
   * Test seam — override the clock used for "is the last index recent enough?"
   * checks.
   */
  now?: () => number;
}

/** Public surface, primarily for tests + `getCodememPrewarmCoordinator()`. */
export class CodememPrewarmCoordinator {
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly queue: string[] = [];
  private readonly queuedSet = new Set<string>();
  private readonly active = new Set<string>();
  /**
   * Paths that have been warm-requested at least once in this app session.
   * Combined with `getLastIndexedAt` to avoid re-warming a workspace whose
   * watcher is already keeping the index live.
   */
  private readonly warmedThisSession = new Set<string>();
  private listenerBound: ((entry: RecentDirectoryEntry) => void) | null = null;
  private started = false;
  private recentDirsManager: EventEmitter | null = null;
  private readonly codemem: PrewarmCodememTarget;
  private readonly settings: PrewarmSettingsTarget;
  private readonly warmTimeoutMs: number;
  private readonly recentIndexSkipMs: number;
  private readonly now: () => number;
  private readonly options: CodememPrewarmCoordinatorOptions;

  constructor(options: CodememPrewarmCoordinatorOptions = {}) {
    this.options = options;
    this.codemem = options.codemem ?? createDefaultCodememTarget();
    this.settings = options.settings ?? createDefaultSettingsTarget();
    this.warmTimeoutMs = options.warmTimeoutMs ?? DEFAULT_WARM_TIMEOUT_MS;
    this.recentIndexSkipMs = options.recentIndexSkipMs ?? DEFAULT_RECENT_INDEX_SKIP_MS;
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
    logger.info('CodememPrewarmCoordinator started');
  }

  /** Detach the listener and clear pending debounce timers (in-flight warms keep running). */
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
    logger.info('CodememPrewarmCoordinator stopped');
  }

  /**
   * Renderer-driven hint that this workspace is the user's current focus.
   * Cancels any debounce, jumps to the front of the queue, or fires immediately
   * if no warm is currently in progress for it.
   */
  hintActiveWorkspace(workspacePath: string | null | undefined): void {
    const normalized = this.normalizePath(workspacePath);
    if (!normalized) return;

    if (!this.isPrewarmEnabled()) return;

    // Belt & braces — the manager already verifies existence for local paths.
    if (!this.pathExistsAsDirectory(normalized)) {
      return;
    }
    if (this.isBroadPrewarmRoot(normalized)) {
      logger.info('Codemem prewarm skipped broad filesystem root', { workspacePath: normalized });
      return;
    }

    // Clear any debounce: we'll act immediately.
    const timer = this.debounceTimers.get(normalized);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(normalized);
    }

    if (this.active.has(normalized)) {
      return;
    }

    if (this.shouldSkipBecauseRecentlyIndexed(normalized)) {
      return;
    }

    // Remove from queue (if pending) so we can move it to the front.
    this.removeFromQueue(normalized);

    this.queue.unshift(normalized);
    this.queuedSet.add(normalized);

    void this.drainQueue();
  }

  /**
   * Test seam — returns a snapshot of internal state useful for assertions.
   */
  _inspectForTesting(): {
    queue: string[];
    active: string[];
    warmedThisSession: string[];
    debouncedPaths: string[];
  } {
    return {
      queue: [...this.queue],
      active: [...this.active],
      warmedThisSession: [...this.warmedThisSession],
      debouncedPaths: [...this.debounceTimers.keys()],
    };
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
    this.queuedSet.clear();
    this.active.clear();
    this.warmedThisSession.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private onDirectoryAdded(entry: RecentDirectoryEntry): void {
    // Remote paths live on another machine — codemem can't index them locally.
    // The remote node owns its own codemem instance.
    if (entry.nodeId) return;

    if (!this.isPrewarmEnabled()) return;

    const normalized = this.normalizePath(entry.path);
    if (!normalized) return;

    if (!this.pathExistsAsDirectory(normalized)) return;
    if (this.isBroadPrewarmRoot(normalized)) {
      logger.info('Codemem prewarm skipped broad filesystem root', { workspacePath: normalized });
      return;
    }

    this.scheduleDebounce(normalized);
  }

  private scheduleDebounce(workspacePath: string): void {
    const existing = this.debounceTimers.get(workspacePath);
    if (existing) {
      clearTimeout(existing);
    }
    const delay = this.getDebounceMs();
    if (delay <= 0) {
      // Zero-debounce path used by tests that want immediate enqueue without
      // having to advance fake timers.
      this.debounceTimers.delete(workspacePath);
      this.enqueue(workspacePath);
      return;
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(workspacePath);
      this.enqueue(workspacePath);
    }, delay);
    // Don't keep the Node event loop alive for a pending debounce.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.debounceTimers.set(workspacePath, timer);
  }

  private enqueue(workspacePath: string): void {
    if (this.active.has(workspacePath) || this.queuedSet.has(workspacePath)) {
      return;
    }
    if (this.shouldSkipBecauseRecentlyIndexed(workspacePath)) {
      return;
    }
    this.queue.push(workspacePath);
    this.queuedSet.add(workspacePath);
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    const cap = this.getMaxConcurrent();
    while (this.active.size < cap && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.queuedSet.delete(next);
      this.active.add(next);
      // Fire-and-forget: each warm runs to completion independently.
      void this.warmOne(next).finally(() => {
        this.active.delete(next);
        void this.drainQueue();
      });
    }
  }

  private async warmOne(workspacePath: string): Promise<void> {
    if (!this.isPrewarmEnabled()) {
      // Re-check on dispatch — settings may have flipped between enqueue and
      // dispatch. Mark as "warmed this session" so we don't keep re-enqueuing
      // the same path while prewarm stays disabled.
      this.warmedThisSession.add(workspacePath);
      return;
    }

    logger.info('Codemem prewarm starting', { workspacePath });

    try {
      const result = await this.codemem.warmWorkspace(workspacePath, this.warmTimeoutMs);
      logger.info('Codemem prewarm completed', {
        workspacePath,
        ready: result.ready,
        representativeFile: result.filePath,
      });
    } catch (error) {
      logger.warn('Codemem prewarm failed; will allow spawn-time warm-up to retry', {
        workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Add to "ever warmed this session" regardless of success — combined with
      // a fresh `lastIndexedAt`, this lets us short-circuit duplicate events
      // for the same workspace within the recent-index window. If the warm
      // failed and `lastIndexedAt` is null/stale, future events will retry.
      this.warmedThisSession.add(workspacePath);
    }
  }

  private shouldSkipBecauseRecentlyIndexed(workspacePath: string): boolean {
    if (!this.warmedThisSession.has(workspacePath)) {
      return false;
    }
    const lastIndexedAt = this.codemem.getLastIndexedAt(workspacePath);
    if (lastIndexedAt == null) {
      return false;
    }
    return this.now() - lastIndexedAt <= this.recentIndexSkipMs;
  }

  private removeFromQueue(workspacePath: string): void {
    if (!this.queuedSet.has(workspacePath)) return;
    const idx = this.queue.indexOf(workspacePath);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
    this.queuedSet.delete(workspacePath);
  }

  private isPrewarmEnabled(): boolean {
    if (!this.codemem.isEnabled() || !this.codemem.isIndexingEnabled()) {
      return false;
    }
    const enabled = this.settings.get('codememPrewarmEnabled');
    return enabled !== false;
  }

  private getMaxConcurrent(): number {
    const raw = this.settings.get('codememPrewarmMaxConcurrent');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.max(1, Math.floor(raw));
    }
    return DEFAULT_MAX_CONCURRENT;
  }

  private getDebounceMs(): number {
    const raw = this.settings.get('codememPrewarmDebounceMs');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return Math.floor(raw);
    }
    return DEFAULT_DEBOUNCE_MS;
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

  private isBroadPrewarmRoot(workspacePath: string): boolean {
    const normalized = path.resolve(workspacePath);
    const root = path.parse(normalized).root;
    if (normalized === root) {
      return true;
    }

    const home = path.resolve(os.homedir());
    const workRoot = path.join(home, 'work');
    return (
      normalized === home
      || normalized === path.dirname(home)
      || normalized === workRoot
      || normalized === '/private/tmp'
    );
  }
}

// ── Default adapters over the live singletons ───────────────────────────────

function createDefaultCodememTarget(): PrewarmCodememTarget {
  return {
    isEnabled: () => getCodemem().isEnabled(),
    isIndexingEnabled: () => getCodemem().isIndexingEnabled(),
    warmWorkspace: (workspacePath, timeoutMs) =>
      getCodemem().warmWorkspace(workspacePath, timeoutMs),
    getLastIndexedAt: (workspacePath) =>
      getLastIndexedAtForCodemem(getCodemem(), workspacePath),
  };
}

function getLastIndexedAtForCodemem(codemem: CodememService, workspacePath: string): number | null {
  try {
    const resolved = path.resolve(workspacePath);
    const root = codemem.store.getWorkspaceRootByPath(resolved);
    return root?.lastIndexedAt ?? null;
  } catch {
    return null;
  }
}

function createDefaultSettingsTarget(): PrewarmSettingsTarget {
  return {
    get<K extends keyof AppSettings>(key: K): AppSettings[K] {
      // Wrapped in try/catch because some test runs construct the coordinator
      // before the settings manager singleton has been initialised. In that
      // case we want the coordinator to fall back to defaults rather than
      // throw and crash app startup. The cast through `unknown` is necessary
      // because `AppSettings[K]` is a generic union of concrete types, none of
      // which include `undefined`; callers in this module always perform
      // narrowing (e.g. `typeof raw === 'number'`) before using the value.
      try {
        return getSettingsManager().get(key);
      } catch {
        return undefined as unknown as AppSettings[K];
      }
    },
  };
}

// ── Singleton accessor ──────────────────────────────────────────────────────

let coordinatorInstance: CodememPrewarmCoordinator | null = null;

export function getCodememPrewarmCoordinator(): CodememPrewarmCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new CodememPrewarmCoordinator();
  }
  return coordinatorInstance;
}

export function resetCodememPrewarmCoordinatorForTesting(): void {
  if (coordinatorInstance) {
    coordinatorInstance._resetForTesting();
  }
  coordinatorInstance = null;
}
