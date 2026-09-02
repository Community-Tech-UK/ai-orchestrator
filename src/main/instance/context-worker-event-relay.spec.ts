import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetContextWorkerEventRelayForTesting,
  getContextWorkerEventRelay,
  publishRlmWorkerEvent,
} from './context-worker-event-relay';
import type { RlmWorkerEventMsg } from './context-worker-protocol';

const storeCreatedEvent: RlmWorkerEventMsg = {
  type: 'worker-event',
  source: 'rlm-context',
  event: 'store:created',
  payload: {
    id: 'store-1',
    instanceId: 'instance-1',
    sections: [],
    totalTokens: 0,
    totalSize: 0,
    createdAt: 1,
    lastAccessed: 2,
    accessCount: 3,
  },
};

describe('context worker event relay', () => {
  afterEach(() => {
    _resetContextWorkerEventRelayForTesting();
  });

  it('publishes an RLM DTO under its existing event name', () => {
    const listener = vi.fn();
    getContextWorkerEventRelay().on('store:created', listener);

    publishRlmWorkerEvent(storeCreatedEvent);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(storeCreatedEvent.payload);
  });

  it('returns one process-local singleton until reset', () => {
    const first = getContextWorkerEventRelay();

    expect(getContextWorkerEventRelay()).toBe(first);
    _resetContextWorkerEventRelayForTesting();
    expect(getContextWorkerEventRelay()).not.toBe(first);
  });

  it('removes listeners from the retired singleton on reset', () => {
    const retired = getContextWorkerEventRelay();
    retired.on('store:created', vi.fn());

    _resetContextWorkerEventRelayForTesting();

    expect(retired.listenerCount('store:created')).toBe(0);
  });
});
