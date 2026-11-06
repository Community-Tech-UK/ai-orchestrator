import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import { InstanceCrashTurnContinuation, type InstanceCrashTurnContinuationHost } from './instance-crash-turn-continuation';
import { InstanceSettledTracker } from './instance-settled-tracker';
import { isInstanceSettled } from './instance-state-machine';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('first-turn crash recovery with the real settlement tracker', () => {
  const cleanup: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const dispose of cleanup.splice(0)) dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function harness(id = 'fresh-session') {
    const events = new EventEmitter();
    const instance = {
      id, provider: 'claude', sessionId: 'original-session', adapterGeneration: 1,
      parentId: null, launchMode: 'orchestrated', status: 'idle', requestCount: 1,
      createdAt: Date.now(), lastActivity: Date.now(),
      outputBuffer: [{ id: 'first-user-message', type: 'user', content: 'Continue the task.', timestamp: Date.now() }],
    } as Instance;
    const tracker = new InstanceSettledTracker({ getInstance: () => instance, emitter: events });
    const transition = (status: Instance['status']) => {
      const previousStatus = instance.status;
      instance.status = status;
      tracker.recordActivity(id);
      events.emit('instance:state-changed', { instanceId: id, previousStatus, status });
    };
    const sendInput = vi.fn<InstanceCrashTurnContinuationHost['sendInput']>(async (_id, _text, _attachments, options) => {
      options?.beforeProviderDispatch?.();
      instance.requestCount += 1;
      events.emit('instance:input-started', { instanceId: id, autoContinuation: true });
      transition('busy');
    });
    const notices = vi.fn();
    const paused = vi.fn(() => false);
    const managed = vi.fn(() => false);
    const host: InstanceCrashTurnContinuationHost = {
      on: events.on.bind(events), off: events.off.bind(events), getInstance: () => instance,
      waitForInstanceSettled: (instanceId, options) => tracker.waitForSettled(instanceId, options),
      sendInput, emitSystemMessage: notices,
    };
    const continuation = new InstanceCrashTurnContinuation(new InstanceAsyncWorkRegistry(), host, managed, paused);
    continuation.start();
    cleanup.push(() => { continuation.stop(); tracker.destroy(); });
    const recover = () => {
      transition('busy');
      transition('respawning');
      instance.adapterGeneration = 2;
      instance.sessionId = `replacement-${id}`;
      instance.waitReason = { kind: 'respawning', strategy: 'fresh-replay', startedAt: Date.now() };
      transition('idle');
      const message = { id: 'restarted', type: 'system' as const, content: 'Session restarted automatically (resume failed)', timestamp: Date.now() };
      instance.outputBuffer.push(message);
      tracker.recordActivity(id);
      events.emit('provider:normalized-event', {
        eventId: 'recovery', seq: 1, timestamp: Date.now(), provider: 'claude', instanceId: id,
        event: { kind: 'output', messageType: 'system', content: message.content, metadata: { autoRespawn: true } },
      });
    };
    return { instance, events, tracker, sendInput, notices, paused, managed, recover };
  }

  it.each([1, 2, 3, 4, 5])('continues a fresh first-turn replay exactly once (trial %s)', async (trial) => {
    const h = harness(`fresh-${trial}`);
    h.recover();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.sendInput).toHaveBeenCalledOnce();
    expect(h.notices).toHaveBeenCalledWith(h.instance.id,
      'Continuing the interrupted turn automatically (attempt 1 of 2).',
      { source: 'crash-turn-continuation', attempt: 1 });
    expect(h.instance.outputBuffer.every((message) => message.type === 'user' || message.type === 'system')).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sendInput).toHaveBeenCalledOnce();
  });

  it.each(['provider-turn', 'interrupt'] as const)('waits for an outstanding %s before sending', async (pending) => {
    const h = harness();
    h.recover();
    if (pending === 'provider-turn') h.instance.activeTurnId = 'live-native-turn';
    else { h.instance.interruptRequestId = 'stop-request'; h.instance.interruptPhase = 'requested'; }
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendInput).not.toHaveBeenCalled();

    h.instance.activeTurnId = undefined;
    h.instance.interruptPhase = 'completed';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sendInput).toHaveBeenCalledOnce();
  });

  it.each(['user-input', 'stop', 'pause', 'loop', 'replacement'] as const)('cancels recovery on %s while waiting', async (cancel) => {
    const h = harness();
    h.recover();
    if (cancel === 'user-input') h.events.emit('instance:input-started', { instanceId: h.instance.id, autoContinuation: false });
    if (cancel === 'stop') h.events.emit('instance:interrupt-requested', { instanceId: h.instance.id });
    if (cancel === 'pause') h.paused.mockReturnValue(true);
    if (cancel === 'loop') h.managed.mockReturnValue(true);
    if (cancel === 'replacement') h.instance.adapterGeneration = 3;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sendInput).not.toHaveBeenCalled();
  });

  it('keeps completed-turn evaluation strict for the same outputless idle session', () => {
    const h = harness();
    expect(isInstanceSettled({ status: 'idle', outputBuffer: h.instance.outputBuffer })).toBe(false);
  });
});
