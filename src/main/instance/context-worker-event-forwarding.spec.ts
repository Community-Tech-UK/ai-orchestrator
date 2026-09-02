/**
 * Regression coverage for LT-206: RLMContextManager and WakeContextBuilder
 * are per-process event sources (same class of cross-process gap as
 * LT-169/LT-170). Production RLM store/section activity and per-turn
 * wake-context generation happen inside the context worker. These tests cover
 * the explicit worker transport plus manager-independent RLM relay dispatch;
 * renderer relay subscriptions remain the following plan task.
 */

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextWorkerClient } from './context-worker-client';
import { registerWorkerEventForwarding } from './context-worker-event-forwarding';
import { WakeContextBuilder, getWakeContextBuilder } from '../memory/wake-context-builder';
import type { ContextWorkerOutboundMsg } from './context-worker-protocol';
import {
  _resetContextWorkerEventRelayForTesting,
  dispatchWorkerBroadcast,
  getContextWorkerEventRelay,
} from './context-worker-event-relay';
import type {
  ContextQueryResult,
  ContextSection,
  ContextStore,
  RLMSession,
} from '../../shared/types/rlm.types';

const section: ContextSection = {
  id: 'section-1',
  type: 'file',
  name: 'private.ts',
  content: 'private-content',
  tokens: 3,
  startOffset: 0,
  endOffset: 15,
  checksum: 'checksum-1',
  depth: 0,
};

function makeStore(sectionCount = 1): ContextStore {
  return {
    id: 'store-1',
    instanceId: 'instance-1',
    sections: Array.from({ length: sectionCount }, (_, index) => ({
      ...section,
      id: `section-${index}`,
      content: `private-content-${index}`,
    })),
    totalTokens: sectionCount * 3,
    totalSize: sectionCount * 15,
    createdAt: 1,
    lastAccessed: 2,
    accessCount: 3,
  };
}

function makeQueryResult(depth: number, subQueries?: ContextQueryResult[]): ContextQueryResult {
  return {
    query: { type: 'grep', params: { pattern: 'needle' } },
    result: 'x'.repeat(100_005),
    tokensUsed: 2,
    sectionsAccessed: Array.from({ length: 505 }, (_, index) => `section-${index}`),
    duration: 4,
    subQueries,
    depth,
  };
}

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
    WakeContextBuilder._resetForTesting();
  });

  it('posts a worker-event message when the worker-local RLMContextManager emits an allowlisted event', () => {
    const transport = { postMessage: vi.fn() };
    const rlm = new EventEmitter();
    registerWorkerEventForwarding(transport, rlm);

    const store = makeStore(0);
    rlm.emit('store:created', store);

    expect(transport.postMessage).toHaveBeenCalledWith({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: {
        id: store.id,
        instanceId: 'instance-1',
        sections: [],
        totalTokens: 0,
        totalSize: 0,
        createdAt: store.createdAt,
        lastAccessed: store.lastAccessed,
        accessCount: 3,
        config: {
          ipcSectionCount: 0,
          ipcSectionsTruncated: true,
        },
      },
    });
  });

  it('strips section content and caps the store snapshot before posting section events', () => {
    const transport = { postMessage: vi.fn() };
    const rlm = new EventEmitter();
    registerWorkerEventForwarding(transport, rlm);
    const store = makeStore(502);

    rlm.emit('section:added', { store, section });

    const message = transport.postMessage.mock.calls.at(-1)?.[0] as Extract<
      ContextWorkerOutboundMsg,
      { type: 'worker-event'; source: 'rlm-context'; event: 'section:added' }
    >;
    expect(message.payload.section.content).toBe('');
    expect(message.payload.store.sections).toHaveLength(500);
    expect(message.payload.store.sections.every((item) => item.content === '')).toBe(true);
  });

  it('normalizes section removal with the high-volume flag and bounded store metadata', () => {
    const transport = { postMessage: vi.fn() };
    const rlm = new EventEmitter();
    registerWorkerEventForwarding(transport, rlm);
    const store = makeStore(501);
    store.config = { kind: 'codebase-auto' };

    rlm.emit('section:removed', { store, section });

    const message = transport.postMessage.mock.calls.at(-1)?.[0] as Extract<
      ContextWorkerOutboundMsg,
      { type: 'worker-event'; source: 'rlm-context'; event: 'section:removed' }
    >;
    expect(message.payload).toMatchObject({
      storeId: 'store-1',
      sectionId: 'section-1',
      highVolume: true,
    });
    expect(message.payload.store.sections).toHaveLength(500);
    expect(message.payload.store.sections.every((item) => item.content === '')).toBe(true);
    expect(() => structuredClone(message)).not.toThrow();
  });

  it('caps query result text, accessed IDs, and the nested sub-query tree before posting', () => {
    const transport = { postMessage: vi.fn() };
    const rlm = new EventEmitter();
    registerWorkerEventForwarding(transport, rlm);
    let nested = makeQueryResult(20);
    for (let depth = 19; depth >= 0; depth--) nested = makeQueryResult(depth, [nested]);
    const session = { id: 'session-1' } as RLMSession;

    rlm.emit('query:executed', {
      session,
      queryResult: nested,
    });

    const message = transport.postMessage.mock.calls.at(-1)?.[0] as Extract<
      ContextWorkerOutboundMsg,
      { type: 'worker-event'; source: 'rlm-context'; event: 'query:executed' }
    >;
    expect(message.payload.queryResult.result).toHaveLength(100_000);
    expect(message.payload.queryResult.sectionsAccessed).toHaveLength(500);
    let totalNestedNodes = 0;
    let totalResultChars = message.payload.queryResult.result.length;
    let totalAccessedIds = message.payload.queryResult.sectionsAccessed.length;
    const pending = [...(message.payload.queryResult.subQueries ?? [])];
    while (pending.length > 0) {
      const item = pending.pop();
      if (!item) continue;
      totalNestedNodes++;
      totalResultChars += item.result.length;
      totalAccessedIds += item.sectionsAccessed.length;
      pending.push(...(item.subQueries ?? []));
    }
    expect(totalNestedNodes).toBe(20);
    expect(totalResultChars).toBe(100_000);
    expect(totalAccessedIds).toBe(500);
    expect(() => structuredClone(message)).not.toThrow();
  });

  it('never subscribes to callback-bearing summarize or sub-query events', () => {
    const transport = { postMessage: vi.fn() };
    const rlm = new EventEmitter();
    registerWorkerEventForwarding(transport, rlm);

    rlm.emit('summarize:request', { callback: () => undefined });
    rlm.emit('sub_query:request', { callback: () => undefined });

    expect(transport.postMessage).not.toHaveBeenCalled();
  });

  it('posts a worker-event message when the worker-local WakeContextBuilder emits wake:context-generated', () => {
    const transport = { postMessage: vi.fn() };
    registerWorkerEventForwarding(transport, new EventEmitter());

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
    registerWorkerEventForwarding(transport, new EventEmitter());

    // Directly emitting the event (rather than calling addHint, which needs a
    // real DB) is sufficient to prove no subscription was registered for it.
    getWakeContextBuilder().emit('wake:hint-added', { id: 'h1', content: 'x', importance: 5 });

    expect(transport.postMessage).not.toHaveBeenCalled();
  });
});

describe('LT-206: main dispatch publishes RLM DTOs and preserves wake re-emission', () => {
  afterEach(() => {
    _resetContextWorkerEventRelayForTesting();
    WakeContextBuilder._resetForTesting();
  });

  it('publishes a forwarded RLM store:created DTO to the main-process relay', () => {
    const received: unknown[] = [];
    getContextWorkerEventRelay().on('store:created', (store) => received.push(store));

    const store = {
      id: 'store-1',
      instanceId: 'inst-1',
      sections: [],
      totalTokens: 0,
      totalSize: 0,
      createdAt: 1,
      lastAccessed: 2,
      accessCount: 3,
    };
    dispatchWorkerBroadcast({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: store,
    } satisfies ContextWorkerOutboundMsg);

    expect(received).toEqual([store]);
  });

  it('publishes a forwarded RLM section:added DTO to the main-process relay', () => {
    const received: unknown[] = [];
    getContextWorkerEventRelay().on('section:added', (data) => received.push(data));

    const payload = {
      storeId: 'store-1',
      section: { ...section, content: '' },
      highVolume: false,
      store: {
        id: 'store-1',
        instanceId: 'inst-1',
        sections: [],
        totalTokens: 0,
        totalSize: 0,
        createdAt: 1,
        lastAccessed: 2,
        accessCount: 3,
      },
    };
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

describe('main-side worker dispatch import isolation', () => {
  afterEach(() => {
    vi.doUnmock('../rlm/context-manager');
    vi.resetModules();
  });

  it('does not resolve the RLM context manager when main imports worker dispatch', async () => {
    vi.resetModules();
    const resolveManager = vi.fn();
    vi.doMock('../rlm/context-manager', () => {
      resolveManager();
      throw new Error('main dispatch must not resolve the RLM manager');
    });

    const forwarding = await import('./context-worker-event-relay');
    expect(forwarding).toMatchObject({
      dispatchWorkerBroadcast: expect.any(Function),
    });
    expect(() => forwarding.dispatchWorkerBroadcast({
      type: 'worker-event',
      source: 'rlm-context',
      event: 'store:created',
      payload: {
        id: 'store-isolated',
        instanceId: 'instance-isolated',
        sections: [],
        totalTokens: 0,
        totalSize: 0,
        createdAt: 1,
        lastAccessed: 2,
        accessCount: 3,
      },
    })).not.toThrow();
    expect(resolveManager).not.toHaveBeenCalled();
  });
});

describe('ContextWorkerClient (LT-206: RLM + wake-context cross-process forwarding, end to end)', () => {
  let fakeWorker: ReturnType<typeof makeFakeWorkerHandle>;
  let client: ContextWorkerClient;

  beforeEach(() => {
    _resetContextWorkerEventRelayForTesting();
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
    _resetContextWorkerEventRelayForTesting();
    WakeContextBuilder._resetForTesting();
  });

  it('a worker-emitted RLM_STORE_UPDATED-source event reaches a listener on the main relay', () => {
    const received: unknown[] = [];
    getContextWorkerEventRelay().on('store:created', (store) => received.push(store));

    const store = {
      id: 'store-e2e',
      instanceId: 'inst-e2e',
      sections: [],
      totalTokens: 0,
      totalSize: 0,
      createdAt: 1,
      lastAccessed: 2,
      accessCount: 3,
    };
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
      payload: {
        id: 'store-metrics',
        instanceId: 'instance-metrics',
        sections: [],
        totalTokens: 0,
        totalSize: 0,
        createdAt: 1,
        lastAccessed: 2,
        accessCount: 3,
      },
    } satisfies ContextWorkerOutboundMsg);

    const metricsAfter = client.getMetrics();
    expect(metricsAfter.processed).toBe(metricsBefore.processed);
    expect(metricsAfter.inFlight).toBe(metricsBefore.inFlight);
  });
});
