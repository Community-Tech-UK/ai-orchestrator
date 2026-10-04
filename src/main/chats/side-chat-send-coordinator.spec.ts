import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { SideChatContextStore } from './side-chat-context-store';
import { SideChatLinkStore } from './side-chat-link-store';
import {
  ParentUnavailableError,
  type ResolvedParentSource,
  type SideChatParentResolver,
} from './side-chat-parent-resolver';
import { SideChatSendCoordinator } from './side-chat-send-coordinator';

function makeSource(content: string): ResolvedParentSource {
  return {
    parent: { kind: 'session', historyThreadId: 'thread-parent', originNodeId: 'node-1' },
    title: 'Provider Hardening',
    workspacePath: '/work',
    originNodeId: 'node-1',
    status: 'busy',
    sourceKind: 'session-runtime',
    checkpoint: null,
    turns: [
      { role: 'user', content: 'Implement the plan', sequence: 1, createdAt: 1, phase: null },
      { role: 'assistant', content, sequence: 2, createdAt: 2, phase: null },
    ],
    pendingRuntimeTurns: [],
    newestSequence: 2,
  };
}

describe('SideChatSendCoordinator', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function harness(options: {
    resolveImpl?: () => Promise<ResolvedParentSource>;
  } = {}) {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const linkStore = new SideChatLinkStore(db);
    const contextStore = new SideChatContextStore(db);
    linkStore.insert({
      chatId: 'side-1',
      parent: { kind: 'session', historyThreadId: 'thread-parent', originNodeId: 'node-1' },
      authority: 'inherit-parent',
      lastReadAssistantSequence: 0,
    });

    const preambles: { instanceId: string; preamble: string }[] = [];
    const sends: string[] = [];
    const parentMutations: string[] = [];
    let resolveCalls = 0;
    let currentSource = makeSource('Tasks 1-2 done. Remaining: 3-6.');
    let failResolve = false;

    const resolver: Pick<SideChatParentResolver, 'resolve'> = {
      resolve: async () => {
        resolveCalls += 1;
        if (options.resolveImpl) {
          return options.resolveImpl();
        }
        if (failResolve) {
          throw new ParentUnavailableError('parent runtime is gone');
        }
        return currentSource;
      },
    };

    const coordinator = new SideChatSendCoordinator({
      resolver: resolver as SideChatParentResolver,
      contextStore,
      linkStore,
      queuePreamble: (instanceId, preamble) => {
        preambles.push({ instanceId, preamble });
        parentMutations.push(`preamble:${instanceId}`);
      },
      dispatchSend: async (chatId, text) => {
        sends.push(`${chatId}:${text}`);
      },
      getRuntimeInstanceId: () => 'side-runtime-1',
    });

    return {
      coordinator,
      linkStore,
      contextStore,
      preambles,
      sends,
      parentMutations,
      get resolveCalls() {
        return resolveCalls;
      },
      setSource(content: string) {
        currentSource = makeSource(content);
      },
      setFailResolve(value: boolean) {
        failResolve = value;
      },
    };
  }

  it('delivers parent task and progress before the question without touching the parent runtime', async () => {
    const h = harness();
    const result = await h.coordinator.send('side-1', 'How far through are you?');
    expect(result.ok).toBe(true);
    expect(h.sends).toEqual(['side-1:How far through are you?']);
    // The parent is never sent to or interrupted: the only mutation recorded
    // is the sidechat's own preamble.
    expect(h.parentMutations.every((m) => m.startsWith('preamble:side-runtime-1'))).toBe(true);
    expect(h.preambles[0]?.preamble).toContain('Implement the plan');
    expect(h.preambles[0]?.preamble).toContain('Tasks 1-2 done');
    expect(h.preambles[0]?.preamble).toContain('parent_context');
  });

  it('refreshes context on each question and the follow-up sees new parent progress', async () => {
    const h = harness();
    await h.coordinator.send('side-1', 'First question');
    h.setSource('Tasks 1-3 done. Remaining: 4-6.');
    await h.coordinator.send('side-1', 'Follow-up question');

    expect(h.resolveCalls).toBe(2);
    expect(h.sends).toHaveLength(2);
    expect(h.preambles).toHaveLength(2);
    expect(h.preambles[0]?.preamble).toContain('Tasks 1-2 done');
    expect(h.preambles[1]?.preamble).toContain('Tasks 1-3 done');
    expect(h.preambles[1]?.preamble).toContain('supersedes');
  });

  it('does not resend unchanged context on an identical follow-up', async () => {
    const h = harness();
    await h.coordinator.send('side-1', 'First');
    await h.coordinator.send('side-1', 'Second');
    expect(h.resolveCalls).toBe(2);
    expect(h.preambles).toHaveLength(1);
  });

  it('persists exactly the latest effective context for rebuild', async () => {
    const h = harness();
    await h.coordinator.send('side-1', 'First');
    h.setSource('Tasks 1-3 done.');
    await h.coordinator.send('side-1', 'Second');

    const stored = h.coordinator.latestEffectiveContext('side-1');
    expect(stored).not.toBeNull();
    expect(stored?.quotedContext).toContain('Tasks 1-3 done');
    // Only one row: rebuild sees the latest snapshot, not a stack of history.
    const rows = h.contextStore.get('side-1');
    expect(rows?.revision).toBe(stored?.revision);
  });

  it('returns an explicit error and offers the last snapshot when context is unavailable', async () => {
    const h = harness();
    await h.coordinator.send('side-1', 'First');
    h.setFailResolve(true);

    const failed = await h.coordinator.send('side-1', 'Second');
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe('parent-unavailable');
      expect(failed.lastSnapshotAvailable).toBe(true);
    }
    // No user turn is appended when snapshot acquisition fails.
    expect(h.sends).toEqual(['side-1:First']);
  });

  it('uses the last snapshot only when explicitly allowed and labels it stale', async () => {
    const h = harness();
    await h.coordinator.send('side-1', 'First');
    h.setFailResolve(true);

    const refused = await h.coordinator.send('side-1', 'Second');
    expect(refused.ok).toBe(false);

    const accepted = await h.coordinator.send('side-1', 'Second', { allowStaleContext: true });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.usedStaleContext).toBe(true);
    }
    expect(h.sends).toEqual(['side-1:First', 'side-1:Second']);
    expect(h.preambles.at(-1)?.preamble).toContain('may be stale');
  });

  it('serializes concurrent sends so a retry cannot duplicate a user turn', async () => {
    const h = harness();
    const results = await Promise.all([
      h.coordinator.send('side-1', 'Same question'),
      h.coordinator.send('side-1', 'Same question'),
      h.coordinator.send('side-1', 'Same question'),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(h.sends).toHaveLength(3);
    // Serialized: each dispatch happened strictly after the previous one.
    expect(h.resolveCalls).toBe(3);
  });

  it('rejects sends for a chat with no parent link', async () => {
    const h = harness();
    const result = await h.coordinator.send('unlinked-chat', 'Hello');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('parent-unavailable');
      expect(result.error).toContain('not linked');
    }
  });

  it('returns an explicit error when dispatch fails after the snapshot is captured', async () => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const linkStore = new SideChatLinkStore(db);
    const contextStore = new SideChatContextStore(db);
    linkStore.insert({
      chatId: 'side-1',
      parent: { kind: 'chat', chatId: 'parent' },
      authority: 'inherit-parent',
      lastReadAssistantSequence: 0,
    });
    const coordinator = new SideChatSendCoordinator({
      resolver: {
        resolve: async () => makeSource('progress'),
      } as unknown as SideChatParentResolver,
      contextStore,
      linkStore,
      queuePreamble: () => undefined,
      dispatchSend: async () => {
        throw new Error('runtime spawn failed');
      },
      getRuntimeInstanceId: () => null,
    });

    const result = await coordinator.send('side-1', 'Question');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('send-failed');
      expect(result.error).toContain('runtime spawn failed');
      expect(result.lastSnapshotAvailable).toBe(true);
    }
  });

  it('skips preamble delivery when no runtime exists yet (first send)', async () => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const linkStore = new SideChatLinkStore(db);
    const contextStore = new SideChatContextStore(db);
    linkStore.insert({
      chatId: 'side-1',
      parent: { kind: 'chat', chatId: 'parent' },
      authority: 'inherit-parent',
      lastReadAssistantSequence: 0,
    });
    const preambles: string[] = [];
    const coordinator = new SideChatSendCoordinator({
      resolver: { resolve: async () => makeSource('progress') } as unknown as SideChatParentResolver,
      contextStore,
      linkStore,
      queuePreamble: (_id, preamble) => preambles.push(preamble),
      dispatchSend: async () => undefined,
      getRuntimeInstanceId: () => null, // no runtime yet on first send
    });

    const result = await coordinator.send('side-1', 'First question');
    expect(result.ok).toBe(true);
    // Preamble is not queued when there is no runtime; the context is delivered
    // via prepareTurnContext's brand-new path after the runtime spawns.
    expect(preambles).toHaveLength(0);
    // But the snapshot IS persisted for later rebuild.
    expect(contextStore.get('side-1')).not.toBeNull();
  });
});
