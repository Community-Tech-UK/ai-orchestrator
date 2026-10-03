import { describe, expect, it, vi } from 'vitest';
import type { ResumeAttemptResult } from '../base-cli-adapter';
import type { ResumeCursor } from '../../../session/session-continuity.types';
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerRequestParams,
  AppServerResponseResult,
  TurnCaptureState,
  UserInput,
} from './app-server-types';
import {
  CodexAppServerThreadRuntime,
  CONTEXT_POLICY_STEER_TEXT,
  createCodexTurnCaptureState,
} from './app-server-thread-runtime';

class FakeClient {
  readonly subscribers = new Set<(notification: AppServerNotification) => void>();
  readonly exitPromise = new Promise<void>(() => { /* The fake connection stays open. */ });
  readonly request = vi.fn(async <M extends AppServerMethod>(
    _method: M,
    _params: AppServerRequestParams<M>,
  ): Promise<AppServerResponseResult<M>> => ({} as AppServerResponseResult<M>));
  readonly close = vi.fn(async () => { /* There is no native process to close. */ });

  subscribeNotifications(handler: (notification: AppServerNotification) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  emit(method: AppServerNotification['method'], params: Record<string, unknown>): void {
    // Snapshot: a subscriber may unsubscribe while we emit.
    for (const subscriber of Array.from(this.subscribers)) subscriber({ method, params });
  }

  isRunning(): boolean { return true; }
  getPid(): number { return 123; }
  getExitError(): Error | null { return null; }
}

const cursor: ResumeCursor = {
  provider: 'openai',
  threadId: 'thread-1',
  workspacePath: '/tmp/project',
  capturedAt: 10,
  scanSource: 'native',
};

const resumeProof: ResumeAttemptResult = {
  source: 'native',
  confirmed: true,
  requestedSessionId: 'thread-1',
  actualSessionId: 'thread-1',
};

function finishTurn(state: TurnCaptureState, status: 'completed' | 'interrupted'): void {
  if (state.completed) return;
  state.completed = true;
  state.finalTurn = { id: state.turnId ?? 'turn-1', status };
  state.resolveCompletion(state);
}

function captureOptions() {
  return {
    input: [{ type: 'text', text: 'hello', text_elements: [] }] as UserInput[],
    turnParams: {},
    createState: createCodexTurnCaptureState,
    belongsToTurn: () => true,
    handleNotification: (state: TurnCaptureState, notification: AppServerNotification) => {
      if (notification.method === 'turn/completed') {
        const turn = notification.params['turn'] as { status?: string } | undefined;
        finishTurn(state, turn?.status === 'interrupted' ? 'interrupted' : 'completed');
      }
    },
    completeTurn: (state: TurnCaptureState) => finishTurn(state, 'completed'),
    toInterruptCompletion: (state: TurnCaptureState) => ({
      status: state.finalTurn?.status === 'interrupted' ? 'interrupted' as const : 'completed' as const,
      turnId: state.turnId ?? undefined,
    }),
    resolveNotificationIdleTimeoutMs: () => 1_000,
    hasPendingApproval: () => false,
    onHeartbeat: vi.fn(),
    onAbandonedTurn: vi.fn(),
  };
}

describe('CodexAppServerThreadRuntime', () => {
  it('owns one atomic native-thread binding snapshot', () => {
    const runtime = new CodexAppServerThreadRuntime({ clock: () => 50 });
    const client = new FakeClient();

    runtime.attach(client, {
      threadId: 'thread-1',
      resumeCursor: cursor,
      resumeProof,
    });

    expect(runtime.getSnapshot()).toMatchObject({
      connectionPhase: 'ready',
      turnPhase: 'idle',
      nativeThreadId: 'thread-1',
      activeTurnId: null,
      providerSessionId: 'thread-1',
      resumeCursor: cursor,
      resumeProof,
      capturedAt: 50,
      revision: 1,
    });
  });

  it('delivers one interrupt armed before the turn id and accepts the generated empty response', async () => {
    const runtime = new CodexAppServerThreadRuntime();
    const client = new FakeClient();
    runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });

    let releaseTurnStart!: () => void;
    const turnStartGate = new Promise<void>((resolve) => { releaseTurnStart = resolve; });
    client.request.mockImplementation(async (method: string) => {
      if (method === 'turn/start') {
        await turnStartGate;
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') {
        client.emit('turn/completed', {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'interrupted' },
        });
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    });

    const capture = runtime.captureTurn(captureOptions());
    const interrupt = runtime.interrupt();
    expect(interrupt.status).toBe('accepted');
    expect(interrupt.turnId).toBeUndefined();

    client.emit('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1' },
    });
    releaseTurnStart();

    await expect(interrupt.completion).resolves.toEqual({
      status: 'interrupted',
      turnId: 'turn-1',
    });
    await expect(capture).resolves.toMatchObject({
      completed: true,
      turnId: 'turn-1',
    });
    expect(client.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(runtime.getSnapshot()).toMatchObject({ turnPhase: 'idle', activeTurnId: null });
  });

  // LT-657: `turn/steer` input is recorded by Codex as a `role: "user"` message
  // (session x7cpyakhs: the agent answered "Who requested you stop?" with "You
  // did, in your immediately preceding message"). The context-policy
  // instruction must reach the live turn as a developer-role item instead.
  it('delivers the context-policy steer as a developer-role item, never as user input, and refuses when idle', async () => {
    const runtime = new CodexAppServerThreadRuntime();
    const client = new FakeClient();
    runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });

    expect(await runtime.steerActiveTurn()).toBe(false);
    expect(client.request).not.toHaveBeenCalled();

    let releaseTurnStart!: () => void;
    const turnStartGate = new Promise<void>((resolve) => { releaseTurnStart = resolve; });
    client.request.mockImplementation(async (method: string) => {
      if (method === 'turn/start') {
        await turnStartGate;
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      if (method === 'thread/inject_items') return {};
      throw new Error(`unexpected method ${method}`);
    });

    const capture = runtime.captureTurn(captureOptions());
    client.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    expect(runtime.getSnapshot().turnPhase).toBe('running');

    expect(await runtime.steerActiveTurn()).toBe(true);
    // Duplicate delivery (a policy re-fire or retry) must take the same channel.
    expect(await runtime.steerActiveTurn()).toBe(true);

    const developerItem = {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: CONTEXT_POLICY_STEER_TEXT }],
    };
    const policyCalls = client.request.mock.calls.filter(([method]) => method !== 'turn/start');
    expect(policyCalls).toEqual([
      ['thread/inject_items', { threadId: 'thread-1', items: [developerItem] }],
      ['thread/inject_items', { threadId: 'thread-1', items: [developerItem] }],
    ]);
    expect(client.request.mock.calls.some(([method]) => method === 'turn/steer')).toBe(false);
    const userInputCarryingSteer = client.request.mock.calls.some(([, params]) => (
      JSON.stringify((params as { input?: unknown }).input ?? null).includes('broad exploration')
    ));
    expect(userInputCarryingSteer).toBe(false);

    // The wording itself must never license "you asked me to stop".
    expect(CONTEXT_POLICY_STEER_TEXT).toContain('not a message from the user');
    expect(CONTEXT_POLICY_STEER_TEXT).toContain('has not asked you to stop');
    expect(CONTEXT_POLICY_STEER_TEXT).toContain('Never attribute this instruction to the user');
    expect(CONTEXT_POLICY_STEER_TEXT).toContain('continue the user\'s current task');

    releaseTurnStart();
    client.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    });
    await capture;
  });

  // LT-657: a Harness-authored turn (continuation, check-in, orchestrator
  // response) starts from a developer item with no user input at all.
  it('starts a Harness-authored turn from a developer item with empty user input', async () => {
    const runtime = new CodexAppServerThreadRuntime();
    const client = new FakeClient();
    runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });
    client.request.mockImplementation(async (method: string) => {
      if (method === 'thread/inject_items') return {};
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      throw new Error(`unexpected method ${method}`);
    });

    const capture = runtime.captureTurn({
      ...captureOptions(),
      input: [],
      developerInput: 'Continue the interrupted task from where you left off.',
    });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
    await capture;

    expect(client.request.mock.calls.map(([method]) => method)).toEqual(['thread/inject_items', 'turn/start']);
    expect(client.request.mock.calls[0][1]).toEqual({
      threadId: 'thread-1',
      items: [{
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Continue the interrupted task from where you left off.' }],
      }],
    });
    expect((client.request.mock.calls[1][1] as { input: unknown }).input).toEqual([]);
  });

  // W6: a steer can lose the race with the turn finishing. The provider then
  // rejects it, which is not a failure of the steer mechanism.
  it('treats a steer rejected after the turn finished as no live turn, but rethrows other rejections', async () => {
    const runtime = new CodexAppServerThreadRuntime();
    const client = new FakeClient();
    runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });
    let steerRejection = 'provider unavailable';
    client.request.mockImplementation(async (method: string) => {
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      if (method === 'thread/inject_items') {
        if (steerRejection === 'turn finished') {
          client.emit('turn/completed', {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'completed' },
          });
        }
        throw new Error(steerRejection);
      }
      throw new Error(`unexpected method ${method}`);
    });

    const capture = runtime.captureTurn(captureOptions());
    client.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    expect(runtime.getSnapshot().turnPhase).toBe('running');

    await expect(runtime.steerActiveTurn()).rejects.toThrow('provider unavailable');

    steerRejection = 'turn finished';
    await expect(runtime.steerActiveTurn()).resolves.toBe(false);
    await capture;
  });

  it('releases only its scoped turn subscriber and preserves the connection observer', async () => {
    const runtime = new CodexAppServerThreadRuntime();
    const client = new FakeClient();
    const permanent = vi.fn();
    runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof }, permanent);
    client.request.mockImplementation(async (method: string) => {
      if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
      client.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
      client.emit('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      });
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    });

    await runtime.captureTurn(captureOptions());
    expect(client.subscribers.size).toBe(1);

    client.emit('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' });
    expect(permanent).toHaveBeenCalledTimes(3);
  });

  it('emits exactly one heartbeat for each provider notification, including reasoning', async () => {
    const runtime = new CodexAppServerThreadRuntime();
    const client = new FakeClient();
    runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });
    const options = captureOptions();
    client.request.mockImplementation(async (method: string) => {
      if (method !== 'turn/start') throw new Error(`unexpected method ${method}`);
      client.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
      client.emit('item/reasoning/summaryTextDelta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        delta: 'still reasoning',
      });
      client.emit('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      });
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    });

    await runtime.captureTurn(options);

    expect(options.onHeartbeat).toHaveBeenCalledTimes(3);
  });

  it('closes the owned client and connection observer exactly once', async () => {
    const runtime = new CodexAppServerThreadRuntime();
    const client = new FakeClient();
    runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });

    await runtime.close();
    await runtime.close();

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.subscribers.size).toBe(0);
    expect(runtime.getSnapshot()).toMatchObject({
      connectionPhase: 'closed',
      nativeThreadId: null,
      turnPhase: 'idle',
    });
  });

  // xqs4fg7sl: Codex's goal extension starts a turn 10-35 ms after a Compact
  // turn ends. Harness's empty developer `turn/start` then lands on that turn as
  // a steer and Codex rejects it with EmptyInput.
  describe('turns Codex starts by itself', () => {
    const emptyInput = new Error('failed to submit turn input: EmptyInput');

    function developerOnly() {
      return { ...captureOptions(), input: [] as UserInput[], developerInput: 'Continue the task.' };
    }

    it('follows the goal turn when an empty developer turn/start is rejected as a steer', async () => {
      const runtime = new CodexAppServerThreadRuntime();
      const client = new FakeClient();
      runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });
      client.request.mockImplementation(async (method: string) => {
        if (method === 'thread/inject_items') {
          client.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });
          return {};
        }
        if (method === 'turn/start') throw emptyInput;
        throw new Error(`unexpected method ${method}`);
      });

      const capture = runtime.captureTurn(developerOnly());
      await vi.waitFor(() => expect(runtime.getCurrentTurnId()).toBe('goal-turn'));
      client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'completed' } });

      await expect(capture).resolves.toMatchObject({ turnId: 'goal-turn', completed: true });
      expect(runtime.hasActiveTurn()).toBe(false);
    });

    it('finds the running turn when its turn/started was missed', async () => {
      const runtime = new CodexAppServerThreadRuntime();
      const client = new FakeClient();
      runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });
      client.request.mockImplementation(async (method: string) => {
        if (method === 'thread/inject_items') return {};
        if (method === 'turn/start') throw emptyInput;
        if (method === 'thread/turns/list') return { data: [{ id: 'goal-turn', status: 'inProgress' }], nextCursor: null, backwardsCursor: null };
        throw new Error(`unexpected method ${method}`);
      });

      const capture = runtime.captureTurn(developerOnly());
      await vi.waitFor(() => expect(runtime.getCurrentTurnId()).toBe('goal-turn'));
      client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'completed' } });

      await expect(capture).resolves.toMatchObject({ turnId: 'goal-turn' });
      expect(client.request).toHaveBeenCalledWith('thread/turns/list', { threadId: 'thread-1', limit: 1, sortDirection: 'desc' });
    });

    it('still rejects EmptyInput for user input or when no turn is running', async () => {
      const runtime = new CodexAppServerThreadRuntime();
      const client = new FakeClient();
      runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });
      client.request.mockImplementation(async (method: string) => {
        if (method === 'thread/inject_items') return {};
        if (method === 'turn/start') throw emptyInput;
        if (method === 'thread/turns/list') return { data: [{ id: 'old', status: 'completed' }], nextCursor: null, backwardsCursor: null };
        throw new Error(`unexpected method ${method}`);
      });

      await expect(runtime.captureTurn(captureOptions())).rejects.toThrow('EmptyInput');
      await expect(runtime.captureTurn(developerOnly())).rejects.toThrow('EmptyInput');
      expect(runtime.hasActiveTurn()).toBe(false);
    });

    it('captures a provider-started turn until it completes, then frees the slot', async () => {
      const runtime = new CodexAppServerThreadRuntime();
      const client = new FakeClient();
      runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });
      const handled: string[] = [];
      const options = {
        ...captureOptions(),
        handleNotification: (state: TurnCaptureState, notification: AppServerNotification) => {
          handled.push(notification.method);
          captureOptions().handleNotification(state, notification);
        },
      };
      const started = { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'goal-turn' } } } as AppServerNotification;

      const capture = runtime.captureProviderTurn('goal-turn', options, started);
      expect(capture).not.toBeNull();
      expect(runtime.getActiveTurnOrigin()).toBe('provider');
      expect(runtime.getSnapshot()).toMatchObject({ activeTurnId: 'goal-turn', turnPhase: 'running' });
      expect(runtime.captureProviderTurn('other', options)).toBeNull();
      await expect(runtime.captureTurn(captureOptions())).rejects.toThrow('already has an active turn');

      client.emit('item/completed', { threadId: 'thread-1', turnId: 'goal-turn', item: { type: 'agentMessage', text: 'working' } });
      client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'completed' } });

      await expect(capture).resolves.toMatchObject({ turnId: 'goal-turn', completed: true });
      expect(handled).toEqual(['turn/started', 'item/completed', 'turn/completed']);
      expect(runtime.hasActiveTurn()).toBe(false);
      expect(runtime.getActiveTurnOrigin()).toBeNull();
      expect(client.request).not.toHaveBeenCalled();
    });

    it('steers Harness input into a provider turn, never into a Harness turn', async () => {
      const runtime = new CodexAppServerThreadRuntime();
      const client = new FakeClient();
      runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });
      const input = [{ type: 'text', text: 'also check the tests', text_elements: [] }] as UserInput[];

      const capture = runtime.captureProviderTurn('goal-turn', captureOptions())!;
      await expect(runtime.steerProviderTurn(input, 'Harness note'))
        .resolves.toEqual({ delivered: true, developerInjected: true });
      expect(client.request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ['thread/inject_items', { threadId: 'thread-1', items: [expect.objectContaining({ role: 'developer' })] }],
        ['turn/steer', { threadId: 'thread-1', expectedTurnId: 'goal-turn', input }],
      ]);

      client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'completed' } });
      await capture;
      await expect(runtime.steerProviderTurn(input)).resolves.toEqual({ delivered: false, developerInjected: false });
    });

    it('reports a developer item already injected when the turn ends before the steer', async () => {
      const runtime = new CodexAppServerThreadRuntime();
      const client = new FakeClient();
      runtime.attach(client, { threadId: 'thread-1', resumeCursor: cursor, resumeProof });
      const input = [{ type: 'text', text: 'attachment note', text_elements: [] }] as UserInput[];
      client.request.mockImplementation(async (method: string) => {
        if (method === 'thread/inject_items') {
          client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'completed' } });
          return {};
        }
        if (method === 'turn/steer') throw new Error('no active turn to steer');
        throw new Error(`unexpected method ${method}`);
      });

      const capture = runtime.captureProviderTurn('goal-turn', captureOptions())!;
      await expect(runtime.steerProviderTurn(input, 'Harness note'))
        .resolves.toEqual({ delivered: false, developerInjected: true });
      await capture;
    });
  });
});


describe('Codex native content acknowledgment', () => {
  function attached() {
    const runtime = new CodexAppServerThreadRuntime();
    const client = new FakeClient();
    runtime.attach(client, { threadId: 'thread-1', resumeCursor: null, resumeProof: null });
    return { runtime, client };
  }

  it.each(['immediate', 'deferred'] as const)('accepts %s start acknowledgment once without serializing the callback', async mode => {
    const { runtime, client } = attached();
    const accepted = vi.fn();
    let acknowledge!: () => void;
    const gate = new Promise<void>(resolve => { acknowledge = resolve; });
    client.request.mockImplementation(async () => {
      if (mode === 'deferred') await gate;
      return { turn: { id: 'turn-1', status: 'completed' } };
    });
    const capture = runtime.captureTurn({ ...captureOptions(), onInputAccepted: accepted });
    if (mode === 'deferred') {
      expect(accepted).not.toHaveBeenCalled();
      acknowledge();
    }
    await capture;
    expect(accepted).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1', input: [{ type: 'text', text: 'hello', text_elements: [] }],
    });
    await runtime.close();
  });

  it('does not accept rejected native start content', async () => {
    const { runtime, client } = attached();
    const accepted = vi.fn();
    client.request.mockRejectedValue(new Error('native rejected'));
    await expect(runtime.captureTurn({ ...captureOptions(), onInputAccepted: accepted })).rejects.toThrow('native rejected');
    expect(accepted).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('observes late start acknowledgment after closing wins the capture race', async () => {
    const { runtime, client } = attached();
    const accepted = vi.fn();
    let acknowledge!: () => void;
    const gate = new Promise<void>(resolve => { acknowledge = resolve; });
    client.request.mockImplementation(async () => {
      await gate;
      return { turn: { id: 'turn-1', status: 'completed' } };
    });
    const capture = runtime.captureTurn({ ...captureOptions(), onInputAccepted: accepted });
    const rejected = expect(capture).rejects.toThrow('runtime closed');
    await runtime.close();
    await rejected;
    expect(accepted).not.toHaveBeenCalled();
    acknowledge();
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  });

  it.each(['assertion-abort', 'start-rejection'] as const)('retains acknowledged developer history after %s', async mode => {
    const { runtime, client } = attached();
    const accepted = vi.fn();
    const assertInputCurrent = vi.fn(() => {
      if (mode === 'assertion-abort' && accepted.mock.calls.length > 0) throw new Error('input aborted');
    });
    client.request.mockImplementation(async method => {
      if (method === 'turn/start') throw new Error('start rejected');
      return {};
    });
    await expect(runtime.captureTurn({ ...captureOptions(), input: [], developerInput: 'instructions',
      onInputAccepted: accepted, assertInputCurrent,
    })).rejects.toThrow(mode === 'assertion-abort' ? 'input aborted' : 'start rejected');
    expect(accepted).toHaveBeenCalledOnce();
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(
      mode === 'assertion-abort' ? ['thread/inject_items'] : ['thread/inject_items', 'turn/start']);
    await runtime.close();
  });

  it('retains acknowledged developer history when user steering is rejected', async () => {
    const { runtime, client } = attached();
    const accepted = vi.fn();
    const capture = runtime.captureProviderTurn('native-turn', captureOptions())!;
    client.request.mockImplementation(async method => {
      if (method === 'turn/steer') throw new Error('steer rejected');
      return {};
    });
    await expect(runtime.steerProviderTurn(captureOptions().input, 'instructions', undefined, accepted)).rejects.toThrow('steer rejected');
    expect(accepted).toHaveBeenCalledOnce();
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(['thread/inject_items', 'turn/steer']);
    client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'completed' } });
    await capture;
    await runtime.close();
  });

  it('accepts successful user steering into a native turn', async () => {
    const { runtime, client } = attached();
    const accepted = vi.fn();
    const capture = runtime.captureProviderTurn('native-turn', captureOptions())!;
    await expect(runtime.steerProviderTurn(captureOptions().input, undefined, undefined, accepted))
      .resolves.toEqual({ delivered: true, developerInjected: false });
    expect(accepted).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thread-1', expectedTurnId: 'native-turn', input: captureOptions().input,
    });
    client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'native-turn', status: 'completed' } });
    await capture;
    await runtime.close();
  });
});
