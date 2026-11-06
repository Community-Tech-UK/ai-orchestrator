import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/types/settings.types';
import type { SessionKind } from '../../../../shared/types/session-kind.types';
import { isHarnessStopError } from '../../../../shared/utils/harness-stop';
import { COMMAND_MODE_NOTICE } from './codex-turn-ceiling-controller';
import type { AppServerNotification } from './app-server-types';
import { isCodexInputTooLargeError, isRecoverableThreadResumeError } from './exec-error-classifier';
import { isRecoverableCodexTurnError } from './app-server-recovery-policy';
import { observeAdapterRuntimeEvents, type NormalizedAdapterRuntimeEvent } from '../../../providers/adapter-runtime-event-bridge';
import { harnessStopDetailsOf } from '../../../../shared/utils/harness-stop';

const settings: { value: AppSettings } = { value: { ...DEFAULT_SETTINGS } };
const shares = vi.hoisted(() => [] as Record<string, unknown>[]);
const credits = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('../../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => settings.value }) }));
// Recording is observed here and still reaches the real writer, which tests point at a scratch directory.
vi.mock('../../../core/system/session-policy-log', async (importActual) => {
  const actual = await importActual<typeof import('../../../core/system/session-policy-log')>();
  return {
    ...actual,
    recordSessionTurnShare: (record: Parameters<typeof actual.recordSessionTurnShare>[0]) => { shares.push(record as unknown as Record<string, unknown>); actual.recordSessionTurnShare(record); },
    recordSessionThreadCredits: (record: Parameters<typeof actual.recordSessionThreadCredits>[0]) => { credits.push(record as unknown as Record<string, unknown>); actual.recordSessionThreadCredits(record); },
  };
});

import { CodexCliAdapter } from '../codex-cli-adapter';

const M = 1_000_000;
const sample = (input: number, output = 0) => ({ inputTokens: input, cachedInputTokens: Math.floor(input * 0.9), outputTokens: output, reasoningOutputTokens: 0, totalTokens: input + output });
const usage = (threadId: string, processed: number): AppServerNotification => ({
  method: 'thread/tokenUsage/updated',
  params: { threadId, tokenUsage: { total: sample(processed - 1_000, 1_000), last: sample(1_000, 100), modelContextWindow: 258400 } },
});

function harness(kind: SessionKind, status: 'completed' | 'interrupted-on-request' = 'interrupted-on-request', usageRead: (params: Record<string, unknown>) => unknown = () => ({ summary: {}, threadUsage: null })) {
  const adapter = new CodexCliAdapter({ model: 'gpt-6-astra', sessionKind: kind, trialKey: 'trial-key', trialArm: 'cheaper' });
  const listeners = new Set<(n: AppServerNotification) => void>();
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let turnId = '';
  let turns = 0;
  /** The root thread the fake app-server is serving; a replacement changes it. */
  const root = { id: 'root' };
  const emit = (n: AppServerNotification) => { for (const listener of listeners) listener(n); };
  let script: AppServerNotification[] = [];
  const client = {
    exitPromise: new Promise<void>(() => { /* resident connection */ }),
    subscribeNotifications(listener: (n: AppServerNotification) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(method: string, params: Record<string, unknown> = {}) {
      requests.push({ method, params });
      if (method === 'turn/start') {
        turnId = `turn-${++turns}`;
        emit({ method: 'turn/started', params: { threadId: root.id, turn: { id: turnId } } });
        for (const notification of script) emit(notification);
        if (status === 'completed') emit({ method: 'turn/completed', params: { threadId: root.id, turn: { id: turnId, status: 'completed' } } });
        return { turn: { id: turnId, status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') {
        // Codex ends an interrupted turn with an interrupted completion.
        setImmediate(() => emit({ method: 'turn/completed', params: { threadId: root.id, turn: { id: turnId, status: 'interrupted' } } }));
        return {};
      }
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'account/usage/read') return usageRead(params);
      if (method === 'thread/start') return { threadId: 'root-2', thread: { id: 'root-2' } };
      return {};
    },
  };
  Object.assign(adapter, { appServerClient: client, appServerThreadId: 'root', useAppServer: true, isSpawned: true });
  client.subscribeNotifications(notification =>
    (adapter as unknown as { handleIdleAppServerNotification(n: AppServerNotification): void }).handleIdleAppServerNotification(notification));
  const outputs: { type: string; content: string; metadata?: Record<string, unknown> }[] = [];
  const turnErrors: Error[] = [];
  adapter.on('output', output => outputs.push(output as never));
  adapter.on('turn_error', error => turnErrors.push(error));
  return {
    adapter, requests, outputs, turnErrors, root,
    reopen: () => (adapter as unknown as { reopenAppServerThread(): Promise<void> }).reopenAppServerThread(),
    count: (method: string) => requests.filter(request => request.method === method).length,
    play(notifications: AppServerNotification[]) { script = notifications; },
    notify: emit,
    send: () => (adapter as unknown as { appServerSendMessageInner(message: string): Promise<void> }).appServerSendMessageInner('work'),
  };
}

const child: AppServerNotification[] = [
  { method: 'thread/started', params: { thread: { id: 'child', parentThreadId: 'root' } } },
  { method: 'item/completed', params: { threadId: 'root', turnId: 'turn-1', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'] } } },
  { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } },
];

beforeEach(() => {
  settings.value = { ...DEFAULT_SETTINGS };
  shares.length = 0;
  credits.length = 0;
});

describe('Codex per-round token ceiling on the real adapter', () => {
  it('asks once to wrap up at 150M and stops a plan-queue round once at 300M, counting helper threads', async () => {
    const h = harness('plan-queue');
    h.play([
      ...child,
      usage('root', 100 * M),
      usage('root', 160 * M), // 160M: wrap-up
      usage('child', 60 * M), // 220M
      usage('root', 200 * M), // 260M
      usage('child', 100 * M), // 300M: stop
      usage('child', 120 * M), // still the same round: no second stop
    ]);

    const outcome = await h.send().then(() => null, (error: unknown) => error);

    expect(isHarnessStopError(outcome)).toBe(true);
    expect((outcome as Error).message).toBe('Stopped by Harness: this turn passed 300M tokens.');
    // The root turn and the helper's running turn are each interrupted once: helpers are separate threads.
    expect(h.requests.filter(request => request.method === 'turn/interrupt').map(request => request.params['threadId']).sort()).toEqual(['child', 'root']);
    expect(h.requests.find(request => request.method === 'turn/interrupt' && request.params['threadId'] === 'child')?.params).toEqual({ threadId: 'child', turnId: 'child-turn' });
    const wrapUps = h.requests.filter(request => request.method === 'thread/inject_items');
    expect(wrapUps).toHaveLength(1);
    expect(JSON.stringify(wrapUps[0]!.params)).toContain('Wrap up now: report what is done and what is left.');
    expect(JSON.stringify(wrapUps[0]!.params)).toContain('"role":"developer"');
    // The stop is announced once in the transcript and is not repeated as a Codex error.
    expect(h.outputs.filter(output => output.metadata?.['stage'] === 'stop')).toHaveLength(1);
    expect(h.outputs.filter(output => output.type === 'error')).toHaveLength(0);
  });

  it('records how much of the round the helper threads spent', async () => {
    const h = harness('plan-queue');
    h.play([...child, usage('root', 160 * M), usage('child', 160 * M)]);

    await h.send().catch(() => undefined);

    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      event: 'turn-share', provider: 'codex', threadId: 'root', turnId: 'turn-1', sessionKind: 'plan-queue',
      revision: 0, rootTokens: 160 * M, helperTokens: 160 * M, totalTokens: 320 * M, helperShare: 0.5, stopRequested: true, wrapUpDelivered: true,
    });
    expect(shares[0]).toHaveProperty('arm');
    expect(shares[0]).toHaveProperty('armKey', 'trial-key');
  });

  it('nudges a chat at 150M but never stops it, however large the round gets', async () => {
    const h = harness('chat', 'completed');
    h.play([...child, usage('root', 160 * M), usage('child', 900 * M), usage('root', 700 * M)]);

    await expect(h.send()).resolves.toBeUndefined();

    expect(h.count('turn/interrupt')).toBe(0);
    expect(h.requests.filter(request => request.method === 'thread/inject_items')).toHaveLength(1);
    expect(shares[0]).toMatchObject({ sessionKind: 'chat', stopRequested: false, wrapUpDelivered: true });
  });

  it.each(['child', 'chat'] as const)('treats a %s session like a chat: nudge only', async (kind) => {
    const h = harness(kind, 'completed');
    h.play([usage('root', 350 * M)]);

    await h.send();

    expect(h.count('turn/interrupt')).toBe(0);
    expect(h.count('thread/inject_items')).toBe(1);
  });

  it.each(['loop', 'automation', 'review'] as const)('stops a %s round too', async (kind) => {
    const h = harness(kind);
    h.play([usage('root', 310 * M)]);

    await expect(h.send()).rejects.toSatisfy(isHarnessStopError);

    expect(h.count('turn/interrupt')).toBe(1);
  });

  it('uses the separate chat setting when James turns the chat stop on (Decision 16b)', async () => {
    settings.value = { ...settings.value, codexTurnCeilingChatsStopTokens: 200 * M };
    const h = harness('chat');
    h.play([usage('root', 210 * M)]);

    await expect(h.send()).rejects.toSatisfy(isHarnessStopError);
    expect(h.count('turn/interrupt')).toBe(1);
  });

  it('leaves Harness work alone when its stop is switched off, and keeps the chat setting independent', async () => {
    settings.value = { ...settings.value, codexTurnCeilingHarnessWorkStopTokens: 0, codexTurnCeilingChatsStopTokens: 100 * M };
    const h = harness('plan-queue', 'completed');
    h.play([usage('root', 500 * M)]);

    await h.send();

    expect(h.count('turn/interrupt')).toBe(0);
    expect(h.count('thread/inject_items')).toBe(1);
  });

  it('starts each round from zero', async () => {
    const h = harness('plan-queue', 'completed');
    h.play([usage('root', 200 * M)]);
    await h.send();
    h.play([usage('root', 230 * M)]); // 30M more than the previous round's total
    await h.send();

    expect(h.count('thread/inject_items')).toBe(1);
    expect(h.count('turn/interrupt')).toBe(0);
  });
});

describe('Codex Harness stop is a clean, non-retryable end', () => {
  it('keeps the session usable and is not mistaken for an oversize input', () => {
    const error = Object.assign(new Error('Stopped by Harness: this turn passed 300M tokens.'), { stoppedByHarness: true });
    expect(isRecoverableCodexTurnError(error)).toBe(true);
    expect(isCodexInputTooLargeError(error)).toBe(false);
    expect(isRecoverableThreadResumeError(error)).toBe(false);
  });
});

describe('a round Codex starts by itself (goal continuation)', () => {
  it('is stopped for Harness work and ends with a typed error event the plan queue can recognise', async () => {
    const adapter = new CodexCliAdapter({ model: 'gpt-6-astra', sessionKind: 'plan-queue' });
    const subscribers = new Set<(n: AppServerNotification) => void>();
    const requests: string[] = [];
    const emit = (method: AppServerNotification['method'], params: Record<string, unknown>) => { for (const subscriber of Array.from(subscribers)) subscriber({ method, params }); };
    const client = {
      exitPromise: new Promise<void>(() => { /* stays connected */ }),
      request: vi.fn(async (method: string) => {
        requests.push(method);
        if (method === 'turn/interrupt') setImmediate(() => emit('turn/completed', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'interrupted' } }));
        return method === 'thread/goal/get' ? { goal: null } : {};
      }),
      subscribeNotifications(handler: (n: AppServerNotification) => void) { subscribers.add(handler); return () => subscribers.delete(handler); },
      isRunning: () => true,
      getPid: () => 4242,
    };
    const internals = adapter as unknown as {
      appServerClient: typeof client; appServerThreadId: string; useAppServer: boolean; isSpawned: boolean;
      appServerRuntime: { attach(c: typeof client, binding: unknown, onNotification: (n: AppServerNotification) => void): void };
      handleIdleAppServerNotification(notification: AppServerNotification): void;
    };
    Object.assign(internals, { appServerClient: client, appServerThreadId: 'thread-1', useAppServer: true, isSpawned: true });
    internals.appServerRuntime.attach(client, { threadId: 'thread-1', resumeCursor: null, resumeProof: null }, (n) => internals.handleIdleAppServerNotification(n));
    const events: NormalizedAdapterRuntimeEvent[] = [];
    const unobserve = observeAdapterRuntimeEvents(adapter, (event) => events.push(event));

    emit('turn/started', { threadId: 'thread-1', turn: { id: 'goal-turn', status: 'inProgress' } });
    emit('thread/tokenUsage/updated', { threadId: 'thread-1', tokenUsage: { total: sample(305 * M - 1_000, 1_000), last: sample(1_000, 100), modelContextWindow: 258400 } });

    await vi.waitFor(() => expect(events.some(({ event }) => event.kind === 'error')).toBe(true));
    unobserve();
    expect(requests.filter((method) => method === 'turn/interrupt')).toHaveLength(1);
    const failure = events.map(({ event }) => event).find((event) => event.kind === 'error');
    expect(failure).toMatchObject({ kind: 'error', message: 'Stopped by Harness: this turn passed 300M tokens.', recoverable: false });
    // A deliberate end: nothing may continue it, and it is not reported as a provider failure.
    expect(failure).toMatchObject({ turnEnding: { reason: 'completed', evidence: 'harness_stop', autoContinueSuppressed: true } });
    expect(harnessStopDetailsOf((failure as { details?: unknown }).details)).toEqual({
      reason: 'turn-token-ceiling', tokens: 305 * M, thresholdTokens: 300 * M,
    });
    await adapter.terminate(false);
  });
});

describe('Codex thread-end credit reading', () => {
  const reading = () => ({
    summary: {},
    threadUsage: { threadId: 'root', estimatedUsageCreditsMicros: 4_200_000, estimatedUsageUsdMicros: null, groups: [{ model: 'gpt-6-astra', totalTokens: 90 * M, estimatedUsageCreditsMicros: 4_200_000 }] },
  });

  it('reads Codex\'s own credit estimate once as the thread ends and stores it with the trial arm', async () => {
    const h = harness('plan-queue', 'completed', reading);
    h.play([usage('root', 90 * M)]);
    await h.send();

    await h.adapter.terminate(true);
    await h.adapter.terminate(true);

    expect(h.requests.filter((request) => request.method === 'account/usage/read')).toEqual([
      { method: 'account/usage/read', params: { threadId: 'root' } },
    ]);
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      event: 'thread-credits', provider: 'codex', threadId: 'root', sessionKind: 'plan-queue', armKey: 'trial-key',
      estimatedUsageCreditsMicros: 4_200_000, estimatedUsageUsdMicros: null, totalTokens: 90 * M,
    });
  });

  it('stores nothing, and still shuts down cleanly, when the thread has no billing route', async () => {
    const h = harness('chat', 'completed');
    h.play([usage('root', 10 * M)]);
    await h.send();

    await expect(h.adapter.terminate(true)).resolves.toBeUndefined();
    expect(credits).toHaveLength(0);
  });

  it('does not ask for a thread that never used tokens, or during a forced shutdown', async () => {
    const idle = harness('chat', 'completed', reading);
    await idle.adapter.terminate(true);
    expect(idle.count('account/usage/read')).toBe(0);

    const forced = harness('chat', 'completed', reading);
    forced.play([usage('root', 10 * M)]);
    await forced.send();
    await forced.adapter.terminate(false);
    expect(forced.count('account/usage/read')).toBe(0);
  });
});

describe('late receipts correct the stored round share', () => {
  it.each(['spawnAgent', 'started'])('stops on delayed %s confirmation without another usage sample', async kind => {
    const h = harness('plan-queue', 'completed');
    const confirmation: AppServerNotification = { method: 'item/completed', params: { threadId: 'root', turnId: 'turn-1', item: kind === 'spawnAgent'
      ? { type: 'collabAgentToolCall', tool: kind, receiverThreadIds: ['child'] }
      : { type: 'subAgentActivity', id: 'activity', kind, agentThreadId: 'child', agentPath: '/root/child', model: null, reasoningEffort: null } } };
    h.play([child[0]!, child[2]!, usage('child', 310 * M), confirmation, confirmation]);
    await h.send();
    await h.adapter.terminate(false);
    expect(h.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params['threadId']).sort()).toEqual(['child', 'root']);
    expect(h.outputs.filter(o => o.metadata?.['stage'] === 'stop')).toHaveLength(1);
    expect(shares.at(-1)).toMatchObject({ helperTokens: 310 * M, stopRequested: true });
  });

  it.each(['item/started', 'item/completed'] as const)('counts started activity from %s without collab or thread discovery', async method => {
    const h = harness('plan-queue', 'completed');
    h.play([
      { method, params: { threadId: 'root', turnId: 'turn-1', item: { type: 'subAgentActivity', id: 'activity', kind: 'started', agentThreadId: 'child', agentPath: '/root/child', model: null, reasoningEffort: null } } },
      child[2]!, usage('child', 310 * M),
    ]);
    await h.send();
    await h.adapter.terminate(false);
    expect(h.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params['threadId']).sort()).toEqual(['child', 'root']);
    expect(shares.at(-1)).toMatchObject({ helperTokens: 310 * M, stopRequested: true });
  });

  it.each(['native', 'inferred'] as const)('does not enforce after %s completion while receipt reconciliation is waiting', async completion => {
    const h = harness('plan-queue', completion === 'native' ? 'completed' : 'interrupted-on-request');
    const adapter = h.adapter as unknown as { reconcileChildRollouts(threadId: string, turnId: string, startedAt: number, endedAt: number): Promise<void> };
    const reconcile = adapter.reconcileChildRollouts.bind(adapter);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(adapter, 'reconcileChildRollouts').mockImplementation(async (...args) => {
      entered();
      await released;
      await reconcile(...args);
    });
    h.play([child[0]!, usage('child', 310 * M), {
      method: 'item/completed', params: { threadId: 'root', turnId: 'turn-1', item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Done.' } },
    }]);
    const sent = h.send();
    try {
      await waiting;
      h.notify(child[1]!);
      expect(h.count('turn/interrupt')).toBe(0);
      expect(h.count('thread/goal/get')).toBe(0);
      expect(h.outputs.filter(o => o.metadata?.['stage'] === 'stop')).toHaveLength(0);
    } finally {
      release();
      await sent;
      spy.mockRestore();
      await h.adapter.terminate(false);
    }
    expect(shares.at(-1)).toMatchObject({ helperTokens: 310 * M, stopRequested: false });
  });

  it('only corrects the share when confirmation arrives after the latest root finished', async () => {
    const h = harness('plan-queue', 'completed');
    h.play([child[0]!, child[2]!, usage('child', 310 * M)]);
    await h.send();
    h.notify(child[1]!);
    await h.adapter.terminate(false);
    expect(h.count('turn/interrupt')).toBe(0);
    expect(h.count('thread/inject_items')).toBe(0);
    expect(shares.at(-1)).toMatchObject({ helperTokens: 310 * M, stopRequested: false });
  });

  it('uses the authoritative parent turn when an earlier helper spawns a child after being reused', async () => {
    const h = harness('plan-queue', 'completed');
    h.play([...child, usage('root', 10 * M), usage('child', 10 * M)]);
    await h.send();
    const late = usage('nested', 310 * M);
    late.params['turnId'] = 'nested-turn';
    h.play([
      { method: 'item/started', params: { threadId: 'root', turnId: 'turn-2', item: { type: 'collabAgentToolCall', tool: 'sendInput', receiverThreadIds: ['child'] } } },
      { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn-2' } } },
      { method: 'thread/started', params: { thread: { id: 'nested', parentThreadId: 'child' } } },
      { method: 'turn/started', params: { threadId: 'nested', turn: { id: 'nested-turn' } } },
      { method: 'item/completed', params: { threadId: 'child', turnId: 'child-turn', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['nested'] } } },
      late, usage('root', 20 * M),
    ]);
    await h.send();
    await h.adapter.terminate(false);
    expect(h.count('turn/interrupt')).toBe(0);
    expect(shares.filter(row => row['turnId'] === 'turn-1').at(-1)).toMatchObject({ helperTokens: 320 * M });
  });
  it.each([true, false])('keeps a nested helper with its earlier parent root (parent supplied: %s)', async parentSupplied => {
    const h = harness('plan-queue', 'completed');
    h.play([...child, usage('root', 10 * M), usage('child', 10 * M)]);
    await h.send();
    const late = usage('nested', 310 * M);
    late.params['turnId'] = 'nested-turn';
    h.play([
      { method: 'thread/started', params: { thread: { id: 'nested', ...(parentSupplied ? { parentThreadId: 'child' } : {}) } } },
      { method: 'turn/started', params: { threadId: 'nested', turn: { id: 'nested-turn' } } },
      late,
      { method: 'item/completed', params: { threadId: 'child', turnId: 'child-turn', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['nested'] } } },
      usage('root', 20 * M),
    ]);
    await h.send();
    await h.adapter.terminate(false);
    expect(h.count('turn/interrupt')).toBe(0);
    expect(shares.filter(row => row['turnId'] === 'turn-1').at(-1)).toMatchObject({ helperTokens: 320 * M });
  });
  it('counts new work explicitly sent to an existing helper against the new root', async () => {
    const h = harness('plan-queue', 'completed');
    h.play([...child, usage('root', 10 * M), usage('child', 10 * M)]);
    await h.send();
    h.play([
      { method: 'item/started', params: { threadId: 'root', turnId: 'turn-2', item: { type: 'collabAgentToolCall', tool: 'sendInput', receiverThreadIds: ['child'] } } },
      { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn-2' } } },
      usage('root', 20 * M), usage('child', 310 * M),
    ]);
    await h.send();
    await h.adapter.terminate(false);
    expect(h.count('turn/interrupt')).toBeGreaterThan(0);
    expect(shares.filter(row => row['turnId'] === 'turn-2').at(-1)).toMatchObject({ rootTokens: 10 * M, helperTokens: 300 * M });
  });

  it('keeps a late native helper turn receipt with its original root after the helper is reused', async () => {
    const h = harness('plan-queue', 'completed');
    h.play([...child, usage('root', 10 * M), usage('child', 10 * M)]);
    await h.send();
    const late = usage('child', 310 * M);
    late.params['turnId'] = 'child-turn';
    h.play([
      { method: 'item/started', params: { threadId: 'root', turnId: 'turn-2', item: { type: 'collabAgentToolCall', tool: 'sendInput', receiverThreadIds: ['child'] } } },
      { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn-2' } } },
      usage('root', 20 * M), late,
    ]);
    await h.send();
    await h.adapter.terminate(false);
    expect(h.count('turn/interrupt')).toBe(0);
    expect(shares.filter(row => row['turnId'] === 'turn-1').at(-1)).toMatchObject({ helperTokens: 310 * M });
  });
  it.each([
    { method: 'thread/started', params: { thread: { id: 'child' } } },
    { method: 'item/completed', params: { threadId: 'root', item: { type: 'subAgentActivity', agentThreadId: 'child' } } },
    { method: 'item/completed', params: { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'wait', receiverThreadIds: ['child'] } } },
  ] as AppServerNotification[])('does not transfer an earlier helper on a repeated or read-only $method notification', async notification => {
    const h = harness('plan-queue', 'completed');
    h.play([...child, usage('root', 10 * M), usage('child', 10 * M)]);
    await h.send();
    h.play([notification, usage('root', 20 * M), usage('child', 310 * M)]);
    await h.send();
    await h.adapter.terminate(false);
    expect(h.count('turn/interrupt')).toBe(0);
    expect(shares.filter(row => row['turnId'] === 'turn-1').at(-1)).toMatchObject({ helperTokens: 310 * M });
  });
  it.each(['thread/tokenUsage/updated', 'turn/completed'] as const)('attributes a late helper %s to its earlier root while the next root is running', async (method) => {
    const h = harness('plan-queue', 'completed');
    h.play([...child, usage('root', 10 * M), usage('child', 10 * M)]);
    await h.send();
    const late: AppServerNotification = method === 'thread/tokenUsage/updated' ? usage('child', 310 * M)
      : { method, params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed', usage: sample(310 * M) } } };
    h.play([usage('root', 20 * M), late]);
    await h.send();
    await h.adapter.terminate(false);
    expect(h.count('turn/interrupt')).toBe(0);
    expect(h.count('thread/inject_items')).toBe(0);
    expect(shares.filter(row => row['turnId'] === 'turn-1').at(-1)).toMatchObject({ helperTokens: 310 * M });
    expect(shares.filter(row => row['turnId'] === 'turn-2').at(-1)).toMatchObject({ rootTokens: 10 * M, helperTokens: 0 });
  });

  it('attributes idle helper usage to its earlier root after a newer root has ended', async () => {
    const h = harness('plan-queue', 'completed');
    h.play([...child, usage('root', 10 * M), usage('child', 10 * M)]);
    await h.send();
    h.play([usage('root', 20 * M)]);
    await h.send();
    h.notify(usage('child', 50 * M));
    await h.adapter.terminate(false);
    expect(shares.filter(row => row['turnId'] === 'turn-1').at(-1)).toMatchObject({ helperTokens: 50 * M });
    expect(shares.filter(row => row['turnId'] === 'turn-2').at(-1)).toMatchObject({ helperTokens: 0 });
  });
  it('records a child receipt that arrives after the round ended as a correction for that same round', async () => {
    const h = harness('plan-queue', 'completed');
    h.play([...child, usage('root', 100 * M), usage('child', 10 * M)]);
    await h.send();
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ turnId: 'turn-1', revision: 0, rootTokens: 100 * M, helperTokens: 10 * M });

    // The helper's last tokens are reported after the root turn completed.
    h.notify(usage('child', 40 * M));
    await h.adapter.terminate(false);

    expect(shares).toHaveLength(2);
    expect(shares[1]).toMatchObject({ turnId: 'turn-1', revision: 1, rootTokens: 100 * M, helperTokens: 40 * M, totalTokens: 140 * M });
  });

  it('books the root thread\'s end-of-round usage when no live update reported it', async () => {
    const h = harness('automation', 'completed');
    const completed: AppServerNotification = { method: 'turn/completed', params: { threadId: 'root', turn: { id: 'turn-1', status: 'completed', usage: sample(80 * M, 5 * M) } } };
    h.play([completed]);
    await h.send();
    await h.adapter.terminate(false);
    expect(shares.at(-1)).toMatchObject({ turnId: 'turn-1', rootTokens: 85 * M, helperTokens: 0, sessionKind: 'automation' });
  });

  it('also publishes the shares and credits as adapter telemetry for a worker node to forward', async () => {
    const h = harness('plan-queue', 'completed', () => ({
      summary: {}, threadUsage: { threadId: 'root', estimatedUsageCreditsMicros: 1_000_000, estimatedUsageUsdMicros: null, groups: [] },
    }));
    const telemetry: { event: string; payload: Record<string, unknown> }[] = [];
    h.adapter.on('session_turn_share', (payload: Record<string, unknown>) => telemetry.push({ event: 'session_turn_share', payload }));
    h.adapter.on('session_thread_credits', (payload: Record<string, unknown>) => telemetry.push({ event: 'session_thread_credits', payload }));
    h.play([usage('root', 20 * M)]);
    await h.send();
    await h.adapter.terminate(true);
    expect(telemetry.map((entry) => entry.event)).toEqual(['session_turn_share', 'session_thread_credits']);
    expect(telemetry[0]!.payload).toMatchObject({ rootTokens: 20 * M, revision: 0 });
    expect(telemetry[1]!.payload).toMatchObject({ threadId: 'root', estimatedUsageCreditsMicros: 1_000_000 });
  });
});

describe('a local adapter writes the real session-policy log', () => {
  it('lands the round share and the thread credits in the main-process log beside the thread policy row', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'codex-share-log-'));
    vi.stubEnv('AIO_SESSION_POLICY_DIR', dir);
    try {
      const h = harness('plan-queue', 'completed', () => ({
        summary: {}, threadUsage: { threadId: 'root', estimatedUsageCreditsMicros: 2_000_000, estimatedUsageUsdMicros: null, groups: [] },
      }));
      h.play([...child, usage('root', 30 * M), usage('child', 10 * M)]);
      await h.send();
      await h.adapter.terminate(true);

      const logged = fs.readdirSync(dir).flatMap((name) => fs.readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
      // The thread's own policy row has no event name; the round share and the credits are the two named rows.
      const rows = logged.filter((row) => row['event'] !== undefined);
      expect(rows.map((row) => row['event'])).toEqual(['turn-share', 'thread-credits']);
      expect(rows[0]).toMatchObject({ threadId: 'root', turnId: 'turn-1', rootTokens: 30 * M, helperTokens: 10 * M, sessionKind: 'plan-queue' });
      expect(rows[1]).toMatchObject({ threadId: 'root', estimatedUsageCreditsMicros: 2_000_000 });
      expect(rows.map((row) => row['armKey'])).toEqual(['trial-key', 'trial-key']);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('thread-end credits when the root thread is replaced', () => {
  const readOf = (params: Record<string, unknown>) => ({
    summary: {},
    threadUsage: { threadId: params['threadId'], estimatedUsageCreditsMicros: params['threadId'] === 'root' ? 1_000_000 : 2_000_000, estimatedUsageUsdMicros: null, groups: [] },
  });
  const reads = (h: ReturnType<typeof harness>) => h.requests.filter((request) => request.method === 'account/usage/read').map((request) => request.params['threadId']);

  afterEach(() => { vi.useRealTimers(); });

  it('reads the old root once before it is replaced and the new root once at shutdown, never twice', async () => {
    const h = harness('plan-queue', 'completed', readOf);
    h.play([usage('root', 10 * M)]);
    await h.send();

    await h.reopen();
    const methods = h.requests.map((request) => request.method);
    expect(methods.indexOf('account/usage/read')).toBeGreaterThan(-1);
    expect(methods.indexOf('account/usage/read')).toBeLessThan(methods.indexOf('thread/start'));
    expect(reads(h)).toEqual(['root']);
    expect(credits.map((row) => [row['threadId'], row['estimatedUsageCreditsMicros']])).toEqual([['root', 1_000_000]]);

    h.root.id = 'root-2';
    h.play([usage('root-2', 20 * M)]);
    await h.send();
    await h.adapter.terminate(true);
    await h.adapter.terminate(true);

    expect(reads(h)).toEqual(['root', 'root-2']);
    expect(credits.map((row) => [row['threadId'], row['estimatedUsageCreditsMicros']])).toEqual([['root', 1_000_000], ['root-2', 2_000_000]]);
  });

  it('keeps each round\'s share under the root it ran on across a replacement', async () => {
    const h = harness('plan-queue', 'completed', readOf);
    h.play([usage('root', 10 * M)]);
    await h.send();
    await h.reopen();
    h.root.id = 'root-2';
    h.play([usage('root-2', 20 * M)]);
    await h.send();
    await h.adapter.terminate(false);

    expect(shares.map((row) => [row['threadId'], row['rootTokens']])).toEqual([['root', 10 * M], ['root-2', 20 * M]]);
  });

  it.each([
    ['the request is rejected', () => { throw new Error('boom'); }],
    ['this Codex does not support the request', () => { throw new Error('method not found: account/usage/read'); }],
    ['there is no billing route for the thread', () => ({ summary: {}, threadUsage: null })],
  ])('still replaces the thread when %s, and records nothing for it', async (_label, read) => {
    const h = harness('plan-queue', 'completed', read);
    h.play([usage('root', 10 * M)]);
    await h.send();

    await h.reopen();

    expect(h.count('thread/start')).toBe(1);
    expect(reads(h)).toEqual(['root']);
    expect(credits).toEqual([]);
    expect(h.adapter.getCurrentTurnId()).toBeNull();
  });

  it('still replaces the thread when the app-server never answers, within the bound', async () => {
    const h = harness('plan-queue', 'completed', () => new Promise(() => { /* the app-server is wedged */ }));
    h.play([usage('root', 10 * M)]);
    await h.send();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const replacing = h.reopen();
    await vi.advanceTimersByTimeAsync(2_499);
    expect(h.count('thread/start')).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await replacing;

    expect(h.count('thread/start')).toBe(1);
    expect(credits).toEqual([]);
  });

  it('does not ask about a replacement thread that never ran a turn, and a forced shutdown asks about nothing', async () => {
    const h = harness('plan-queue', 'completed', readOf);
    h.play([usage('root', 10 * M)]);
    await h.send();
    await h.reopen();
    h.root.id = 'root-2';

    await h.adapter.terminate(true);
    expect(reads(h)).toEqual(['root']);

    const forced = harness('plan-queue', 'completed', readOf);
    forced.play([usage('root', 10 * M)]);
    await forced.send();
    await forced.adapter.terminate(false);
    expect(reads(forced)).toEqual([]);
  });

  it('asks about nothing once the app-server is gone', async () => {
    const h = harness('plan-queue', 'completed', readOf);
    h.play([usage('root', 10 * M)]);
    await h.send();
    Object.assign(h.adapter, { useAppServer: false });

    await h.adapter.terminate(true);

    expect(reads(h)).toEqual([]);
    expect(credits).toEqual([]);
  });
});

describe('command mode has no live token feed', () => {
  async function commandModeOutputs(kind: SessionKind, overrides: Partial<AppSettings> = {}, sends = 2) {
    settings.value = { ...DEFAULT_SETTINGS, ...overrides };
    const adapter = new CodexCliAdapter({ model: 'gpt-6-astra', sessionKind: kind });
    Object.assign(adapter, { isSpawned: true, useAppServer: false });
    vi.spyOn(adapter, 'sendMessage').mockResolvedValue({ id: 'r', content: 'ok', role: 'assistant' } as never);
    const notices: { content: string; metadata?: Record<string, unknown> }[] = [];
    adapter.on('output', (output: { content: string; metadata?: Record<string, unknown> }) => {
      if (output.metadata?.['source'] === 'codex-turn-ceiling') notices.push(output);
    });
    for (let send = 0; send < sends; send += 1) await adapter.sendInput('go');
    return notices;
  }

  it('says once, for Harness work that promises a stop, that the limit cannot act during a turn', async () => {
    const notices = await commandModeOutputs('plan-queue');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ content: COMMAND_MODE_NOTICE, metadata: { stage: 'inactive', hardened: false } });
    expect(COMMAND_MODE_NOTICE).toContain('command mode');
    expect(COMMAND_MODE_NOTICE).toContain('only when a turn ends');
  });

  it('adds no notice for a chat (it is never stopped) or when the stop is switched off, and never changes how the session runs', async () => {
    expect(await commandModeOutputs('chat')).toEqual([]);
    expect(await commandModeOutputs('loop', { codexTurnCeilingHarnessWorkStopTokens: 0 })).toEqual([]);
    expect(await commandModeOutputs('loop', { codexTurnCeilingHarnessWorkStopTokens: 0, codexTurnCeilingHarnessWorkWrapUpTokens: 0 })).toEqual([]);
  });

  it('marks a hardened session in the notice without touching its mode', async () => {
    settings.value = { ...DEFAULT_SETTINGS };
    const adapter = new CodexCliAdapter({ model: 'gpt-6-astra', sessionKind: 'plan-queue' });
    Object.assign(adapter, { isSpawned: true, useAppServer: false });
    adapter.configureHardenedMode({ writableRoots: ['/work'] });
    vi.spyOn(adapter, 'sendMessage').mockResolvedValue({ id: 'r', content: 'ok', role: 'assistant' } as never);
    const notices: Record<string, unknown>[] = [];
    adapter.on('output', (output: { metadata?: Record<string, unknown> }) => { if (output.metadata?.['stage'] === 'inactive') notices.push(output.metadata); });
    await adapter.sendInput('go');
    expect(notices).toEqual([{ source: 'codex-turn-ceiling', stage: 'inactive', hardened: true }]);
    expect(adapter.isHardenedModeConfigured()).toBe(true);
    expect(adapter.isAppServerMode()).toBe(false);
  });
});
