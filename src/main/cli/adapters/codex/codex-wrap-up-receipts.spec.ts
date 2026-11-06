import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  latestTurnShares, readSessionPolicyEvents, recordSessionPolicy, type SessionTurnShareRecord,
} from '../../../core/system/session-policy-log';
import type { AppServerMethod, AppServerNotification, AppServerRequestParams, AppServerResponseResult } from './app-server-types';
import { CodexAppServerThreadRuntime, createCodexTurnCaptureState } from './app-server-thread-runtime';
import { publishSessionTurnShare } from './codex-session-telemetry';
import { CodexTurnCeilingController } from './codex-turn-ceiling-controller';

function setup() {
  const subscribers = new Set<(notification: AppServerNotification) => void>();
  const emitter = new EventEmitter();
  const shares: SessionTurnShareRecord[] = [];
  emitter.on('session_turn_share', row => shares.push(row));
  const acknowledgements: { resolve(): void; reject(error: Error): void }[] = [];
  const requests: string[] = [];
  const client = {
    exitPromise: new Promise<void>(() => { /* Synthetic resident connection; no process. */ }),
    subscribeNotifications(handler: (notification: AppServerNotification) => void) {
      subscribers.add(handler);
      return () => { subscribers.delete(handler); };
    },
    async request<M extends AppServerMethod>(method: M, _params: AppServerRequestParams<M>): Promise<AppServerResponseResult<M>> {
      requests.push(method);
      if (method !== 'thread/inject_items') throw new Error(`Unexpected request: ${method}`);
      await new Promise<void>((resolve, reject) => acknowledgements.push({ resolve, reject }));
      return {} as AppServerResponseResult<M>;
    },
  };
  const runtime = new CodexAppServerThreadRuntime();
  runtime.attach(client, { threadId: 'root', resumeCursor: null, resumeProof: null });
  let cumulative = 0;
  const notices: Record<string, unknown>[] = [];
  const controller = new CodexTurnCeilingController({
    sessionKind: () => 'chat', trial: () => ({ arm: 'cheaper' }), threadId: () => runtime.getThreadId(),
    instanceId: () => 'instance', cumulativeTokens: () => cumulative,
    deliverWrapUp: text => runtime.steerActiveTurn(text),
    requestStop: () => { requests.push('stop'); }, emitSystem: (_text, metadata) => notices.push(metadata),
    publishShare: row => publishSessionTurnShare(emitter, row),
    readSettings: () => ({ codexTurnCeilingChatsWrapUpTokens: 150, codexTurnCeilingChatsStopTokens: 300 }),
  });
  const book = (tokens: number, turnId?: string) => controller.measure(false, () => { cumulative += tokens; }, turnId ? 'late' : 'live', turnId);
  const start = (turnId: string) => {
    controller.beginTurn(turnId);
    const capture = runtime.captureProviderTurn(turnId, {
      createState: createCodexTurnCaptureState, belongsToTurn: () => true,
      handleNotification: (state, notification) => {
        if (notification.method !== 'turn/completed') return;
        controller.endTurn(turnId);
        state.completed = true;
        state.finalTurn = { id: turnId, status: 'completed' };
        state.resolveCompletion(state);
      },
      toInterruptCompletion: () => ({ status: 'completed', turnId }),
      resolveNotificationIdleTimeoutMs: () => 60_000, hasPendingApproval: () => false,
      onHeartbeat: () => undefined, onAbandonedTurn: () => undefined,
    });
    if (!capture) throw new Error('Expected native capture');
    return async () => {
      for (const handler of [...subscribers]) handler({ method: 'turn/completed', params: { threadId: 'root', turn: { id: turnId, status: 'completed' } } });
      await capture;
      controller.finishTurn(turnId);
    };
  };
  return { runtime, controller, start, book, shares, notices, acknowledgements, requests, subscribers };
}

describe('wrap-up delivery receipts through the native runtime and persisted log', () => {
  let directory: string;
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), 'codex-wrap-receipts-'));
    vi.stubEnv('AIO_SESSION_POLICY_DIR', directory);
    h = setup();
  });
  afterEach(async () => {
    h.controller.flush();
    await h.runtime.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('includes an acknowledgement received before the final publication without a correction', async () => {
    const finish = h.start('a');
    h.book(160);
    h.acknowledgements[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await finish();
    h.controller.flush();
    expect(h.shares).toHaveLength(1);
    expect(h.shares[0]).toMatchObject({ turnId: 'a', revision: 0, totalTokens: 160, wrapUpDelivered: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('corrects unchanged counters after publication and the persisted reader counts delivery once', async () => {
    recordSessionPolicy({ provider: 'codex', threadId: 'root', sessionKind: 'chat', level: 'economy', arm: 'cheaper', applied: true, outputLimit: null, postTurnCompactPercent: null });
    const finish = h.start('a');
    h.book(160);
    await finish();
    expect(h.shares[0]).toMatchObject({ revision: 0, wrapUpDelivered: false });
    h.acknowledgements[0]!.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    h.controller.flush();
    h.controller.flush();
    expect(h.shares.map(row => [row.revision, row.totalTokens, row.wrapUpDelivered])).toEqual([[0, 160, false], [1, 160, true]]);
    const rows = latestTurnShares(readSessionPolicyEvents<SessionTurnShareRecord>('turn-share', 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ threadId: 'root', turnId: 'a', rootTokens: 160, helperTokens: 0, wrapUpDelivered: true });
    expect(h.requests).toEqual(['thread/inject_items']);
    expect(h.subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('corrects only the originating round when a new round has already begun', async () => {
    const finishA = h.start('a');
    h.book(160);
    await finishA();
    const finishB = h.start('b');
    h.book(10);
    h.acknowledgements[0]!.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.shares.at(-1)).toMatchObject({ turnId: 'a', revision: 1, totalTokens: 160, wrapUpDelivered: true });
    expect(h.notices).toHaveLength(0);
    h.book(150); // b must still be allowed to request its own wrap-up.
    expect(h.requests).toEqual(['thread/inject_items', 'thread/inject_items']);
    h.acknowledgements[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await finishB();
    expect(h.shares.at(-1)).toMatchObject({ turnId: 'b', revision: 0, totalTokens: 160, wrapUpDelivered: true, stopRequested: false });
  });

  it('persists an acknowledgement after the shutdown flush without waiting for another timer', async () => {
    const finish = h.start('a');
    h.book(160);
    await finish();
    h.controller.flush();
    h.acknowledgements[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // Shutdown need not keep the process alive for an unreferenced correction timer.
    expect(h.shares.map(row => [row.revision, row.totalTokens, row.wrapUpDelivered])).toEqual([[0, 160, false], [1, 160, true]]);
    expect(latestTurnShares(readSessionPolicyEvents<SessionTurnShareRecord>('turn-share', 0))[0])
      .toMatchObject({ threadId: 'root', turnId: 'a', revision: 1, totalTokens: 160, wrapUpDelivered: true });
    expect(h.requests).toEqual(['thread/inject_items']);
    expect(h.subscribers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records a retired acknowledgement even when replacement overtook final publication', async () => {
    h.controller.beginTurn('a');
    // A direct deferred transport isolates retirement before finishTurn.
    let acknowledge!: (delivered: boolean) => void;
    const shares: SessionTurnShareRecord[] = [];
    let total = 0;
    const controller = new CodexTurnCeilingController({
      sessionKind: () => 'chat', trial: () => ({}), threadId: () => 'root', cumulativeTokens: () => total,
      deliverWrapUp: () => new Promise<boolean>(resolve => { acknowledge = resolve; }), requestStop: () => undefined,
      emitSystem: () => undefined, publishShare: row => shares.push(row),
      readSettings: () => ({ codexTurnCeilingChatsWrapUpTokens: 150 }),
    });
    controller.beginTurn('a');
    controller.measure(false, () => { total += 160; });
    controller.beginTurn('b');
    acknowledge(true);
    await vi.advanceTimersByTimeAsync(3_000);
    controller.flush();
    expect(shares.map(row => [row.turnId, row.revision, row.wrapUpDelivered])).toEqual([['a', 0, false], ['a', 1, true]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['before', 'after'] as const)('does not claim delivery when injection rejects %s completion', async when => {
    const finish = h.start('a');
    h.book(160);
    if (when === 'after') await finish();
    h.acknowledgements[0]!.reject(new Error('synthetic rejected injection'));
    await vi.advanceTimersByTimeAsync(0);
    if (when === 'before') await finish();
    h.controller.flush();
    expect(h.shares).toHaveLength(1);
    expect(h.shares[0]).toMatchObject({ wrapUpDelivered: false, totalTokens: 160 });
    expect(h.notices).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces delivery and token corrections within the existing revision bound', async () => {
    const finish = h.start('a');
    h.book(160);
    await finish();
    h.book(5, 'a');
    h.acknowledgements[0]!.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.shares.at(-1)).toMatchObject({ revision: 1, totalTokens: 165, wrapUpDelivered: true });
    for (let i = 0; i < 8; i++) {
      h.book(1, 'a');
      await vi.advanceTimersByTimeAsync(3_000);
    }
    h.controller.flush();
    expect(h.shares.map(row => row.revision)).toEqual([0, 1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an acknowledgement after its round was evicted from bounded retention', async () => {
    const finish = h.start('a');
    h.book(160);
    await finish();
    for (let i = 0; i < 5; i++) {
      const end = h.start(`next-${i}`);
      h.book(1);
      await end();
    }
    h.acknowledgements[0]!.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    h.controller.flush();
    expect(h.shares.filter(row => row.turnId === 'a')).toHaveLength(1);
    expect(h.requests).toEqual(['thread/inject_items']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
