/**
 * Integration coverage for the codebase auto-index workspace-open trigger.
 *
 * This wires the real RecentDirectoriesManager singleton and recent-directory
 * IPC handler to a CodebaseIndexingAutoCoordinator with fake heavy dependencies.
 * It verifies that opening a local workspace through RECENT_DIRS_ADD reaches a
 * complete auto-index status and starts the watcher without spawning an
 * instance or booting embeddings/sqlite.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { AppSettings } from '../../../../shared/types/settings.types';
import type {
  AutoIndexContextManagerTarget,
  AutoIndexFileWatcherTarget,
  AutoIndexingTarget,
  AutoIndexProjectRegistryTarget,
  AutoIndexSettingsTarget,
  PreflightResult,
} from '../../../indexing/codebase-indexing-auto-coordinator';
import type { IndexingProgress, IndexingStats } from '../../../../shared/types/codebase.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const handlers = new Map<string, IpcHandler>();

function createStoreMock(tempRoot: string) {
  return class MockElectronStore<T extends Record<string, unknown>> {
    private data: Record<string, unknown>;
    path = path.join(tempRoot, 'recent-directories.json');

    constructor(options?: { defaults?: T }) {
      this.data = structuredClone(options?.defaults ?? {});
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.data[key as string] as T[K];
    }

    set<K extends keyof T>(key: K, value: T[K]): void;
    set(object: Partial<T>): void;
    set(keyOrObject: keyof T | Partial<T>, value?: T[keyof T]): void {
      if (typeof keyOrObject === 'string') {
        this.data[keyOrObject] = value;
        return;
      }
      Object.assign(this.data, keyOrObject);
    }

    clear(): void {
      this.data = {};
    }

    get store(): T {
      return this.data as T;
    }
  };
}

function createAutoIndexSettings(): AutoIndexSettingsTarget {
  const values: Partial<AppSettings> = {
    codebaseAutoIndexEnabled: true,
    codebaseAutoIndexMaxFiles: 100,
    codebaseAutoIndexMaxBytes: 1_000_000,
    codebaseAutoIndexConcurrent: 1,
    codebaseAutoIndexDebounceMs: 0,
  };

  return {
    get<K extends keyof AppSettings>(key: K): AppSettings[K] {
      return values[key] as AppSettings[K];
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('recent directories IPC codebase auto-index integration', () => {
  let tempRoot = '';

  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    tempRoot = mkdtempSync(path.join(tmpdir(), 'recent-codebase-auto-index-'));

    vi.doMock('electron', () => ({
      ipcMain: {
        handle: vi.fn((channel: string, handler: IpcHandler) => {
          handlers.set(channel, handler);
        }),
      },
      app: {
        getPath: vi.fn(() => tempRoot),
        addRecentDocument: vi.fn(),
      },
    }));

    vi.doMock('electron-store', () => ({
      default: createStoreMock(tempRoot),
    }));

    vi.doMock('../../core/config/settings-manager', () => ({
      getSettingsManager: () => ({
        get: (key: keyof AppSettings) => {
          if (key === 'maxRecentDirectories') return 50;
          if (key === 'defaultWorkingDirectory') return '';
          return undefined;
        },
        on: vi.fn(),
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('electron-store');
    vi.doUnmock('../../core/config/settings-manager');
    vi.resetModules();
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('auto-indexes a local directory added through RECENT_DIRS_ADD and starts the watcher', async () => {
    const workspacePath = path.join(tempRoot, 'workspace');
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(path.join(workspacePath, 'index.ts'), 'export const answer = 42;\n');

    const progress = new EventEmitter();
    const indexing: AutoIndexingTarget & {
      indexCodebase: ReturnType<typeof vi.fn<[string, string, { force?: boolean }?], Promise<IndexingStats>>>;
    } = {
      indexCodebase: vi.fn(async () => ({
        filesIndexed: 1,
        chunksCreated: 2,
        tokensProcessed: 12,
        duration: 5,
        errors: [],
      })),
      on(event: 'progress', listener: (progress: IndexingProgress) => void) {
        progress.on(event, listener);
        return this;
      },
      off(event: 'progress', listener: (progress: IndexingProgress) => void) {
        progress.off(event, listener);
        return this;
      },
    };
    const fileWatcher: AutoIndexFileWatcherTarget & {
      startCalls: { storeId: string; rootPath: string }[];
    } = {
      startCalls: [],
      async startWatching(storeId: string, rootPath: string): Promise<void> {
        this.startCalls.push({ storeId, rootPath });
      },
    };
    const contextManager: AutoIndexContextManagerTarget = {
      createStore(instanceId: string): { id: string } {
        return { id: `ctx_${instanceId}` };
      },
    };
    const registry: AutoIndexProjectRegistryTarget = {
      canAutoMine: () => true,
    };
    const preflight = vi.fn<
      [string, { maxFiles: number; maxBytes: number }],
      Promise<PreflightResult>
    >().mockResolvedValue({ fileCount: 1, totalBytes: 26 });

    const { getRecentDirectoriesManager } = await import(
      '../../../core/config/recent-directories-manager'
    );
    const { CodebaseIndexingAutoCoordinator } = await import(
      '../../../indexing/codebase-indexing-auto-coordinator'
    );
    const { registerRecentDirectoriesHandlers } = await import(
      '../recent-directories-handlers'
    );
    const { IPC_CHANNELS } = await import('../../../../shared/types/ipc.types');

    const coordinator = new CodebaseIndexingAutoCoordinator({
      recentDirectoriesManager: getRecentDirectoriesManager(),
      indexingService: indexing,
      fileWatcher,
      contextManager,
      registry,
      settings: createAutoIndexSettings(),
      preflight,
      storeIdResolver: (rootPath) => `codebase:${rootPath}`,
    });
    coordinator.start();
    registerRecentDirectoriesHandlers();

    const handler = handlers.get(IPC_CHANNELS.RECENT_DIRS_ADD);
    expect(handler).toBeDefined();

    const response = await handler!({}, { path: workspacePath });
    await flushMicrotasks();

    expect(response.success).toBe(true);
    expect(indexing.indexCodebase).toHaveBeenCalledWith(
      `ctx_codebase:${workspacePath}`,
      workspacePath,
      { force: false },
    );
    const status = coordinator.getStatus(workspacePath);
    expect(status?.state).toBe('complete');
    expect(status?.chunksProcessed).toBeGreaterThan(0);
    expect(fileWatcher.startCalls).toEqual([
      {
        storeId: `ctx_codebase:${workspacePath}`,
        rootPath: workspacePath,
      },
    ]);

    coordinator.stop();
  });
});
