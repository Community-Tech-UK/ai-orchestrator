/**
 * File Watcher Tests
 *
 * Tests for the file watcher that monitors codebase changes.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as path from 'node:path';
import {
  CodebaseFileWatcher,
  resetCodebaseFileWatcher,
  type CodebaseFileIndexingTarget,
} from './file-watcher';
import { MAX_INDEXING_LANE_BATCH_FILES } from './codebase-indexing-lane-protocol';

// Mock chokidar
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
    getWatched: vi.fn().mockReturnValue({}),
  })),
}));

// Mock indexing service
vi.mock('./indexing-service', () => ({
  getCodebaseIndexingService: vi.fn(() => ({
    indexFile: vi.fn().mockResolvedValue(undefined),
    removeFile: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { watch, type FSWatcher } from 'chokidar';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('CodebaseFileWatcher', () => {
  let watcher: CodebaseFileWatcher;
  const fakePath = path.resolve('/fake/path');

  beforeEach(() => {
    vi.clearAllMocks();
    resetCodebaseFileWatcher();
    watcher = new CodebaseFileWatcher();
  });

  afterEach(async () => {
    await watcher.stopAll();
  });

  describe('startWatching', () => {
    it('should start watching a directory', async () => {
      await watcher.startWatching('test-store', '/fake/path');

      expect(watch).toHaveBeenCalledWith(
        expect.stringContaining(fakePath),
        expect.objectContaining({
          persistent: true,
        })
      );
    });

    it('should not create duplicate watchers for same store', async () => {
      await watcher.startWatching('test-store', '/fake/path');
      await watcher.startWatching('test-store', '/fake/path');

      // Should have called watch twice (stops previous watcher first)
      expect(watch).toHaveBeenCalled();
    });

    it('should emit watcher:started event', async () => {
      const startedEvents: any[] = [];
      watcher.on('watcher:started', (data) => {
        startedEvents.push(data);
      });

      await watcher.startWatching('test-store', '/fake/path');

      expect(startedEvents.length).toBeGreaterThan(0);
      expect(startedEvents[0].storeId).toBe('test-store');
    });

    it('gives each start an ownership-safe disposable registration', async () => {
      const firstWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      const secondWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch)
        .mockReturnValueOnce(firstWatcher as unknown as FSWatcher)
        .mockReturnValueOnce(secondWatcher as unknown as FSWatcher);

      const first = await watcher.startWatching('test-store', '/first');
      const second = await watcher.startWatching('test-store', '/second');
      await first.dispose();

      expect(watcher.getStatus('test-store')?.rootPath).toBe(path.resolve('/second'));
      expect(secondWatcher.close).not.toHaveBeenCalled();

      await second.dispose();
      expect(secondWatcher.close).toHaveBeenCalledOnce();
      expect(watcher.getStatus('test-store')).toBeNull();
    });

    it('does not let a superseded pending start replace or dispose the newest watcher', async () => {
      const closeFirst = deferred();
      const firstWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn(() => closeFirst.promise),
        getWatched: vi.fn().mockReturnValue({}),
      };
      const newestWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch)
        .mockReturnValueOnce(firstWatcher as unknown as FSWatcher)
        .mockReturnValueOnce(newestWatcher as unknown as FSWatcher);

      const first = await watcher.startWatching('test-store', '/first');
      const supersededStart = watcher.startWatching('test-store', '/superseded');
      const newest = await watcher.startWatching('test-store', '/newest');
      closeFirst.resolve();
      const superseded = await supersededStart;

      await first.dispose();
      await superseded.dispose();

      expect(watch).toHaveBeenCalledTimes(2);
      expect(watcher.getStatus('test-store')?.rootPath).toBe(path.resolve('/newest'));
      expect(newestWatcher.close).not.toHaveBeenCalled();

      await newest.dispose();
      expect(watcher.getStatus('test-store')).toBeNull();
    });

    it('retains a rejected replacement close until stopAll retries it successfully', async () => {
      let underlyingOpen = true;
      const close = vi.fn()
        .mockRejectedValueOnce(new Error('controlled close failure'))
        .mockImplementationOnce(async () => {
          underlyingOpen = false;
        });
      const firstWatcher = {
        on: vi.fn().mockReturnThis(),
        close,
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch).mockReturnValue(firstWatcher as unknown as FSWatcher);

      await watcher.startWatching('test-store', '/first');
      await expect(watcher.startWatching('test-store', '/replacement'))
        .rejects.toThrow('controlled close failure');

      const active = Reflect.get(watcher, 'watchers') as Map<string, unknown>;
      const owned = Reflect.get(watcher, 'ownedWatchers') as Map<symbol, unknown> | undefined;
      const latest = Reflect.get(watcher, 'latestStartIds') as Map<string, symbol>;
      expect(owned?.size ?? active.size).toBe(1);
      expect(latest.size).toBe(0);
      expect(underlyingOpen).toBe(true);

      await watcher.stopAll();

      expect(close).toHaveBeenCalledTimes(2);
      expect(active.size).toBe(0);
      expect(owned?.size ?? active.size).toBe(0);
      expect(latest.size).toBe(0);
      expect(underlyingOpen).toBe(false);
    });

    it('backs off to polling on recoverable watcher errors without emitting unhandled error', async () => {
      vi.useFakeTimers();

      const nativeWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      const pollingWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any)
        .mockReturnValueOnce(nativeWatcher)
        .mockReturnValueOnce(pollingWatcher);

      await watcher.startWatching('test-store', '/fake/path');

      const errorHandler = nativeWatcher.on.mock.calls.find((call: any[]) => call[0] === 'error')?.[1];
      expect(errorHandler).toBeTypeOf('function');

      expect(() => errorHandler(Object.assign(new Error('too many files'), { code: 'EMFILE' }))).not.toThrow();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(nativeWatcher.close).toHaveBeenCalled();
      expect(watch).toHaveBeenLastCalledWith(
        expect.stringContaining(fakePath),
        expect.objectContaining({
          usePolling: true,
          interval: expect.any(Number),
        }),
      );

      vi.useRealTimers();
    });

    it('should emit change events', async () => {
      const changeEvents: any[] = [];
      watcher.on('change:detected', (data) => {
        changeEvents.push(data);
      });

      // Get the mock watcher
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');

      // Simulate a file change by calling the 'change' handler
      const onCalls = mockWatcher.on.mock.calls;
      const changeHandler = onCalls.find((call: any[]) => call[0] === 'change');

      if (changeHandler) {
        // Call the change handler with a file path
        changeHandler[1]('/fake/path/file.ts');
      }
    });
  });

  describe('stopWatching', () => {
    it('should stop watching a specific store', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: mockClose,
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');
      await watcher.stopWatching('test-store');

      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle stopping non-existent watcher', async () => {
      // Should not throw
      await expect(watcher.stopWatching('non-existent')).resolves.not.toThrow();
    });

    it('should emit watcher:stopped event', async () => {
      const stoppedEvents: any[] = [];
      watcher.on('watcher:stopped', (data) => {
        stoppedEvents.push(data);
      });

      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');
      await watcher.stopWatching('test-store');

      expect(stoppedEvents.length).toBeGreaterThan(0);
      expect(stoppedEvents[0].storeId).toBe('test-store');
    });
  });

  describe('stopAll', () => {
    it('should stop all watchers', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: mockClose,
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('store-1', '/path1');
      await watcher.startWatching('store-2', '/path2');
      await watcher.stopAll();

      expect(mockClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStatus', () => {
    it('should return watching status', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');
      const status = watcher.getStatus('test-store');

      expect(status).toEqual(expect.objectContaining({
        storeId: 'test-store',
        rootPath: expect.stringContaining(fakePath),
        isWatching: true,
        pendingChanges: 0,
      }));
    });

    it('should return null for non-existent watcher', () => {
      const status = watcher.getStatus('non-existent');
      expect(status).toBeNull();
    });
  });

  describe('getActiveWatchers', () => {
    it('should return list of active watcher store IDs', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('store-1', '/path1');
      await watcher.startWatching('store-2', '/path2');

      const active = watcher.getActiveWatchers();

      expect(active).toContain('store-1');
      expect(active).toContain('store-2');
    });
  });

  describe('debouncing', () => {
    it('should debounce rapid changes', async () => {
      vi.useFakeTimers();

      const processingEvents: any[] = [];
      watcher.on('changes:processing', (data) => {
        processingEvents.push(data);
      });

      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');

      // Simulate multiple rapid changes via the 'change' handler
      const onCalls = mockWatcher.on.mock.calls;
      const changeHandler = onCalls.find((call: any[]) => call[0] === 'change');

      if (changeHandler) {
        // Simulate rapid file changes
        changeHandler[1]('/fake/path/file1.ts');
        changeHandler[1]('/fake/path/file2.ts');
        changeHandler[1]('/fake/path/file3.ts');
      }

      // Fast forward past debounce time
      await vi.advanceTimersByTimeAsync(1000);

      vi.useRealTimers();
    });
  });

  describe('configure', () => {
    it('should update configuration', () => {
      watcher.configure({
        debounceMs: 500,
        autoIndex: false,
      });

      // Configuration is internal, but we can test behavior
      expect(watcher).toBeDefined();
    });
  });

  describe('flushChanges', () => {
    it('should process pending changes immediately', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');

      // Should not throw
      await expect(watcher.flushChanges('test-store')).resolves.not.toThrow();
    });

    it('lets an existing add become a deletion at capacity while rejecting only a new path', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch).mockReturnValue(mockWatcher as unknown as FSWatcher);
      const syncFiles = vi.fn<CodebaseFileIndexingTarget['syncFiles']>(
        async (_storeId, deletions, upserts) => ({
          outcomes: [
            ...deletions.map((filePath) => ({
              operation: 'removed' as const,
              filePath,
              success: true,
            })),
            ...upserts.map((filePath) => ({
              operation: 'indexed' as const,
              filePath,
              success: true,
            })),
          ],
        }),
      );
      watcher = new CodebaseFileWatcher({ maxPendingChanges: 2 }, { syncFiles });
      const warning = vi.fn();
      watcher.on('warning', warning);

      await watcher.startWatching('test-store', '/fake/path');
      const add = mockWatcher.on.mock.calls.find(([event]) => event === 'add')?.[1] as
        ((filePath: string) => void) | undefined;
      const unlink = mockWatcher.on.mock.calls.find(([event]) => event === 'unlink')?.[1] as
        ((filePath: string) => void) | undefined;
      add?.('/fake/path/a.ts');
      add?.('/fake/path/b.ts');
      unlink?.('/fake/path/a.ts');
      add?.('/fake/path/c.ts');

      expect(watcher.getStatus('test-store')?.pendingChanges).toBe(2);
      expect(warning).toHaveBeenCalledOnce();
      await watcher.flushChanges('test-store');

      expect(syncFiles.mock.calls).toEqual([
        ['test-store', ['/fake/path/a.ts'], []],
        ['test-store', [], ['/fake/path/b.ts']],
      ]);
    });

    it('lets an existing deletion become an addition at capacity while rejecting only a new path', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch).mockReturnValue(mockWatcher as unknown as FSWatcher);
      const syncFiles = vi.fn<CodebaseFileIndexingTarget['syncFiles']>(
        async (_storeId, deletions, upserts) => ({
          outcomes: [
            ...deletions.map((filePath) => ({
              operation: 'removed' as const,
              filePath,
              success: true,
            })),
            ...upserts.map((filePath) => ({
              operation: 'indexed' as const,
              filePath,
              success: true,
            })),
          ],
        }),
      );
      watcher = new CodebaseFileWatcher({ maxPendingChanges: 2 }, { syncFiles });
      const warning = vi.fn();
      watcher.on('warning', warning);

      await watcher.startWatching('test-store', '/fake/path');
      const add = mockWatcher.on.mock.calls.find(([event]) => event === 'add')?.[1] as
        ((filePath: string) => void) | undefined;
      const change = mockWatcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
        ((filePath: string) => void) | undefined;
      const unlink = mockWatcher.on.mock.calls.find(([event]) => event === 'unlink')?.[1] as
        ((filePath: string) => void) | undefined;
      unlink?.('/fake/path/a.ts');
      add?.('/fake/path/b.ts');
      add?.('/fake/path/a.ts');
      change?.('/fake/path/c.ts');

      expect(watcher.getStatus('test-store')?.pendingChanges).toBe(2);
      expect(warning).toHaveBeenCalledOnce();
      await watcher.flushChanges('test-store');

      expect(syncFiles.mock.calls).toEqual([
        ['test-store', [], ['/fake/path/a.ts', '/fake/path/b.ts']],
      ]);
    });

    it('sends deletion chunks before upsert chunks and maps each outcome to watcher events', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch).mockReturnValue(mockWatcher as unknown as FSWatcher);
      const syncFiles = vi.fn<CodebaseFileIndexingTarget['syncFiles']>(
        async (_storeId, deletions, upserts) => ({
          outcomes: [
            ...deletions.map((filePath) => ({
              operation: 'removed' as const,
              filePath,
              success: true,
            })),
            ...upserts.map((filePath) => ({
              operation: 'indexed' as const,
              filePath,
              success: !filePath.endsWith('/bad.ts'),
              ...(filePath.endsWith('/bad.ts') ? { error: 'parse failed' } : {}),
            })),
          ],
        }),
      );
      const indexingTarget = { syncFiles };
      watcher = new CodebaseFileWatcher({}, indexingTarget);
      const removed = vi.fn();
      const indexed = vi.fn();
      const failed = vi.fn();
      watcher.on('file:removed', removed);
      watcher.on('file:indexed', indexed);
      watcher.on('file:error', failed);

      await watcher.startWatching('test-store', '/fake/path');
      const eventHandler = (event: 'add' | 'change' | 'unlink') => (
        mockWatcher.on.mock.calls.find(([registeredEvent]) => registeredEvent === event)?.[1]
      ) as ((filePath: string) => void) | undefined;
      eventHandler('add')?.('/fake/path/new.ts');
      eventHandler('change')?.('/fake/path/bad.ts');
      eventHandler('unlink')?.('/fake/path/old.ts');

      await watcher.flushChanges('test-store');

      expect(syncFiles.mock.calls).toEqual([
        ['test-store', ['/fake/path/old.ts'], []],
        ['test-store', [], ['/fake/path/new.ts', '/fake/path/bad.ts']],
      ]);
      expect(removed).toHaveBeenCalledWith({
        storeId: 'test-store',
        filePath: '/fake/path/old.ts',
      });
      expect(indexed).toHaveBeenCalledWith({
        storeId: 'test-store',
        filePath: '/fake/path/new.ts',
      });
      expect(failed).toHaveBeenCalledWith({
        storeId: 'test-store',
        filePath: '/fake/path/bad.ts',
        error: 'parse failed',
      });
    });

    it('maps a lane-level batch failure to every affected file without losing the watcher', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch).mockReturnValue(mockWatcher as unknown as FSWatcher);
      const indexingTarget = {
        syncFiles: vi.fn().mockRejectedValue(new Error('lane unavailable')),
      };
      watcher = new CodebaseFileWatcher({}, indexingTarget);
      const failed = vi.fn();
      watcher.on('file:error', failed);

      await watcher.startWatching('test-store', '/fake/path');
      const unlink = mockWatcher.on.mock.calls.find(([event]) => event === 'unlink')?.[1] as
        ((filePath: string) => void) | undefined;
      const add = mockWatcher.on.mock.calls.find(([event]) => event === 'add')?.[1] as
        ((filePath: string) => void) | undefined;
      unlink?.('/fake/path/old.ts');
      add?.('/fake/path/new.ts');

      await watcher.flushChanges('test-store');

      expect(failed).toHaveBeenCalledTimes(2);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({
        storeId: 'test-store',
        filePath: '/fake/path/old.ts',
        error: 'lane unavailable',
      }));
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({
        storeId: 'test-store',
        filePath: '/fake/path/new.ts',
        error: 'lane unavailable',
      }));
      expect(watcher.getStatus('test-store')?.isWatching).toBe(true);
    });

    it('chunks mixed flushes above the lane cap without omitting or reordering files', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch).mockReturnValue(mockWatcher as unknown as FSWatcher);
      const syncFiles = vi.fn<CodebaseFileIndexingTarget['syncFiles']>(
        async (_storeId, deletions, upserts) => {
          if (deletions.length + upserts.length > MAX_INDEXING_LANE_BATCH_FILES) {
            throw new Error('oversized lane batch');
          }
          return {
            outcomes: [
              ...deletions.map((filePath) => ({
                operation: 'removed' as const,
                filePath,
                success: true,
              })),
              ...upserts.map((filePath) => ({
                operation: 'indexed' as const,
                filePath,
                success: true,
              })),
            ],
          };
        },
      );
      watcher = new CodebaseFileWatcher({}, { syncFiles });
      const removedPaths: string[] = [];
      const indexedPaths: string[] = [];
      const failed = vi.fn();
      const processed = vi.fn();
      watcher.on('file:removed', (event: { filePath: string }) => removedPaths.push(event.filePath));
      watcher.on('file:indexed', (event: { filePath: string }) => indexedPaths.push(event.filePath));
      watcher.on('file:error', failed);
      watcher.on('changes:processed', processed);

      await watcher.startWatching('test-store', '/fake/path');
      const unlink = mockWatcher.on.mock.calls.find(([event]) => event === 'unlink')?.[1] as
        ((filePath: string) => void) | undefined;
      const add = mockWatcher.on.mock.calls.find(([event]) => event === 'add')?.[1] as
        ((filePath: string) => void) | undefined;
      const deletionPaths = Array.from(
        { length: 300 },
        (_, index) => `/fake/path/deleted-${String(index).padStart(3, '0')}.ts`,
      );
      const upsertPaths = Array.from(
        { length: 300 },
        (_, index) => `/fake/path/added-${String(index).padStart(3, '0')}.ts`,
      );
      for (const filePath of deletionPaths) unlink?.(filePath);
      for (const filePath of upsertPaths) add?.(filePath);

      await watcher.flushChanges('test-store');

      expect(syncFiles.mock.calls).toEqual([
        ['test-store', deletionPaths.slice(0, MAX_INDEXING_LANE_BATCH_FILES), []],
        ['test-store', deletionPaths.slice(MAX_INDEXING_LANE_BATCH_FILES), []],
        ['test-store', [], upsertPaths.slice(0, MAX_INDEXING_LANE_BATCH_FILES)],
        ['test-store', [], upsertPaths.slice(MAX_INDEXING_LANE_BATCH_FILES)],
      ]);
      expect(removedPaths).toEqual(deletionPaths);
      expect(indexedPaths).toEqual(upsertPaths);
      expect(failed).not.toHaveBeenCalled();
      expect(processed).toHaveBeenCalledOnce();
      expect(watcher.getStatus('test-store')?.pendingChanges).toBe(0);
    });

    it('continues later deletion and upsert chunks after one chunk-level failure', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch).mockReturnValue(mockWatcher as unknown as FSWatcher);
      let invocation = 0;
      const syncFiles = vi.fn<CodebaseFileIndexingTarget['syncFiles']>(
        async (_storeId, deletions, upserts) => {
          invocation++;
          if (invocation === 1) throw new Error('first chunk failed');
          return {
            outcomes: [
              ...deletions.map((filePath) => ({
                operation: 'removed' as const,
                filePath,
                success: true,
              })),
              ...upserts.map((filePath) => ({
                operation: 'indexed' as const,
                filePath,
                success: true,
              })),
            ],
          };
        },
      );
      watcher = new CodebaseFileWatcher({}, { syncFiles });
      const removedPaths: string[] = [];
      const indexedPaths: string[] = [];
      const failedPaths: string[] = [];
      watcher.on('file:removed', (event: { filePath: string }) => removedPaths.push(event.filePath));
      watcher.on('file:indexed', (event: { filePath: string }) => indexedPaths.push(event.filePath));
      watcher.on('file:error', (event: { filePath: string }) => failedPaths.push(event.filePath));

      await watcher.startWatching('test-store', '/fake/path');
      const unlink = mockWatcher.on.mock.calls.find(([event]) => event === 'unlink')?.[1] as
        ((filePath: string) => void) | undefined;
      const add = mockWatcher.on.mock.calls.find(([event]) => event === 'add')?.[1] as
        ((filePath: string) => void) | undefined;
      const deletionPaths = Array.from(
        { length: 300 },
        (_, index) => `/fake/path/deleted-${String(index).padStart(3, '0')}.ts`,
      );
      const upsertPaths = ['/fake/path/added-000.ts', '/fake/path/added-001.ts'];
      for (const filePath of deletionPaths) unlink?.(filePath);
      for (const filePath of upsertPaths) add?.(filePath);

      await watcher.flushChanges('test-store');

      expect(syncFiles.mock.calls).toEqual([
        ['test-store', deletionPaths.slice(0, MAX_INDEXING_LANE_BATCH_FILES), []],
        ['test-store', deletionPaths.slice(MAX_INDEXING_LANE_BATCH_FILES), []],
        ['test-store', [], upsertPaths],
      ]);
      expect(failedPaths).toEqual(deletionPaths.slice(0, MAX_INDEXING_LANE_BATCH_FILES));
      expect(removedPaths).toEqual(deletionPaths.slice(MAX_INDEXING_LANE_BATCH_FILES));
      expect(indexedPaths).toEqual(upsertPaths);
    });

    it('does not spawn an empty lane job when auto-indexing is disabled', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      vi.mocked(watch).mockReturnValue(mockWatcher as unknown as FSWatcher);
      const indexingTarget = {
        syncFiles: vi.fn().mockResolvedValue({ outcomes: [] }),
      };
      watcher = new CodebaseFileWatcher({ autoIndex: false }, indexingTarget);
      const pending = vi.fn();
      watcher.on('file:pending', pending);

      await watcher.startWatching('test-store', '/fake/path');
      const add = mockWatcher.on.mock.calls.find(([event]) => event === 'add')?.[1] as
        ((filePath: string) => void) | undefined;
      add?.('/fake/path/new.ts');
      await watcher.flushChanges('test-store');

      expect(pending).toHaveBeenCalledWith({
        storeId: 'test-store',
        filePath: '/fake/path/new.ts',
      });
      expect(indexingTarget.syncFiles).not.toHaveBeenCalled();
    });
  });
});
