/**
 * Codebase auto-index IPC handler tests.
 *
 * Covers two of the channels introduced by
 * `docs/plans/2026-05-26-codebase-indexing-auto-start.md`:
 *   - CODEBASE_AUTO_STATUS_GET (per-path + list-all)
 *   - CODEBASE_AUTO_STATUS_CHANGED (coordinator → renderer forwarding)
 *
 * The original third channel, `CODEBASE_AUTO_HINT`, was consolidated into
 * the unified `WORKSPACE_HINT_ACTIVE` channel per
 * `docs/plans/2026-05-26-project-code-index-bridge-auto-mirror.md`; tests
 * for the fan-out behaviour live in `workspace-hint-handlers.spec.ts`.
 *
 * We don't exercise the heavier indexing / watcher / search handlers here —
 * they have their own coverage and bringing them up would require mocking
 * sqlite, the embedder, chokidar, etc.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { CodebaseAutoIndexStatus } from '../../../../shared/types/codebase.types';

// ─── Mock electron + send tracking ────────────────────────────────────────────

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, IpcHandler>();
const ipcRegistrationControl = vi.hoisted(() => ({
  failHandleAt: null as number | null,
  failRemoveChannel: null as string | null,
  handleCalls: 0,
  handleError: null as Error | null,
  removeError: null as Error | null,
  trace: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      ipcRegistrationControl.handleCalls += 1;
      ipcRegistrationControl.trace.push(`handle:${channel}`);
      if (ipcRegistrationControl.handleCalls === ipcRegistrationControl.failHandleAt) {
        throw ipcRegistrationControl.handleError;
      }
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcRegistrationControl.trace.push(`remove:${channel}`);
      if (channel === ipcRegistrationControl.failRemoveChannel) {
        throw ipcRegistrationControl.removeError;
      }
      handlers.delete(channel);
    }),
  },
}));

const sentMessages: { channel: string; payload: unknown }[] = [];
const mainWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload: unknown) => sentMessages.push({ channel, payload }),
  },
};

const windowManager = {
  getMainWindow: () => mainWindow as unknown as Electron.BrowserWindow,
  sendToRenderer: (channel: string, payload: unknown) => sentMessages.push({ channel, payload }),
} as unknown as import('../../../window-manager').WindowManager;

// ─── Mock the indexing module so registerCodebaseHandlers can wire up ───────

const indexingProgressEmitter = new EventEmitter();
const fileWatcherChangesEmitter = new EventEmitter();
const autoCoordinatorEmitter = new EventEmitter();

const indexingService = Object.assign(indexingProgressEmitter, {
  indexCodebase: vi.fn(),
  indexFile: vi.fn(),
  cancel: vi.fn(),
  getProgress: vi.fn(() => ({ status: 'idle' })),
  getStats: vi.fn(),
  clearLegacyCodebaseStore: vi.fn(),
});

const indexingLaneGateway = Object.assign(new EventEmitter(), {
  indexCodebase: vi.fn(),
  indexFile: vi.fn(),
  getStats: vi.fn(),
  clearLegacyCodebaseStore: vi.fn(),
  cancelIndexCodebase: vi.fn(),
  getIndexCodebaseProgress: vi.fn(),
});

const fileWatcher = Object.assign(fileWatcherChangesEmitter, {
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getStatus: vi.fn(),
});

const autoStatuses = new Map<string, CodebaseAutoIndexStatus>();
const autoCoordinator = Object.assign(autoCoordinatorEmitter, {
  hintActiveWorkspace: vi.fn((path: string) => {
    autoStatuses.set(path, {
      rootPath: path,
      storeId: `store_${path}`,
      state: 'queued',
    });
    autoCoordinatorEmitter.emit('status', autoStatuses.get(path));
  }),
  getStatus: vi.fn((path: string) => autoStatuses.get(path)),
  listStatuses: vi.fn(() => Array.from(autoStatuses.values())),
});

const codeRetrievalService = {
  search: vi.fn(),
};

const codemem = {
  indexWorkerGateway: {
    getIndexStatus: vi.fn(),
    cancelIndex: vi.fn(),
  },
};

vi.mock('../../../indexing/indexing-service', () => {
  throw new Error('Electron main resolved CodebaseIndexingService');
});

vi.mock('../../../indexing/file-watcher', () => ({
  getCodebaseFileWatcher: () => fileWatcher,
}));

vi.mock('../../../indexing/codebase-indexing-auto-coordinator', () => ({
  getCodebaseIndexingAutoCoordinator: () => autoCoordinator,
}));

vi.mock('../../../indexing/codebase-indexing-lane-gateway', () => ({
  getCodebaseIndexingLaneGateway: () => indexingLaneGateway,
}));

vi.mock('../../../persistence/rlm-database', () => ({
  RLMDatabase: {
    getInstance: () => ({ db: {} }),
  },
}));

vi.mock('../../../codemem', () => ({
  getCodeRetrievalService: () => codeRetrievalService,
  getCodemem: () => codemem,
}));

// Import the handler module last so vi.mock() statements above take effect.
import { registerCodebaseHandlers } from '../codebase-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

const registrationChannels = [
  IPC_CHANNELS.CODEBASE_INDEX_STORE,
  IPC_CHANNELS.CODEBASE_INDEX_FILE,
  IPC_CHANNELS.CODEBASE_INDEX_CANCEL,
  IPC_CHANNELS.CODEBASE_INDEX_STATUS,
  IPC_CHANNELS.CODEBASE_INDEX_STATS,
  IPC_CHANNELS.CODEBASE_LEGACY_CLEAR,
  IPC_CHANNELS.CODEBASE_SEARCH,
  IPC_CHANNELS.CODEBASE_SEARCH_SYMBOLS,
  IPC_CHANNELS.CODEBASE_WATCHER_START,
  IPC_CHANNELS.CODEBASE_WATCHER_STOP,
  IPC_CHANNELS.CODEBASE_WATCHER_STATUS,
  IPC_CHANNELS.CODEBASE_AUTO_STATUS_GET,
] as const;

function resetRegistrationFailureControl(): void {
  ipcRegistrationControl.failHandleAt = null;
  ipcRegistrationControl.failRemoveChannel = null;
  ipcRegistrationControl.handleCalls = 0;
  ipcRegistrationControl.handleError = null;
  ipcRegistrationControl.removeError = null;
  ipcRegistrationControl.trace.length = 0;
}

function traceListenerRemoval(): () => void {
  const laneOff = indexingLaneGateway.off.bind(indexingLaneGateway);
  const watcherOff = fileWatcher.off.bind(fileWatcher);
  const autoOff = autoCoordinator.off.bind(autoCoordinator);
  const laneSpy = vi.spyOn(indexingLaneGateway, 'off').mockImplementation((event, listener) => {
    ipcRegistrationControl.trace.push(`off:lane:${String(event)}`);
    return laneOff(event, listener);
  });
  const watcherSpy = vi.spyOn(fileWatcher, 'off').mockImplementation((event, listener) => {
    ipcRegistrationControl.trace.push(`off:watcher:${String(event)}`);
    return watcherOff(event, listener);
  });
  const autoSpy = vi.spyOn(autoCoordinator, 'off').mockImplementation((event, listener) => {
    ipcRegistrationControl.trace.push(`off:auto:${String(event)}`);
    return autoOff(event, listener);
  });
  return () => {
    laneSpy.mockRestore();
    watcherSpy.mockRestore();
    autoSpy.mockRestore();
  };
}

describe('codebase auto-index handlers', () => {
  let registration: { dispose(): void };

  beforeEach(() => {
    handlers.clear();
    ipcRegistrationControl.failHandleAt = null;
    ipcRegistrationControl.failRemoveChannel = null;
    ipcRegistrationControl.handleCalls = 0;
    ipcRegistrationControl.handleError = null;
    ipcRegistrationControl.removeError = null;
    ipcRegistrationControl.trace.length = 0;
    sentMessages.length = 0;
    autoStatuses.clear();
    indexingProgressEmitter.removeAllListeners();
    fileWatcherChangesEmitter.removeAllListeners();
    autoCoordinatorEmitter.removeAllListeners();
    indexingLaneGateway.removeAllListeners();
    autoCoordinator.hintActiveWorkspace.mockClear();
    autoCoordinator.getStatus.mockClear();
    autoCoordinator.listStatuses.mockClear();
    indexingService.indexCodebase.mockReset();
    indexingService.clearLegacyCodebaseStore.mockReset();
    indexingLaneGateway.indexCodebase.mockReset();
    indexingLaneGateway.indexFile.mockReset();
    indexingLaneGateway.getStats.mockReset();
    indexingLaneGateway.clearLegacyCodebaseStore.mockReset();
    indexingLaneGateway.cancelIndexCodebase.mockReset();
    indexingLaneGateway.getIndexCodebaseProgress.mockReset();
    codeRetrievalService.search.mockReset();
    codemem.indexWorkerGateway.getIndexStatus.mockReset();
    codemem.indexWorkerGateway.cancelIndex.mockReset();
    registration = registerCodebaseHandlers(windowManager) as unknown as { dispose(): void };
  });

  it('disposes every IPC registration and event forwarding listener idempotently', () => {
    expect(indexingLaneGateway.listenerCount('progress')).toBe(1);
    expect(fileWatcher.listenerCount('changes:processed')).toBe(1);
    expect(autoCoordinator.listenerCount('status')).toBe(1);
    expect(handlers.size).toBe(12);

    registration.dispose();
    registration.dispose();

    expect(indexingLaneGateway.listenerCount('progress')).toBe(0);
    expect(fileWatcher.listenerCount('changes:processed')).toBe(0);
    expect(autoCoordinator.listenerCount('status')).toBe(0);
    expect(handlers.size).toBe(0);
  });

  it.each([
    { failAt: 1, attempted: registrationChannels.slice(0, 1) },
    { failAt: 6, attempted: registrationChannels.slice(0, 6) },
    { failAt: 12, attempted: registrationChannels.slice(0, 12) },
  ])('rolls back the exact successful prefix when handler registration $failAt fails', ({
    failAt,
    attempted,
  }) => {
    registration.dispose();
    handlers.clear();
    resetRegistrationFailureControl();
    const registrationError = new Error(`injected registration failure ${failAt}`);
    const failedChannel = registrationChannels[failAt - 1];
    const preExistingHandler = vi.fn();
    const unrelatedHandler = vi.fn();
    handlers.set(failedChannel, preExistingHandler as never);
    handlers.set('unrelated:channel', unrelatedHandler as never);
    const unrelatedLaneListener = vi.fn();
    const unrelatedWatcherListener = vi.fn();
    const unrelatedAutoListener = vi.fn();
    indexingLaneGateway.on('progress', unrelatedLaneListener);
    fileWatcher.on('changes:processed', unrelatedWatcherListener);
    autoCoordinator.on('status', unrelatedAutoListener);
    const restoreListenerTracing = traceListenerRemoval();
    ipcRegistrationControl.failHandleAt = failAt;
    ipcRegistrationControl.handleError = registrationError;

    try {
      expect(() => registerCodebaseHandlers(windowManager)).toThrow(registrationError);

      expect([...handlers.entries()]).toEqual([
        [failedChannel, preExistingHandler],
        ['unrelated:channel', unrelatedHandler],
      ]);
      expect(indexingLaneGateway.listeners('progress')).toEqual([unrelatedLaneListener]);
      expect(fileWatcher.listeners('changes:processed')).toEqual([unrelatedWatcherListener]);
      expect(autoCoordinator.listeners('status')).toEqual([unrelatedAutoListener]);
      expect(ipcRegistrationControl.trace).toEqual([
        ...attempted.map((channel) => `handle:${channel}`),
        ...attempted.slice(0, -1).reverse().map((channel) => `remove:${channel}`),
        'off:auto:status',
        'off:watcher:changes:processed',
        'off:lane:progress',
      ]);

      handlers.delete(failedChannel);
      resetRegistrationFailureControl();
      const retry = registerCodebaseHandlers(windowManager);
      expect(handlers.size).toBe(13);
      retry.dispose();
      expect([...handlers.entries()]).toEqual([['unrelated:channel', unrelatedHandler]]);
      expect(indexingLaneGateway.listeners('progress')).toEqual([unrelatedLaneListener]);
      expect(fileWatcher.listeners('changes:processed')).toEqual([unrelatedWatcherListener]);
      expect(autoCoordinator.listeners('status')).toEqual([unrelatedAutoListener]);
    } finally {
      restoreListenerTracing();
    }
  });

  it('attempts every rollback when a handler removal also fails', () => {
    registration.dispose();
    handlers.clear();
    resetRegistrationFailureControl();
    const registrationError = new Error('injected middle registration failure');
    const removalError = new Error('injected rollback removal failure');
    const unrelatedHandler = vi.fn();
    handlers.set('unrelated:channel', unrelatedHandler as never);
    const restoreListenerTracing = traceListenerRemoval();
    ipcRegistrationControl.failHandleAt = 6;
    ipcRegistrationControl.handleError = registrationError;
    ipcRegistrationControl.failRemoveChannel = IPC_CHANNELS.CODEBASE_INDEX_FILE;
    ipcRegistrationControl.removeError = removalError;
    let observedError: unknown;

    try {
      try {
        registerCodebaseHandlers(windowManager);
      } catch (error) {
        observedError = error;
      }

      expect(observedError).toBeInstanceOf(AggregateError);
      expect((observedError as AggregateError).errors).toEqual([
        registrationError,
        removalError,
      ]);
      expect(ipcRegistrationControl.trace).toEqual([
        ...registrationChannels.slice(0, 6).map((channel) => `handle:${channel}`),
        `remove:${IPC_CHANNELS.CODEBASE_INDEX_STATS}`,
        `remove:${IPC_CHANNELS.CODEBASE_INDEX_STATUS}`,
        `remove:${IPC_CHANNELS.CODEBASE_INDEX_CANCEL}`,
        `remove:${IPC_CHANNELS.CODEBASE_INDEX_FILE}`,
        `remove:${IPC_CHANNELS.CODEBASE_INDEX_STORE}`,
        'off:auto:status',
        'off:watcher:changes:processed',
        'off:lane:progress',
      ]);
      expect([...handlers.entries()]).toEqual([
        ['unrelated:channel', unrelatedHandler],
        [IPC_CHANNELS.CODEBASE_INDEX_FILE, expect.any(Function)],
      ]);
      expect(indexingLaneGateway.listenerCount('progress')).toBe(0);
      expect(fileWatcher.listenerCount('changes:processed')).toBe(0);
      expect(autoCoordinator.listenerCount('status')).toBe(0);
    } finally {
      restoreListenerTracing();
    }
  });

  it('rolls back earlier listeners when later listener setup throws', () => {
    registration.dispose();
    handlers.clear();
    resetRegistrationFailureControl();
    const registrationError = new Error('injected auto listener failure');
    const unrelatedLaneListener = vi.fn();
    const unrelatedWatcherListener = vi.fn();
    indexingLaneGateway.on('progress', unrelatedLaneListener);
    fileWatcher.on('changes:processed', unrelatedWatcherListener);
    const restoreListenerTracing = traceListenerRemoval();
    const autoOn = vi.spyOn(autoCoordinator, 'on').mockImplementationOnce(() => {
      throw registrationError;
    });

    try {
      expect(() => registerCodebaseHandlers(windowManager)).toThrow(registrationError);
      expect(ipcRegistrationControl.trace).toEqual([
        'off:watcher:changes:processed',
        'off:lane:progress',
      ]);
      expect(indexingLaneGateway.listeners('progress')).toEqual([unrelatedLaneListener]);
      expect(fileWatcher.listeners('changes:processed')).toEqual([unrelatedWatcherListener]);
      expect(autoCoordinator.listenerCount('status')).toBe(0);
      expect(handlers.size).toBe(0);
    } finally {
      autoOn.mockRestore();
      restoreListenerTracing();
    }
  });

  it('CODEBASE_INDEX_STORE dispatches manual legacy indexing through the background lane', async () => {
    indexingLaneGateway.indexCodebase.mockResolvedValue({
      filesIndexed: 2,
      chunksCreated: 3,
      tokensProcessed: 0,
      duration: 12,
      errors: [],
    });

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_STORE);
    const result = await handler!({}, {
      storeId: 'codebase:test',
      rootPath: '/repo',
      options: { force: true },
    });

    expect(result.success).toBe(true);
    expect(indexingLaneGateway.indexCodebase).toHaveBeenCalledWith('codebase:test', '/repo', { force: true });
  });

  it('forwards background lane indexing progress on CODEBASE_INDEX_PROGRESS', () => {
    const progress = {
      status: 'chunking',
      totalFiles: 10,
      processedFiles: 4,
      totalChunks: 12,
      currentFile: '/repo/src/main.ts',
    };

    indexingLaneGateway.emit('progress', progress);

    const forwarded = sentMessages.filter((m) => m.channel === IPC_CHANNELS.CODEBASE_INDEX_PROGRESS);
    expect(forwarded[forwarded.length - 1]?.payload).toEqual(progress);
  });

  it('CODEBASE_AUTO_STATUS_GET returns null when no status for path', async () => {
    const handler = handlers.get(IPC_CHANNELS.CODEBASE_AUTO_STATUS_GET);
    expect(handler).toBeDefined();
    const result = await handler!({}, { rootPath: '/tmp/unknown' });
    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  it('CODEBASE_AUTO_STATUS_GET returns the status when present', async () => {
    autoStatuses.set('/tmp/known', {
      rootPath: '/tmp/known',
      storeId: 'store_known',
      state: 'complete',
      filesProcessed: 7,
    });

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_AUTO_STATUS_GET);
    const result = await handler!({}, { rootPath: '/tmp/known' });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ rootPath: '/tmp/known', state: 'complete' });
  });

  it('CODEBASE_AUTO_STATUS_GET returns the full list when no rootPath', async () => {
    autoStatuses.set('/a', { rootPath: '/a', storeId: 'sa', state: 'queued' });
    autoStatuses.set('/b', { rootPath: '/b', storeId: 'sb', state: 'running' });

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_AUTO_STATUS_GET);
    const result = await handler!({}, undefined);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect((result.data as CodebaseAutoIndexStatus[]).length).toBe(2);
  });

  it('forwards coordinator status events on CODEBASE_AUTO_STATUS_CHANGED', () => {
    const status: CodebaseAutoIndexStatus = {
      rootPath: '/forward',
      storeId: 'sf',
      state: 'running',
    };
    autoCoordinatorEmitter.emit('status', status);
    const forwarded = sentMessages.filter((m) => m.channel === IPC_CHANNELS.CODEBASE_AUTO_STATUS_CHANGED);
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded[forwarded.length - 1].payload).toMatchObject(status);
  });

  it('CODEBASE_SEARCH returns renderer-compatible hybrid results from codemem retrieval', async () => {
    codeRetrievalService.search.mockResolvedValue([
      {
        workspacePath: '/repo',
        relativePath: 'src/auth.ts',
        absolutePath: '/repo/src/auth.ts',
        content: 'export function issueSessionToken() {}',
        startLine: 1,
        endLine: 1,
        score: -1.2,
        source: 'fts',
        language: 'typescript',
        symbolName: 'issueSessionToken',
        stale: false,
      },
    ]);

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_SEARCH);
    const result = await handler!({}, {
      options: {
        workspacePath: '/repo',
        query: 'issue session token',
        topK: 5,
      },
    });

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>[] | undefined)?.[0]).toEqual(expect.objectContaining({
      filePath: '/repo/src/auth.ts',
      content: expect.stringContaining('issueSessionToken'),
      matchType: 'bm25',
    }));
    expect(codeRetrievalService.search).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/repo',
      query: 'issue session token',
      limit: 5,
    }));
  });

  it('CODEBASE_INDEX_STATUS returns codemem status when workspacePath is provided', async () => {
    codemem.indexWorkerGateway.getIndexStatus.mockResolvedValue({
      workspacePath: '/repo',
      workspaceHash: 'workspace-hash',
      state: 'running',
      phase: 'chunking',
      totalFiles: 20,
      processedFiles: 10,
      totalChunks: 40,
      processedChunks: 12,
      currentPath: 'src/auth.ts',
      startedAt: 100,
      updatedAt: 200,
      completedAt: null,
      etaMs: 500,
      errorMessage: null,
    });

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_STATUS);
    const result = await handler!({}, { workspacePath: '/repo' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      workspacePath: '/repo',
      state: 'running',
      phase: 'chunking',
    }));
  });

  it('CODEBASE_INDEX_STATUS returns legacy lane status when target is legacy', async () => {
    indexingLaneGateway.getIndexCodebaseProgress.mockReturnValue({
      status: 'chunking',
      totalFiles: 20,
      processedFiles: 10,
      totalChunks: 0,
      rootPath: '/repo',
      currentFile: '/repo/src/auth.ts',
    });

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_STATUS);
    const result = await handler!({}, { workspacePath: '/repo', target: 'legacy' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({
      status: 'chunking',
      rootPath: '/repo',
      processedFiles: 10,
    }));
    expect(indexingLaneGateway.getIndexCodebaseProgress).toHaveBeenCalledWith('/repo');
    expect(codemem.indexWorkerGateway.getIndexStatus).not.toHaveBeenCalled();
  });

  it('CODEBASE_INDEX_CANCEL cancels codemem indexing when workspacePath is provided', async () => {
    codemem.indexWorkerGateway.cancelIndex.mockResolvedValue(undefined);

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_CANCEL);
    const result = await handler!({}, { workspacePath: '/repo' });

    expect(result.success).toBe(true);
    expect(codemem.indexWorkerGateway.cancelIndex).toHaveBeenCalledWith('/repo');
  });

  it('CODEBASE_INDEX_CANCEL cancels legacy lane indexing when target is legacy', async () => {
    indexingLaneGateway.cancelIndexCodebase.mockResolvedValue(1);

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_CANCEL);
    const result = await handler!({}, { workspacePath: '/repo', target: 'legacy' });

    expect(result.success).toBe(true);
    expect(indexingLaneGateway.cancelIndexCodebase).toHaveBeenCalledWith('/repo');
    expect(codemem.indexWorkerGateway.cancelIndex).not.toHaveBeenCalled();
  });

  it('CODEBASE_LEGACY_CLEAR clears the requested legacy RLM store', async () => {
    indexingLaneGateway.clearLegacyCodebaseStore.mockResolvedValue(undefined);

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_LEGACY_CLEAR);
    const result = await handler!({}, { storeId: 'codebase:test' });

    expect(result.success).toBe(true);
    expect(indexingLaneGateway.clearLegacyCodebaseStore).toHaveBeenCalledWith('codebase:test');
  });

  it('routes single-file indexing and stats through the transient lane facade', async () => {
    indexingLaneGateway.indexFile.mockResolvedValue(undefined);
    indexingLaneGateway.getStats.mockResolvedValue({
      storeId: 'codebase:test',
      totalFiles: 2,
      totalChunks: 5,
      totalTokens: 50,
      lastIndexedAt: 1_000,
      indexSize: 2_000,
    });

    const indexFile = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_FILE);
    const indexResult = await indexFile!({}, {
      storeId: 'codebase:test',
      filePath: '/repo/src/file.ts',
    });
    const indexStats = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_STATS);
    const statsResult = await indexStats!({}, { storeId: 'codebase:test' });

    expect(indexResult).toEqual({ success: true });
    expect(indexingLaneGateway.indexFile).toHaveBeenCalledWith(
      'codebase:test',
      '/repo/src/file.ts',
    );
    expect(statsResult).toEqual({
      success: true,
      data: {
        storeId: 'codebase:test',
        totalFiles: 2,
        totalChunks: 5,
        totalTokens: 50,
        lastIndexedAt: 1_000,
        indexSize: 2_000,
      },
    });
    expect(indexingLaneGateway.getStats).toHaveBeenCalledWith('codebase:test');
  });

  it('returns the legacy idle status when no transient lane job exists', async () => {
    indexingLaneGateway.getIndexCodebaseProgress.mockReturnValue(null);

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_STATUS);
    const result = await handler!({}, undefined);

    expect(result).toEqual({
      success: true,
      data: {
        status: 'idle',
        totalFiles: 0,
        processedFiles: 0,
        totalChunks: 0,
      },
    });
  });
});
