import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDriver, SqliteDriverFactory, SqliteDriverOptions } from '../db/sqlite-driver';
import { ConversationLedgerService } from '../conversation-ledger';
import { InternalOrchestratorConversationAdapter } from '../conversation-ledger/orchestrator/internal-orchestrator-conversation-adapter';
import { NativeConversationRegistry } from '../conversation-ledger/native-conversation-registry';
import { OperatorEngine } from './operator-engine';

describe('OperatorEngine', () => {
  const services: ConversationLedgerService[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const service of services) service.close();
    services.length = 0;
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('persists a global orchestrator conversation without launching runs', async () => {
    const ledger = createLedger();
    const engine = new OperatorEngine({ ledger });

    const initial = await engine.getThread();
    const sent = await engine.sendMessage({ text: 'Map every active project' });
    const reloaded = await new OperatorEngine({ ledger }).getThread();

    expect(initial.conversation.thread.provider).toBe('orchestrator');
    expect(initial.conversation.thread.workspacePath).toBeNull();
    expect(initial.conversation.messages).toEqual([]);
    expect(sent.run).toBeNull();
    expect(sent.runs).toEqual([]);
    expect(sent.conversation.messages.map(message => message.content)).toEqual([
      'Map every active project',
      expect.stringContaining('recorded'),
    ]);
    expect(reloaded.conversation.thread.id).toBe(initial.conversation.thread.id);
    expect(reloaded.conversation.messages).toHaveLength(2);
  });

  it('reloads the global transcript after reopening the ledger database', async () => {
    const driverFactory = await loadRealSqliteDriverFactory();
    if (!driverFactory) {
      return;
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'operator-ledger-'));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, 'conversation-ledger.db');
    const firstLedger = createLedger(dbPath, driverFactory);
    const firstEngine = new OperatorEngine({ ledger: firstLedger });

    await firstEngine.sendMessage({ text: 'Persist through restart' });
    firstLedger.close();
    services.splice(services.indexOf(firstLedger), 1);

    const secondLedger = createLedger(dbPath, driverFactory);
    const reloaded = await new OperatorEngine({ ledger: secondLedger }).getThread();

    expect(reloaded.conversation.messages.map(message => message.content)).toEqual([
      'Persist through restart',
      expect.stringContaining('recorded'),
    ]);
  });

  function createLedger(
    dbPath = ':memory:',
    driverFactory?: SqliteDriverFactory
  ): ConversationLedgerService {
    const service = new ConversationLedgerService({
      dbPath,
      enableWAL: false,
      driverFactory,
      registry: new NativeConversationRegistry(),
      adapters: [new InternalOrchestratorConversationAdapter()],
    });
    services.push(service);
    return service;
  }
});

async function loadRealSqliteDriverFactory(): Promise<SqliteDriverFactory | null> {
  try {
    const mod = await vi.importActual<{
      default: new (filename: string, options?: SqliteDriverOptions) => SqliteDriver;
    }>('better-sqlite3');
    const smokeDir = mkdtempSync(join(tmpdir(), 'operator-ledger-smoke-'));
    const smokePath = join(smokeDir, 'smoke.db');
    const smoke = new mod.default(smokePath);
    smoke.close();
    rmSync(smokeDir, { recursive: true, force: true });
    return (filename: string, options?: SqliteDriverOptions) => new mod.default(filename, options);
  } catch {
    return null;
  }
}
