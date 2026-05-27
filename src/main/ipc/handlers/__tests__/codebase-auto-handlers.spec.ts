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

vi.mock('../../../indexing', () => ({
  getCodebaseIndexingService: () => indexingService,
  getHybridSearchService: () => ({ search: vi.fn() }),
  getCodebaseFileWatcher: () => fileWatcher,
  getCodebaseIndexingAutoCoordinator: () => autoCoordinator,
}));

vi.mock('../../../persistence/rlm-database', () => ({
  RLMDatabase: {
    getInstance: () => ({ db: {} }),
  },
}));

// Import the handler module last so vi.mock() statements above take effect.
import { registerCodebaseHandlers } from '../codebase-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

describe('codebase auto-index handlers', () => {
  beforeEach(() => {
    handlers.clear();
    sentMessages.length = 0;
    autoStatuses.clear();
    autoCoordinator.hintActiveWorkspace.mockClear();
    autoCoordinator.getStatus.mockClear();
    autoCoordinator.listStatuses.mockClear();
    registerCodebaseHandlers(windowManager);
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
});
