/**
 * Tests for CodebaseIndexingAutoCoordinator
 *
 * The coordinator is the bridge between RecentDirectoriesManager's
 * `'directory-added'` event and CodebaseIndexingService. These tests verify
 * the event → preflight → queue → run pipeline using fakes so we don't touch
 * sqlite, embeddings, or the file watcher.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CodebaseIndexingAutoCoordinator,
  type AutoIndexingTarget,
  type AutoIndexFileWatcherTarget,
  type AutoIndexContextManagerTarget,
  type AutoIndexProjectRegistryTarget,
  type AutoIndexSettingsTarget,
  type PreflightResult,
} from './codebase-indexing-auto-coordinator';
import type { AppSettings } from '../../shared/types/settings.types';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import type { RecentDirectoryEntry } from '../../shared/types/recent-directories.types';
import type { CodebaseAutoIndexStatus, IndexingProgress, IndexingStats } from '../../shared/types/codebase.types';

interface Fakes {
  emitter: EventEmitter;
  indexing: AutoIndexingTarget & {
    indexCalls: { storeId: string; rootPath: string; force?: boolean }[];
    resolveNext: (stats?: Partial<IndexingStats>) => void;
    rejectNext: (err: Error) => void;
    progress: EventEmitter;
  };
  fileWatcher: AutoIndexFileWatcherTarget & {
    startCalls: { storeId: string; rootPath: string }[];
  };
  contextManager: AutoIndexContextManagerTarget & {
    createCalls: { instanceId: string; config?: Record<string, unknown> }[];
    listStores: ReturnType<typeof vi.fn>;
  };
  registry: AutoIndexProjectRegistryTarget & { excluded: Set<string> };
  settings: AutoIndexSettingsTarget & { values: Partial<AppSettings> };
  preflight: ReturnType<
    typeof vi.fn<
      (storeId: string, options: { maxFiles: number; maxBytes: number }) => Promise<PreflightResult>
    >
  >;
  tempDirs: string[];
}

function makeFakes(): Fakes {
  const emitter = new EventEmitter();
  const progress = new EventEmitter();
  const pending: Array<{
    resolve: (stats: IndexingStats) => void;
    reject: (err: Error) => void;
  }> = [];

  const indexing = {
    indexCalls: [] as { storeId: string; rootPath: string; force?: boolean }[],
    async indexCodebase(
      storeId: string,
      rootPath: string,
      options?: { force?: boolean },
    ): Promise<IndexingStats> {
      this.indexCalls.push({ storeId, rootPath, force: options?.force });
      return new Promise<IndexingStats>((resolve, reject) => {
        pending.push({
          resolve,
          reject,
        });
      });
    },
    on(event: 'progress', listener: (progress: IndexingProgress) => void) {
      progress.on(event, listener);
      return this;
    },
    off(event: 'progress', listener: (progress: IndexingProgress) => void) {
      progress.off(event, listener);
      return this;
    },
    resolveNext(stats: Partial<IndexingStats> = {}): void {
      const next = pending.shift();
      if (!next) throw new Error('no pending indexCodebase to resolve');
      next.resolve({
        filesIndexed: stats.filesIndexed ?? 5,
        chunksCreated: stats.chunksCreated ?? 25,
        tokensProcessed: stats.tokensProcessed ?? 0,
        duration: stats.duration ?? 1,
        errors: stats.errors ?? [],
      });
    },
    rejectNext(err: Error): void {
      const next = pending.shift();
      if (!next) throw new Error('no pending indexCodebase to reject');
      next.reject(err);
    },
    progress,
  };

  const fileWatcher = {
    startCalls: [] as { storeId: string; rootPath: string }[],
    async startWatching(storeId: string, rootPath: string) {
      this.startCalls.push({ storeId, rootPath });
      return { dispose: async () => undefined };
    },
  };

  const contextManager = {
    createCalls: [] as { instanceId: string; config?: Record<string, unknown> }[],
    async createStore(instanceId: string, config?: Record<string, unknown>): Promise<{ id: string }> {
      this.createCalls.push({ instanceId, config });
      return { id: `ctx_${instanceId}` };
    },
    listStores: vi.fn(async () => []),
  };

  const registry = {
    excluded: new Set<string>(),
    canAutoMine(rootPath: string): boolean {
      return !this.excluded.has(rootPath);
    },
  };

  const settings = {
    values: {
      codebaseAutoIndexEnabled: true,
      codebaseAutoIndexMaxFiles: 1000,
      codebaseAutoIndexMaxBytes: 10_000_000,
      codebaseAutoIndexConcurrent: 1,
      codebaseAutoIndexDebounceMs: 0,
    } as Partial<AppSettings>,
    get<K extends keyof AppSettings>(key: K): AppSettings[K] {
      return this.values[key] as AppSettings[K];
    },
  };

  // The default preflight implementation ignores its arguments — the tests
  // that need a different result use `.mockResolvedValueOnce(...)`.
  const preflight = vi.fn<
    (storeId: string, options: { maxFiles: number; maxBytes: number }) => Promise<PreflightResult>
  >();
  preflight.mockResolvedValue({ fileCount: 10, totalBytes: 1024 });

  return {
    emitter,
    indexing,
    fileWatcher,
    contextManager,
    registry,
    settings,
    preflight,
    tempDirs: [],
  };
}

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-idx-'));
  return dir;
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class ControlledWatcherStarts {
  readonly active = new Set<string>();
  readonly disposed: string[] = [];
  readonly pending: Array<{
    token: string;
    commit: () => void;
  }> = [];
  private nextToken = 0;

  startWatching(storeId: string): Promise<{ dispose(): Promise<void> }> {
    const token = `${storeId}:${++this.nextToken}`;
    return new Promise((resolve) => {
      this.pending.push({
        token,
        commit: () => {
          this.active.add(token);
          resolve({
            dispose: async () => {
              this.disposed.push(token);
              this.active.delete(token);
            },
          });
        },
      });
    });
  }

  resolveStart(index: number): string {
    const pending = this.pending[index];
    if (!pending) throw new Error(`missing watcher start ${index}`);
    pending.commit();
    return pending.token;
  }
}

function makeEntry(rootPath: string, overrides: Partial<RecentDirectoryEntry> = {}): RecentDirectoryEntry {
  return {
    path: rootPath,
    displayName: path.basename(rootPath),
    lastAccessed: Date.now(),
    accessCount: 1,
    isPinned: false,
    ...overrides,
  };
}

describe('CodebaseIndexingAutoCoordinator', () => {
  let fakes: Fakes;
  let coordinator: CodebaseIndexingAutoCoordinator;

  beforeEach(() => {
    fakes = makeFakes();
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: fakes.fileWatcher,
      contextManager: fakes.contextManager,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });
    coordinator.start();
  });

  afterEach(() => {
    coordinator._resetForTesting();
    for (const dir of fakes.tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to codemem automatic indexing with legacy RLM auto-index disabled', () => {
    expect(DEFAULT_SETTINGS.codebaseAutoIndexEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.codememEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.codememIndexingEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.codememPrewarmEnabled).toBe(true);
  });

  it('fires indexCodebase on directory-added for a local path', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    expect(fakes.indexing.indexCalls).toHaveLength(1);
    expect(fakes.indexing.indexCalls[0]).toMatchObject({
      rootPath: dir,
      force: false,
    });
  });

  it('creates the RLM store with codebase-auto metadata for the workspace', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    expect(fakes.contextManager.createCalls[0]).toEqual({
      instanceId: `codebase:${path.resolve(dir)}`,
      config: {
        kind: 'codebase-auto',
        rootPath: path.resolve(dir),
      },
    });
  });

  it('awaits async worker store creation before dispatching the indexing job', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    const createStore = vi.fn().mockResolvedValue({ id: 'worker-owned-store' });
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: fakes.fileWatcher,
      contextManager: { createStore } as unknown as AutoIndexContextManagerTarget,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });
    coordinator.start();

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    expect(createStore).toHaveBeenCalledOnce();
    expect(fakes.indexing.indexCalls[0]?.storeId).toBe('worker-owned-store');

    fakes.indexing.resolveNext();
    await flushMicrotasks();
  });

  it('uses the deterministic store ID after one failed worker mutation without retrying it', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    const createStore = vi.fn().mockRejectedValue(new Error('worker unavailable'));
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: fakes.fileWatcher,
      contextManager: { createStore } as unknown as AutoIndexContextManagerTarget,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });
    coordinator.start();

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    expect(createStore).toHaveBeenCalledOnce();
    expect(fakes.indexing.indexCalls[0]?.storeId).toBe(`codebase:${path.resolve(dir)}`);

    fakes.indexing.resolveNext();
    await flushMicrotasks();
  });

  it('skips remote paths (entry.nodeId present)', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);

    fakes.emitter.emit('directory-added', makeEntry(dir, { nodeId: 'node-1' }));
    await flushMicrotasks();

    expect(fakes.indexing.indexCalls).toHaveLength(0);
    const status = coordinator.getStatus(dir);
    expect(status?.state).toBe('skipped');
    expect(status?.reason).toBe('remote');
  });

  it('skips when codebaseAutoIndexEnabled is false', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    fakes.settings.values.codebaseAutoIndexEnabled = false;

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    expect(fakes.indexing.indexCalls).toHaveLength(0);
    const status = coordinator.getStatus(dir);
    expect(status?.state).toBe('skipped');
    expect(status?.reason).toBe('disabled');
  });

  it('skips and records "too_large" when preflight exceeds limits', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    fakes.preflight.mockResolvedValueOnce({
      fileCount: 5000,
      totalBytes: 100,
      exceeded: 'files',
    });

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    expect(fakes.indexing.indexCalls).toHaveLength(0);
    const status = coordinator.getStatus(dir);
    expect(status?.state).toBe('skipped');
    expect(status?.reason).toBe('too_large');
    expect(status?.filesProcessed).toBe(5000);
  });

  it('records "excluded" when the project registry refuses auto-mining', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    fakes.registry.excluded.add(path.resolve(dir));

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    expect(fakes.indexing.indexCalls).toHaveLength(0);
    const status = coordinator.getStatus(dir);
    expect(status?.state).toBe('skipped');
    expect(status?.reason).toBe('excluded');
  });

  it('reuses storeId from contextManager.createStore for the same workspace', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();
    fakes.indexing.resolveNext();
    await flushMicrotasks();

    expect(fakes.contextManager.createCalls.length).toBeGreaterThanOrEqual(1);
    expect(fakes.contextManager.createCalls[0]?.instanceId).toBe(`codebase:${path.resolve(dir)}`);
    const firstStoreId = fakes.indexing.indexCalls[0].storeId;
    expect(firstStoreId).toBe(`ctx_codebase:${path.resolve(dir)}`);

    // Second event for the same dir should reuse the same workspaceHash-based
    // input to createStore (idempotent on instanceId).
    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();
    fakes.indexing.resolveNext();
    await flushMicrotasks();

    expect(fakes.indexing.indexCalls[1].storeId).toBe(firstStoreId);
  });

  it('honours concurrency cap of 1 — second event queues until the first completes', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    fakes.tempDirs.push(dirA, dirB);

    fakes.emitter.emit('directory-added', makeEntry(dirA));
    await flushMicrotasks();
    fakes.emitter.emit('directory-added', makeEntry(dirB));
    await flushMicrotasks();

    // Only A should be running; B is queued.
    expect(fakes.indexing.indexCalls).toHaveLength(1);
    expect(coordinator.getStatus(dirB)?.state).toBe('queued');

    // Complete A — B should kick off.
    fakes.indexing.resolveNext();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(fakes.indexing.indexCalls).toHaveLength(2);
    expect(coordinator.getStatus(dirB)?.state).toBe('running');

    fakes.indexing.resolveNext();
    await flushMicrotasks();
  });

  it('scopes progress events to their workspace when multiple auto-index runs overlap', async () => {
    fakes.settings.values.codebaseAutoIndexConcurrent = 2;
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    fakes.tempDirs.push(dirA, dirB);
    const rootA = path.resolve(dirA);
    const rootB = path.resolve(dirB);

    fakes.emitter.emit('directory-added', makeEntry(dirA));
    fakes.emitter.emit('directory-added', makeEntry(dirB));
    await flushMicrotasks();

    expect(fakes.indexing.indexCalls.map((call) => call.rootPath)).toEqual([rootA, rootB]);
    expect(coordinator.getStatus(rootA)?.state).toBe('running');
    expect(coordinator.getStatus(rootB)?.state).toBe('running');

    fakes.indexing.progress.emit('progress', {
      status: 'chunking',
      totalFiles: 10,
      processedFiles: 4,
      totalChunks: 12,
      rootPath: rootA,
    });

    expect(coordinator.getStatus(rootA)?.filesProcessed).toBe(4);
    expect(coordinator.getStatus(rootA)?.chunksProcessed).toBe(12);
    expect(coordinator.getStatus(rootB)?.filesProcessed).toBe(0);
    expect(coordinator.getStatus(rootB)?.chunksProcessed).toBe(0);

    fakes.indexing.resolveNext();
    fakes.indexing.resolveNext();
    await flushMicrotasks();
  });

  it('hintActiveWorkspace jumps a path to the front of the queue', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    const dirC = mkTmpDir();
    fakes.tempDirs.push(dirA, dirB, dirC);

    fakes.emitter.emit('directory-added', makeEntry(dirA));
    fakes.emitter.emit('directory-added', makeEntry(dirB));
    await flushMicrotasks();

    // Hint dirC before either has finished: C should now be the next thing run.
    coordinator.hintActiveWorkspace(dirC);
    await flushMicrotasks();

    // Resolve A; the next to start should be C (hinted to front), then B.
    fakes.indexing.resolveNext();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(fakes.indexing.indexCalls.map((c) => c.rootPath)).toEqual([
      path.resolve(dirA),
      path.resolve(dirC),
    ]);

    fakes.indexing.resolveNext();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(fakes.indexing.indexCalls[2]?.rootPath).toBe(path.resolve(dirB));

    fakes.indexing.resolveNext();
    await flushMicrotasks();
  });

  it('starts the file watcher after a completed run', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    fakes.indexing.resolveNext({ filesIndexed: 12, chunksCreated: 30 });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(fakes.fileWatcher.startCalls).toHaveLength(1);
    expect(fakes.fileWatcher.startCalls[0]).toMatchObject({
      rootPath: path.resolve(dir),
    });

    const status = coordinator.getStatus(dir);
    expect(status?.state).toBe('complete');
    expect(status?.filesProcessed).toBe(12);
    expect(status?.chunksProcessed).toBe(30);
  });

  it('records failure when indexCodebase rejects', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    fakes.indexing.rejectNext(new Error('boom'));
    await flushMicrotasks();
    await flushMicrotasks();

    const status = coordinator.getStatus(dir);
    expect(status?.state).toBe('failed');
    expect(status?.errorMessage).toContain('boom');
    expect(fakes.fileWatcher.startCalls).toHaveLength(0);
  });

  it('emits status events for queued → running → complete', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);

    const states: CodebaseAutoIndexStatus['state'][] = [];
    coordinator.on('status', (status: CodebaseAutoIndexStatus) => {
      states.push(status.state);
    });

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();
    fakes.indexing.resolveNext();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(states).toContain('queued');
    expect(states).toContain('running');
    expect(states[states.length - 1]).toBe('complete');
  });

  it('does not carry completed-run fields into a later queued or running status', async () => {
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    const rootPath = path.resolve(dir);
    const events: CodebaseAutoIndexStatus[] = [];
    coordinator.on('status', (status: CodebaseAutoIndexStatus) => {
      if (status.rootPath === rootPath) {
        events.push(status);
      }
    });

    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();
    fakes.indexing.resolveNext({ filesIndexed: 12, chunksCreated: 30 });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(coordinator.getStatus(dir)?.state).toBe('complete');

    events.length = 0;
    fakes.emitter.emit('directory-added', makeEntry(dir));
    await flushMicrotasks();

    const queued = events.find((status) => status.state === 'queued');
    const running = events.find((status) => status.state === 'running');
    expect(queued).toBeDefined();
    expect(queued?.completedAt).toBeUndefined();
    expect(queued?.filesProcessed).toBeUndefined();
    expect(queued?.chunksProcessed).toBeUndefined();
    expect(running).toBeDefined();
    expect(running?.completedAt).toBeUndefined();
    expect(running?.errorMessage).toBeUndefined();
    expect(running?.filesProcessed).toBe(0);
    expect(running?.chunksProcessed).toBe(0);

    fakes.indexing.resolveNext();
    await flushMicrotasks();
  });

  it('does not double-enqueue the same path while it is already queued', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    fakes.tempDirs.push(dirA, dirB);

    fakes.emitter.emit('directory-added', makeEntry(dirA));
    await flushMicrotasks();
    // A is running, B queues
    fakes.emitter.emit('directory-added', makeEntry(dirB));
    fakes.emitter.emit('directory-added', makeEntry(dirB));
    fakes.emitter.emit('directory-added', makeEntry(dirB));
    await flushMicrotasks();

    const inspect = coordinator._inspectForTesting();
    const bEntries = inspect.queue.filter((q) => q.rootPath === path.resolve(dirB));
    expect(bEntries).toHaveLength(1);

    fakes.indexing.resolveNext();
    await flushMicrotasks();
    fakes.indexing.resolveNext();
    await flushMicrotasks();
  });

  it('restores file watchers for persisted codebase-auto stores on start', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    fakes.contextManager.listStores.mockResolvedValue([
      {
        id: 'ctx-persisted',
        instanceId: `codebase:${path.resolve(dir)}`,
        sections: [],
        totalTokens: 0,
        totalSize: 0,
        createdAt: 1,
        lastAccessed: 1,
        accessCount: 0,
        config: {
          kind: 'codebase-auto',
          rootPath: path.resolve(dir),
        },
      },
    ]);

    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: fakes.fileWatcher,
      contextManager: fakes.contextManager,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });
    coordinator.start();
    await flushMicrotasks(12);

    expect(fakes.fileWatcher.startCalls).toEqual([
      { storeId: 'ctx-persisted', rootPath: path.resolve(dir) },
    ]);
  });

  it('awaits async worker store discovery before restoring persisted watchers', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    const persisted = {
      id: 'ctx-worker-persisted',
      instanceId: `codebase:${path.resolve(dir)}`,
      sections: [],
      totalTokens: 0,
      totalSize: 0,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 0,
      config: {
        kind: 'codebase-auto',
        rootPath: path.resolve(dir),
      },
    };
    const listStores = vi.fn().mockResolvedValue([persisted]);
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: fakes.fileWatcher,
      contextManager: {
        createStore: vi.fn(),
        listStores,
      } as unknown as AutoIndexContextManagerTarget,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });

    coordinator.start();
    await flushMicrotasks();

    expect(listStores).toHaveBeenCalledOnce();
    expect(fakes.fileWatcher.startCalls).toEqual([
      { storeId: persisted.id, rootPath: path.resolve(dir) },
    ]);
  });

  it('absorbs unavailable worker discovery without an unhandled rejection', async () => {
    coordinator._resetForTesting();
    const listStores = vi.fn().mockRejectedValue(new Error('worker unavailable'));
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: fakes.fileWatcher,
      contextManager: {
        createStore: vi.fn(),
        listStores,
      } as unknown as AutoIndexContextManagerTarget,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });

    coordinator.start();
    await flushMicrotasks();

    expect(listStores).toHaveBeenCalledOnce();
    expect(fakes.fileWatcher.startCalls).toEqual([]);
  });

  it('cancels a restore before delayed worker discovery can create side effects', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    const pendingStores = deferred<Awaited<ReturnType<NonNullable<AutoIndexContextManagerTarget['listStores']>>>>();
    const listStores = vi.fn(() => pendingStores.promise);
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: fakes.fileWatcher,
      contextManager: {
        createStore: vi.fn(),
        listStores,
      } as unknown as AutoIndexContextManagerTarget,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });

    coordinator.start();
    coordinator.stop();
    pendingStores.resolve([persistedStore(dir, 'ctx-cancelled')]);
    await flushMicrotasks();

    expect(listStores).toHaveBeenCalledOnce();
    expect(fakes.fileWatcher.startCalls).toEqual([]);
    expect(fakes.indexing.indexCalls).toEqual([]);
    expect(coordinator.listStatuses()).toEqual([]);
  });

  it('allows only the current restore generation to act when starts resolve out of order', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    const first = deferred<Awaited<ReturnType<NonNullable<AutoIndexContextManagerTarget['listStores']>>>>();
    const second = deferred<Awaited<ReturnType<NonNullable<AutoIndexContextManagerTarget['listStores']>>>>();
    const listStores = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: fakes.fileWatcher,
      contextManager: {
        createStore: vi.fn(),
        listStores,
      } as unknown as AutoIndexContextManagerTarget,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });

    coordinator.start();
    coordinator.stop();
    coordinator.start();
    second.resolve([persistedStore(dir, 'ctx-current')]);
    await flushMicrotasks();
    first.resolve([persistedStore(dir, 'ctx-stale')]);
    await flushMicrotasks();

    expect(listStores).toHaveBeenCalledTimes(2);
    expect(fakes.fileWatcher.startCalls).toEqual([
      { storeId: 'ctx-current', rootPath: path.resolve(dir) },
    ]);
    expect(coordinator.listStatuses()).toEqual([
      expect.objectContaining({ storeId: 'ctx-current', state: 'complete' }),
    ]);
  });

  it('disposes a watcher that finishes starting after the coordinator stops', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    const watcherStarts = new ControlledWatcherStarts();
    const listStores = vi.fn().mockResolvedValue([persistedStore(dir, 'ctx-race')]);
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: watcherStarts as unknown as AutoIndexFileWatcherTarget,
      contextManager: {
        createStore: vi.fn(),
        listStores,
      } as unknown as AutoIndexContextManagerTarget,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });

    coordinator.start();
    await flushMicrotasks();
    expect(watcherStarts.pending).toHaveLength(1);
    coordinator.stop();
    const staleToken = watcherStarts.resolveStart(0);
    await flushMicrotasks();

    expect(watcherStarts.active).toEqual(new Set());
    expect(watcherStarts.disposed).toEqual([staleToken]);
    expect(coordinator.listStatuses()).toEqual([]);
    expect(fakes.indexing.indexCalls).toEqual([]);
  });

  it('keeps only the current watcher when restart completions arrive out of order', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    const watcherStarts = new ControlledWatcherStarts();
    const listStores = vi.fn().mockResolvedValue([persistedStore(dir, 'ctx-same-store')]);
    const statusEvents: CodebaseAutoIndexStatus[] = [];
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: watcherStarts as unknown as AutoIndexFileWatcherTarget,
      contextManager: {
        createStore: vi.fn(),
        listStores,
      } as unknown as AutoIndexContextManagerTarget,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });
    coordinator.on('status', (status: CodebaseAutoIndexStatus) => statusEvents.push(status));

    coordinator.start();
    await flushMicrotasks();
    coordinator.stop();
    coordinator.start();
    await flushMicrotasks();
    expect(watcherStarts.pending).toHaveLength(2);

    const currentToken = watcherStarts.resolveStart(1);
    await flushMicrotasks();
    const staleToken = watcherStarts.resolveStart(0);
    await flushMicrotasks();

    expect(watcherStarts.active).toEqual(new Set([currentToken]));
    expect(watcherStarts.disposed).toEqual([staleToken]);
    expect(statusEvents).toEqual([
      expect.objectContaining({ storeId: 'ctx-same-store', state: 'complete' }),
    ]);
    expect(fakes.indexing.indexCalls).toEqual([]);

    coordinator.stop();
    await flushMicrotasks();
    expect(watcherStarts.active).toEqual(new Set());
    expect(watcherStarts.disposed).toEqual([staleToken, currentToken]);
  });

  it('retains a rejected watcher disposal so a later stop can retry it', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    const active = new Set(['ctx-retry']);
    const dispose = vi.fn()
      .mockRejectedValueOnce(new Error('controlled dispose failure'))
      .mockImplementationOnce(async () => {
        active.delete('ctx-retry');
      });
    const fileWatcher: AutoIndexFileWatcherTarget = {
      startWatching: vi.fn().mockResolvedValue({ dispose }),
    };
    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher,
      contextManager: {
        createStore: vi.fn(),
        listStores: vi.fn().mockResolvedValue([persistedStore(dir, 'ctx-retry')]),
      },
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });

    coordinator.start();
    await flushMicrotasks();
    coordinator.stop();
    await flushMicrotasks();

    const registrations = Reflect.get(
      coordinator,
      'restoreWatcherRegistrations',
    ) as Map<number, Set<unknown>>;
    expect(dispose).toHaveBeenCalledOnce();
    expect(active).toEqual(new Set(['ctx-retry']));
    expect(Array.from(registrations.values()).flatMap((items) => [...items])).toHaveLength(1);

    coordinator.stop();
    await flushMicrotasks();

    expect(dispose).toHaveBeenCalledTimes(2);
    expect(active).toEqual(new Set());
    expect(Array.from(registrations.values()).flatMap((items) => [...items])).toHaveLength(0);
  });

  it('reindexes from production-shaped paged worker metadata beyond the first page', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    fakes.contextManager.listStores.mockResolvedValue([
      {
        id: 'ctx-polluted',
        instanceId: `codebase:${path.resolve(dir)}`,
        sections: [],
        totalTokens: 7999,
        totalSize: 1,
        createdAt: 1,
        lastAccessed: 1,
        accessCount: 0,
        config: {
          kind: 'codebase-auto',
          rootPath: path.resolve(dir),
          ipcSectionCount: 257,
          ipcSectionsTruncated: true,
        },
      },
    ]);
    const listSectionFilterMetadata = vi.fn()
      .mockResolvedValueOnce({
        sections: Array.from({ length: 256 }, (_, index) => ({
          type: 'file' as const,
          filePath: path.join(dir, 'src', `file-${index}.ts`),
        })),
        nextOffset: 256,
      })
      .mockResolvedValueOnce({
        sections: [{
          type: 'file' as const,
          filePath: path.join(dir, 'libraries', 'example.jar'),
        }],
      });

    coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: fakes.emitter,
      indexingService: fakes.indexing,
      fileWatcher: fakes.fileWatcher,
      contextManager: {
        ...fakes.contextManager,
        listSectionFilterMetadata,
      } as AutoIndexContextManagerTarget,
      registry: fakes.registry,
      settings: fakes.settings,
      preflight: fakes.preflight,
      storeIdResolver: (p) => `codebase:${p}`,
    });
    coordinator.start();
    await flushMicrotasks(12);

    expect(fakes.fileWatcher.startCalls).toEqual([
      { storeId: 'ctx-polluted', rootPath: path.resolve(dir) },
    ]);
    expect(listSectionFilterMetadata.mock.calls).toEqual([
      ['ctx-polluted', 0, 256],
      ['ctx-polluted', 256, 1],
    ]);
    const returnedPages = await Promise.all(
      listSectionFilterMetadata.mock.results.map(({ value }) => value),
    );
    expect(returnedPages.every((page) => (
      !JSON.stringify(page).includes('content')
    ))).toBe(true);
    expect(fakes.indexing.indexCalls).toEqual([
      {
        storeId: 'ctx_codebase:' + path.resolve(dir),
        rootPath: path.resolve(dir),
        force: false,
      },
    ]);

    fakes.indexing.resolveNext();
    await flushMicrotasks();
  });
});

function persistedStore(rootPath: string, id: string) {
  return {
    id,
    instanceId: `codebase:${path.resolve(rootPath)}`,
    sections: [],
    totalTokens: 0,
    totalSize: 0,
    createdAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    config: {
      kind: 'codebase-auto',
      rootPath: path.resolve(rootPath),
      ipcSectionCount: 0,
      ipcSectionsTruncated: false,
    },
  };
}
