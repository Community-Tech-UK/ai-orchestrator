import { afterEach, describe, expect, it } from 'vitest';
import { ConversationLedgerService } from '../conversation-ledger';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import {
  createInstance,
  type Instance,
  type InstanceCreateConfig,
  type OutputMessage,
} from '../../shared/types/instance.types';
import { ChatStore } from './chat-store';
import {
  ParentUnavailableError,
  SideChatParentResolver,
  type SideChatParentResolverDeps,
} from './side-chat-parent-resolver';

class FakeInstanceManager {
  private readonly instances = new Map<string, Instance>();

  create(config: InstanceCreateConfig): Instance {
    const instance = createInstance(config);
    this.instances.set(instance.id, instance);
    return instance;
  }

  getInstance(id: string): Instance | undefined {
    return this.instances.get(id);
  }

  getAllInstances(): Instance[] {
    return [...this.instances.values()];
  }
}

describe('SideChatParentResolver', () => {
  const dbs: SqliteDriver[] = [];
  const ledgers: ConversationLedgerService[] = [];

  afterEach(async () => {
    for (const ledger of ledgers) await ledger.close();
    ledgers.length = 0;
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  async function harness() {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const ledger = new ConversationLedgerService({
      dbPath: ':memory:',
    });
    ledgers.push(ledger);
    const chatStore = new ChatStore(db);
    const instanceManager = new FakeInstanceManager();
    const archiveMessages = new Map<string, OutputMessage[]>();
    const deps: SideChatParentResolverDeps = {
      ledger,
      chatStore,
      instanceManager: instanceManager as never,
      archive: {
        find: (historyThreadId) => archiveMessages.has(historyThreadId)
          ? { entryId: `entry-${historyThreadId}`, title: 'Archived title', workspacePath: '/archived', originNodeId: null }
          : null,
        loadMessages: async (entryId) => archiveMessages.get(entryId.replace(/^entry-/, '')) ?? null,
      },
    };
    const resolver = new SideChatParentResolver(deps);
    return { db, ledger, chatStore, instanceManager, archiveMessages, resolver };
  }

  async function createChatThread(
    ledger: ConversationLedgerService,
    chatStore: ChatStore,
    id: string,
    title: string,
  ) {
    const thread = await ledger.startConversation({
      provider: 'orchestrator',
      workspacePath: '/work',
      title,
      metadata: { chatId: id, scope: 'chat', operatorThreadKind: 'chat' },
    });
    chatStore.insert({
      id,
      name: title,
      provider: 'claude',
      currentCwd: '/work',
      ledgerThreadId: thread.id,
    });
    await ledger.appendMessageReturningRecord(thread.id, {
      nativeMessageId: `${id}-u1`,
      role: 'user',
      content: 'Implement provider_hardening.md',
      createdAt: Date.now(),
      sequence: 1,
    });
    await ledger.appendMessageReturningRecord(thread.id, {
      nativeMessageId: `${id}-a1`,
      role: 'assistant',
      content: 'Tasks 1-3 done. Remaining: 4-6.',
      createdAt: Date.now(),
      sequence: 2,
    });
    return thread;
  }

  it('resolves a chat parent through its ledger thread', async () => {
    const { ledger, chatStore, resolver } = await harness();
    await createChatThread(ledger, chatStore, 'parent-chat', 'Provider hardening');

    const source = await resolver.resolve({ kind: 'chat', chatId: 'parent-chat' });
    expect(source.sourceKind).toBe('chat-ledger');
    expect(source.title).toBe('Provider hardening');
    expect(source.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(source.turns[0]?.content).toContain('provider_hardening.md');
  });

  it('resolves a session parent via the chat that owns the ledger thread id', async () => {
    const { ledger, chatStore, resolver } = await harness();
    const thread = await createChatThread(ledger, chatStore, 'parent-chat', 'Hardening');

    const source = await resolver.resolve({
      kind: 'session',
      historyThreadId: thread.id,
      originNodeId: 'node-9',
    });
    expect(source.sourceKind).toBe('chat-ledger');
    expect(source.parent).toEqual({ kind: 'session', historyThreadId: thread.id, originNodeId: 'node-9' });
  });

  it('resolves a session parent via a direct ledger thread', async () => {
    const { ledger, resolver } = await harness();
    const thread = await ledger.startConversation({
      provider: 'orchestrator',
      workspacePath: '/work',
      title: 'Imported session',
    });
    await ledger.appendMessageReturningRecord(thread.id, {
      nativeMessageId: 's-u1',
      role: 'user',
      content: 'Trace identity first',
      createdAt: Date.now(),
      sequence: 1,
    });

    const source = await resolver.resolve({
      kind: 'session',
      historyThreadId: thread.id,
      originNodeId: null,
    });
    expect(source.sourceKind).toBe('session-ledger');
    expect(source.title).toBe('Imported session');
    expect(source.turns[0]?.content).toContain('Trace identity first');
  });

  it('resolves a session parent from a live runtime buffer when no ledger thread exists', async () => {
    const { instanceManager, resolver } = await harness();
    const instance = instanceManager.create({
      workingDirectory: '/work',
      displayName: 'Codex hardening run',
      provider: 'codex',
      historyThreadId: 'thread-live',
    });
    instance.outputBuffer.push({
      id: 'm1',
      timestamp: Date.now(),
      type: 'user',
      content: 'Start the plan',
    });
    instance.outputBuffer.push({
      id: 'm2',
      timestamp: Date.now(),
      type: 'assistant',
      content: 'Working on task 2',
    });

    const source = await resolver.resolve({
      kind: 'session',
      historyThreadId: 'thread-live',
      originNodeId: 'node-3',
    });
    expect(source.sourceKind).toBe('session-runtime');
    expect(source.status).toBeTruthy();
    expect(source.pendingRuntimeTurns.map((t) => t.content)).toEqual([
      'Start the plan',
      'Working on task 2',
    ]);
    expect(source.originNodeId).toBe('node-3');
  });

  it('resolves a session parent from a history archive entry', async () => {
    const { archiveMessages, resolver } = await harness();
    archiveMessages.set('thread-archived', [
      { id: 'a1', timestamp: 1, type: 'user', content: 'Old task' },
      { id: 'a2', timestamp: 2, type: 'assistant', content: 'Old progress' },
    ]);

    const source = await resolver.resolve({
      kind: 'session',
      historyThreadId: 'thread-archived',
      originNodeId: null,
    });
    expect(source.sourceKind).toBe('session-archive');
    expect(source.title).toBe('Archived title');
    expect(source.turns.map((t) => t.content)).toEqual(['Old task', 'Old progress']);
    expect(await resolver.resolveIdentity({ kind: 'session', historyThreadId: 'thread-archived', originNodeId: null }))
      .toEqual({ title: 'Archived title', workspacePath: '/archived', originNodeId: null });
  });

  it('keeps a long-running session\'s original task after its buffer was trimmed', async () => {
    const { instanceManager, resolver } = await harness();
    const live = instanceManager.create({ workingDirectory: '/work', displayName: 'Long run', historyThreadId: 'thread-long' });
    live.status = 'busy';
    live.retainedPrompts = [{ id: 'p0', timestamp: 1, type: 'user', content: 'Original task: port the scheduler' }];
    live.outputBuffer = [{ id: 'p9', timestamp: 9, type: 'assistant', content: 'Step 9 of 12 complete' }];

    const source = await resolver.resolve({ kind: 'session', historyThreadId: 'thread-long', originNodeId: null });

    expect(source.pendingRuntimeTurns.map((turn) => turn.content)).toEqual([
      'Original task: port the scheduler',
      'Step 9 of 12 complete',
    ]);
  });

  it('returns an explicit unavailable error for a missing parent', async () => {
    const { resolver } = await harness();
    await expect(
      resolver.resolve({ kind: 'chat', chatId: 'ghost' }),
    ).rejects.toThrow(ParentUnavailableError);
    await expect(
      resolver.resolve({ kind: 'session', historyThreadId: 'ghost-thread', originNodeId: null }),
    ).rejects.toThrow(ParentUnavailableError);
  });

  it('does not assume historyThreadId is a ledger conversation id', async () => {
    // A session whose historyThreadId happens to look like a chat's ledger
    // thread id must still resolve through the owning chat, and a session with
    // a non-ledger id must fall through to runtime/archive owners.
    const { ledger, chatStore, instanceManager, resolver } = await harness();
    await createChatThread(ledger, chatStore, 'parent-chat', 'Hardening');
    instanceManager.create({
      workingDirectory: '/work',
      displayName: 'Standalone',
      provider: 'codex',
      historyThreadId: 'not-a-ledger-id',
    });

    const viaChat = await resolver.resolve({
      kind: 'session',
      historyThreadId: chatStore.get('parent-chat')!.ledgerThreadId,
      originNodeId: null,
    });
    expect(viaChat.sourceKind).toBe('chat-ledger');

    const viaRuntime = await resolver.resolve({
      kind: 'session',
      historyThreadId: 'not-a-ledger-id',
      originNodeId: null,
    });
    expect(viaRuntime.sourceKind).toBe('session-runtime');
  });

  it('keeps two parents in one directory resolved independently', async () => {
    const { ledger, chatStore, resolver } = await harness();
    const a = await createChatThread(ledger, chatStore, 'session-a', 'Session A');
    const b = await createChatThread(ledger, chatStore, 'session-b', 'Session B');

    const sourceA = await resolver.resolve({ kind: 'chat', chatId: 'session-a' });
    const sourceB = await resolver.resolve({ kind: 'chat', chatId: 'session-b' });
    expect(sourceA.title).toBe('Session A');
    expect(sourceB.title).toBe('Session B');
    expect(a.id).not.toBe(b.id);
  });
});
