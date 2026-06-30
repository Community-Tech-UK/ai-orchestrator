import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { streamLoopEvents } from './loop-stream';
import type { LoopStreamEvent } from '../../shared/types/loop.types';

describe('streamLoopEvents', () => {
  it('yields completed-needs-review and then closes the stream', async () => {
    const emitter = new EventEmitter();
    const stream = streamLoopEvents({ emitter, loopRunId: 'loop-1', chatId: 'chat-1' });

    await expect(nextStreamEvent(stream)).resolves.toMatchObject({
      value: { type: 'started', loopRunId: 'loop-1', chatId: 'chat-1' },
      done: false,
    });

    emitter.emit('loop:completed-needs-review', {
      loopRunId: 'loop-1',
      reason: 'operator accepted completion',
      acceptedByOperator: true,
    });

    await expect(nextStreamEvent(stream)).resolves.toMatchObject({
      value: {
        type: 'completed-needs-review',
        loopRunId: 'loop-1',
        reason: 'operator accepted completion',
        acceptedByOperator: true,
      },
      done: false,
    });
    await expect(nextStreamEvent(stream)).resolves.toMatchObject({ done: true });
  });

  it('yields state-change-only ping-pong terminal statuses and then closes the stream', async () => {
    const emitter = new EventEmitter();
    const stream = streamLoopEvents({ emitter, loopRunId: 'loop-1', chatId: 'chat-1' });

    await expect(nextStreamEvent(stream)).resolves.toMatchObject({
      value: { type: 'started', loopRunId: 'loop-1', chatId: 'chat-1' },
      done: false,
    });

    emitter.emit('loop:state-changed', {
      loopRunId: 'loop-1',
      state: {
        id: 'loop-1',
        status: 'reviewer-unreliable',
        endReason: 'reviewer produced unusable output',
      },
    });

    await expect(nextStreamEvent(stream)).resolves.toMatchObject({
      value: {
        type: 'terminal-status',
        loopRunId: 'loop-1',
        status: 'reviewer-unreliable',
        reason: 'reviewer produced unusable output',
      },
      done: false,
    });
    await expect(nextStreamEvent(stream)).resolves.toMatchObject({ done: true });
  });

  it('does not close on a restored resumable provider-limit state-change', async () => {
    const emitter = new EventEmitter();
    const stream = streamLoopEvents({ emitter, loopRunId: 'loop-1', chatId: 'chat-1' });

    await expect(nextStreamEvent(stream)).resolves.toMatchObject({
      value: { type: 'started', loopRunId: 'loop-1', chatId: 'chat-1' },
      done: false,
    });

    emitter.emit('loop:state-changed', {
      loopRunId: 'loop-1',
      state: {
        id: 'loop-1',
        status: 'provider-limit',
        endedAt: null,
        endReason: 'provider window exhausted',
      },
    });
    emitter.emit('loop:iteration-started', {
      loopRunId: 'loop-1',
      seq: 4,
      stage: 'IMPLEMENT',
    });

    await expect(nextStreamEvent(stream)).resolves.toMatchObject({
      value: {
        type: 'iteration-started',
        loopRunId: 'loop-1',
        seq: 4,
        stage: 'IMPLEMENT',
      },
      done: false,
    });
    await stream.return(undefined);
  });
});

function nextStreamEvent(stream: AsyncGenerator<LoopStreamEvent>, timeoutMs = 250) {
  return Promise.race([
    stream.next(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('stream did not yield an event')), timeoutMs);
    }),
  ]);
}
