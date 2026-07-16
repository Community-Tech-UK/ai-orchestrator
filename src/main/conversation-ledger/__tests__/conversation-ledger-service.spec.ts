import { afterEach, describe, expect, it } from 'vitest';
import { ConversationLedgerService } from '../conversation-ledger-service';
import { NativeConversationRegistry } from '../native-conversation-registry';
import type { NativeConversationAdapter } from '../native-conversation-adapter';

describe('ConversationLedgerService', () => {
  const services: ConversationLedgerService[] = [];

  afterEach(async () => {
    for (const service of services) await service.close();
    services.length = 0;
  });

  it('discovers native Codex metadata and imports it into the ledger', async () => {
    const adapter = new FakeAdapter();
    const service = createService(adapter);

    const discovered = await service.discoverNativeConversations({ provider: 'codex', workspacePath: '/tmp/project' });

    expect(discovered).toMatchObject([{
      provider: 'codex',
      nativeThreadId: 'native-1',
      nativeSourceKind: 'appServer',
      workspacePath: '/tmp/project',
    }]);
  });

  it('starts durable threads, sends turns, and reconciles idempotently', async () => {
    const adapter = new FakeAdapter();
    const service = createService(adapter);

    const thread = await service.startConversation({
      provider: 'codex',
      workspacePath: '/tmp/project',
      title: 'Durable',
    });
    const turn = await service.sendTurn(thread.id, { text: 'hello' });
    const firstReconcile = await service.reconcileConversation(thread.id);
    const secondReconcile = await service.reconcileConversation(thread.id);
    const conversation = await service.getConversation(thread.id);

    expect(adapter.startedEphemeral).toBe(false);
    expect(turn.messages.length).toBeGreaterThanOrEqual(2);
    expect(firstReconcile.syncStatus).toBe('synced');
    expect(secondReconcile.syncStatus).toBe('synced');
    expect(conversation.messages.map(message => message.content)).toEqual(['hello', 'answer']);
  });

  it('marks sync errors without corrupting existing messages', async () => {
    const adapter = new FakeAdapter();
    const service = createService(adapter);
    const thread = await service.startConversation({ provider: 'codex', workspacePath: '/tmp/project' });
    await service.sendTurn(thread.id, { text: 'hello' });
    adapter.readFails = true;

    await expect(service.reconcileConversation(thread.id)).rejects.toThrow('read failed');

    const conversation = await service.getConversation(thread.id);
    expect(conversation.thread.syncStatus).toBe('error');
    expect(conversation.messages.map(message => message.content)).toEqual(['hello', 'answer']);
  });

  it('persists internal orchestrator thread messages without a workspace path', async () => {
    const service = new ConversationLedgerService({
      dbPath: ':memory:',
      enableWAL: false,
      registry: new NativeConversationRegistry(),
    });
    services.push(service);

    const thread = await service.startConversation({
      provider: 'orchestrator',
      workspacePath: null,
      title: 'Orchestrator',
      metadata: { scope: 'global', operatorThreadKind: 'root' },
    });
    await service.sendTurn(thread.id, { text: 'Pull all repos' });

    const conversation = await service.getConversation(thread.id);
    expect(conversation.thread.provider).toBe('orchestrator');
    expect(conversation.thread.workspacePath).toBeNull();
    expect(conversation.thread.syncStatus).toBe('synced');
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Pull all repos',
      sequence: 1,
    });
  });

  it('returns recent windows and older-message pages with window metadata', async () => {
    const service = new ConversationLedgerService({
      dbPath: ':memory:',
      enableWAL: false,
      registry: new NativeConversationRegistry(),
    });
    services.push(service);

    const thread = await service.startConversation({
      provider: 'orchestrator',
      workspacePath: '/tmp/project',
      title: 'Paged',
    });

    for (let index = 1; index <= 5; index += 1) {
      await service.appendMessage(thread.id, {
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `message-${index}`,
        createdAt: index,
      });
    }

    const recent = await service.getRecentConversation(thread.id, 2);
    expect(recent.messages.map((message) => message.sequence)).toEqual([4, 5]);
    expect(recent.window).toEqual({
      totalMessages: 5,
      hasOlder: true,
      oldestSequence: 4,
      newestSequence: 5,
    });

    const older = await service.getConversationPageBefore(thread.id, 4, 2);
    expect(older.messages.map((message) => message.sequence)).toEqual([2, 3]);
    expect(older.totalMessages).toBe(5);
    expect(older.hasMore).toBe(true);
    expect(older.nextBeforeSequence).toBe(2);
  });

  it('exposes scoped evidence operations through the async ledger port', async () => {
    const service = new ConversationLedgerService({
      dbPath: ':memory:',
      enableWAL: false,
      registry: new NativeConversationRegistry(),
    });
    services.push(service);
    const thread = await service.startConversation({
      provider: 'orchestrator',
      workspacePath: null,
      title: 'Evidence owner',
    });

    const staged = await service.stageEvidence({
      id: 'service-evidence', conversationId: thread.id, provider: 'codex',
      toolName: 'placeholder-tool', sourceKind: 'other', mimeType: 'text/plain',
      sensitivity: 'normal', provenanceTrust: 'runtime-authenticated',
      captureMode: 'post-retention', captureCompleteness: 'complete',
      captureKey: 'service-capture', createdAt: 1,
    });
    await service.finalizeEvidence({
      evidenceId: staged.id, conversationId: thread.id, blobRef: 'opaque/service.aioev',
      keyedContentId: 'a'.repeat(64), byteCount: 7, keyVersion: 1, completedAt: 2,
    });

    expect(await service.listEvidence(thread.id)).toEqual([
      expect.objectContaining({ id: staged.id, status: 'complete' }),
    ]);
    expect(await service.getEvidence(thread.id, staged.id)).toEqual(
      expect.objectContaining({ conversationId: thread.id }),
    );
    expect(await service.searchEvidenceMetadata(thread.id, { text: 'placeholder' })).toEqual([
      expect.objectContaining({ id: staged.id }),
    ]);
    expect(await service.authorizeEvidenceRange({
      conversationId: thread.id,
      evidenceId: staged.id,
      startByte: 0,
      endByte: 7,
    })).toEqual(expect.objectContaining({ authorized: true, evidenceId: staged.id }));

    await service.softDeleteConversationWithEvidence({
      conversationId: thread.id,
      deletedAt: '2026-07-15T12:00:00.000Z',
      graceDeadline: 600_000,
    });
    expect(await service.getThread(thread.id)).toBeNull();
    expect(await service.listEvidence(thread.id)).toEqual([]);
  });

  it('does not restore transcript messages when deletion wins an in-flight provider turn race', async () => {
    const adapter = new FakeAdapter();
    const service = createService(adapter);
    const thread = await service.startConversation({
      provider: 'codex',
      workspacePath: '/tmp/project',
    });
    const turnGate = adapter.blockNextTurn();

    const pendingTurn = service.sendTurn(thread.id, { text: 'hello' });
    await turnGate.started;
    await service.softDeleteConversationWithEvidence({
      conversationId: thread.id,
      deletedAt: '2026-07-15T12:00:00.000Z',
      graceDeadline: 600_000,
    });
    turnGate.release();

    await expect(pendingTurn).rejects.toThrow('CONVERSATION_NOT_FOUND');
    expect(await service.getThread(thread.id)).toBeNull();
  });

  function createService(adapter: FakeAdapter): ConversationLedgerService {
    const service = new ConversationLedgerService({
      dbPath: ':memory:',
      enableWAL: false,
      registry: new NativeConversationRegistry(),
      adapters: [adapter],
    });
    services.push(service);
    return service;
  }
});

class FakeAdapter implements NativeConversationAdapter {
  readonly provider = 'codex' as const;
  readFails = false;
  startedEphemeral: boolean | null = null;
  private turnGate: Promise<void> | null = null;
  private markTurnStarted: (() => void) | null = null;

  blockNextTurn(): { started: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    this.turnGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      this.markTurnStarted = resolve;
    });
    return { started, release };
  }

  getCapabilities() {
    return {
      provider: 'codex' as const,
      canDiscover: true,
      canRead: true,
      canCreate: true,
      canResume: true,
      canSendTurns: true,
      canReconcile: true,
      durableByDefault: true,
      nativeVisibilityMode: 'app-server-durable' as const,
    };
  }

  async discover() {
    return [{
      provider: 'codex' as const,
      nativeThreadId: 'native-1',
      nativeSessionId: 'native-1',
      nativeSourceKind: 'appServer',
      workspacePath: '/tmp/project',
      title: 'Native',
      updatedAt: 2,
      writable: true,
      nativeVisibilityMode: 'app-server-durable' as const,
    }];
  }

  async readThread() {
    if (this.readFails) throw new Error('read failed');
    return {
      thread: {
        provider: 'codex' as const,
        nativeThreadId: 'native-1',
        nativeSourceKind: 'appServer',
        workspacePath: '/tmp/project',
        writable: true,
        nativeVisibilityMode: 'app-server-durable' as const,
      },
      messages: [
        { nativeMessageId: 'user-1', role: 'user' as const, content: 'hello', sequence: 1 },
        { nativeMessageId: 'assistant-1', role: 'assistant' as const, content: 'answer', sequence: 2 },
      ],
      warnings: [],
      rawRefs: [],
    };
  }

  async startThread(request: { ephemeral?: boolean }) {
    this.startedEphemeral = request.ephemeral ?? null;
    return {
      provider: 'codex' as const,
      nativeThreadId: 'native-1',
      nativeSessionId: 'native-1',
      workspacePath: '/tmp/project',
      title: 'Durable',
      metadata: { ephemeral: request.ephemeral ?? false },
    };
  }

  async resumeThread() {
    return {
      provider: 'codex' as const,
      nativeThreadId: 'native-1',
    };
  }

  async sendTurn() {
    this.markTurnStarted?.();
    this.markTurnStarted = null;
    await this.turnGate;
    this.turnGate = null;
    return {
      provider: 'codex' as const,
      nativeThreadId: 'native-1',
      nativeTurnId: 'turn-1',
      messages: [
        { nativeMessageId: 'user-1', role: 'user' as const, content: 'hello', sequence: 1 },
        { nativeMessageId: 'assistant-1', role: 'assistant' as const, content: 'answer', sequence: 2 },
      ],
    };
  }

  async reconcile() {
    return {
      provider: 'codex' as const,
      nativeThreadId: 'native-1',
      addedMessages: 2,
      updatedMessages: 0,
      deletedMessages: 0,
      syncStatus: 'synced' as const,
      conflictStatus: 'none' as const,
      warnings: [],
    };
  }
}
