import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';

import { InstanceSettledTracker } from './instance-settled-tracker';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

function output(type: OutputMessage['type'], timestamp: number): OutputMessage {
  return {
    id: `${type}-${timestamp}`,
    type,
    content: `${type} output`,
    timestamp,
  };
}

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    provider: 'claude',
    workingDirectory: '/repo',
    status: 'idle',
    createdAt: 1_000,
    lastActivity: 1_100,
    outputBuffer: [output('assistant', 1_100)],
    activeTurnId: undefined,
    interruptRequestId: undefined,
    interruptPhase: undefined,
    ...overrides,
  } as Instance;
}

describe('InstanceSettledTracker', () => {
  it('emits a settled event only when the state-machine predicate passes', () => {
    const current = instance();
    const emitter = new EventEmitter();
    const tracker = new InstanceSettledTracker({
      getInstance: (id) => (id === current.id ? current : undefined),
      emitter,
    });
    const settled: unknown[] = [];
    emitter.on('instance:settled', (event) => settled.push(event));

    tracker.maybeEmit(current.id);

    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      instanceId: current.id,
      status: 'idle',
      outputMessageId: 'assistant-1100',
    });
  });

  it('waits for a later settled event and re-checks the watched timestamp', async () => {
    const current = instance({
      outputBuffer: [output('assistant', 900)],
    });
    const emitter = new EventEmitter();
    const tracker = new InstanceSettledTracker({
      getInstance: (id) => (id === current.id ? current : undefined),
      emitter,
    });
    const waiting = tracker.waitForSettled(current.id, {
      afterTimestamp: 1_000,
      timeoutMs: 1_000,
      debounceMs: 0,
    });

    current.outputBuffer.push(output('assistant', 1_100));
    emitter.emit('instance:settled', {
      instanceId: current.id,
      status: 'idle',
      timestamp: Date.now(),
      instance: current,
    });

    await expect(waiting).resolves.toBe(current);
  });

  it('settles an error state after the watched timestamp even without output', async () => {
    const current = instance({
      status: 'error',
      outputBuffer: [],
    });
    const emitter = new EventEmitter();
    const tracker = new InstanceSettledTracker({
      getInstance: (id) => (id === current.id ? current : undefined),
      emitter,
    });
    tracker.recordActivity(current.id, 1_100);

    await expect(tracker.waitForSettled(current.id, {
      afterTimestamp: 1_000,
      timeoutMs: 1_000,
      debounceMs: 0,
    })).resolves.toBe(current);
  });

  it('settles an outputless error state through the default debounce path', async () => {
    const now = Date.now();
    const current = instance({
      status: 'error',
      outputBuffer: [],
    });
    const emitter = new EventEmitter();
    const tracker = new InstanceSettledTracker({
      getInstance: (id) => (id === current.id ? current : undefined),
      emitter,
    });
    tracker.recordActivity(current.id, now - 1_000);

    await expect(tracker.waitForSettled(current.id, {
      afterTimestamp: now - 2_000,
      timeoutMs: 1_000,
    })).resolves.toBe(current);
  });
});
