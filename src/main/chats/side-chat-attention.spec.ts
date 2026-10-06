import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { createInstance, type Instance, type InstanceCreateConfig } from '../../shared/types/instance.types';
import type { SideChatParentRef } from '../../shared/types/side-chat.types';
import { ChatStore } from './chat-store';
import { SideChatLinkStore } from './side-chat-link-store';
import { SideChatAttentionTracker } from './side-chat-attention';

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

const PARENT: SideChatParentRef = { kind: 'chat', chatId: 'parent-1' };

describe('SideChatAttentionTracker', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function harness() {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const chatStore = new ChatStore(db);
    const linkStore = new SideChatLinkStore(db);
    const instanceManager = new FakeInstanceManager();
    const latestSequences = new Map<string, number>();

    chatStore.insert({
      id: 'parent-1', name: 'Parent', provider: 'codex',
      currentCwd: '/work', ledgerThreadId: 'thread-parent',
    });

    const tracker = new SideChatAttentionTracker({
      linkStore,
      chatStore,
      instanceManager: instanceManager as never,
      getLatestAssistantSequence: async (link) => latestSequences.get(link.chatId) ?? 0,
      resolveParentTitle: async (parent) => (parent.kind === 'chat' ? chatStore.get(parent.chatId)?.name ?? null : null),
    });

    function addSideChat(id: string, options: {
      status?: Instance['status'];
      archived?: boolean;
      latestSequence?: number;
      readSequence?: number;
    } = {}) {
      chatStore.insert({
        id, name: id, provider: 'claude',
        currentCwd: '/work', ledgerThreadId: `thread-${id}`,
        archivedAt: options.archived ? Date.now() : null,
      });
      linkStore.insert({
        chatId: id,
        parent: PARENT,
        authority: 'inherit-parent',
        lastReadAssistantSequence: options.readSequence ?? 0,
      });
      if (options.status) {
        const instance = instanceManager.create({
          workingDirectory: '/work', displayName: id, provider: 'claude',
        });
        instance.status = options.status;
        chatStore.update(id, { currentInstanceId: instance.id });
      }
      if (options.latestSequence !== undefined) {
        latestSequences.set(id, options.latestSequence);
      }
    }

    return { tracker, addSideChat, latestSequences, linkStore };
  }

  it('reports zero attention for a parent with no sidechats', async () => {
    const { tracker } = harness();

    expect(await tracker.forParent(PARENT)).toEqual({
      parent: PARENT,
      parentTitle: 'Parent',
      total: 0,
      running: 0,
      unread: 0,
      needsAttention: 0,
      targetChatId: null,
    });
  });

  it('counts conversations with unread answers, not streamed chunks', async () => {
    const { tracker, addSideChat } = harness();
    // One conversation whose answer arrived as many chunks (sequence 9).
    addSideChat('a', { latestSequence: 9, readSequence: 2 });
    addSideChat('b', { latestSequence: 4, readSequence: 4 });

    expect(await tracker.forParent(PARENT)).toMatchObject({ total: 2, unread: 1, targetChatId: 'a' });
  });

  it('tracks running conversations', async () => {
    const { tracker, addSideChat } = harness();
    addSideChat('a', { status: 'busy' });
    addSideChat('b', { status: 'idle' });

    expect(await tracker.forParent(PARENT)).toMatchObject({ running: 1, targetChatId: 'a' });
  });

  it('targets the conversation needing action ahead of unread and running ones', async () => {
    const { tracker, addSideChat } = harness();
    addSideChat('running', { status: 'busy' });
    addSideChat('unread', { latestSequence: 3 });
    addSideChat('needs', { status: 'waiting_for_permission' });

    const attention = await tracker.forParent(PARENT);

    expect(attention).toMatchObject({ needsAttention: 1, running: 1, unread: 1, targetChatId: 'needs' });
    const states = Object.fromEntries((await tracker.summariesForParent(PARENT)).map((item) => [item.chat.id, item.state]));
    expect(states).toEqual({ running: 'running', unread: 'unread', needs: 'needs-attention' });
  });

  it('excludes archived sidechats from active counts', async () => {
    const { tracker, addSideChat } = harness();
    addSideChat('active');
    addSideChat('old', { archived: true, latestSequence: 5 });

    expect(await tracker.forParent(PARENT)).toMatchObject({ total: 1, unread: 0 });
  });

  it('clears unread once the read mark reaches the latest answer, and never rewinds', async () => {
    const { tracker, addSideChat, linkStore } = harness();
    addSideChat('a', { latestSequence: 6 });

    linkStore.markRead('a', 6);
    linkStore.markRead('a', 3);

    expect(linkStore.get('a')?.lastReadAssistantSequence).toBe(6);
    expect((await tracker.forParent(PARENT)).unread).toBe(0);
  });

  it('lists every parent with active sidechats', async () => {
    const { tracker, addSideChat } = harness();
    addSideChat('a', { latestSequence: 1 });

    const all = await tracker.forAllParents();

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ parent: PARENT, unread: 1 });
  });
});
