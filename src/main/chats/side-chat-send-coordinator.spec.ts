import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { SideChatContextStore } from './side-chat-context-store';
import { SideChatLinkStore } from './side-chat-link-store';
import { ParentUnavailableError, type ResolvedParentSource } from './side-chat-parent-resolver';
import { SideChatSendCoordinator, type SideChatSendFailure } from './side-chat-send-coordinator';

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

  function harness() {
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
    const state = {
      source: makeSource('Tasks 1-2 done. Remaining: 3-6.') as ResolvedParentSource | Error,
      blocked: null as SideChatFailureForTest,
      sends: [] as string[],
      dispatchError: null as Error | null,
      dispatchDelayMs: 0,
      /** Runtime instance id the next dispatch "runs" on. */
      runtime: 'runtime-1',
      delivered: [] as (string | null)[],
      /** Ledger turn id passed to every dispatch attempt, including failed ones. */
      turnIds: [] as string[],
    };
    const coordinator: SideChatSendCoordinator = new SideChatSendCoordinator({
      resolver: {
        resolve: async () => {
          if (state.source instanceof Error) throw state.source;
          return state.source;
        },
      },
      contextStore,
      linkStore,
      preflight: async () => state.blocked,
      dispatchSend: async (input, userTurnId) => {
        state.turnIds.push(userTurnId);
        if (state.dispatchDelayMs) await new Promise((resolve) => setTimeout(resolve, state.dispatchDelayMs));
        if (state.dispatchError) throw state.dispatchError;
        // ChatService.prepareTurnContext asks for context during dispatch.
        state.delivered.push(coordinator.contextForTurn(input.chatId, state.runtime, 'resume'));
        state.sends.push(input.text);
      },
    });
    return { coordinator, contextStore, state };
  }

  type SideChatFailureForTest = SideChatSendFailure | null;

  it('captures the parent task and progress and delivers it ahead of the first question', async () => {
    const { coordinator, state } = harness();

    const result = await coordinator.send({ chatId: 'side-1', text: 'How far through are you?' });

    expect(result).toMatchObject({ ok: true, usedStaleContext: false });
    expect(state.delivered[0]).toContain('Implement the plan');
    expect(state.delivered[0]).toContain('Remaining: 3-6');
    expect(state.sends).toEqual(['How far through are you?']);
  });

  it('does not resend an unchanged snapshot to the runtime that already has it', async () => {
    const { coordinator, state } = harness();

    await coordinator.send({ chatId: 'side-1', text: 'First' });
    await coordinator.send({ chatId: 'side-1', text: 'Second' });

    expect(state.delivered[1]).toBeNull();
  });

  it('sends a superseding snapshot when the parent progresses', async () => {
    const { coordinator, state } = harness();
    await coordinator.send({ chatId: 'side-1', text: 'First' });

    state.source = makeSource('Tasks 1-4 done. Remaining: 5-6.');
    await coordinator.send({ chatId: 'side-1', text: 'Now?' });

    expect(state.delivered[1]).toContain('supersedes the earlier snapshot');
    expect(state.delivered[1]).toContain('Remaining: 5-6');
  });

  it('delivers the latest snapshot to a replacement runtime even when unchanged', async () => {
    const { coordinator, state } = harness();
    await coordinator.send({ chatId: 'side-1', text: 'First' });

    state.runtime = 'runtime-2';
    await coordinator.send({ chatId: 'side-1', text: 'After provider switch' });

    expect(state.delivered[1]).toContain('Remaining: 3-6');
    expect(state.delivered[1]).not.toContain('supersedes');
  });

  it('always includes the snapshot in a rebuild, once', async () => {
    const { coordinator } = harness();
    await coordinator.send({ chatId: 'side-1', text: 'First' });

    const rebuild = coordinator.contextForTurn('side-1', 'runtime-1', 'rebuild');

    expect(rebuild?.match(/<parent_context/g)).toHaveLength(1);
  });

  it('returns an explicit error and creates no user turn when context is unavailable', async () => {
    const { coordinator, state } = harness();
    await coordinator.send({ chatId: 'side-1', text: 'First' });

    state.source = new Error('ledger read failed');
    const result = await coordinator.send({ chatId: 'side-1', text: 'Second' });

    expect(result).toEqual({
      ok: false,
      code: 'context-unavailable',
      error: 'Parent context unavailable: ledger read failed',
      lastSnapshotAvailable: true,
    });
    expect(state.sends).toEqual(['First']);
  });

  it('distinguishes a missing parent from a read failure', async () => {
    const { coordinator, state } = harness();
    state.source = new ParentUnavailableError('Parent chat deleted');

    const result = await coordinator.send({ chatId: 'side-1', text: 'Hello' });

    expect(result).toMatchObject({ ok: false, code: 'parent-unavailable', lastSnapshotAvailable: false });
  });

  it('uses the last snapshot only when explicitly allowed and labels it stale', async () => {
    const { coordinator, state } = harness();
    await coordinator.send({ chatId: 'side-1', text: 'First' });
    state.source = new Error('offline');

    const result = await coordinator.send({ chatId: 'side-1', text: 'Second' }, { allowStaleContext: true });

    expect(result).toMatchObject({ ok: true, usedStaleContext: true });
    expect(state.delivered[1]).toContain('may be stale');
  });

  it('serializes concurrent sends in order', async () => {
    const { coordinator, state } = harness();
    state.dispatchDelayMs = 5;

    await Promise.all([
      coordinator.send({ chatId: 'side-1', text: 'one' }),
      coordinator.send({ chatId: 'side-1', text: 'two' }),
      coordinator.send({ chatId: 'side-1', text: 'three' }),
    ]);

    expect(state.sends).toEqual(['one', 'two', 'three']);
  });

  it('stops before capturing context when preflight refuses', async () => {
    const { coordinator, state, contextStore } = harness();
    state.blocked = { ok: false, code: 'unavailable-permissions', error: 'no policy', lastSnapshotAvailable: false };

    const result = await coordinator.send({ chatId: 'side-1', text: 'Edit it' });

    expect(result).toMatchObject({ ok: false, code: 'unavailable-permissions' });
    expect(contextStore.get('side-1')).toBeNull();
    expect(state.sends).toEqual([]);
  });

  it('rejects a chat with no parent link', async () => {
    const { coordinator } = harness();

    expect(await coordinator.send({ chatId: 'unlinked', text: 'Hi' })).toMatchObject({ ok: false, code: 'not-linked' });
  });

  it('reports a dispatch failure after the snapshot is captured', async () => {
    const { coordinator, state } = harness();
    state.dispatchError = new Error('spawn failed');

    const result = await coordinator.send({ chatId: 'side-1', text: 'Hi' });

    expect(result).toMatchObject({ ok: false, code: 'send-failed', error: 'spawn failed', lastSnapshotAvailable: true });
  });

  it('retries a failed dispatch under the same user turn, and starts a new turn otherwise', async () => {
    const { coordinator, state } = harness();
    state.dispatchError = new Error('spawn failed');
    await coordinator.send({ chatId: 'side-1', text: 'Hi' });
    state.dispatchError = null;

    // Whitespace-only differences are the same question (the ledger stores it trimmed).
    expect(await coordinator.send({ chatId: 'side-1', text: ' Hi ' }, { allowStaleContext: true })).toMatchObject({ ok: true });
    await coordinator.send({ chatId: 'side-1', text: 'Hi' });

    expect(state.turnIds[1]).toBe(state.turnIds[0]);
    expect(state.turnIds[2]).not.toBe(state.turnIds[0]);
  });

  it('does not reuse a failed turn for a different question', async () => {
    const { coordinator, state } = harness();
    state.dispatchError = new Error('spawn failed');
    await coordinator.send({ chatId: 'side-1', text: 'Hi' });
    state.dispatchError = null;

    await coordinator.send({ chatId: 'side-1', text: 'Something else' });

    expect(state.turnIds[1]).not.toBe(state.turnIds[0]);
  });

  it('forgets delivery state for a removed runtime', async () => {
    const { coordinator } = harness();
    await coordinator.send({ chatId: 'side-1', text: 'First' });

    coordinator.forgetRuntime('runtime-1');

    expect(coordinator.contextForTurn('side-1', 'runtime-1', 'resume')).toContain('<parent_context');
  });
});
