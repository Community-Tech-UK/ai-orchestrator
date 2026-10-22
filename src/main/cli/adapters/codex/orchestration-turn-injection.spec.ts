import { describe, expect, it, vi } from 'vitest';
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerRequestParams,
  AppServerResponseResult,
  TurnCaptureState,
  UserInput,
} from './app-server-types';
import { CodexAppServerThreadRuntime, createCodexTurnCaptureState } from './app-server-thread-runtime';
import { injectOrchestrationIntoRunningTurn, ORCHESTRATION_REDELIVERY_NOTE } from './orchestration-turn-injection';

class FakeClient {
  readonly subscribers = new Set<(notification: AppServerNotification) => void>();
  readonly exitPromise = new Promise<void>(() => { /* The fake connection stays open. */ });
  injectBehaviour: (() => Promise<void>) | null = null;
  readonly request = vi.fn(async <M extends AppServerMethod>(
    method: M,
    _params: AppServerRequestParams<M>,
  ): Promise<AppServerResponseResult<M>> => {
    if (method === 'turn/start') {
      return { turn: { id: 'turn-1', status: 'inProgress' } } as AppServerResponseResult<M>;
    }
    if (method === 'thread/inject_items' && this.injectBehaviour) await this.injectBehaviour();
    return {} as AppServerResponseResult<M>;
  });

  subscribeNotifications(handler: (notification: AppServerNotification) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  emit(method: AppServerNotification['method'], params: Record<string, unknown>): void {
    for (const subscriber of Array.from(this.subscribers)) subscriber({ method, params });
  }

  isRunning(): boolean { return true; }
}

function finishTurn(state: TurnCaptureState, status: 'completed' | 'interrupted'): void {
  if (state.completed) return;
  state.completed = true;
  state.finalTurn = { id: state.turnId ?? 'turn-1', status };
  state.resolveCompletion(state);
}

function captureOptions() {
  return {
    input: [{ type: 'text', text: 'keep working', text_elements: [] }] as UserInput[],
    turnParams: {},
    createState: createCodexTurnCaptureState,
    belongsToTurn: () => true,
    handleNotification: (state: TurnCaptureState, notification: AppServerNotification) => {
      if (notification.method !== 'turn/completed') return;
      const turn = notification.params['turn'] as { status?: string } | undefined;
      finishTurn(state, turn?.status === 'interrupted' ? 'interrupted' : 'completed');
    },
    completeTurn: (state: TurnCaptureState) => finishTurn(state, 'completed'),
    toInterruptCompletion: () => ({ status: 'completed' as const }),
    resolveNotificationIdleTimeoutMs: () => 60_000,
    hasPendingApproval: () => false,
    onHeartbeat: vi.fn(),
    onAbandonedTurn: vi.fn(),
  };
}

/** A runtime with a Harness-started turn that is running, as in session x3po7817o. */
async function runningHarnessTurn() {
  const runtime = new CodexAppServerThreadRuntime();
  const client = new FakeClient();
  runtime.attach(client, { threadId: 'thread-1', resumeCursor: null, resumeProof: null });
  const capture = runtime.captureTurn(captureOptions());
  await vi.waitFor(() => expect(runtime.getRunningTurn()).not.toBeNull());
  return { runtime, client, capture };
}

function completeTurn(client: FakeClient, status = 'completed'): void {
  client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status } });
}

function injectCalls(client: FakeClient) {
  return client.request.mock.calls.filter(([method]) => method === 'thread/inject_items');
}

describe('injectOrchestrationIntoRunningTurn', () => {
  it('adds the response to a running Harness-started turn as a developer item', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    const redeliver = vi.fn(async () => undefined);

    await expect(injectOrchestrationIntoRunningTurn('Consensus: ship it', runtime, redeliver)).resolves.toBe('delivered');

    expect(injectCalls(client)).toEqual([['thread/inject_items', {
      threadId: 'thread-1',
      items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Consensus: ship it' }] }],
    }]]);
    expect(client.request.mock.calls.some(([method]) => method === 'turn/steer')).toBe(false);
    client.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'c1', type: 'commandExecution' } });
    completeTurn(client);
    await capture;
    await Promise.resolve();
    expect(redeliver).not.toHaveBeenCalled();
  });

  it('re-delivers once when the turn ends without another step after the item', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    const redeliver = vi.fn(async () => undefined);

    await injectOrchestrationIntoRunningTurn('Consensus: ship it', runtime, redeliver);
    // Model output alone does not prove a new step: it may come from the step already running.
    client.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'm1', type: 'agentMessage' } });
    completeTurn(client);
    await capture;

    await vi.waitFor(() => expect(redeliver).toHaveBeenCalledOnce());
    expect(redeliver).toHaveBeenCalledWith(`${ORCHESTRATION_REDELIVERY_NOTE}\n\nConsensus: ship it`);
  });

  it('does not count a tool call that finished before the item was accepted', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    client.injectBehaviour = async () => {
      client.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'c1', type: 'commandExecution' } });
    };
    const redeliver = vi.fn(async () => undefined);

    await injectOrchestrationIntoRunningTurn('Consensus: ship it', runtime, redeliver);
    completeTurn(client);
    await capture;

    await vi.waitFor(() => expect(redeliver).toHaveBeenCalledOnce());
  });

  it('does not count a web search, which can run inside the step already streaming', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    const redeliver = vi.fn(async () => undefined);

    await injectOrchestrationIntoRunningTurn('Consensus: ship it', runtime, redeliver);
    client.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'w1', type: 'webSearch' } });
    completeTurn(client);
    await capture;

    await vi.waitFor(() => expect(redeliver).toHaveBeenCalledOnce());
  });

  it('does not count a tool call from another turn or a child thread', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    const redeliver = vi.fn(async () => undefined);

    await injectOrchestrationIntoRunningTurn('Consensus: ship it', runtime, redeliver);
    client.emit('item/completed', { threadId: 'child-thread', turnId: 'turn-9', item: { id: 'c1', type: 'commandExecution' } });
    client.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-0', item: { id: 'c2', type: 'commandExecution' } });
    completeTurn(client);
    await capture;

    await vi.waitFor(() => expect(redeliver).toHaveBeenCalledOnce());
  });

  it('waits rather than injecting while the turn is being interrupted', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    client.request.mockClear();
    runtime.interrupt();

    await expect(injectOrchestrationIntoRunningTurn('Consensus', runtime, vi.fn())).resolves.toBe('not-running');
    expect(injectCalls(client)).toEqual([]);
    completeTurn(client, 'interrupted');
    await capture;
  });

  it('never re-delivers a re-delivery', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    const redeliver = vi.fn(async () => undefined);

    await injectOrchestrationIntoRunningTurn(`${ORCHESTRATION_REDELIVERY_NOTE}\n\nConsensus: ship it`, runtime, redeliver);
    completeTurn(client);
    await capture;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(redeliver).not.toHaveBeenCalled();
  });

  it('leaves an interrupted turn alone', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    const redeliver = vi.fn(async () => undefined);

    await injectOrchestrationIntoRunningTurn('Consensus: ship it', runtime, redeliver);
    completeTurn(client, 'interrupted');
    await capture;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(redeliver).not.toHaveBeenCalled();
  });

  it('reports not-running when no turn is running', async () => {
    const runtime = new CodexAppServerThreadRuntime();
    const client = new FakeClient();
    runtime.attach(client, { threadId: 'thread-1', resumeCursor: null, resumeProof: null });

    await expect(injectOrchestrationIntoRunningTurn('Consensus', runtime, vi.fn())).resolves.toBe('not-running');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('reports not-running when the turn ended while the item was in flight', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    client.injectBehaviour = async () => { completeTurn(client); };
    const redeliver = vi.fn(async () => undefined);

    await expect(injectOrchestrationIntoRunningTurn('Consensus', runtime, redeliver)).resolves.toBe('not-running');
    await capture;
    expect(redeliver).not.toHaveBeenCalled();
    expect(client.subscribers.size).toBe(0);
  });

  it('reports failed when Codex refuses the item while the turn is still running', async () => {
    const { runtime, client, capture } = await runningHarnessTurn();
    client.injectBehaviour = async () => { throw new Error('method not found'); };

    await expect(injectOrchestrationIntoRunningTurn('Consensus', runtime, vi.fn())).resolves.toBe('failed');
    completeTurn(client);
    await capture;
  });
});
