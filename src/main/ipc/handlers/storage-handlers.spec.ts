import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { StorageCleanupResult } from '../../../shared/types/storage.types';
import { createSqliteWasmDatabase } from '../../db/sqlite-wasm-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../../db/sqlite-driver';
import { previewRtkHistoryTrim, trimRtkHistory } from '../../cli/rtk/rtk-history-trim';
import { StorageCleanupService, type StorageCleanupDependencies } from '../../storage/storage-cleanup-service';
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<IpcResponse>>();
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler) }, app: { getPath: () => '/fixture' } }));
vi.mock('../../storage/storage-runtime', () => ({ createStorageRuntime: vi.fn() }));
import { registerStorageHandlers } from './storage-handlers';
import { StorageRunCleanupRequestSchema } from '@contracts/schemas/storage';
describe('storage IPC', () => {
  const runtime = { usage: { getUsage: vi.fn(async () => ({ rows: [] })), invalidate: vi.fn() }, cleanup: { preview: vi.fn(async () => ({})), run: vi.fn(async () => { throw new Error('Review first'); }) } };
  beforeEach(() => { handlers.clear(); vi.clearAllMocks(); registerStorageHandlers({ runtime: runtime as never }); });
  it('registers all channels and rejects missing or unexpected run fields', async () => {
    expect(handlers.size).toBe(3);
    expect(StorageRunCleanupRequestSchema.safeParse({ target: 'rlm-backups' }).success).toBe(false);
    expect(StorageRunCleanupRequestSchema.safeParse({ target: 'rlm-backups', previewId: 'fixture', directory: '/escape' }).success).toBe(false);
    const response = await handlers.get(IPC_CHANNELS.STORAGE_RUN_CLEANUP)!({}, { target: 'rlm-backups' });
    expect(response.success).toBe(false);
    expect(runtime.cleanup.run).not.toHaveBeenCalled();
  });
  it('preserves service preview enforcement through the handler', async () => {
    const response = await handlers.get(IPC_CHANNELS.STORAGE_RUN_CLEANUP)!({}, { target: 'rlm-backups', previewId: 'unknown' });
    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('Review first');
  });
});

describe('RTK storage cleanup through IPC', () => {
  it.each([
    { name: 'busy before deletion', busyAfterBegins: 0, removed: 0, remaining: 3, stoppedEarly: true },
    { name: 'busy after one table', busyAfterBegins: 1, removed: 2, remaining: 1, stoppedEarly: true },
    { name: 'full trim', busyAfterBegins: Infinity, removed: 3, remaining: 0, stoppedEarly: false },
  ])('reports $name with actual row and disk counts', async ({ busyAfterBegins, removed, remaining, stoppedEarly }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'storage-rtk-ipc-'));
    const dbPath = path.join(root, 'history.db');
    writeFileSync(dbPath, 'marker');
    const db = createSqliteWasmDatabase(':memory:') as SqliteDriver;
    try {
      db.exec("CREATE TABLE commands(id INTEGER PRIMARY KEY, timestamp TEXT); CREATE TABLE parse_failures(id INTEGER PRIMARY KEY, timestamp TEXT); INSERT INTO commands VALUES(1, '2026-01-01T00:00:00.000Z'), (2, '2026-01-02T00:00:00.000Z'); INSERT INTO parse_failures VALUES(1, '2026-01-01T00:00:00.000Z');");
      let begins = 0;
      const factory: SqliteDriverFactory = () => new Proxy(db, {
        get(target, key) {
          if (key === 'close') return () => undefined;
          if (key === 'exec') return (sql: string) => {
            if (sql === 'BEGIN IMMEDIATE' && begins++ >= busyAfterBegins) {
              throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
            }
            if (sql === 'ROLLBACK') return undefined;
            return target.exec(sql);
          };
          const value = target[key as keyof SqliteDriver];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as SqliteDriver;
      const now = Date.parse('2026-02-20T12:00:00.000Z');
      const unused = () => { throw new Error('Unexpected storage dependency'); };
      const deps: StorageCleanupDependencies = {
        getLedgerStats: unused,
        pruneEvents: unused,
        rebuildLedger: unused,
        listBackups: unused,
        removeBackup: unused,
        isRlmMaintenanceRunning: unused,
        listRecords: unused,
        removeRecords: unused,
        listLegacyAppData: unused,
        trashLegacyAppData: unused,
        listAttachmentFolders: unused,
        removeAttachmentSessions: unused,
        getCodexStateOverview: unused,
        removeCodexSafetyCopies: unused,
        getAvailableDiskBytes: unused,
        now: () => now,
        getRtkHistoryPreview: async (at: number) => previewRtkHistoryTrim(30, { dbPath, now: () => at, driverFactory: factory }),
        trimRtkHistory: (at, approvedDbPath) => trimRtkHistory(30, { dbPath: approvedDbPath, now: () => at, driverFactory: factory }),
      };
      const cleanup = new StorageCleanupService(deps);
      handlers.clear();
      registerStorageHandlers({ runtime: { cleanup, usage: { invalidate: vi.fn() } } as never });
      const preview = await cleanup.preview('rtk-history');
      expect(preview.estimatedCount).toBe(3);

      const response = await handlers.get(IPC_CHANNELS.STORAGE_RUN_CLEANUP)!({}, { target: 'rtk-history', previewId: preview.previewId });

      expect(response.success).toBe(true);
      expect(response.data as StorageCleanupResult).toEqual({ target: 'rtk-history', removed, bytesFreed: 0, stoppedEarly });
      expect(db.prepare('SELECT (SELECT COUNT(*) FROM commands) + (SELECT COUNT(*) FROM parse_failures) AS total').get<{ total: number }>()).toEqual({ total: remaining });
      await expect(cleanup.run('rtk-history', preview.previewId)).rejects.toThrow(/Review/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
