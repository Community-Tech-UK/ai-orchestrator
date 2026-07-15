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
  createCodexTurnCaptureState,
} from './app-server-thread-runtime';

class FakeClient {
  readonly subscribers = new Set<(notification: AppServerNotification) => void>();
  readonly exitPromise = new Promise<void>(() => {});
  readonly request = vi.fn(async <M extends AppServerMethod>(
    _method: M,
    _params: AppServerRequestParams<M>,
  ): Promise<AppServerResponseResult<M>> => ({} as AppServerResponseResult<M>));
  readonly close = vi.fn(async () => {});

  subscribeNotifications(handler: (notification: AppServerNotification) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  emit(method: AppServerNotification['method'], params: Record<string, unknown>): void {
    for (const subscriber of [...this.subscribers]) subscriber({ method, params });
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
});
