import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import { InstanceContinuationDispatch } from './instance-continuation-dispatch';
import { InstanceWaitingCheckIn, WAITING_CHECK_IN_DELAYS_MS } from './instance-waiting-check-in';
import type { Instance } from '../../shared/types/instance.types';

const MINUTE = 60_000;
const WAITING = "The page works. I'm waiting for the PC's result.";

describe('InstanceWaitingCheckIn', () => {
  let events: EventEmitter;
  let instance: Instance;
  let registry: InstanceAsyncWorkRegistry;
  let dispatch: InstanceContinuationDispatch;
  let checkIn: InstanceWaitingCheckIn;
  let paused = false;
  const sendInput = vi.fn();
  const finishTurn = (content = WAITING) => {
    events.emit('provider:normalized-event', {
      instanceId: 'root', provider: 'claude',
      event: { kind: 'complete', requestCountAtCompletion: instance.requestCount, turnEnding: { reason: 'completed', evidence: 'native_completed' } },
      raw: { source: 'adapter-event:complete', payload: { content } },
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sendInput.mockReset();
    sendInput.mockImplementation(async (_id, _prompt, _attachments, options) => {
      options?.beforeProviderDispatch?.();
      instance.requestCount += 1;
    });
    events = new EventEmitter();
    instance = { id: 'root', parentId: null, launchMode: 'orchestrated', provider: 'claude', sessionId: 's', adapterGeneration: 1,
      status: 'idle', requestCount: 3, outputBuffer: [] } as unknown as Instance;
    registry = new InstanceAsyncWorkRegistry();
    const host = {
      on: events.on.bind(events), off: events.off.bind(events), getInstance: () => instance,
      waitForInstanceSettled: async () => instance, sendInput,
    };
    paused = false;
    dispatch = new InstanceContinuationDispatch(registry, host, () => false, () => paused);
    dispatch.start();
    checkIn = new InstanceWaitingCheckIn(host, dispatch);
    checkIn.start();
  });
  afterEach(() => { checkIn.stop(); dispatch.stop(); vi.useRealTimers(); });

  it('checks in after five minutes, quoting what it was waiting for', async () => {
    finishTurn();
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(sendInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput.mock.calls[0]?.[1]).toContain("I'm waiting for the PC's result.");
    expect(sendInput.mock.calls[0]?.[3]).toMatchObject({ autoContinuation: true, internalSource: 'waiting-check-in' });
  });

  it('backs off, then gives up after the last check-in', async () => {
    for (const delay of WAITING_CHECK_IN_DELAYS_MS) {
      finishTurn("I'm waiting for the tests.");
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(sendInput).toHaveBeenCalledTimes(WAITING_CHECK_IN_DELAYS_MS.length);
    finishTurn("I'm waiting for the tests.");
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE);
    expect(sendInput).toHaveBeenCalledTimes(WAITING_CHECK_IN_DELAYS_MS.length);
  });

  it('stops when a reply no longer waits on anything', async () => {
    finishTurn();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    finishTurn('The work is complete.');
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE);
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('leaves a reply alone when it waits on the user', async () => {
    finishTurn("I'm waiting for your decision.");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('cancels on any new input, and a user message restarts the series', async () => {
    finishTurn();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    finishTurn();
    events.emit('instance:input-started', { instanceId: 'root', autoContinuation: false });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(sendInput).toHaveBeenCalledTimes(1);
    finishTurn();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sendInput).toHaveBeenCalledTimes(2);
  });

  it('lets tracked background work own the wake, and looks again later', async () => {
    registry.observe('root', { phase: 'started', workId: 'bg', kind: 'background-shell' });
    finishTurn();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sendInput).not.toHaveBeenCalled();
    registry.clearInstance('root');
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('never checks in on a helper session', async () => {
    (instance as { parentId: string | null }).parentId = 'parent';
    finishTurn();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tries again when a check comes due during a pause', async () => {
    paused = true;
    finishTurn();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sendInput).not.toHaveBeenCalled();
    paused = false;
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('tries again when a check comes due while the session is busy', async () => {
    finishTurn();
    instance.status = 'busy';
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sendInput).not.toHaveBeenCalled();
    instance.status = 'idle';
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('stops after the last due check even if none could be sent', async () => {
    paused = true;
    finishTurn();
    await vi.advanceTimersByTimeAsync(75 * MINUTE);
    expect(vi.getTimerCount()).toBe(0);
    paused = false;
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('works for a provider that reports no request count at completion', async () => {
    events.emit('provider:normalized-event', {
      instanceId: 'root', provider: 'copilot', event: { kind: 'complete' },
      raw: { source: 'adapter-event:complete', payload: { content: WAITING } },
    });
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('holds no timers after stopping', () => {
    finishTurn();
    checkIn.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wakes a session that went to sleep while waiting', async () => {
    const wakeInstance = vi.fn(async () => { instance.status = 'ready'; });
    checkIn.stop(); dispatch.stop();
    const host = { on: events.on.bind(events), off: events.off.bind(events), getInstance: () => instance,
      waitForInstanceSettled: async () => instance, sendInput, wakeInstance };
    dispatch = new InstanceContinuationDispatch(registry, host);
    dispatch.start();
    checkIn = new InstanceWaitingCheckIn(host, dispatch);
    checkIn.start();
    finishTurn();
    instance.status = 'hibernated';
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(wakeInstance).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledTimes(1);
  });
});
