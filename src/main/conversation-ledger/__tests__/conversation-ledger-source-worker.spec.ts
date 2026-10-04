import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { ConversationLedgerWorkerClient } from '../conversation-ledger-worker-client';
import { ConversationLedgerService } from '../conversation-ledger-service';
import type { LedgerWorkerInboundMsg, LedgerWorkerOutboundMsg } from '../conversation-ledger-worker-protocol';

describe('latest user source worker protocol', () => {
  let db: SqliteDriver | undefined;
  let client: ConversationLedgerWorkerClient | undefined;
  let directory: string | undefined;
  let parentPort: EventEmitter | undefined;

  afterEach(async () => {
    await client?.close();
    parentPort?.removeAllListeners();
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    vi.doUnmock('node:worker_threads');
    vi.doUnmock('../../db/better-sqlite3-driver');
    vi.doUnmock('../../logging/logger');
    vi.resetModules();
  });

  it('round-trips service to client to the real closed worker switch and indexed SQL store', async () => {
    vi.resetModules();
    db = new Database(':memory:') as unknown as SqliteDriver;
    directory = mkdtempSync(join(tmpdir(), 'aio-ledger-source-'));
    const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn().mockResolvedValue(0) });
    parentPort = Object.assign(new EventEmitter(), {
      postMessage: (message: LedgerWorkerOutboundMsg) => worker.emit('message', message),
    });
    worker.postMessage.mockImplementation((message: LedgerWorkerInboundMsg) => {
      if (message.type === 'shutdown') {
        worker.emit('message', { type: 'rpc-response', id: message.id });
      } else {
        parentPort!.emit('message', message);
      }
    });
    vi.doMock('node:worker_threads', () => {
      const runtime = { parentPort, isMainThread: false, workerData: { userDataPath: directory } };
      return { ...runtime, default: runtime };
    });
    vi.doMock('../../db/better-sqlite3-driver', () => ({ defaultDriverFactory: () => db }));
    vi.doMock('../../logging/logger', () => ({
      getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    }));
    await import('../conversation-ledger-worker-main');
    client = new ConversationLedgerWorkerClient({ workerFactory: () => worker as never, userDataPath: directory });
    const thread = await client.upsertThread({ provider: 'orchestrator', sourceKind: 'orchestrator' });
    await client.upsertMessages(thread.id, [
      { id: 'source', role: 'user', content: 'Synthetic source', sequence: 1, rawJson: { metadata: { instanceId: 'current' } } },
      { id: 'foreign', role: 'user', content: 'Synthetic foreign source', sequence: 2, rawJson: { metadata: { instanceId: 'foreign' } } },
    ]);
    const service = new ConversationLedgerService({ port: client });
    expect(await service.getLatestUserMessage(thread.id, 'current')).toMatchObject({ id: 'source', threadId: thread.id });
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'store-call', method: 'getLatestUserMessage', args: [thread.id, 'current'],
    }));
    expect(await service.getLatestUserMessage(thread.id, null)).toBeNull();
    db.prepare('UPDATE conversation_threads SET deleted_at = ? WHERE id = ?').run('synthetic-deleted', thread.id);
    expect(await service.getLatestUserMessage(thread.id, 'current')).toBeNull();
    expect(await service.getLatestUserMessage('missing', 'current')).toBeNull();
  });
});
