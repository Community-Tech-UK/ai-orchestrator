import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import { invokeLoopChildIteration, LOOP_TIMEOUT_SETTLEMENT_GRACE_MS } from './loop-child-invoker';

function makeState(over: {
  id?: string;
  totalIterations?: number;
  iterationTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
} = {}): LoopState {
  return {
    id: over.id ?? 'loop-1',
    chatId: 'chat-1',
    totalIterations: over.totalIterations ?? 0,
    config: {
      provider: 'cursor',
      workspaceCwd: '/tmp',
      iterationTimeoutMs: over.iterationTimeoutMs ?? 40,
      streamIdleTimeoutMs: over.streamIdleTimeoutMs ?? 20,
    },
  } as LoopState;
}

describe('invokeLoopChildIteration timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits loop:iteration-timeout then rejects when the child stays silent', async () => {
    const emitter = new EventEmitter();
    const timeouts: unknown[] = [];
    emitter.on('loop:invoke-iteration', () => { /* never settle */ });
    emitter.on('loop:iteration-timeout', (payload) => timeouts.push(payload));

    const pending = invokeLoopChildIteration({
      emitter,
      state: makeState(),
      prompt: 'go',
      stage: 'IMPLEMENT',
      forceContextReset: false,
      idempotencyKey: 'k-1',
    });
    const expectTimeout = expect(pending).rejects.toThrow('Loop iteration timed out after 40ms');

    await vi.advanceTimersByTimeAsync(40 + LOOP_TIMEOUT_SETTLEMENT_GRACE_MS);
    await expectTimeout;
    expect(timeouts).toEqual([
      expect.objectContaining({ loopRunId: 'loop-1', seq: 0, iterationTimeoutMs: 40 }),
    ]);
  });

  it('does not extend the checkpoint on heartbeat-only activity', async () => {
    const emitter = new EventEmitter();
    emitter.on('loop:invoke-iteration', () => { /* never settle */ });
    const timeouts: unknown[] = [];
    emitter.on('loop:iteration-timeout', (payload) => timeouts.push(payload));

    const pending = invokeLoopChildIteration({
      emitter,
      state: makeState({ iterationTimeoutMs: 40, streamIdleTimeoutMs: 30 }),
      prompt: 'go',
      stage: 'IMPLEMENT',
      forceContextReset: false,
      idempotencyKey: 'k-2',
    });
    const expectTimeout = expect(pending).rejects.toThrow('Loop iteration timed out after 40ms');

    await vi.advanceTimersByTimeAsync(20);
    emitter.emit('loop:activity', {
      loopRunId: 'loop-1',
      seq: 0,
      kind: 'heartbeat',
      message: 'CLI heartbeat received',
    });
    await vi.advanceTimersByTimeAsync(20 + LOOP_TIMEOUT_SETTLEMENT_GRACE_MS);
    await expectTimeout;
    expect(timeouts).toHaveLength(1);
  });

  it('extends the checkpoint while tool activity is still arriving, up to the wall cap', async () => {
    const emitter = new EventEmitter();
    emitter.on('loop:invoke-iteration', () => { /* never settle */ });
    const timeouts: unknown[] = [];
    emitter.on('loop:iteration-timeout', (payload) => timeouts.push(payload));

    const pending = invokeLoopChildIteration({
      emitter,
      state: makeState({ iterationTimeoutMs: 40, streamIdleTimeoutMs: 30 }),
      prompt: 'go',
      stage: 'IMPLEMENT',
      forceContextReset: false,
      idempotencyKey: 'k-3',
    });

    await vi.advanceTimersByTimeAsync(20);
    emitter.emit('loop:activity', {
      loopRunId: 'loop-1',
      seq: 0,
      kind: 'tool_use',
      message: 'tool started',
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(timeouts).toEqual([]);

    await vi.advanceTimersByTimeAsync(50 + LOOP_TIMEOUT_SETTLEMENT_GRACE_MS);
    await expect(pending).rejects.toThrow('Loop iteration timed out after 40ms');
    expect(timeouts).toHaveLength(1);
  });

  it('waits for an interrupted success-shaped callback and rejects with its observed effects and usage', async () => {
    const emitter = new EventEmitter();
    let callback: ((result: unknown) => void) | undefined;
    emitter.on('loop:invoke-iteration', (payload: { callback: (result: unknown) => void }) => {
      callback = payload.callback;
    });
    const timeouts: unknown[] = [];
    emitter.on('loop:iteration-timeout', (payload) => timeouts.push(payload));

    const pending = invokeLoopChildIteration({
      emitter,
      state: makeState(),
      prompt: 'go',
      stage: 'IMPLEMENT',
      forceContextReset: false,
      idempotencyKey: 'k-observed',
    });
    const failurePromise = pending.then(
      () => { throw new Error('timed-out partial response must not complete the iteration'); },
      (err: unknown) => err as Error & { attemptEvidence?: unknown; partialUsage?: unknown },
    );

    await vi.advanceTimersByTimeAsync(40);
    expect(timeouts).toHaveLength(1);
    callback?.({
      childInstanceId: null,
      output: 'partial work',
      tokens: 300,
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
      filesChanged: [{ path: 'src/changed.ts', additions: 1, deletions: 0, contentHash: 'hash' }],
      toolCalls: [],
      errors: [],
      testPassCount: null,
      testFailCount: null,
      exitedCleanly: true,
      attemptEvidence: {
        outcome: 'completed',
        outputExcerpt: 'partial work',
        workspaceEffect: 'writes-observed',
        filesChanged: [{ path: 'src/changed.ts', additions: 1, deletions: 0, contentHash: 'hash' }],
        providerThreadReusable: false,
      },
    });
    const failure = await failurePromise;
    expect(failure.message).toContain('timed out');
    expect(failure.attemptEvidence).toEqual(expect.objectContaining({
      outcome: 'failed',
      workspaceEffect: 'writes-observed',
    }));
    expect(failure.partialUsage).toEqual({ inputTokens: 200, outputTokens: 100, totalTokens: 300 });
    expect(emitter.listenerCount('loop:activity')).toBe(0);
  });

  it('retains a failed callback workspace observation after timeout', async () => {
    const emitter = new EventEmitter();
    let callback: ((result: unknown) => void) | undefined;
    emitter.on('loop:invoke-iteration', (payload: { callback: (result: unknown) => void }) => {
      callback = payload.callback;
    });
    const pending = invokeLoopChildIteration({
      emitter,
      state: makeState(),
      prompt: 'go',
      stage: 'IMPLEMENT',
      forceContextReset: false,
      idempotencyKey: 'k-failed-observed',
    });
    const failurePromise = pending.then(
      () => { throw new Error('expected timeout'); },
      (err: unknown) => err as Error & { attemptEvidence?: unknown },
    );
    await vi.advanceTimersByTimeAsync(40);
    callback?.({
      error: 'provider interrupted',
      attemptEvidence: {
        outcome: 'failed',
        outputExcerpt: 'provider interrupted',
        workspaceEffect: 'none-observed',
        filesChanged: [],
        providerThreadReusable: false,
      },
    });
    expect((await failurePromise).attemptEvidence).toEqual(expect.objectContaining({ workspaceEffect: 'none-observed' }));
  });
});

describe('invokeLoopChildIteration failure payload', () => {
  it('carries sanitized partial usage onto the rejected Error so it survives to the coordinator', async () => {
    const emitter = new EventEmitter();
    emitter.on('loop:invoke-iteration', (payload: { callback: (result: unknown) => void }) => {
      payload.callback({
        error: 'ACP prompt turn failed.',
        model: 'grok-4.6',
        partialUsage: { inputTokens: 1_200, outputTokens: 800, totalTokens: 2_000, isEstimated: true },
      });
    });

    const failure = await invokeLoopChildIteration({
      emitter,
      state: makeState({ iterationTimeoutMs: 10_000, streamIdleTimeoutMs: 5_000 }),
      prompt: 'go',
      stage: 'IMPLEMENT',
      forceContextReset: false,
      idempotencyKey: 'k-partial',
    }).then(
      () => { throw new Error('expected the iteration to reject'); },
      (err: unknown) => err as Error & { partialUsage?: unknown; model?: string },
    );

    expect(failure.message).toBe('ACP prompt turn failed.');
    expect(failure.model).toBe('grok-4.6');
    expect(failure.partialUsage).toEqual({
      inputTokens: 1_200,
      outputTokens: 800,
      totalTokens: 2_000,
      isEstimated: true,
    });
  });

  it('leaves partial usage off an error the child reported without it', async () => {
    const emitter = new EventEmitter();
    emitter.on('loop:invoke-iteration', (payload: { callback: (result: unknown) => void }) => {
      payload.callback({ error: 'spawn failed' });
    });

    const failure = await invokeLoopChildIteration({
      emitter,
      state: makeState({ iterationTimeoutMs: 10_000, streamIdleTimeoutMs: 5_000 }),
      prompt: 'go',
      stage: 'IMPLEMENT',
      forceContextReset: false,
      idempotencyKey: 'k-nopartial',
    }).then(
      () => { throw new Error('expected the iteration to reject'); },
      (err: unknown) => err as Error & { partialUsage?: unknown },
    );

    expect(failure.message).toBe('spawn failed');
    expect('partialUsage' in failure).toBe(false);
  });
});
