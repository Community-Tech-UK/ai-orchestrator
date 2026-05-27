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
import type { RecentDirectoryEntry } from '../../shared/types/recent-directories.types';
import type { CodebaseAutoIndexStatus, IndexingStats } from '../../shared/types/codebase.types';

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
      [string, { maxFiles: number; maxBytes: number }],
      Promise<PreflightResult>
    >
  >;
  tempDirs: string[];
}

function makeFakes(): Fakes {
  const emitter = new EventEmitter();
  const progress = new EventEmitter();
  let pending:
    | { resolve: (stats: IndexingStats) => void; reject: (err: Error) => void }
    | null = null;

  const indexing = {
    indexCalls: [] as { storeId: string; rootPath: string; force?: boolean }[],
    async indexCodebase(
      storeId: string,
      rootPath: string,
      options?: { force?: boolean },
    ): Promise<IndexingStats> {
      this.indexCalls.push({ storeId, rootPath, force: options?.force });
      return new Promise<IndexingStats>((resolve, reject) => {
        pending = {
          resolve,
          reject,
        };
      });
    },
    on(event: 'progress', listener: (...args: unknown[]) => void) {
      progress.on(event, listener);
      return this;
    },
    off(event: 'progress', listener: (...args: unknown[]) => void) {
      progress.off(event, listener);
      return this;
    },
    resolveNext(stats: Partial<IndexingStats> = {}): void {
      if (!pending) throw new Error('no pending indexCodebase to resolve');
      pending.resolve({
        filesIndexed: stats.filesIndexed ?? 5,
        chunksCreated: stats.chunksCreated ?? 25,
        tokensProcessed: stats.tokensProcessed ?? 0,
        embeddingsCreated: stats.embeddingsCreated ?? 25,
        duration: stats.duration ?? 1,
        errors: stats.errors ?? [],
      });
      pending = null;
    },
    rejectNext(err: Error): void {
      if (!pending) throw new Error('no pending indexCodebase to reject');
      pending.reject(err);
      pending = null;
    },
    progress,
  };

  const fileWatcher = {
    startCalls: [] as { storeId: string; rootPath: string }[],
    async startWatching(storeId: string, rootPath: string): Promise<void> {
      this.startCalls.push({ storeId, rootPath });
    },
  };

  const contextManager = {
    createCalls: [] as { instanceId: string; config?: Record<string, unknown> }[],
    createStore(instanceId: string, config?: Record<string, unknown>): { id: string } {
      this.createCalls.push({ instanceId, config });
      return { id: `ctx_${instanceId}` };
    },
    listStores: vi.fn(() => []),
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
    [string, { maxFiles: number; maxBytes: number }],
    Promise<PreflightResult>
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
    fakes.contextManager.listStores.mockReturnValue([
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
    await flushMicrotasks();

    expect(fakes.fileWatcher.startCalls).toEqual([
      { storeId: 'ctx-persisted', rootPath: path.resolve(dir) },
    ]);
  });

  it('reindexes a persisted codebase store that contains sections no longer eligible for indexing', async () => {
    coordinator._resetForTesting();
    const dir = mkTmpDir();
    fakes.tempDirs.push(dir);
    fakes.contextManager.listStores.mockReturnValue([
      {
        id: 'ctx-polluted',
        instanceId: `codebase:${path.resolve(dir)}`,
        sections: [
          {
            id: 'sec-jar',
            type: 'file',
            name: 'library.jar',
            content: '',
            tokens: 7999,
            startOffset: 0,
            endOffset: 1,
            checksum: 'jar',
            depth: 0,
            filePath: path.join(dir, 'libraries', 'example.jar'),
          },
        ],
        totalTokens: 7999,
        totalSize: 1,
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
    await flushMicrotasks();

    expect(fakes.fileWatcher.startCalls).toEqual([
      { storeId: 'ctx-polluted', rootPath: path.resolve(dir) },
    ]);
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
