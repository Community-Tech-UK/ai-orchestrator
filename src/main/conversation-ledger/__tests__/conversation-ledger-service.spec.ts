import { afterEach, describe, expect, it } from 'vitest';
import { ConversationLedgerService } from '../conversation-ledger-service';
import { NativeConversationRegistry } from '../native-conversation-registry';
import type { NativeConversationAdapter } from '../native-conversation-adapter';

describe('ConversationLedgerService', () => {
  const services: ConversationLedgerService[] = [];

  afterEach(() => {
    for (const service of services) service.close();
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
    const conversation = service.getConversation(thread.id);

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

    const conversation = service.getConversation(thread.id);
    expect(conversation.thread.syncStatus).toBe('error');
    expect(conversation.messages.map(message => message.content)).toEqual(['hello', 'answer']);
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
