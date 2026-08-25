import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import type { SafeStorageAccessor } from '../../session/safe-storage-accessor';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import { WorkspaceSecretStore } from '../../secrets/workspace-secret-store';

const { logCalls } = vi.hoisted(() => ({ logCalls: [] as unknown[] }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: (m: string, d?: unknown) => { logCalls.push(m, d); },
    warn: (m: string, d?: unknown) => { logCalls.push(m, d); },
    error: (m: string, e?: unknown, d?: unknown) => { logCalls.push(m, e, d); },
    debug: (m: string, d?: unknown) => { logCalls.push(m, d); },
  }),
}));

import { registerSecretCardHandlers } from './secret-card-handlers';

const TOKEN = 'ghp_exampleplaceholdervalue0000000000';
const INSTANCE = 'inst-1';
const CWD = process.cwd();

const fakeEvent = {} as Parameters<Parameters<typeof ipcMain.handle>[1]>[0];
type RegisteredHandler = (...args: unknown[]) => Promise<{ success: boolean; data?: unknown; error?: { code: string } }>;

function handlerFor(channel: string): RegisteredHandler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as unknown as RegisteredHandler;
}

function fakeSafeStorage(available = true): SafeStorageAccessor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, ''),
  };
}

let db: SqliteDriver;
let notified: Array<{ instanceId: string; message: string }>;

function setup(overrides: { available?: boolean; workingDirectory?: string | undefined } = {}): void {
  db = defaultDriverFactory(':memory:');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  notified = [];

  const store = new WorkspaceSecretStore({
    db,
    safeStorage: fakeSafeStorage(overrides.available ?? true),
    now: () => 1_000,
  });

  registerSecretCardHandlers({
    store,
    getWorkingDirectory: () => ('workingDirectory' in overrides ? overrides.workingDirectory : CWD),
    notifyAgent: async (instanceId, message) => { notified.push({ instanceId, message }); },
  });
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear();
  logCalls.length = 0;
});

afterEach(() => {
  db?.close();
});

describe('secret card submit', () => {
  it('stores the secret and returns only a reference', async () => {
    setup();
    const result = await handlerFor(IPC_CHANNELS.SECRET_CARD_SUBMIT)(fakeEvent, {
      instanceId: INSTANCE, requestId: 'req-1', name: 'github-pat', label: 'GitHub PAT', purpose: 'watch deploys', value: TOKEN,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: 'github-pat', reference: 'secret://github-pat' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('tells the agent the reference and NEVER the value', async () => {
    setup();
    await handlerFor(IPC_CHANNELS.SECRET_CARD_SUBMIT)(fakeEvent, {
      instanceId: INSTANCE, requestId: 'req-1', name: 'github-pat', value: TOKEN,
    });

    expect(notified).toHaveLength(1);
    expect(notified[0].message).toContain('secret://github-pat');
    expect(notified[0].message).not.toContain(TOKEN);
  });

  it('never writes the value to a log line', async () => {
    setup();
    await handlerFor(IPC_CHANNELS.SECRET_CARD_SUBMIT)(fakeEvent, {
      instanceId: INSTANCE, requestId: 'req-1', name: 'github-pat', value: TOKEN,
    });

    expect(logCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logCalls)).not.toContain(TOKEN);
  });

  it('reports a clear failure and leaks nothing when encryption is unavailable', async () => {
    setup({ available: false });
    const result = await handlerFor(IPC_CHANNELS.SECRET_CARD_SUBMIT)(fakeEvent, {
      instanceId: INSTANCE, requestId: 'req-1', name: 'github-pat', value: TOKEN,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SECRET_CARD_ENCRYPTION_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(notified).toHaveLength(0);
  });

  it('refuses an instance with no working directory', async () => {
    setup({ workingDirectory: undefined });
    const result = await handlerFor(IPC_CHANNELS.SECRET_CARD_SUBMIT)(fakeEvent, {
      instanceId: INSTANCE, requestId: 'req-1', name: 'github-pat', value: TOKEN,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SECRET_CARD_UNKNOWN_INSTANCE');
  });

  it('rejects a payload with no value at the schema boundary', async () => {
    setup();
    const result = await handlerFor(IPC_CHANNELS.SECRET_CARD_SUBMIT)(fakeEvent, {
      instanceId: INSTANCE, requestId: 'req-1', name: 'github-pat', value: '',
    });

    expect(result.success).toBe(false);
  });
});

describe('secret card decline', () => {
  it('tells the agent it was declined and stores nothing', async () => {
    setup();
    const result = await handlerFor(IPC_CHANNELS.SECRET_CARD_DECLINE)(fakeEvent, {
      instanceId: INSTANCE, requestId: 'req-1', name: 'github-pat',
    });

    expect(result.success).toBe(true);
    expect(notified[0].message).toMatch(/declined/i);

    const listed = await handlerFor(IPC_CHANNELS.SECRET_CARD_LIST)(fakeEvent, { workingDirectory: CWD });
    expect(listed.data).toEqual([]);
  });
});

describe('list / forget', () => {
  it('lists metadata without values and forgets on request', async () => {
    setup();
    await handlerFor(IPC_CHANNELS.SECRET_CARD_SUBMIT)(fakeEvent, {
      instanceId: INSTANCE, requestId: 'req-1', name: 'github-pat', value: TOKEN,
    });

    const listed = await handlerFor(IPC_CHANNELS.SECRET_CARD_LIST)(fakeEvent, { workingDirectory: CWD });
    expect(JSON.stringify(listed.data)).not.toContain(TOKEN);
    expect(listed.data).toHaveLength(1);

    const forgotten = await handlerFor(IPC_CHANNELS.SECRET_CARD_FORGET)(fakeEvent, {
      workingDirectory: CWD, name: 'github-pat',
    });
    expect(forgotten.data).toEqual({ forgotten: true });
  });
});

/**
 * Structural guard. The behavioural tests above prove this handler does not leak
 * today; this one proves it *cannot* start leaking through an innocent-looking
 * import, which is the failure mode the separate-channel design exists to prevent.
 */
describe('security contract: no import path to the CLI', () => {
  it('does not import the adapter or instance-communication layer', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'secret-card-handlers.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import[^;]*?from\s+'([^']+)';/gms)].map((m) => m[1]);

    for (const forbidden of ['instance-communication', 'instance-manager', 'cli/adapters']) {
      expect(imports.some((spec) => spec.includes(forbidden))).toBe(false);
    }

    // Strip comments before checking for calls. The security contract at the top of
    // the module deliberately NAMES these functions in order to forbid them, so a
    // raw substring search over the whole file would flag the documentation itself.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toContain('sendInputResponse');
    expect(code).not.toContain('sendRaw');
  });
});
