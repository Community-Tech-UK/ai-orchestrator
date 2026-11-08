import { describe, expect, it, vi } from 'vitest';

vi.mock('./codex/app-server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex/app-server-client')>();
  return { ...actual, terminateProcessTree: vi.fn() };
});

import { CodexCliAdapter } from './codex-cli-adapter';
import type { CliResponse } from './base-cli-adapter';
import { observeAdapterRuntimeEvents, type NormalizedAdapterRuntimeEvent } from '../../providers/adapter-runtime-event-bridge';
import { EventEmitter } from 'events';
import type { Instance } from '../../../shared/types/instance.types';
import type { CliAdapter } from './adapter-factory';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { bindRawAdapterProviderEvents } from '../../instance/instance-communication-provider-events';
import { enrichProviderTurnEndingIngress } from '../../instance/provider-turn-ending-ingress';
import { InstanceReasoningCollapseContinuation } from '../../instance/instance-reasoning-collapse-continuation';
import { InstanceAsyncWorkRegistry } from '../../instance/instance-async-work-registry';
import { getInstanceTurnEnding } from '../../instance/instance-turn-ending-state';
import { HibernationManager } from '../../process/hibernation-manager';
import { dispatchInstanceLifecycleHook } from '../../instance/instance-lifecycle-hooks';
import type { HookManager } from '../../hooks/hook-manager';
import { getLogger } from '../../logging/logger';

vi.setConfig({ testTimeout: 15_000 });

interface Notification { method: string; params: Record<string, unknown> }
type RpcHandler = (method: string, params: Record<string, unknown>) => unknown;

interface Harness {
  adapter: CodexCliAdapter;
  emit(method: string, params: Record<string, unknown>): void;
  requests: [string, Record<string, unknown>][];
  outputs: { id?: string; timestamp?: number; type: string; content: string; metadata?: Record<string, unknown> }[];
  statuses: string[];
  completions: string[];
  hasActiveTurn(): boolean;
  activeTurnOrigin(): string | null;
  currentTurnId(): string | null;
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
      getCurrentTurnId(): string | null;
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
    emit: (method, params) => {
      // Snapshot: a subscriber may unsubscribe while we emit.
      for (const subscriber of Array.from(subscribers)) subscriber({ method, params });
    },
    requests,
    outputs,
    statuses,
    completions,
    hasActiveTurn: () => internals.appServerRuntime.hasActiveTurn(),
    activeTurnOrigin: () => internals.appServerRuntime.getActiveTurnOrigin(),
    currentTurnId: () => internals.appServerRuntime.getCurrentTurnId(),
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
  it('logs a current-thread goal update with status and no objective', async () => {
    const h = createHarness(() => ({}));
    const info = vi.spyOn(getLogger('CodexCliAdapter'), 'info');
    try {
      h.emit('thread/goal/updated', { threadId: 'thread-1', goal: { status: 'active', objective: 'Private goal text' } });
      const logs = info.mock.calls.filter(([message]) => message === 'Codex thread goal changed');
      expect(logs).toEqual([['Codex thread goal changed', { status: 'active' }]]);
      h.emit('thread/goal/updated', { threadId: 'other', goal: { status: 'active' } });
      expect(info.mock.calls.filter(([message]) => message === 'Codex thread goal changed')).toHaveLength(1);
      h.emit('thread/goal/updated', { threadId: 'thread-1', goal: { status: { objective: 'Private goal text' } } });
      expect(info.mock.calls.filter(([message]) => message === 'Codex thread goal changed').at(-1)).toEqual(['Codex thread goal changed', { status: 'unknown' }]);
    } finally { info.mockRestore(); await h.adapter.terminate(false); }
  });
  it.each([
    ['ContentFilterError', undefined, 'content_filter'],
    ['Quota exceeded', 429, 'quota'],
    ['Unauthorized', 401, 'auth'],
    ['Context window exceeded', undefined, 'context_overflow'],
    ['Temporarily unavailable', 503, 'retryable'],
  ])('classifies final exec fallback failure %s before idle through both ingress paths', async (message, statusCode, reason) => {
    const adapter = new CodexCliAdapter();
    Object.assign(adapter, { isSpawned: true, useAppServer: false });
    expect(adapter.listenerCount('error')).toBe(0);
    const failure = Object.assign(new Error(message), { statusCode });
    vi.spyOn(adapter, 'sendMessage').mockRejectedValue(failure);
    const observed: NormalizedAdapterRuntimeEvent[] = [];
    const unobserve = observeAdapterRuntimeEvents(adapter, (event) => observed.push(event));
    const interactive: ProviderRuntimeEventEnvelope['event'][] = [];
    const instance = { id: `exec-error-${reason}`, adapterGeneration: 1, provider: 'codex' } as Instance;
    bindRawAdapterProviderEvents({ adapter: adapter as CliAdapter, isStale: () => false,
      emit: (event, options) => interactive.push(enrichProviderTurnEndingIngress(instance, event, options.raw.payload)),
    });
    try {
      await expect(adapter.sendInput('Read the entry.')).rejects.toBe(failure);
      const terminal = observed.filter(({ event }) => event.kind === 'error' || event.kind === 'complete');
      expect(terminal).toEqual([expect.objectContaining({ event: expect.objectContaining({
        kind: 'error', turnEnding: expect.objectContaining({ reason }),
      }) })]);
      expect(interactive).toEqual([expect.objectContaining({ turnEnding: expect.objectContaining({ reason }) })]);
      expect(observed.at(-1)?.event).toMatchObject({ kind: 'status', status: 'idle' });
      expect(observed.indexOf(terminal[0])).toBeLessThan(observed.length - 1);
    } finally { unobserve(); await adapter.terminate(false); }
  });

  it.each([
    ['usageLimitExceeded', 'quota'], ['rateLimitExceeded', 'quota'], ['unauthorized', 'auth'],
    ['contextWindowExceeded', 'context_overflow'], ['serverOverloaded', 'retryable'],
    ['internalServerError', 'retryable'], ['cyberPolicy', 'content_filter'],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 503 } }, 'retryable'],
  ])('preserves native %s classification through headless and interactive terminal ingress', async (codexErrorInfo, reason) => {
    const h = createHarness(() => ({}));
    const normalized: NormalizedAdapterRuntimeEvent[] = [];
    const unobserve = observeAdapterRuntimeEvents(h.adapter, (event) => normalized.push(event));
    const interactive: ProviderRuntimeEventEnvelope['event'][] = [];
    const instance = { id: 'native-error-codes', adapterGeneration: 1, provider: 'codex' } as Instance;
    bindRawAdapterProviderEvents({ adapter: h.adapter as CliAdapter, isStale: () => false,
      emit: (event, options) => interactive.push(enrichProviderTurnEndingIngress(instance, event, options.raw.payload)),
    });
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });
    h.emit('turn/completed', { threadId: 'thread-1', turn: {
      id: 'goal-turn', status: 'failed', error: { message: 'Provider rejected the request.', codexErrorInfo },
    } });
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(normalized.filter(({ event }) => event.kind === 'error').map(({ event }) => event)).toEqual([
      expect.objectContaining({ turnEnding: expect.objectContaining({ reason }) }),
    ]);
    expect(interactive).toEqual([expect.objectContaining({ turnEnding: expect.objectContaining({ reason }) })]);
    unobserve();
    await h.adapter.terminate(false);
  });

  it('keeps native retries nonterminal then records terminal overflow before idle and suppresses hooks/hibernation', async () => {
    const h = createHarness(() => ({ goal: { status: 'active' } }));
    const instance = { id: 'native-overflow', adapterGeneration: 1, provider: 'codex', status: 'idle',
      parentId: null, launchMode: 'orchestrated', requestCount: 1, outputBuffer: [], lastActivity: 0 } as unknown as Instance;
    const events = new EventEmitter();
    const observed: ProviderRuntimeEventEnvelope['event'][] = [];
    const notices = vi.fn();
    const sendInput = vi.fn(async () => undefined);
    const continuation = new InstanceReasoningCollapseContinuation(new InstanceAsyncWorkRegistry(), {
      on: events.on.bind(events), off: events.off.bind(events), getInstance: () => instance,
      getAdapter: () => h.adapter, emitSystemMessage: notices, sendInput,
      waitForInstanceSettled: async () => instance,
    });
    continuation.start();
    const publish = (event: ProviderRuntimeEventEnvelope['event'], payload?: unknown) => {
      const enriched = enrichProviderTurnEndingIngress(instance, event, payload);
      observed.push(enriched);
      events.emit('provider:normalized-event', { instanceId: instance.id, event: enriched, raw: { payload } });
    };
    bindRawAdapterProviderEvents({ adapter: h.adapter as CliAdapter, isStale: () => false,
      emit: (event, options) => publish(event, options.raw.payload),
    });
    h.adapter.on('output', (output) => publish({ kind: 'output', content: output.content, messageType: output.type, metadata: output.metadata }, output));
    h.adapter.on('status', (status) => {
      instance.status = status;
      publish({ kind: 'status', status });
      if (status === 'idle') expect(getInstanceTurnEnding(instance.id)).toBe('context_overflow');
    });
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });
    h.emit('error', { threadId: 'thread-1', turnId: 'goal-turn', error: { message: 'native retry pending' }, willRetry: true });
    expect(getInstanceTurnEnding(instance.id)).toBeUndefined();
    expect(observed.filter((event) => event.kind === 'error')).toEqual([]);
    h.emit('error', { threadId: 'thread-1', turnId: 'goal-turn', error: {
      message: 'Provider rejected the request.', codexErrorInfo: 'contextWindowExceeded',
    }, willRetry: false });
    h.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'failed' } });
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(observed.filter((event) => event.kind === 'error')).toEqual([
      expect.objectContaining({ turnEnding: { reason: 'context_overflow', evidence: 'provider_context_error' } }),
    ]);
    expect(notices).toHaveBeenCalledTimes(1);
    expect(sendInput).not.toHaveBeenCalled();
    expect(new HibernationManager({ idleThresholdMs: 1 }).getHibernationCandidates([instance])).toEqual([]);
    const triggerLifecycleHooks = vi.fn(async () => undefined);
    for (const hook of ['PostSampling', 'Stop'] as const) dispatchInstanceLifecycleHook(hook, instance, {}, getLogger('CodexIngressTest'), { triggerLifecycleHooks } as unknown as HookManager);
    expect(triggerLifecycleHooks).not.toHaveBeenCalled();
    continuation.stop();
    await h.adapter.terminate(false);
  });

  it('publishes a classified failed goal before idle without an infrastructure error or completion', async () => {
    const h = createHarness(() => ({ goal: { status: 'active' } }));
    const events: NormalizedAdapterRuntimeEvent[] = [];
    const unobserve = observeAdapterRuntimeEvents(h.adapter, (event) => events.push(event));
    const infrastructureError = vi.fn();
    h.adapter.on('error', infrastructureError);
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });
    h.emit('turn/completed', { threadId: 'thread-1', turn: {
      id: 'goal-turn', status: 'failed', error: { message: 'ContentFilterError' },
    } });
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    const endings = events.filter((event) => event.kind === 'error' || event.kind === 'complete');
    expect(endings).toHaveLength(1);
    expect(endings[0].event).toMatchObject({ kind: 'error', turnEnding: { reason: 'content_filter' } });
    expect(events.indexOf(endings[0])).toBeLessThan(events.findIndex(({ event }) => event.kind === 'status' && event.status === 'idle'));
    expect(infrastructureError).not.toHaveBeenCalled();
    expect(h.completions).toEqual([]);
    await expect(h.adapter.hasProviderAutoContinuation()).resolves.toBe(true);
    unobserve();
    await h.adapter.terminate(false);
  });

  it('publishes a failed user send once before status settlement while preserving its rejection', async () => {
    const h = createHarness((method) => method === 'turn/start' ? { turn: {
      id: 'user-turn', status: 'failed', error: { message: 'ContentFilterError' },
    } } : {});
    const events: NormalizedAdapterRuntimeEvent[] = [];
    const unobserve = observeAdapterRuntimeEvents(h.adapter, (event) => events.push(event));
    await expect(h.adapter.sendInput('Read the entry.')).rejects.toThrow('ContentFilterError');
    const endings = events.filter((event) => event.kind === 'error' || event.kind === 'complete');
    expect(endings).toHaveLength(1);
    expect(endings[0].event).toMatchObject({ kind: 'error', turnEnding: { reason: 'content_filter' } });
    expect(events.indexOf(endings[0])).toBeLessThan(events.length - 1);
    expect(h.outputs.filter((output) => output.type === 'error')).toHaveLength(1);
    expect(h.completions).toEqual([]);
    unobserve();
    await h.adapter.terminate(false);
  });

  it.each([
    ['usageLimitExceeded', 'quota'], ['unauthorized', 'auth'],
    ['contextWindowExceeded', 'context_overflow'], ['serverOverloaded', 'retryable'],
  ])('records user-owned %s once without an EventEmitter error listener', async (codexErrorInfo, reason) => {
    const h = createHarness((method) => method === 'turn/start' ? { turn: {
      id: 'user-turn', status: 'failed', error: { message: 'Provider rejected the request.', codexErrorInfo },
    } } : {});
    const instance = { id: 'user-error-codes', adapterGeneration: 1, provider: 'codex' } as Instance;
    const terminal: ProviderRuntimeEventEnvelope['event'][] = [];
    bindRawAdapterProviderEvents({ adapter: h.adapter as CliAdapter, isStale: () => false,
      emit: (event, options) => terminal.push(enrichProviderTurnEndingIngress(instance, event, options.raw.payload)),
    });
    expect(h.adapter.listenerCount('error')).toBe(0);
    await expect(h.adapter.sendInput('Continue reading.')).rejects.toThrow('Provider rejected the request.');
    expect(terminal).toEqual([expect.objectContaining({ turnEnding: expect.objectContaining({ reason }) })]);
    expect(h.outputs.filter((output) => output.type === 'error')).toHaveLength(1);
    expect(h.completions).toEqual([]);
    await h.adapter.terminate(false);
  });

  it('detaches terminal observation with the other runtime listeners', () => {
    const h = createHarness(() => ({}));
    const observed = vi.fn();
    const unobserve = observeAdapterRuntimeEvents(h.adapter, observed);
    unobserve();
    h.adapter.emit('turn_error', new Error('Fixture terminal error'));
    expect(observed).not.toHaveBeenCalled();
    expect(h.adapter.listenerCount('turn_error')).toBe(0);
  });

  it('reports native continuation ownership for active goals', async () => {
    const h = createHarness(() => ({ goal: { status: 'active' } }));
    await expect(h.adapter.hasProviderAutoContinuation()).resolves.toBe(true);
    expect(h.requests.map(([method]) => method)).toEqual(['thread/goal/get']);
  });

  it('rechecks newly active native goals synchronously without another RPC', async () => {
    const h = createHarness(() => ({ goal: null }));
    await expect(h.adapter.hasProviderAutoContinuation()).resolves.toBe(false);
    expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(false);
    h.emit('thread/goal/updated', { threadId: 'thread-1', goal: { threadId: 'thread-1', objective: 'fixture', status: 'active' } });
    expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(true);
    h.emit('thread/goal/updated', { threadId: 'thread-1', goal: { threadId: 'thread-1', objective: 'fixture', status: 'paused' } });
    expect(h.adapter.hasPendingProviderAutoContinuation()).toBe(false);
    expect(h.requests.map(([method]) => method)).toEqual(['thread/goal/get']);
  });

  it('fails closed when native continuation ownership cannot be read', async () => {
    const h = createHarness(() => { throw new Error('goal query unavailable'); });
    await expect(h.adapter.hasProviderAutoContinuation()).resolves.toBe(true);
  });

  it('allows Harness recovery when a goal is explicitly inactive', async () => {
    const h = createHarness(() => ({ goal: null }));
    await expect(h.adapter.hasProviderAutoContinuation()).resolves.toBe(false);
  });

  it('fails closed for malformed native goal responses', async () => {
    const h = createHarness(() => ({}));
    await expect(h.adapter.hasProviderAutoContinuation()).resolves.toBe(true);
  });

  it('retains native ownership while a provider turn is retrying', async () => {
    const h = createHarness(() => ({ goal: null }));
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'retry-turn', status: 'inProgress' } });
    h.emit('error', { threadId: 'thread-1', turnId: 'retry-turn', error: { message: 'provider retry pending' }, willRetry: true });
    expect(h.outputs.at(-1)).toMatchObject({ type: 'system', metadata: { willRetry: true } });
    expect(JSON.stringify(h.outputs)).not.toContain('provider retry pending');
    await expect(h.adapter.hasProviderAutoContinuation()).resolves.toBe(true);
    expect(h.requests).toEqual([]);
    await h.adapter.terminate(false);
  });

  // 2026-10-13: these notices were archived without id or time, which made
  // History stop counting the whole conversation as saved.
  it('gives both native-retry notices an id and a time', async () => {
    const h = createHarness(() => ({ goal: null }));
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'retry-turn', status: 'inProgress' } });
    h.emit('error', { threadId: 'thread-1', turnId: 'retry-turn', error: { message: 'pending' }, willRetry: true });
    h.emit('error', { threadId: 'thread-1', turnId: 'retry-turn', error: { message: 'gave up' }, willRetry: false });

    const notices = h.outputs.filter((output) => output.metadata?.['source'] === 'codex-native-retry');
    expect(notices.map((notice) => notice.metadata?.['willRetry'])).toEqual([true, false]);
    for (const notice of notices) {
      expect(notice.id).toEqual(expect.any(String));
      expect(Number.isFinite(notice.timestamp)).toBe(true);
    }
    expect(notices[0]!.id).not.toBe(notices[1]!.id);
    await h.adapter.terminate(false);
  });

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

  it('stops the send loop when a queued native turn cannot be followed, instead of spinning', async () => {
    const h = createHarness(() => ({}));
    const internals = h.adapter as unknown as {
      appServerRuntime: { hasActiveTurn(): boolean };
      pendingProviderNotifications: Notification[];
      followPendingProviderTurn(): boolean;
      joinProviderTurn(): Promise<{ joined: boolean; developerInjected: boolean }>;
    };
    // A non-provider turn holds the runtime while a native notification waits behind it.
    let runtimeBusy = false;
    vi.spyOn(internals.appServerRuntime, 'hasActiveTurn').mockImplementation(() => runtimeBusy);
    const follow = internals.followPendingProviderTurn.bind(h.adapter);
    vi.spyOn(internals, 'followPendingProviderTurn').mockImplementation(() => {
      runtimeBusy = true;
      return follow();
    });
    internals.pendingProviderNotifications.push({
      method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'native', status: 'inProgress' } },
    });
    let joins = 0;
    const join = vi.spyOn(internals, 'joinProviderTurn').mockImplementation(async () => {
      // Bounded so a regression fails this test instead of blocking the worker's event loop.
      if (++joins > 3) throw new Error('send loop kept spinning');
      return { joined: false, developerInjected: false };
    });

    await expect(h.adapter.sendInput('Continue.')).rejects.toThrow('already has an active turn');
    expect(join).not.toHaveBeenCalled();
    await h.adapter.terminate(false);
  });

  it('keeps a steered provider turn open after an early final answer', async () => {
    const h = createHarness((method) => (method === 'turn/steer' ? { turnId: 'goal-turn' } : {}));
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });
    h.emit(...finalAnswer('goal-turn', 'First paragraph.'));

    const send = (h.adapter as unknown as {
      sendInputImpl(message: string): Promise<void>;
    }).sendInputImpl('JOINED');
    await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toContain('turn/steer'));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(h.statuses).not.toContain('idle');
    h.emit('item/completed', {
      threadId: 'thread-1',
      turnId: 'goal-turn',
      item: { id: 'goal-turn-joined', type: 'agentMessage', phase: 'final_answer', text: 'MIDJOIN the peregrine falcon' },
    });
    h.emit(...turnCompleted('goal-turn'));

    await expect(send).resolves.toBeUndefined();
    expect(h.statuses.filter((status) => status === 'idle')).toEqual(['idle']);
    expect(h.outputs.some((output) => output.content.includes('MIDJOIN the peregrine falcon'))).toBe(true);
    await h.adapter.terminate(false);
  });

  it('follows a goal turn that starts before the previous capture has torn down', async () => {
    const h = createHarness(() => ({}));
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-1', status: 'inProgress' } });
    h.emit(...finalAnswer('goal-1', 'First animal.'));
    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-2', status: 'inProgress' } });
    h.emit(...turnCompleted('goal-1'));
    await vi.waitFor(() => expect(h.completions).toContain('First animal.'));
    expect(h.hasActiveTurn()).toBe(true);
    expect(h.statuses).not.toContain('idle');

    h.emit(...finalAnswer('goal-2', 'Second animal.'));
    h.emit(...turnCompleted('goal-2'));
    await vi.waitFor(() => expect(h.completions).toContain('Second animal.'));
    const idleAt = h.statuses.indexOf('idle');
    const secondBusy = h.statuses.lastIndexOf('busy');
    expect(idleAt).toBeGreaterThan(secondBusy);
    await h.adapter.terminate(false);
  });

  it.each(['notification-first', 'response-first'] as const)(
    'keeps following native turns after a Harness start and joined input (%s)', async (order) => {
      const h = createHarness((method) => {
        if (method === 'turn/start') {
          if (order === 'notification-first') {
            h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'initial', status: 'inProgress' } });
          }
          return { turn: { id: 'initial', status: 'inProgress' } };
        }
        return {};
      });
      try {
        const initial = h.adapter.sendInput('Create a multi-turn goal.');
        await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toContain('turn/start'));
        if (order === 'response-first') {
          h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'initial', status: 'inProgress' } });
        }
        h.emit(...finalAnswer('initial', 'Initial reply.'));
        h.emit(...turnCompleted('initial'));
        await initial;
        expect(h.hasActiveTurn()).toBe(false);

        for (let index = 1; index <= 4; index++) {
          const id = `native-${index}`;
          h.emit('turn/started', { threadId: 'thread-1', turn: { id, status: 'inProgress' } });
          expect(h.activeTurnOrigin()).toBe('provider');
          expect(h.statuses.at(-1)).toBe('busy');
          const joined = index === 1 ? h.adapter.sendInput('JOINED') : undefined;
          if (joined) {
            await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toContain('turn/steer'));
            h.emit(...finalAnswer(id, 'Early reply before joined input.'));
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(h.hasActiveTurn()).toBe(true);
            expect(h.statuses.at(-1)).toBe('busy');
          }
          h.emit(...finalAnswer(id, `Native reply ${index}.`));
          h.emit(...turnCompleted(id));
          if (joined) await joined;
          await vi.waitFor(() => expect(h.completions).toContain(`Native reply ${index}.`));
          await vi.waitFor(() => expect(h.hasActiveTurn()).toBe(false));
        }
        expect(h.completions).toEqual(['Initial reply.', 'Native reply 1.', 'Native reply 2.', 'Native reply 3.', 'Native reply 4.']);
        expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
        expect(h.requests.filter(([method]) => method === 'turn/start')).toHaveLength(1);
      } finally { await h.adapter.terminate(false); }
    },
  );

  it('follows a native turn arriving during Harness capture teardown without reporting idle', async () => {
    const h = createHarness((method) => method === 'turn/start'
      ? { turn: { id: 'initial', status: 'inProgress' } } : {});
    try {
      const initial = h.adapter.sendInput('Create a goal.');
      await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toContain('turn/start'));
      h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'initial', status: 'inProgress' } });
      h.emit(...finalAnswer('initial', 'Initial reply.'));
      h.emit(...turnCompleted('initial'));
      h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'native', status: 'inProgress' } });
      await initial;
      expect(h.activeTurnOrigin()).toBe('provider');
      expect(h.statuses).not.toContain('idle');
      h.emit(...finalAnswer('native', 'Native reply.'));
      h.emit(...turnCompleted('native'));
      await vi.waitFor(() => expect(h.completions).toEqual(['Initial reply.', 'Native reply.']));
      await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    } finally { await h.adapter.terminate(false); }
  });

  it.each(['provider', 'harness'] as const)('retains complete batched native turns after a %s turn', async (origin) => {
    const h = createHarness((method) => method === 'turn/start'
      ? { turn: { id: 'initial', status: 'inProgress' } } : {});
    const order: string[] = [];
    const responses: CliResponse[] = [];
    h.adapter.on('complete', (response: CliResponse) => { order.push(response.content); responses.push(response); });
    h.adapter.on('status', (status) => { if (status === 'idle') order.push('idle'); });
    try {
      const send = origin === 'harness' ? h.adapter.sendInput('Create a goal.') : undefined;
      if (send) await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toContain('turn/start'));
      for (const id of ['initial', 'native-1', 'native-2', 'native-3']) {
        // No yield: the transport parser can deliver this entire sequence in one chunk.
        h.emit('turn/started', { threadId: 'thread-1', turn: { id, status: 'inProgress' } });
        h.emit('item/completed', { threadId: 'foreign-thread', turnId: 'foreign-turn',
          item: { id: 'foreign-answer', type: 'agentMessage', phase: 'final_answer', text: 'Foreign reply.' } });
        h.emit('item/completed', { threadId: 'thread-1', turnId: id, item: {
          id: `${id}-command`, type: 'commandExecution', command: 'fixture-command',
          status: 'completed', aggregatedOutput: `Result ${id}.`, exitCode: 0,
        } });
        h.emit(...finalAnswer(id, `Reply ${id}.`));
        h.emit('turn/completed', { threadId: 'thread-1', turn: {
          id, status: 'completed', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        } });
      }
      if (send) await send;
      await vi.waitFor(() => expect(h.completions).toEqual([
        'Reply initial.', 'Reply native-1.', 'Reply native-2.', 'Reply native-3.',
      ]));
      await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
      expect(order).toEqual([...h.completions, 'idle']);
      expect(h.outputs.filter((output) => output.type === 'assistant').map((output) => output.content))
        .toEqual(h.completions);
      expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
      expect(h.hasActiveTurn()).toBe(false);
      expect(responses.map((response) => response.toolCalls?.map((tool) => tool.result))).toEqual([
        ['Result initial.'], ['Result native-1.'], ['Result native-2.'], ['Result native-3.'],
      ]);
      expect(responses.map((response) => [response.usage?.inputTokens, response.usage?.outputTokens]))
        .toEqual([[100, 10], [100, 10], [100, 10], [100, 10]]);
      expect(h.requests.filter(([method]) => method === 'turn/start')).toHaveLength(origin === 'harness' ? 1 : 0);
    } finally { await h.adapter.terminate(false); }
  });

  it.each(['provider', 'harness'] as const)('serializes replies and usage while a %s turn is publishing', async (origin) => {
    const h = createHarness((method) => method === 'turn/start'
      ? { turn: { id: 'initial', status: 'inProgress' } } : {});
    let release!: () => void;
    let publishing = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const internals = h.adapter as unknown as {
      reconcileChildRollouts(threadId: string, turnId: string, startedAt: number, endedAt: number): Promise<void>;
      scheduleChildRolloutRetry(threadId: string, turnId: string, startedAt: number, endedAt: number): void;
    };
    const reconcile = vi.spyOn(internals, 'reconcileChildRollouts').mockImplementation(async (_threadId, turnId) => {
      if (turnId === 'initial') { publishing = true; await gate; }
    });
    const responses: CliResponse[] = [];
    h.adapter.on('complete', response => responses.push(response));
    const finish = (id: string, inputTokens: number) => {
      h.emit('turn/started', { threadId: 'thread-1', turn: { id, status: 'inProgress' } });
      if (id === 'native-1') h.emit('thread/compacted', { threadId: 'thread-1' });
      h.emit(...finalAnswer(id, `Reply ${id}.`));
      h.emit('turn/completed', { threadId: 'thread-1', turn: {
        id, status: 'completed', usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10 },
      } });
    };
    try {
      const send = origin === 'harness' ? h.adapter.sendInput('Create a goal.') : undefined;
      if (send) await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toContain('turn/start'));
      finish('initial', 100);
      await vi.waitFor(() => expect(publishing).toBe(true));
      expect(h.hasActiveTurn()).toBe(false);
      // An earlier turn's bounded rollout retry must not drain this unpublished usage.
      internals.scheduleChildRolloutRetry('thread-1', 'prior-turn', 1, 2);
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith('thread-1', 'prior-turn', 1, 2));
      finish('native-1', 200);
      // A real asynchronous publication dependency yields; the next turn must wait.
      await new Promise(resolve => setImmediate(resolve));
      expect(h.completions).toEqual([]);
      release();
      if (send) await send;
      await vi.waitFor(() => expect(h.completions).toEqual(['Reply initial.', 'Reply native-1.']));
      expect(responses.map(response => [response.usage?.inputTokens, response.usage?.outputTokens]))
        .toEqual([[100, 10], [200, 10]]);
      expect(h.outputs.filter(output => output.metadata?.['threadCompacted'] === true)).toHaveLength(1);
      const visible = h.outputs.filter(output => output.type === 'assistant' || output.metadata?.['threadCompacted'] === true);
      expect(visible.map(output => output.type)).toEqual(['assistant', 'system', 'assistant']);
      await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    } finally { release(); await h.adapter.terminate(false); vi.restoreAllMocks(); }
  });

  it.each(['provider', 'harness'] as const)('joins queued native work after a %s publication finishes', async (origin) => {
    const h = createHarness(method => method === 'turn/start'
      ? { turn: { id: 'initial', status: 'inProgress' } } : {});
    let release!: () => void;
    let publishing = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(h.adapter as unknown as {
      reconcileChildRollouts(threadId: string, turnId: string, startedAt: number, endedAt: number): Promise<void>;
    }, 'reconcileChildRollouts').mockImplementation(async (_threadId, turnId) => {
      if (turnId === 'initial') { publishing = true; await gate; }
    });
    try {
      const initialSend = origin === 'harness' ? h.adapter.sendInput('Create a goal.') : undefined;
      if (initialSend) await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toContain('turn/start'));
      h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'initial', status: 'inProgress' } });
      h.emit(...finalAnswer('initial', 'Initial reply.'));
      h.emit(...turnCompleted('initial'));
      await vi.waitFor(() => expect(publishing).toBe(true));
      h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'native-1', status: 'inProgress' } });
      const joined = h.adapter.sendInput('Join pending work.');
      release();
      if (initialSend) await initialSend;
      await vi.waitFor(() => expect(h.requests.map(([method]) => method)).toContain('turn/steer'));
      expect(h.requests.filter(([method]) => method === 'turn/start')).toHaveLength(origin === 'harness' ? 1 : 0);
      expect(h.requests.find(([method]) => method === 'turn/steer')?.[1]['expectedTurnId']).toBe('native-1');
      h.emit(...finalAnswer('native-1', 'Joined reply.'));
      h.emit(...turnCompleted('native-1'));
      await joined;
      expect(h.completions).toEqual(['Initial reply.', 'Joined reply.']);
      expect(h.outputs.filter(output => output.type === 'error')).toEqual([]);
      await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    } finally { release(); await h.adapter.terminate(false); vi.restoreAllMocks(); }
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

  it.each([true, false])('does not replay a completed Harness turn after raw compaction (notification before response: %s)', async (notificationFirst) => {
    const h = createHarness((method) => {
      if (method === 'turn/start') {
        if (notificationFirst) h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'user-turn', status: 'inProgress' } });
        return { turn: { id: 'user-turn', status: 'inProgress' } };
      }
      if (method === 'thread/compact/start') {
        h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'inProgress' } });
        h.emit('item/started', { threadId: 'thread-1', turnId: 'compact-turn', item: compactionItem });
        h.emit('item/completed', { threadId: 'thread-1', turnId: 'compact-turn', item: compactionItem });
        h.emit(...turnCompleted('compact-turn'));
      }
      return {};
    });
    try {
      const send = h.adapter.sendInput('Read the entry.');
      await vi.waitFor(() => expect(h.currentTurnId()).toBe('user-turn'));
      if (!notificationFirst) h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'user-turn', status: 'inProgress' } });
      h.emit(...finalAnswer('user-turn', 'Read it.'));
      h.emit(...turnCompleted('user-turn'));
      await send;
      expect(h.statuses.at(-1)).toBe('idle');

      const { appServerClient } = h.adapter as unknown as { appServerClient: { request(method: string, params: Record<string, unknown>): Promise<unknown> } };
      await appServerClient.request('thread/compact/start', { threadId: 'thread-1' });
      await vi.waitFor(() => expect(h.hasActiveTurn()).toBe(false));
      expect(h.statuses.at(-1)).toBe('idle');
      expect(h.completions).toEqual(['Read it.', '']);
    } finally {
      await h.adapter.terminate(false);
    }
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

  it.each([true, false])('keeps a final answer busy through inline compaction (compaction starts first: %s)', async (compactionFirst) => {
    const h = createHarness(() => ({}));
    vi.useFakeTimers();
    try {
      h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });
      if (compactionFirst) h.emit('item/started', { threadId: 'thread-1', turnId: 'goal-turn', item: compactionItem });
      h.emit(...finalAnswer('goal-turn', 'Finished the work.'));
      if (!compactionFirst) {
        await vi.advanceTimersByTimeAsync(100);
        h.emit('item/started', { threadId: 'thread-1', turnId: 'goal-turn', item: compactionItem });
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.hasActiveTurn()).toBe(true);
      expect(h.statuses).not.toContain('idle');
      expect(h.completions).toEqual([]);
      expect(h.adapter.isProviderCompacting()).toBe(false);

      h.emit('item/completed', { threadId: 'thread-1', turnId: 'goal-turn', item: compactionItem });
      await vi.advanceTimersByTimeAsync(300);
      expect(h.hasActiveTurn()).toBe(false);
      expect(h.completions).toEqual(['Finished the work.']);
      expect(h.statuses.at(-1)).toBe('idle');
      h.emit(...turnCompleted('goal-turn'));
      expect(h.completions).toEqual(['Finished the work.']);
    } finally {
      await h.adapter.terminate(false);
      vi.useRealTimers();
    }
  });

  it.each(['completed', 'interrupted'])('honours a Harness turn %s while inline compaction is active', async (status) => {
    const h = createHarness((method) => method === 'turn/start' ? { turn: { id: 'user-turn', status: 'inProgress' } } : {});
    const send = h.adapter.sendInput('Read the entry.');
    await vi.waitFor(() => expect(h.currentTurnId()).toBe('user-turn'));
    vi.useFakeTimers();
    try {
      h.emit(...finalAnswer('user-turn', 'Finished the work.'));
      h.emit('item/started', { threadId: 'thread-1', turnId: 'user-turn', item: compactionItem });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.hasActiveTurn()).toBe(true);
      expect(h.statuses.at(-1)).toBe('busy');
      expect(h.completions).toEqual([]);
      expect(h.adapter.isProviderCompacting()).toBe(false);

      h.emit(...turnCompleted('user-turn', status));
      await send;
      await vi.advanceTimersByTimeAsync(300);
      expect(h.hasActiveTurn()).toBe(false);
      expect(h.statuses.at(-1)).toBe('idle');
      expect(h.completions).toEqual(status === 'completed' ? ['Finished the work.'] : []);
    } finally {
      await h.adapter.terminate(false);
      vi.useRealTimers();
    }
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
      && output.content.includes('Codex is carrying on with the task.'))).toBe(true);
    expect(h.outputs.filter((output) => output.type === 'error')).toEqual([]);
  });
});

describe('CodexCliAdapter turn starts (Plan Queue "Land anyway")', () => {
  it('reports a turn Codex starts by itself (a goal turn) as one turn start', async () => {
    const h = createHarness(() => ({ goal: { status: 'active' } }));
    const started = vi.fn();
    h.adapter.on('turn_started', started);

    h.emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith({ source: 'provider' });

    h.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'completed' } });
    await vi.waitFor(() => expect(h.statuses.at(-1)).toBe('idle'));
    expect(started).toHaveBeenCalledTimes(1);
    await h.adapter.terminate(false);
  });

  it('reports the turn a Harness send starts', async () => {
    const h = createHarness((method) => method === 'turn/start'
      ? { turn: { id: 'user-turn', status: 'completed' } } : {});
    const started = vi.fn();
    h.adapter.on('turn_started', started);

    await h.adapter.sendInput('Read the entry.').catch(() => undefined);

    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith({ source: 'harness-send' });
    expect(h.requests.map(([method]) => method)).toContain('turn/start');
    await h.adapter.terminate(false);
  });

  it('reports turn starts only in app-server mode, where it can see every turn', () => {
    const resident = new CodexCliAdapter();
    Object.assign(resident, { useAppServer: true });
    expect(resident.getAdapterCapabilities().reportsTurnStarts).toBe(true);
    const stateless = new CodexCliAdapter();
    Object.assign(stateless, { useAppServer: false });
    expect(stateless.getAdapterCapabilities().reportsTurnStarts).toBe(false);
  });
});
