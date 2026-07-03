import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleLateNodeReconnect,
  RECOVERY_OFFER_DEBOUNCE_MS,
  _resetRecoveryOfferDebounceForTesting,
} from './node-failover';
import type { InstanceManager } from '../instance/instance-manager';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('./worker-node-registry', () => ({
  getWorkerNodeRegistry: () => ({ getNode: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

interface FakeInstance {
  id: string;
  status: string;
}

function makeManager(instances: FakeInstance[]): {
  manager: InstanceManager;
  emit: ReturnType<typeof vi.fn>;
} {
  const emit = vi.fn();
  const manager = {
    getInstancesByNode: (_nodeId: string) => instances,
    emit,
  } as unknown as InstanceManager;
  return { manager, emit };
}

describe('handleLateNodeReconnect recovery-offer debounce', () => {
  beforeEach(() => {
    _resetRecoveryOfferDebounceForTesting();
  });

  afterEach(() => {
    _resetRecoveryOfferDebounceForTesting();
  });

  it('emits recovery-available for failed instances on first reconnect', () => {
    const { manager, emit } = makeManager([
      { id: 'a', status: 'failed' },
      { id: 'b', status: 'failed' },
    ]);
    const now = 1_000;
    handleLateNodeReconnect('node-1', manager, () => now);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('instance:remote-recovery-available', {
      instanceId: 'a',
      nodeId: 'node-1',
    });
  });

  it('suppresses an identical offer re-fired within the debounce window', () => {
    const { manager, emit } = makeManager([
      { id: 'a', status: 'failed' },
      { id: 'b', status: 'failed' },
    ]);
    let now = 1_000;
    handleLateNodeReconnect('node-1', manager, () => now);
    expect(emit).toHaveBeenCalledTimes(2);

    // A flap fires node:connected again a few seconds later — same failed set.
    now += RECOVERY_OFFER_DEBOUNCE_MS - 1;
    handleLateNodeReconnect('node-1', manager, () => now);
    expect(emit).toHaveBeenCalledTimes(2); // no new emits
  });

  it('re-offers once the debounce window has passed', () => {
    const { manager, emit } = makeManager([{ id: 'a', status: 'failed' }]);
    let now = 1_000;
    handleLateNodeReconnect('node-1', manager, () => now);
    expect(emit).toHaveBeenCalledTimes(1);

    now += RECOVERY_OFFER_DEBOUNCE_MS + 1;
    handleLateNodeReconnect('node-1', manager, () => now);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('re-offers immediately when the failed-instance set changes', () => {
    const first = makeManager([{ id: 'a', status: 'failed' }]);
    let now = 1_000;
    handleLateNodeReconnect('node-1', first.manager, () => now);
    expect(first.emit).toHaveBeenCalledTimes(1);

    // Different failed set within the window → not a duplicate.
    const second = makeManager([
      { id: 'a', status: 'failed' },
      { id: 'c', status: 'failed' },
    ]);
    now += 1_000;
    handleLateNodeReconnect('node-1', second.manager, () => now);
    expect(second.emit).toHaveBeenCalledTimes(2);
  });

  it('does nothing (and clears state) when there are no failed instances', () => {
    const { manager, emit } = makeManager([{ id: 'a', status: 'running' }]);
    let now = 1_000;
    handleLateNodeReconnect('node-1', manager, () => now);
    expect(emit).not.toHaveBeenCalled();

    // After a clear, a later identical failed set is offered (not suppressed).
    const failed = makeManager([{ id: 'a', status: 'failed' }]);
    now += 100;
    handleLateNodeReconnect('node-1', failed.manager, () => now);
    expect(failed.emit).toHaveBeenCalledTimes(1);
  });

  it('tracks debounce per node independently', () => {
    const n1 = makeManager([{ id: 'a', status: 'failed' }]);
    const n2 = makeManager([{ id: 'a', status: 'failed' }]);
    const now = 1_000;
    handleLateNodeReconnect('node-1', n1.manager, () => now);
    handleLateNodeReconnect('node-2', n2.manager, () => now);
    expect(n1.emit).toHaveBeenCalledTimes(1);
    expect(n2.emit).toHaveBeenCalledTimes(1);
  });
});
