import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import { invokeLoopChildIteration } from './loop-child-invoker';

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

    await vi.advanceTimersByTimeAsync(40);
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
    await vi.advanceTimersByTimeAsync(20);
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

    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).rejects.toThrow('Loop iteration timed out after 40ms');
    expect(timeouts).toHaveLength(1);
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
