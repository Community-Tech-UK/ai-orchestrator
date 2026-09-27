import { describe, expect, it, vi } from 'vitest';

vi.mock('./codex/app-server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex/app-server-client')>();
  return { ...actual, terminateProcessTree: vi.fn() };
});

import { CodexCliAdapter } from './codex-cli-adapter';

vi.setConfig({ testTimeout: 15_000 });

type Notification = { method: string; params: Record<string, unknown> };
type RpcHandler = (method: string, params: Record<string, unknown>) => unknown;

interface Harness {
  adapter: CodexCliAdapter;
  emit(method: string, params: Record<string, unknown>): void;
  requests: Array<[string, Record<string, unknown>]>;
  outputs: Array<{ type: string; content: string; metadata?: Record<string, unknown> }>;
  statuses: string[];
  completions: string[];
  hasActiveTurn(): boolean;
  activeTurnOrigin(): string | null;
}

/**
 * An app-server connection whose notifications reach the adapter the way
 * production wires them: one connection-level observer plus per-turn subscribers.
 */
function createHarness(rpc: RpcHandler): Harness {
  const adapter = new CodexCliAdapter();
  const subscribers = new Set<(notification: Notification) => void>();
  const requests: Harness['requests'] = [];
  const client = {
    exitPromise: new Promise<void>(() => { /* stays connected */ }),
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push([method, params]);
      return rpc(method, params);
    }),
    subscribeNotifications(handler: (notification: Notification) => void) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    isRunning: () => true,
    getPid: () => 4242,
  };
  const internals = adapter as unknown as {
    appServerClient: typeof client;
    appServerThreadId: string;
    useAppServer: boolean;
    isSpawned: boolean;
    appServerRuntime: {
      attach(c: typeof client, binding: unknown, onNotification: (n: Notification) => void): void;
      hasActiveTurn(): boolean;
      getActiveTurnOrigin(): string | null;
    };
    handleIdleAppServerNotification(notification: Notification): void;
  };
  internals.appServerClient = client;
  internals.appServerThreadId = 'thread-1';
  internals.useAppServer = true;
  internals.isSpawned = true;
  internals.appServerRuntime.attach(
    client,
    { threadId: 'thread-1', resumeCursor: null, resumeProof: null },
    (notification) => internals.handleIdleAppServerNotification(notification),
  );
  const outputs: Harness['outputs'] = [];
  const statuses: string[] = [];
  const completions: string[] = [];
  adapter.on('output', (output: Harness['outputs'][number]) => outputs.push(output));
  adapter.on('status', (status: string) => statuses.push(status));
  adapter.on('complete', (response: { content: string }) => completions.push(response.content));
  return {
    adapter,
    emit: (method, params) => { for (const subscriber of [...subscribers]) subscriber({ method, params }); },
    requests,
    outputs,
    statuses,
    completions,
    hasActiveTurn: () => internals.appServerRuntime.hasActiveTurn(),
    activeTurnOrigin: () => internals.appServerRuntime.getActiveTurnOrigin(),
  };
}

function finalAnswer(turnId: string, text: string): [string, Record<string, unknown>] {
  return ['item/completed', {
    threadId: 'thread-1',
    turnId,
    item: { id: `${turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text },
  }];
}

function turnCompleted(turnId: string, status = 'completed'): [string, Record<string, unknown>] {
  return ['turn/completed', { threadId: 'thread-1', turn: { id: turnId, status } }];
}

const compactionItem = { type: 'contextCompaction', id: 'compaction-item' };

describe('CodexCliAdapter turns Codex starts by itself', () => {
  // xqs4fg7sl: after the model called create_goal, every turn after 04:36 was a
  // goal continuation. None reached the transcript and the session read idle.
  it('renders a goal-continuation turn, holds busy, and settles to idle once', async () => {
    const h = createHarness(() => ({}));

    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });
    expect(h.activeTurnOrigin()).toBe('provider');
    expect(h.statuses).toEqual(['busy']);

    h.emit(...finalAnswer('goal-turn', 'Checked the remaining livetests.'));
    h.emit(...turnCompleted('goal-turn'));

    await vi.waitFor(() => expect(h.completions).toEqual(['Checked the remaining livetests.']));
    await vi.waitFor(() => expect(h.statuses).toEqual(['busy', 'idle']));
    expect(h.outputs.some((output) => output.type === 'assistant'
      && output.content.includes('Checked the remaining livetests.'))).toBe(true);
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.requests).toEqual([]);
  });

  it('delivers a send during a provider turn into that turn and resolves when it ends', async () => {
    const h = createHarness((method) => (method === 'turn/steer' ? { turnId: 'goal-turn' } : {}));
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });

    const send = (h.adapter as unknown as {
      sendInputImpl(message: string): Promise<void>;
    }).sendInputImpl('Also re-run the failing check.');
    await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toContain('turn/steer'));

    expect(h.requests).toEqual([['turn/steer', {
      threadId: 'thread-1',
      expectedTurnId: 'goal-turn',
      input: [{ type: 'text', text: 'Also re-run the failing check.', text_elements: [] }],
    }]]);
    h.emit(...finalAnswer('goal-turn', 'Re-ran it.'));
    h.emit(...turnCompleted('goal-turn'));

    await expect(send).resolves.toBeUndefined();
    expect(h.completions).toEqual(['Re-ran it.']);
    expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
  });

  it('does not follow the Compact turn of a Harness compaction request as task work', async () => {
    const h = createHarness((method) => {
      if (method === 'thread/compact/start') {
        setTimeout(() => {
          h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'inProgress' } });
          expect(h.hasActiveTurn()).toBe(false);
          h.emit('item/started', { threadId: 'thread-1', turnId: 'compact-turn', item: compactionItem });
          h.emit('item/completed', { threadId: 'thread-1', turnId: 'compact-turn', item: compactionItem });
          h.emit(...turnCompleted('compact-turn'));
        }, 0);
      }
      return {};
    });

    await expect(h.adapter.compactContext()).resolves.toBe(true);
    expect(h.hasActiveTurn()).toBe(false);
    expect(h.completions).toEqual([]);
  });

  it('refuses to compact over a running provider turn, which Codex would replace', async () => {
    const h = createHarness(() => ({}));
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });

    await expect(h.adapter.compactContext()).resolves.toBe(false);
    expect(h.requests.map(([method]) => method)).not.toContain('thread/compact/start');
  });

  it('keeps Codex inline compaction inside the turn: no gate, turn stays followed', async () => {
    const h = createHarness(() => ({}));
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });

    h.emit('item/started', { threadId: 'thread-1', turnId: 'goal-turn', item: compactionItem });
    expect(h.adapter.isProviderCompacting()).toBe(false);
    h.emit('item/completed', { threadId: 'thread-1', turnId: 'goal-turn', item: compactionItem });
    expect(h.activeTurnOrigin()).toBe('provider');
    expect(h.outputs.some((output) => output.metadata?.['threadCompacted'] === true)).toBe(true);

    h.emit(...finalAnswer('goal-turn', 'Continued after compacting.'));
    h.emit(...turnCompleted('goal-turn'));
    await vi.waitFor(() => expect(h.completions).toEqual(['Continued after compacting.']));
  });

  it('pauses an active goal on stop, and leaves an inactive one alone', async () => {
    let goalStatus: string | null = 'active';
    const h = createHarness((method, params) => {
      if (method === 'thread/goal/get') return { goal: goalStatus ? { threadId: 'thread-1', objective: 'x', status: goalStatus } : null };
      if (method === 'thread/goal/set') {
        goalStatus = String(params['status']);
        return { goal: { threadId: 'thread-1', objective: 'x', status: goalStatus } };
      }
      return {};
    });

    await expect(h.adapter.stopProviderAutoContinuation()).resolves.toBe(true);
    expect(h.requests).toContainEqual(['thread/goal/set', { threadId: 'thread-1', status: 'paused' }]);
    expect(h.outputs.at(-1)?.metadata?.['providerGoalPaused']).toBe(true);

    await expect(h.adapter.stopProviderAutoContinuation()).resolves.toBe(false);
    expect(h.requests.filter(([method]) => method === 'thread/goal/set')).toHaveLength(1);
  });

  it('pauses a goal Codex reported active in one request, sent ahead of the interrupt', async () => {
    const h = createHarness((method) => (method === 'thread/goal/set'
      ? { goal: { threadId: 'thread-1', objective: 'x', status: 'paused' } }
      : {}));
    h.emit('thread/goal/updated', { threadId: 'thread-1', turnId: null, goal: { threadId: 'thread-1', objective: 'x', status: 'active' } });
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });

    const paused = h.adapter.stopProviderAutoContinuation();
    h.adapter.interrupt();
    await expect(paused).resolves.toBe(true);

    expect(h.requests.map(([method]) => method)).toEqual(['thread/goal/set', 'turn/interrupt']);
  });

  it('sends nothing on stop when Codex reported the goal inactive', async () => {
    const h = createHarness(() => ({}));
    h.emit('thread/goal/updated', { threadId: 'thread-1', turnId: null, goal: { threadId: 'thread-1', objective: 'x', status: 'complete' } });

    await expect(h.adapter.stopProviderAutoContinuation()).resolves.toBe(false);
    expect(h.requests).toEqual([]);
  });

  // Replays the xqs4fg7sl sequence: Harness interrupts and compacts, Codex's goal
  // extension starts a turn right after the Compact turn, and Harness's empty
  // developer turn/start used to land on it as a steer (EmptyInput, 7 of 7).
  it('leaves the post-compaction continuation to an active goal and renders the goal turn', async () => {
    let turnStarts = 0;
    const h = createHarness((method) => {
      if (method === 'turn/start') {
        turnStarts += 1;
        setTimeout(() => h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } }), 0);
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') {
        setTimeout(() => h.emit(...turnCompleted('turn-1', 'interrupted')), 0);
        return {};
      }
      if (method === 'thread/compact/start') {
        setTimeout(() => {
          h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'inProgress' } });
          h.emit('item/started', { threadId: 'thread-1', turnId: 'compact-turn', item: compactionItem });
          h.emit('item/completed', { threadId: 'thread-1', turnId: 'compact-turn', item: compactionItem });
          h.emit(...turnCompleted('compact-turn'));
          setTimeout(() => h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } }), 5);
        }, 0);
        return {};
      }
      if (method === 'thread/goal/get') return { goal: { threadId: 'thread-1', objective: 'livetests', status: 'active' } };
      return {};
    });
    const inner = (h.adapter as unknown as {
      appServerSendMessageInner(message: string): Promise<void>;
    }).appServerSendMessageInner('Run as many of these livetests as possible.');
    await vi.waitFor(() => expect(h.hasActiveTurn()).toBe(true));
    await h.adapter.executeContextAction('controlled-recovery');

    await expect(inner).resolves.toBeUndefined();
    await vi.waitFor(() => expect(h.activeTurnOrigin()).toBe('provider'));
    h.emit(...finalAnswer('goal-turn', 'Resumed the livetests.'));
    h.emit(...turnCompleted('goal-turn'));

    await vi.waitFor(() => expect(h.completions).toContain('Resumed the livetests.'));
    expect(turnStarts).toBe(1);
    expect(h.requests.map(([method]) => method)).not.toContain('thread/inject_items');
    expect(h.outputs.some((output) => output.metadata?.['contextCostRecovery'] === true
      && output.content.includes('continuing the task by itself'))).toBe(true);
    expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
  });
});
