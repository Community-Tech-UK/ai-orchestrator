import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  FOLLOW_UP_DRAIN_MS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_QUEUED_PER_INSTANCE,
  MobileInputQueue,
  isReadyForQueuedInput,
  shouldQueueInput,
  type MobileInputQueueDeps,
} from './mobile-input-queue';
import type { Instance } from '../../shared/types/instance.types';

type QueueInstance = Pick<Instance, 'status' | 'waitReason'>;

function instance(status: string, waitReason?: QueueInstance['waitReason']): QueueInstance {
  return { status, waitReason } as QueueInstance;
}

interface Harness {
  queue: MobileInputQueue;
  deps: MobileInputQueueDeps;
  deliver: ReturnType<typeof vi.fn>;
  setStatus(status: string): void;
  setPaused(paused: boolean): void;
  removeInstance(): void;
  changes: number;
}

function harness(initialStatus = 'busy'): Harness {
  let current: QueueInstance | undefined = instance(initialStatus);
  let paused = false;
  let ids = 0;
  const deliver = vi.fn(async () => undefined);
  const state = {
    changes: 0,
  };
  const deps: MobileInputQueueDeps = {
    getInstance: () => current,
    isPaused: () => paused,
    deliver,
    onChange: () => {
      state.changes += 1;
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    now: () => 1000,
    nextId: () => `q${++ids}`,
  };
  const queue = new MobileInputQueue(deps);
  return {
    queue,
    deps,
    deliver,
    setStatus: (status: string) => {
      current = instance(status);
    },
    setPaused: (value: boolean) => {
      paused = value;
    },
    removeInstance: () => {
      current = undefined;
    },
    get changes() {
      return state.changes;
    },
  };
}

describe('shouldQueueInput', () => {
  it.each([
    'busy',
    'processing',
    'thinking_deeply',
    'waiting_for_permission',
    'respawning',
    'interrupting',
    'cancelling',
    'interrupt-escalating',
    'initializing',
    'waking',
    'hibernating',
    'degraded',
  ])('queues while %s', (status) => {
    expect(shouldQueueInput(instance(status), false)).toBe(true);
  });

  it.each(['idle', 'ready', 'waiting_for_input'])('sends immediately while %s', (status) => {
    expect(shouldQueueInput(instance(status), false)).toBe(false);
    expect(isReadyForQueuedInput(instance(status), false)).toBe(true);
  });

  it('leaves hibernated and terminal sends on the direct path', () => {
    // Unchanged behaviour: a hibernated session needs an explicit wake, and a
    // terminal one should surface its real error rather than park silently.
    expect(shouldQueueInput(instance('hibernated'), false)).toBe(false);
    expect(shouldQueueInput(instance('error'), false)).toBe(false);
  });

  it('queues while globally paused, even when idle', () => {
    expect(shouldQueueInput(instance('idle'), true)).toBe(true);
    expect(isReadyForQueuedInput(instance('idle'), true)).toBe(false);
  });

  it('queues a quota-parked instance that looks idle', () => {
    const parked = instance('idle', { kind: 'quota-park', provider: 'codex', resumeAt: 5 });
    expect(shouldQueueInput(parked, false)).toBe(true);
    expect(isReadyForQueuedInput(parked, false)).toBe(false);
  });
});

describe('MobileInputQueue', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  afterEach(() => {
    // Cancels any pending follow-up drain so it can't fire into a later test.
    h.queue.clearAll();
  });

  it('holds messages while busy and delivers them in order once ready', async () => {
    h.queue.enqueue('i1', 'first');
    h.queue.enqueue('i1', 'second');
    expect(h.queue.size('i1')).toBe(2);

    await h.queue.drain('i1');
    expect(h.deliver).not.toHaveBeenCalled();

    // One per ready edge, exactly like the desktop queue.
    h.setStatus('idle');
    await h.queue.drain('i1');
    expect(h.deliver.mock.calls.map((c) => c[1])).toEqual(['first']);

    await h.queue.drain('i1');
    expect(h.deliver.mock.calls.map((c) => c[1])).toEqual(['first', 'second']);
    expect(h.queue.size('i1')).toBe(0);
    expect(h.queue.toDto('i1')).toBeUndefined();
  });

  it('does not send a second message into the turn it just started', async () => {
    h.setStatus('idle');
    h.queue.enqueue('i1', 'first');
    h.queue.enqueue('i1', 'second');
    h.deliver.mockImplementationOnce(async () => {
      h.setStatus('busy');
    });

    await h.queue.drain('i1');

    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.queue.size('i1')).toBe(1);
  });

  it('re-checks a still-loaded queue when a delivery produced no status edge', async () => {
    vi.useFakeTimers();
    try {
      h.setStatus('idle');
      h.queue.enqueue('i1', 'first');
      h.queue.enqueue('i1', 'second');

      await h.queue.drain('i1');
      expect(h.deliver).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(FOLLOW_UP_DRAIN_MS + 1);
      expect(h.deliver).toHaveBeenCalledTimes(2);
      expect(h.queue.size('i1')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never runs two drains for the same instance at once', async () => {
    h.setStatus('idle');
    h.queue.enqueue('i1', 'first');
    h.queue.enqueue('i1', 'second');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.deliver.mockImplementationOnce(async () => { await gate; });

    const firstDrain = h.queue.drain('i1');
    await h.queue.drain('i1'); // must no-op while the first is in flight
    expect(h.deliver).toHaveBeenCalledTimes(1);

    release();
    await firstDrain;
    // Still one: the second call was rejected, not deferred into a double-send.
    expect(h.deliver).toHaveBeenCalledTimes(1);

    await h.queue.drain('i1');
    expect(h.deliver).toHaveBeenCalledTimes(2);
  });

  it('retries a failed head on later ready edges, then parks it with the error', async () => {
    h.setStatus('idle');
    h.queue.enqueue('i1', 'first');
    h.queue.enqueue('i1', 'second');
    h.deliver.mockRejectedValue(new Error('active turn'));

    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await h.queue.drain('i1');
    }

    expect(h.deliver).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
    const dto = h.queue.toDto('i1');
    expect(dto?.[0]).toMatchObject({ message: 'first', attempts: 3, error: 'active turn' });
    // The failed head blocks the rest rather than silently reordering them.
    expect(dto).toHaveLength(2);

    await h.queue.drain('i1');
    expect(h.deliver).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
  });

  it('resumes the queue once the failed head is cancelled', async () => {
    h.setStatus('idle');
    h.queue.enqueue('i1', 'first');
    h.queue.enqueue('i1', 'second');
    h.deliver.mockRejectedValue(new Error('nope'));
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await h.queue.drain('i1');
    }

    const cancelled = h.queue.cancel('i1', h.queue.toDto('i1')![0].id);
    expect(cancelled?.message).toBe('first');

    h.deliver.mockResolvedValue(undefined);
    await h.queue.drain('i1');
    expect(h.deliver).toHaveBeenLastCalledWith('i1', 'second', undefined);
    expect(h.queue.size('i1')).toBe(0);
  });

  it('fails the head instead of retrying when the session went terminal', async () => {
    h.queue.enqueue('i1', 'first');
    h.setStatus('failed');

    await h.queue.drain('i1');

    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.queue.toDto('i1')?.[0].error).toContain('failed');
  });

  it('drops the queue when the instance disappeared', async () => {
    h.queue.enqueue('i1', 'first');
    h.removeInstance();

    await h.queue.drain('i1');

    expect(h.queue.size('i1')).toBe(0);
  });

  it('holds while paused and delivers when the pause lifts', async () => {
    h.setStatus('idle');
    h.setPaused(true);
    h.queue.enqueue('i1', 'first');

    await h.queue.drain('i1');
    expect(h.deliver).not.toHaveBeenCalled();

    h.setPaused(false);
    await h.queue.drain('i1');
    expect(h.deliver).toHaveBeenCalledWith('i1', 'first', undefined);
  });

  it('refuses to queue past the per-instance cap', () => {
    for (let i = 0; i < MAX_QUEUED_PER_INSTANCE; i += 1) {
      expect(h.queue.enqueue('i1', `m${i}`)).not.toBeNull();
    }
    expect(h.queue.enqueue('i1', 'one too many')).toBeNull();
    expect(h.queue.size('i1')).toBe(MAX_QUEUED_PER_INSTANCE);
  });

  it('exposes queue state (including attachments) for the snapshot', () => {
    h.queue.enqueue('i1', 'with photo', [
      { name: 'a.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' },
    ]);
    expect(h.queue.toDto('i1')).toEqual([
      { id: 'q1', message: 'with photo', hasAttachments: true, enqueuedAt: 1000, attempts: 0 },
    ]);
    expect(h.queue.toDto('other')).toBeUndefined();
  });

  it('clears a queue on demand and notifies the snapshot', () => {
    h.queue.enqueue('i1', 'first');
    const before = h.changes;
    h.queue.clear('i1');
    expect(h.queue.size('i1')).toBe(0);
    expect(h.changes).toBeGreaterThan(before);
  });
});
