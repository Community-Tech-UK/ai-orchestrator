import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/test'), isPackaged: false } }));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ConversationLedgerWorkerClient } from '../conversation-ledger-worker-client';
import type {
  LedgerWorkerInboundMsg,
  LedgerWorkerOutboundMsg,
} from '../conversation-ledger-worker-protocol';

type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function createFakeWorker(): FakeWorker {
  const emitter = new EventEmitter() as FakeWorker;
  emitter.postMessage = vi.fn();
  emitter.terminate = vi.fn().mockResolvedValue(0);
  return emitter;
}

function lastPosted(worker: FakeWorker): LedgerWorkerInboundMsg {
  const calls = worker.postMessage.mock.calls;
  return calls[calls.length - 1][0] as LedgerWorkerInboundMsg;
}

function respond(worker: FakeWorker, id: number, result?: unknown, error?: string): void {
  worker.emit('message', { type: 'rpc-response', id, result, error } satisfies LedgerWorkerOutboundMsg);
}

describe('ConversationLedgerWorkerClient', () => {
  let worker: FakeWorker;
  let client: ConversationLedgerWorkerClient;

  beforeEach(() => {
    worker = createFakeWorker();
    client = new ConversationLedgerWorkerClient({
      rpcTimeoutMs: 50,
      workerFactory: () => worker as never,
      userDataPath: '/tmp/test',
    });
  });

  it('dispatches a store call by method name and resolves with the worker result', async () => {
    const promise = client.findThreadById('thread-1');
    const msg = lastPosted(worker);
    expect(msg).toMatchObject({ type: 'store-call', method: 'findThreadById', args: ['thread-1'] });
    respond(worker, (msg as { id: number }).id, { id: 'thread-1', provider: 'orchestrator' });
    await expect(promise).resolves.toMatchObject({ id: 'thread-1' });
  });

  it('rejects when the worker reports an error', async () => {
    const promise = client.countMessages('thread-1');
    const msg = lastPosted(worker);
    respond(worker, (msg as { id: number }).id, undefined, 'boom');
    await expect(promise).rejects.toThrow('boom');
  });

  it('rejects on RPC timeout rather than hanging', async () => {
    const promise = client.getMessages('thread-1');
    // Never respond — the 50ms deadline should reject.
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it('fails in-flight RPCs when the worker crashes', async () => {
    const promise = client.listThreads({});
    worker.emit('error', new Error('worker died'));
    await expect(promise).rejects.toThrow('worker died');
    expect(client.getMetrics().degraded).toBe(true);
  });

  it('round-trips a batched append through the store-call protocol', async () => {
    const promise = client.appendMessagesWithThreadTouch('thread-1', [
      { role: 'assistant', content: 'hi' },
    ]);
    const msg = lastPosted(worker);
    expect(msg).toMatchObject({ type: 'store-call', method: 'appendMessagesWithThreadTouch' });
    respond(worker, (msg as { id: number }).id, [{ id: 'm1', threadId: 'thread-1', sequence: 1, content: 'hi' }]);
    await expect(promise).resolves.toMatchObject([{ id: 'm1', sequence: 1 }]);
  });

  it('round-trips a raw provider-event capture batch through the worker protocol', async () => {
    const promise = client.appendProviderEventCaptures([
      {
        eventId: 'event-1',
        provider: 'claude',
        instanceId: 'instance-1',
        sessionId: 'session-1',
        sequence: 2,
        createdAt: 100,
        event: { kind: 'output', content: 'captured' },
        raw: { source: 'adapter-event:output', payload: { nativeId: 'n-1' } },
      },
    ]);

    const msg = lastPosted(worker);
    expect(msg).toMatchObject({
      type: 'store-call',
      method: 'appendProviderEventCaptures',
      args: [expect.arrayContaining([expect.objectContaining({ eventId: 'event-1' })])],
    });
    respond(worker, (msg as { id: number }).id);
    await expect(promise).resolves.toBeUndefined();
  });

  it('keeps normal calls at 10 seconds while only rebuilding gets 15 minutes', async () => {
    vi.useFakeTimers();
    try {
      client = new ConversationLedgerWorkerClient({ workerFactory: () => worker as never, userDataPath: '/tmp/test' });
      const rebuild = client.rebuildLedgerStorage();
      const rebuildId = lastPosted(worker).id;
      const normal = client.getLedgerStorageStats();
      const rejected = expect(normal).rejects.toThrow('10000ms');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(client.getMetrics().inFlight).toBe(1);
      respond(worker, rebuildId, { bytesFreed: 42 });
      await expect(rebuild).resolves.toMatchObject({ bytesFreed: 42 });
    } finally { vi.useRealTimers(); }
  });

  it('passes the prune limit and bounded vacuum size over the worker protocol', async () => {
    const prune = client.pruneProviderEventCapturesBefore(100, 20_000);
    expect(lastPosted(worker)).toMatchObject({ method: 'pruneProviderEventCapturesBefore', args: [100, 20_000] });
    respond(worker, lastPosted(worker).id, 20_000);
    await expect(prune).resolves.toBe(20_000);
    const compact = client.compactLedgerStorage(25_600);
    expect(lastPosted(worker)).toMatchObject({ method: 'compactLedgerStorage', args: [25_600] });
    respond(worker, lastPosted(worker).id, { pagesFreed: 1, freePages: 0 });
    await expect(compact).resolves.toEqual({ pagesFreed: 1, freePages: 0 });
  });

  it('round-trips context-evidence operations through the closed worker protocol', async () => {
    const input = {
      id: 'evidence-1', conversationId: 'thread-1', provider: 'codex',
      toolName: 'placeholder-tool', sourceKind: 'other' as const, mimeType: 'text/plain',
      sensitivity: 'normal' as const, provenanceTrust: 'runtime-authenticated' as const,
      captureMode: 'post-retention' as const, captureCompleteness: 'complete' as const,
      captureKey: 'turn-1:tool-1', createdAt: 1,
    };
    const promise = client.stageEvidence(input);
    const msg = lastPosted(worker);
    expect(msg).toMatchObject({
      type: 'store-call',
      method: 'stageEvidence',
      args: [expect.objectContaining({ conversationId: 'thread-1', captureKey: 'turn-1:tool-1' })],
    });
    respond(worker, (msg as { id: number }).id, { ...input, status: 'staging' });
    await expect(promise).resolves.toMatchObject({ id: 'evidence-1', status: 'staging' });
  });
  it('round-trips fresh maintenance reads and bounded candidate checks through the closed protocol', async () => {
    const read = client.getEvidenceForMaintenance('placeholder-conversation', 'placeholder-evidence');
    const readMsg = lastPosted(worker);
    expect(readMsg).toMatchObject({ type: 'store-call', method: 'getEvidenceForMaintenance',
      args: ['placeholder-conversation', 'placeholder-evidence'] });
    respond(worker, readMsg.id, { id: 'placeholder-evidence', status: 'staging' });
    await expect(read).resolves.toMatchObject({ id: 'placeholder-evidence', status: 'staging' });
    const check = client.listReferencedEvidenceBlobRefsForCandidates(['placeholder/ref']);
    const checkMsg = lastPosted(worker);
    expect(checkMsg).toMatchObject({ type: 'store-call', method: 'listReferencedEvidenceBlobRefsForCandidates',
      args: [['placeholder/ref']] });
    respond(worker, checkMsg.id, ['placeholder/ref']);
    await expect(check).resolves.toEqual(['placeholder/ref']);
  });

  it('preserves empty live pages and their authoritative raw cursor through the worker scan route', async () => {
    const promise = client.listEvidenceBlobReferenceScanPage({ limit: 1000, afterBlobRef: 'placeholder/before' });
    const msg = lastPosted(worker);
    expect(msg).toMatchObject({ type: 'store-call', method: 'listEvidenceBlobReferenceScanPage',
      args: [{ limit: 1000, afterBlobRef: 'placeholder/before' }] });
    respond(worker, msg.id, { blobRefs: [], afterBlobRef: 'placeholder/deleted-history', done: false });
    await expect(promise).resolves.toEqual({ blobRefs: [], afterBlobRef: 'placeholder/deleted-history', done: false });
  });

});
