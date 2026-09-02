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

  it('extends the checkpoint while heartbeat activity is still arriving', async () => {
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

    await vi.advanceTimersByTimeAsync(20);
    emitter.emit('loop:activity', {
      loopRunId: 'loop-1',
      seq: 0,
      kind: 'heartbeat',
      message: 'CLI heartbeat received',
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(timeouts).toEqual([]);

    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).rejects.toThrow('Loop iteration timed out after 40ms');
    expect(timeouts).toHaveLength(1);
  });
});
