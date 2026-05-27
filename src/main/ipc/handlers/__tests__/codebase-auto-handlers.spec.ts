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

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
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

vi.mock('../../../indexing', () => ({
  getCodebaseIndexingService: () => indexingService,
  getHybridSearchService: () => ({ search: vi.fn() }),
  getCodebaseFileWatcher: () => fileWatcher,
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

describe('codebase auto-index handlers', () => {
  beforeEach(() => {
    handlers.clear();
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
    indexingLaneGateway.cancelIndexCodebase.mockReset();
    indexingLaneGateway.getIndexCodebaseProgress.mockReset();
    codeRetrievalService.search.mockReset();
    codemem.indexWorkerGateway.getIndexStatus.mockReset();
    codemem.indexWorkerGateway.cancelIndex.mockReset();
    registerCodebaseHandlers(windowManager);
  });

  it('CODEBASE_INDEX_STORE dispatches manual legacy indexing through the background lane', async () => {
    indexingLaneGateway.indexCodebase.mockResolvedValue({
      filesIndexed: 2,
      chunksCreated: 3,
      tokensProcessed: 0,
      embeddingsCreated: 0,
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
    expect(indexingService.indexCodebase).not.toHaveBeenCalled();
  });

  it('forwards background lane indexing progress on CODEBASE_INDEX_PROGRESS', () => {
    const progress = {
      status: 'chunking',
      totalFiles: 10,
      processedFiles: 4,
      totalChunks: 12,
      embeddedChunks: 0,
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
    expect(result.data?.[0]).toEqual(expect.objectContaining({
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
    expect(indexingService.getProgress).not.toHaveBeenCalled();
  });

  it('CODEBASE_INDEX_STATUS returns legacy lane status when target is legacy', async () => {
    indexingLaneGateway.getIndexCodebaseProgress.mockReturnValue({
      status: 'chunking',
      totalFiles: 20,
      processedFiles: 10,
      totalChunks: 0,
      embeddedChunks: 0,
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
    expect(indexingService.getProgress).not.toHaveBeenCalled();
  });

  it('CODEBASE_INDEX_CANCEL cancels codemem indexing when workspacePath is provided', async () => {
    codemem.indexWorkerGateway.cancelIndex.mockResolvedValue(undefined);

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_CANCEL);
    const result = await handler!({}, { workspacePath: '/repo' });

    expect(result.success).toBe(true);
    expect(codemem.indexWorkerGateway.cancelIndex).toHaveBeenCalledWith('/repo');
    expect(indexingService.cancel).not.toHaveBeenCalled();
  });

  it('CODEBASE_INDEX_CANCEL cancels legacy lane indexing when target is legacy', async () => {
    indexingLaneGateway.cancelIndexCodebase.mockResolvedValue(1);

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_INDEX_CANCEL);
    const result = await handler!({}, { workspacePath: '/repo', target: 'legacy' });

    expect(result.success).toBe(true);
    expect(indexingLaneGateway.cancelIndexCodebase).toHaveBeenCalledWith('/repo');
    expect(codemem.indexWorkerGateway.cancelIndex).not.toHaveBeenCalled();
    expect(indexingService.cancel).not.toHaveBeenCalled();
  });

  it('CODEBASE_LEGACY_CLEAR clears the requested legacy RLM store', async () => {
    indexingService.clearLegacyCodebaseStore.mockResolvedValue(undefined);

    const handler = handlers.get(IPC_CHANNELS.CODEBASE_LEGACY_CLEAR);
    const result = await handler!({}, { storeId: 'codebase:test' });

    expect(result.success).toBe(true);
    expect(indexingService.clearLegacyCodebaseStore).toHaveBeenCalledWith('codebase:test');
  });
});
