/**
 * ProjectKnowledgeAutoMirrorCoordinator — auto-runs
 * `ProjectKnowledgeCoordinator.ensureProjectKnown(path, 'recent-directory-open',
 * { autoRefresh: true })` whenever a workspace path enters the app.
 *
 * Today the bridge that mirrors codemem's snapshot into the RLM
 * `project_code_index_status` / `project_code_symbols` / `project_knowledge_*`
 * tables (the data behind the Knowledge Graph read model + project-knowledge
 * UI + wake-context hints) only fires on instance spawn (see
 * `src/main/instance/instance-lifecycle.ts`'s `ensureProjectKnown` call). A
 * user who opens a folder but doesn't spawn an instance leaves the RLM
 * mirror stale, so the project shows zero `code_file` / `code_symbol`
 * evidence in those surfaces.
 *
 * This coordinator subscribes to `RecentDirectoriesManager`'s
 * `'directory-added'` event — the canonical chokepoint for "a workspace path
 * entered the app" — and triggers the mirror in the background with
 * debouncing, concurrency capping, and a `lastSyncedAt` short-circuit so a
 * recently-completed mirror doesn't kick off another expensive run.
 *
 * Design doc: docs/plans/2026-05-26-project-code-index-bridge-auto-mirror.md.
 * The two sibling coordinators that subscribe to the same event are
 * `CodememPrewarmCoordinator` (fast LSP/AST warm-up) and
 * `CodebaseIndexingAutoCoordinator` (heavier embedding pipeline). Each owns
 * its own queue, settings, and status — see the design doc for why we don't
 * fold them together.
 *
 * The existing spawn-time call in `instance-lifecycle.ts` stays in place as
 * the safety net for instances restored from history or attached to remote
 * nodes — see the "De-duplication" section of the design doc.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import { getCodemem, type CodememService } from '../codemem';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import { getSettingsManager } from '../core/config/settings-manager';
import { getProjectKnowledgeCoordinator, type ProjectKnowledgeCoordinator } from './project-knowledge-coordinator';
import { getProjectCodeIndexBridge, type ProjectCodeIndexBridge } from './project-code-index-bridge';
import { getProjectRootRegistry, type ProjectRootRegistry } from './project-root-registry';
import type { AppSettings } from '../../shared/types/settings.types';
import type { RecentDirectoryEntry } from '../../shared/types/recent-directories.types';
import type {
  CodebaseMiningResult,
  CodebaseMiningStatus,
  ProjectCodeIndexStatus,
} from '../../shared/types/knowledge-graph.types';

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_SKIP_WITHIN_MS = 30_000;

const logger = getLogger('ProjectKnowledgeAutoMirror');

/**
 * Subset of `ProjectKnowledgeCoordinator` we depend on — kept narrow so tests
 * can stand in a fake without standing up the real coordinator + miner +
 * bridge + RLM database.
 */
export interface AutoMirrorKnowledgeTarget {
  ensureProjectKnown(
    rootPath: string,
    discoverySource: 'recent-directory-open',
    options: { autoRefresh: true },
  ): Promise<CodebaseMiningStatus | CodebaseMiningResult>;
}

/**
 * Minimal `ProjectCodeIndexBridge.getStatus(...)` surface used to short-
 * circuit re-mirrors of paths whose `lastSyncedAt` is fresh.
 */
export interface AutoMirrorBridgeTarget {
  getStatus(projectKey: string): ProjectCodeIndexStatus;
}

/** Codemem readiness gate — bridge does nothing without it. */
export interface AutoMirrorCodememTarget {
  isEnabled(): boolean;
  isIndexingEnabled(): boolean;
  on?(event: 'code-index:changed', listener: (event: CodememCodeIndexChangedEvent) => void): unknown;
  off?(event: 'code-index:changed', listener: (event: CodememCodeIndexChangedEvent) => void): unknown;
}

export interface CodememCodeIndexChangedEvent {
  workspacePath: string;
  workspaceHash?: string;
  paths: string[];
  timestamp: number;
}

/**
 * Project registry — we honour pause/exclude/autoMine the same way the
 * coordinator inside `ensureProjectKnown` does, so a paused project never
 * enters the queue in the first place.
 */
export interface AutoMirrorRegistryTarget {
  canAutoMine(rootPath: string): boolean;
}

/** Settings provider — wrapped so tests can inject a fake value bag. */
export interface AutoMirrorSettingsTarget {
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
}

export interface ProjectKnowledgeAutoMirrorCoordinatorOptions {
  /**
   * Source of `directory-added` events. Defaults to the singleton.
   * Typed as the base EventEmitter so tests can pass a plain emitter without
   * importing the real `RecentDirectoriesManager` (which pulls in
   * `electron-store` and noisily tries to write to disk under vitest).
   */
  recentDirectoriesManager?: EventEmitter;
  knowledge?: AutoMirrorKnowledgeTarget;
  bridge?: AutoMirrorBridgeTarget;
  codemem?: AutoMirrorCodememTarget;
  registry?: AutoMirrorRegistryTarget;
  settings?: AutoMirrorSettingsTarget;
  /**
   * Override the project-key normalisation used to look up bridge status.
   * Defaults to `path.resolve(...)` (matching how the bridge resolves keys),
   * which is also what `normalizeProjectMemoryKey` does for absolute paths.
   */
  projectKeyResolver?: (rootPath: string) => string;
  /** Test seam — override the clock used for "is the last sync recent enough?" */
  now?: () => number;
}

interface MirrorQueueEntry {
  rootPath: string;
  force: boolean;
}

/**
 * Public surface, primarily for tests + `getProjectKnowledgeAutoMirrorCoordinator()`.
 */
export class ProjectKnowledgeAutoMirrorCoordinator extends EventEmitter {
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly debounceForces = new Map<string, boolean>();
  private readonly queue: MirrorQueueEntry[] = [];
  private readonly queuedSet = new Set<string>();
  private readonly active = new Set<string>();
  private listenerBound: ((entry: RecentDirectoryEntry) => void) | null = null;
  private codeIndexChangedBound: ((event: CodememCodeIndexChangedEvent) => void) | null = null;
  private started = false;
  private recentDirsManager: EventEmitter | null = null;
  private readonly knowledge: AutoMirrorKnowledgeTarget;
  private readonly bridge: AutoMirrorBridgeTarget;
  private readonly codemem: AutoMirrorCodememTarget;
  private readonly registry: AutoMirrorRegistryTarget;
  private readonly settings: AutoMirrorSettingsTarget;
  private readonly projectKeyResolver: (rootPath: string) => string;
  private readonly now: () => number;
  private readonly options: ProjectKnowledgeAutoMirrorCoordinatorOptions;

  constructor(options: ProjectKnowledgeAutoMirrorCoordinatorOptions = {}) {
    super();
    this.options = options;
    this.knowledge = options.knowledge ?? createDefaultKnowledgeTarget();
    this.bridge = options.bridge ?? createDefaultBridgeTarget();
    this.codemem = options.codemem ?? createDefaultCodememTarget();
    this.registry = options.registry ?? createDefaultRegistryTarget();
    this.settings = options.settings ?? createDefaultSettingsTarget();
    this.projectKeyResolver = options.projectKeyResolver ?? defaultProjectKeyResolver;
    this.now = options.now ?? (() => Date.now());
  }

  /** Idempotent — attach the listener once. */
  start(): void {
    if (this.started) return;
    const manager = this.options.recentDirectoriesManager ?? getRecentDirectoriesManager();
    this.recentDirsManager = manager;
    this.listenerBound = (entry: RecentDirectoryEntry) => this.onDirectoryAdded(entry);
    this.codeIndexChangedBound = (event: CodememCodeIndexChangedEvent) =>
      this.onCodeIndexChanged(event);
    manager.on('directory-added', this.listenerBound);
    this.codemem.on?.('code-index:changed', this.codeIndexChangedBound);
    this.started = true;
    logger.info('ProjectKnowledgeAutoMirrorCoordinator started');
  }

  /** Detach the listener and clear pending debounce timers. In-flight mirrors keep running. */
  stop(): void {
    if (!this.started) return;
    if (this.recentDirsManager && this.listenerBound) {
      this.recentDirsManager.off('directory-added', this.listenerBound);
    }
    if (this.codeIndexChangedBound) {
      this.codemem.off?.('code-index:changed', this.codeIndexChangedBound);
    }
    this.listenerBound = null;
    this.codeIndexChangedBound = null;
    this.recentDirsManager = null;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.debounceForces.clear();
    this.started = false;
    logger.info('ProjectKnowledgeAutoMirrorCoordinator stopped');
  }

  /**
   * Renderer-driven hint that this workspace is the user's current focus.
   * Cancels any debounce, jumps to the front of the queue, or fires
   * immediately if no mirror is currently in progress for it.
   */
  hintActiveWorkspace(workspacePath: string | null | undefined): void {
    const normalized = this.normalizePath(workspacePath);
    if (!normalized) return;

    if (!this.isEnabled()) return;
    if (!this.pathExistsAsDirectory(normalized)) return;
    if (!this.registry.canAutoMine(normalized)) return;

    // Cancel any debounce: we'll act immediately.
    const timer = this.debounceTimers.get(normalized);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(normalized);
    }

    if (this.active.has(normalized)) {
      return;
    }

    if (this.shouldSkipBecauseRecentlyMirrored(normalized)) {
      return;
    }

    // Remove from queue (if pending) so we can move it to the front.
    this.removeFromQueue(normalized);

    this.queue.unshift({ rootPath: normalized, force: false });
    this.queuedSet.add(normalized);

    void this.drainQueue();
  }

  /**
   * Test seam — returns a snapshot of internal state useful for assertions.
   */
  _inspectForTesting(): {
    queue: string[];
    active: string[];
    debouncedPaths: string[];
  } {
    return {
      queue: this.queue.map((entry) => entry.rootPath),
      active: [...this.active],
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
    this.debounceForces.clear();
    this.queue.length = 0;
    this.queuedSet.clear();
    this.active.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private onDirectoryAdded(entry: RecentDirectoryEntry): void {
    // Remote paths live on another machine; the owning node owns its own
    // project-knowledge mirror. We must not auto-mirror those locally.
    if (entry.nodeId) return;

    if (!this.isEnabled()) return;

    const normalized = this.normalizePath(entry.path);
    if (!normalized) return;

    if (!this.pathExistsAsDirectory(normalized)) return;
    if (!this.registry.canAutoMine(normalized)) return;

    this.scheduleDebounce(normalized);
  }

  private onCodeIndexChanged(event: CodememCodeIndexChangedEvent): void {
    this.hintWorkspaceChanged(event.workspacePath);
  }

  private hintWorkspaceChanged(workspacePath: string | null | undefined): void {
    const normalized = this.normalizePath(workspacePath);
    if (!normalized) return;

    if (!this.isEnabled()) return;
    if (!this.pathExistsAsDirectory(normalized)) return;
    if (!this.registry.canAutoMine(normalized)) return;

    this.scheduleDebounce(normalized, true);
  }

  private scheduleDebounce(rootPath: string, force = false): void {
    const existing = this.debounceTimers.get(rootPath);
    if (existing) {
      clearTimeout(existing);
    }
    const shouldForce = force || this.debounceForces.get(rootPath) === true;
    const delay = this.getDebounceMs();
    if (delay <= 0) {
      // Zero-debounce path used by tests that want immediate enqueue without
      // having to advance fake timers.
      this.debounceTimers.delete(rootPath);
      this.debounceForces.delete(rootPath);
      this.enqueue(rootPath, shouldForce);
      return;
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(rootPath);
      const forceEntry = this.debounceForces.get(rootPath) === true;
      this.debounceForces.delete(rootPath);
      this.enqueue(rootPath, forceEntry);
    }, delay);
    // Don't keep the Node event loop alive for a pending debounce.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.debounceTimers.set(rootPath, timer);
    this.debounceForces.set(rootPath, shouldForce);
  }

  private enqueue(rootPath: string, force = false): void {
    if (this.active.has(rootPath) || this.queuedSet.has(rootPath)) {
      return;
    }
    if (!force && this.shouldSkipBecauseRecentlyMirrored(rootPath)) {
      return;
    }
    this.queue.push({ rootPath, force });
    this.queuedSet.add(rootPath);
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    const cap = this.getMaxConcurrent();
    while (this.active.size < cap && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.queuedSet.delete(next.rootPath);
      this.active.add(next.rootPath);
      // Fire-and-forget: each mirror runs to completion independently.
      void this.mirrorOne(next).finally(() => {
        this.active.delete(next.rootPath);
        void this.drainQueue();
      });
    }
  }

  private async mirrorOne(entry: MirrorQueueEntry): Promise<void> {
    const { rootPath, force } = entry;
    // Re-check on dispatch — settings or codemem state may have flipped
    // between enqueue and dispatch.
    if (!this.isEnabled()) {
      return;
    }
    if (!this.registry.canAutoMine(rootPath)) {
      return;
    }
    if (!force && this.shouldSkipBecauseRecentlyMirrored(rootPath)) {
      return;
    }

    logger.info('Project knowledge auto-mirror starting', { rootPath });
    try {
      await this.knowledge.ensureProjectKnown(rootPath, 'recent-directory-open', {
        autoRefresh: true,
      });
      logger.info('Project knowledge auto-mirror completed', { rootPath });
      this.emit('mirrored', { rootPath });
    } catch (error) {
      logger.warn('Project knowledge auto-mirror failed; spawn-time call remains as the safety net', {
        rootPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private shouldSkipBecauseRecentlyMirrored(rootPath: string): boolean {
    const skipWithin = this.getSkipWithinMs();
    if (skipWithin <= 0) return false;
    let status: ProjectCodeIndexStatus;
    try {
      status = this.bridge.getStatus(this.projectKeyResolver(rootPath));
    } catch {
      // If the bridge can't return a status (rare — typically only on a
      // teardown race), proceed and let the bridge itself short-circuit.
      return false;
    }
    const lastSyncedAt = status.lastSyncedAt;
    if (lastSyncedAt && this.isWithinSkipWindow(lastSyncedAt, skipWithin)) {
      return true;
    }

    return (
      status.status === 'failed'
      && status.metadata['reason'] === 'limit_exceeded'
      && this.isWithinSkipWindow(status.updatedAt, skipWithin)
    );
  }

  private isWithinSkipWindow(timestamp: number | undefined, skipWithin: number): boolean {
    return typeof timestamp === 'number' && timestamp > 0 && this.now() - timestamp <= skipWithin;
  }

  private removeFromQueue(rootPath: string): void {
    if (!this.queuedSet.has(rootPath)) return;
    const idx = this.queue.findIndex((entry) => entry.rootPath === rootPath);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
    this.queuedSet.delete(rootPath);
  }

  private isEnabled(): boolean {
    if (!this.codemem.isEnabled() || !this.codemem.isIndexingEnabled()) {
      return false;
    }
    const enabled = this.settings.get('projectKnowledgeAutoMirrorEnabled');
    return enabled !== false;
  }

  private getMaxConcurrent(): number {
    const raw = this.settings.get('projectKnowledgeAutoMirrorMaxConcurrent');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.max(1, Math.floor(raw));
    }
    return DEFAULT_MAX_CONCURRENT;
  }

  private getDebounceMs(): number {
    const raw = this.settings.get('projectKnowledgeAutoMirrorDebounceMs');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return Math.floor(raw);
    }
    return DEFAULT_DEBOUNCE_MS;
  }

  private getSkipWithinMs(): number {
    const raw = this.settings.get('projectKnowledgeAutoMirrorSkipWithinMs');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return Math.floor(raw);
    }
    return DEFAULT_SKIP_WITHIN_MS;
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
}

// ── Default adapters over the live singletons ───────────────────────────────

function createDefaultKnowledgeTarget(): AutoMirrorKnowledgeTarget {
  return {
    ensureProjectKnown: (rootPath, discoverySource, options) =>
      // Casting through the interface preserves the constrained
      // discoverySource literal type the coordinator uses.
      (getProjectKnowledgeCoordinator() as ProjectKnowledgeCoordinator).ensureProjectKnown(
        rootPath,
        discoverySource,
        options,
      ),
  };
}

function createDefaultBridgeTarget(): AutoMirrorBridgeTarget {
  return {
    getStatus: (projectKey: string) =>
      (getProjectCodeIndexBridge() as ProjectCodeIndexBridge).getStatus(projectKey),
  };
}

function createDefaultCodememTarget(): AutoMirrorCodememTarget {
  return {
    isEnabled: () => (getCodemem() as CodememService).isEnabled(),
    isIndexingEnabled: () => (getCodemem() as CodememService).isIndexingEnabled(),
    on: (event, listener) => (getCodemem() as CodememService).on(event, listener),
    off: (event, listener) => (getCodemem() as CodememService).off(event, listener),
  };
}

function createDefaultRegistryTarget(): AutoMirrorRegistryTarget {
  return {
    canAutoMine: (rootPath: string): boolean => {
      try {
        return (getProjectRootRegistry() as ProjectRootRegistry).canAutoMine(rootPath);
      } catch {
        // If the registry is unavailable (e.g. database not initialised in
        // a test or early startup), default to allowing the auto-mirror.
        return true;
      }
    },
  };
}

function createDefaultSettingsTarget(): AutoMirrorSettingsTarget {
  return {
    get<K extends keyof AppSettings>(key: K): AppSettings[K] {
      // Wrapped in try/catch because some test runs construct the
      // coordinator before the settings manager singleton has been
      // initialised. In that case we want to fall back to defaults rather
      // than throw and crash startup. The cast through `unknown` is
      // necessary because `AppSettings[K]` is a generic union of concrete
      // types, none of which include `undefined`; callers in this module
      // always narrow before using the value.
      try {
        return getSettingsManager().get(key);
      } catch {
        return undefined as unknown as AppSettings[K];
      }
    },
  };
}

function defaultProjectKeyResolver(rootPath: string): string {
  // The bridge resolves keys via `normalizeProjectMemoryKey(...)` which —
  // for absolute paths — is equivalent to `path.resolve(...)`. Resolving
  // here gives the same key the bridge will look up in its status table.
  return path.resolve(rootPath);
}

// ── Singleton accessor ──────────────────────────────────────────────────────

let coordinatorInstance: ProjectKnowledgeAutoMirrorCoordinator | null = null;

export function getProjectKnowledgeAutoMirrorCoordinator(): ProjectKnowledgeAutoMirrorCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new ProjectKnowledgeAutoMirrorCoordinator();
  }
  return coordinatorInstance;
}

export function resetProjectKnowledgeAutoMirrorCoordinatorForTesting(): void {
  if (coordinatorInstance) {
    coordinatorInstance._resetForTesting();
  }
  coordinatorInstance = null;
}
