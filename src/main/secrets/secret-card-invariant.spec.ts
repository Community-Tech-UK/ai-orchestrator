import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { SafeStorageAccessor } from '../session/safe-storage-accessor';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { redactForEgress } from '../security/content-egress-gate';
import { _resetExactSecretValuesForTesting } from '../security/secret-detector';
import { WorkspaceSecretStore } from './workspace-secret-store';

const { logCalls } = vi.hoisted(() => ({ logCalls: [] as unknown[] }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: (message: string, data?: unknown) => { logCalls.push(message, data); },
    warn: (message: string, data?: unknown) => { logCalls.push(message, data); },
    error: (message: string, error?: unknown, data?: unknown) => { logCalls.push(message, error, data); },
    debug: (message: string, data?: unknown) => { logCalls.push(message, data); },
  }),
}));

import { registerSecretCardHandlers } from '../ipc/handlers/secret-card-handlers';

const TOKEN = 'ghp_exampleplaceholdervalue0000000000';
const CWD = process.cwd();
const fakeEvent = {} as Parameters<Parameters<typeof ipcMain.handle>[1]>[0];
type RegisteredHandler = (...args: unknown[]) => Promise<{ success: boolean; data?: unknown }>;

function handlerFor(channel: string): RegisteredHandler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as unknown as RegisteredHandler;
}

function fakeSafeStorage(): SafeStorageAccessor {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, ''),
  };
}

describe('secret-card invariant', () => {
  let db: SqliteDriver;
  const sendRaw = vi.fn();
  const notifyAgent = vi.fn(async (_instanceId: string, message: string) => {
    sendRaw(message);
  });

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    logCalls.length = 0;
    sendRaw.mockClear();
    notifyAgent.mockClear();
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    registerSecretCardHandlers({
      store: new WorkspaceSecretStore({
        db,
        safeStorage: fakeSafeStorage(),
        now: () => 1_000,
      }),
      getWorkingDirectory: () => CWD,
      notifyAgent,
    });
  });

  afterEach(() => {
    db.close();
    _resetExactSecretValuesForTesting();
  });

  it('submits a value that never reaches sendRaw, logs, or unredacted egress', async () => {
    const result = await handlerFor(IPC_CHANNELS.SECRET_CARD_SUBMIT)(fakeEvent, {
      instanceId: 'inst-1',
      requestId: 'req-1',
      name: 'github-pat',
      label: 'GitHub PAT',
      purpose: 'watch deploys',
      value: TOKEN,
    });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(sendRaw).toHaveBeenCalledTimes(1);
    expect(sendRaw.mock.calls[0][0]).toContain('secret://github-pat');
    expect(sendRaw.mock.calls[0][0]).not.toContain(TOKEN);
    expect(JSON.stringify(logCalls)).not.toContain(TOKEN);

    const egress = redactForEgress(`leaked ${TOKEN}`, { kind: 'prompt' });
    expect(egress.content).not.toContain(TOKEN);
  });
});
