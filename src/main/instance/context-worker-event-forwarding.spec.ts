/**
 * Regression coverage for LT-206: RLMContextManager and WakeContextBuilder
 * are per-process singletons (same class of bug as LT-169/LT-170). Production
 * RLM store/section activity and per-turn wake-context generation both happen
 * inside the context-worker process, so main's own separate singleton
 * instance never observed those events until this fix — the renderer's
 * RLM_STORE_UPDATED/RLM_SECTION_ADDED/RLM_SECTION_REMOVED/RLM_QUERY_COMPLETE
 * and WAKE_EVENT_CONTEXT_GENERATED channels went dead for all worker-routed
 * (i.e. real) usage.
 */

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextWorkerClient } from './context-worker-client';
import { registerWorkerEventForwarding, dispatchWorkerBroadcast } from './context-worker-event-forwarding';
import { RLMContextManager } from '../rlm/context-manager';
import { WakeContextBuilder, getWakeContextBuilder } from '../memory/wake-context-builder';
import type { ContextWorkerOutboundMsg } from './context-worker-protocol';

/** Minimal IsolatedWorkerProcess fake: a real EventEmitter plus the two
 * methods ContextWorkerClient calls on it (postMessage/terminate). */
function makeFakeWorkerHandle() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    postMessage: vi.fn(),
    terminate: vi.fn().mockResolvedValue(0),
  });
}

describe('LT-206: worker-side registration posts RLM/wake events across the transport', () => {
  afterEach(() => {
    RLMContextManager._resetForTesting();
    WakeContextBuilder._resetForTesting();
  });

  it('posts a worker-event message when the worker-local RLMContextManager emits an allowlisted event', () => {
    const transport = { postMessage: vi.fn() };
    registerWorkerEventForwarding(transport);

    const rlm = RLMContextManager.getInstance();
    const store = rlm.createStore('worker-local-instance');

    expect(transport.postMessage).toHaveBeenCalledWith({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: store,
    });
  });

  it('posts a worker-event message when the worker-local WakeContextBuilder emits wake:context-generated', () => {
    const transport = { postMessage: vi.fn() };
    registerWorkerEventForwarding(transport);

    getWakeContextBuilder().generateWakeContext(undefined, { bypassCache: true });

    expect(transport.postMessage).toHaveBeenCalledWith({
      type: 'worker-event',
      source: 'wake-context',
      event: 'wake:context-generated',
      payload: expect.objectContaining({ wing: undefined }),
    });
  });

  it('does NOT forward wake:hint-added — addHint() has no worker call path in production', () => {
    const transport = { postMessage: vi.fn() };
    registerWorkerEventForwarding(transport);

    // Directly emitting the event (rather than calling addHint, which needs a
    // real DB) is sufficient to prove no subscription was registered for it.
    getWakeContextBuilder().emit('wake:hint-added', { id: 'h1', content: 'x', importance: 5 });

    expect(transport.postMessage).not.toHaveBeenCalled();
  });
});

describe('LT-206: main-side dispatch re-emits on main\'s own RLMContextManager/WakeContextBuilder singleton', () => {
  afterEach(() => {
    RLMContextManager._resetForTesting();
    WakeContextBuilder._resetForTesting();
  });

  it('re-emits a forwarded RLM store:created event on the main-process singleton', () => {
    const received: unknown[] = [];
    RLMContextManager.getInstance().on('store:created', (store) => received.push(store));

    const store = { id: 'store-1', instanceId: 'inst-1' };
    dispatchWorkerBroadcast({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: store,
    } satisfies ContextWorkerOutboundMsg);

    expect(received).toEqual([store]);
  });

  it('re-emits a forwarded RLM section:added event on the main-process singleton', () => {
    const received: unknown[] = [];
    RLMContextManager.getInstance().on('section:added', (data) => received.push(data));

    const payload = { store: { id: 'store-1' }, section: { id: 'sec-1' } };
    dispatchWorkerBroadcast({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'section:added',
      payload,
    } satisfies ContextWorkerOutboundMsg);

    expect(received).toEqual([payload]);
  });

  it('re-emits a forwarded wake:context-generated event on the main-process singleton', () => {
    const received: unknown[] = [];
    getWakeContextBuilder().on('wake:context-generated', (data) => received.push(data));

    const payload = { totalTokens: 42, wing: 'lt206-wing' };
    dispatchWorkerBroadcast({
      type: 'worker-event',
      source: 'wake-context',
      event: 'wake:context-generated',
      payload,
    } satisfies ContextWorkerOutboundMsg);

    expect(received).toEqual([payload]);
  });
});

describe('ContextWorkerClient (LT-206: RLM + wake-context cross-process forwarding, end to end)', () => {
  let fakeWorker: ReturnType<typeof makeFakeWorkerHandle>;
  let client: ContextWorkerClient;

  beforeEach(() => {
    RLMContextManager._resetForTesting();
    WakeContextBuilder._resetForTesting();
    fakeWorker = makeFakeWorkerHandle();
    client = new ContextWorkerClient({
      userDataPath: '/tmp/lt206-spec',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workerFactory: (): any => fakeWorker,
    });
  });

  afterEach(async () => {
    await client.shutdown();
    RLMContextManager._resetForTesting();
    WakeContextBuilder._resetForTesting();
  });

  it('a worker-emitted RLM_STORE_UPDATED-source event reaches a listener on main\'s RLMContextManager singleton', () => {
    const received: unknown[] = [];
    RLMContextManager.getInstance().on('store:created', (store) => received.push(store));

    const store = { id: 'store-e2e', instanceId: 'inst-e2e' };
    // Simulate the context worker's outbound message the way the real
    // worker_threads/utilityProcess transport delivers it.
    fakeWorker.emit('message', {
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: store,
    } satisfies ContextWorkerOutboundMsg);

    expect(received).toEqual([store]);
  });

  it('a worker-emitted WAKE_EVENT_CONTEXT_GENERATED-source event reaches a listener on main\'s WakeContextBuilder singleton', () => {
    const received: unknown[] = [];
    getWakeContextBuilder().on('wake:context-generated', (data) => received.push(data));

    const payload = { totalTokens: 99, wing: 'lt206-e2e-wing' };
    fakeWorker.emit('message', {
      type: 'worker-event',
      source: 'wake-context',
      event: 'wake:context-generated',
      payload,
    } satisfies ContextWorkerOutboundMsg);

    expect(received).toEqual([payload]);
  });

  it('does not touch RPC bookkeeping when forwarding a worker-event message', () => {
    const metricsBefore = client.getMetrics();

    fakeWorker.emit('message', {
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: { id: 'store-metrics' },
    } satisfies ContextWorkerOutboundMsg);

    const metricsAfter = client.getMetrics();
    expect(metricsAfter.processed).toBe(metricsBefore.processed);
    expect(metricsAfter.inFlight).toBe(metricsBefore.inFlight);
  });
});
