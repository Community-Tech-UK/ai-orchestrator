import { describe, expect, it } from 'vitest';
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
      getLatestAssistantSequence: (chatId) => latestSequences.get(chatId) ?? 0,
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

  it('reports zero attention for a parent with no sidechats', () => {
    const { tracker } = harness();
    const attention = tracker.forParent(PARENT);
    expect(attention).toEqual({
      parent: PARENT, total: 0, running: 0, unread: 0, needsAttention: 0,
    });
  });

  it('counts unread conversations, not streaming chunks', () => {
    const { tracker, addSideChat } = harness();
    addSideChat('side-1', { latestSequence: 5, readSequence: 0 });
    addSideChat('side-2', { latestSequence: 3, readSequence: 3 });
    addSideChat('side-3', { latestSequence: 1, readSequence: 0 });

    const attention = tracker.forParent(PARENT);
    expect(attention.total).toBe(3);
    expect(attention.unread).toBe(2); // side-1 and side-3
  });

  it('tracks running state', () => {
    const { tracker, addSideChat } = harness();
    addSideChat('side-1', { status: 'busy' });
    addSideChat('side-2', { status: 'idle' });

    const attention = tracker.forParent(PARENT);
    expect(attention.running).toBe(1);
  });

  it('tracks needs-attention with higher priority than running', () => {
    const { tracker, addSideChat } = harness();
    addSideChat('side-1', { status: 'waiting_for_permission' });
    addSideChat('side-2', { status: 'error' });
    addSideChat('side-3', { status: 'busy' });

    const attention = tracker.forParent(PARENT);
    expect(attention.needsAttention).toBe(2);
    expect(attention.running).toBe(1);
  });

  it('excludes archived sidechats from active counts', () => {
    const { tracker, addSideChat } = harness();
    addSideChat('side-1', { latestSequence: 5 });
    addSideChat('side-2', { archived: true, latestSequence: 5 });

    const attention = tracker.forParent(PARENT);
    expect(attention.total).toBe(1);
    expect(attention.unread).toBe(1);
  });

  it('keeps attention state available without mounting the panel', () => {
    const { tracker, addSideChat } = harness();
    addSideChat('side-1', { status: 'busy', latestSequence: 5 });
    // The tracker computes from durable state — no panel or renderer required.
    const attention = tracker.forParent(PARENT);
    expect(attention.running).toBe(1);
    expect(attention.unread).toBe(1);
  });

  it('handles simultaneous completion and read acknowledgement', () => {
    const { tracker, addSideChat, linkStore, latestSequences } = harness();
    addSideChat('side-1', { latestSequence: 0, readSequence: 0 });

    // Completion arrives and read acknowledgement lands concurrently.
    latestSequences.set('side-1', 7);
    linkStore.markRead('side-1', 7);

    const attention = tracker.forParent(PARENT);
    expect(attention.unread).toBe(0);
  });

  it('handles duplicates and out-of-order events without inflating counts', () => {
    const { tracker, addSideChat, latestSequences } = harness();
    addSideChat('side-1', { latestSequence: 0, readSequence: 0 });

    // Out-of-order: a lower sequence arrives after a higher one.
    latestSequences.set('side-1', 5);
    latestSequences.set('side-1', 3); // stale/out-of-order
    latestSequences.set('side-1', 5); // duplicate

    const attention = tracker.forParent(PARENT);
    expect(attention.unread).toBe(1);
    expect(attention.total).toBe(1);
  });
});
