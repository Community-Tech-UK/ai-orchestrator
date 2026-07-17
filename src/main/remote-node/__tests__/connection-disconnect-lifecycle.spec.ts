import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  ConnectionDisconnectLifecycle,
  DISCONNECT_GRACE_MS,
  PARKED_WORK_RPC_WINDOW_MS,
} from '../connection-disconnect-lifecycle';

function makeLifecycle(overrides: {
  connected?: boolean;
  durable?: boolean;
  hasWork?: boolean;
} = {}) {
  const state = { connected: overrides.connected ?? false };
  const rejectPending = vi.fn();
  const onTrueDisconnect = vi.fn();
  const lifecycle = new ConnectionDisconnectLifecycle({
    isNodeConnected: () => state.connected,
    isDurableNode: () => overrides.durable ?? false,
    hasPendingWork: () => overrides.hasWork ?? true,
    rejectPending,
    onTrueDisconnect,
  });
  return { lifecycle, rejectPending, onTrueDisconnect, state };
}

describe('ConnectionDisconnectLifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('legacy node: grace expiry rejects ALL pending RPCs and signals disconnect', () => {
    const { lifecycle, rejectPending, onTrueDisconnect } = makeLifecycle({ durable: false });
    lifecycle.beginGrace('n1');
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 10);

    expect(rejectPending).toHaveBeenCalledWith('n1', 'Node disconnected: n1', 'all');
    expect(onTrueDisconnect).toHaveBeenCalledWith('n1');
  });

  it('re-registration within grace cancels everything (continuous session)', () => {
    const { lifecycle, rejectPending, onTrueDisconnect } = makeLifecycle({ durable: false });
    lifecycle.beginGrace('n1');
    expect(lifecycle.cancelOnReregister('n1')).toBe(true);
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS * 3);

    expect(rejectPending).not.toHaveBeenCalled();
    expect(onTrueDisconnect).not.toHaveBeenCalled();
    // No grace in progress → false.
    expect(lifecycle.cancelOnReregister('n1')).toBe(false);
  });

  it('durable node: grace expiry rejects only NON-work and parks work RPCs', () => {
    const { lifecycle, rejectPending, onTrueDisconnect } = makeLifecycle({ durable: true });
    lifecycle.beginGrace('n1');
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 10);

    expect(rejectPending).toHaveBeenCalledTimes(1);
    expect(rejectPending).toHaveBeenCalledWith('n1', 'Node disconnected: n1', 'non-work');
    expect(onTrueDisconnect).toHaveBeenCalledWith('n1');

    // Parked window elapses without reconnect → work RPCs rejected too.
    vi.advanceTimersByTime(PARKED_WORK_RPC_WINDOW_MS + 10);
    expect(rejectPending).toHaveBeenCalledWith(
      'n1',
      'Node disconnected: n1 (parked-work window elapsed)',
      'work',
    );
  });

  it('durable node: reconnect within the parked window preserves work RPCs', () => {
    const { lifecycle, rejectPending, state } = makeLifecycle({ durable: true });
    lifecycle.beginGrace('n1');
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 10);
    rejectPending.mockClear();

    state.connected = true;
    lifecycle.cancelOnReregister('n1');
    vi.advanceTimersByTime(PARKED_WORK_RPC_WINDOW_MS * 2);

    expect(rejectPending).not.toHaveBeenCalled();
  });

  it('durable node with no pending work skips the parked window entirely', () => {
    const { lifecycle, rejectPending } = makeLifecycle({ durable: true, hasWork: false });
    lifecycle.beginGrace('n1');
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS + PARKED_WORK_RPC_WINDOW_MS + 20);

    expect(rejectPending).toHaveBeenCalledTimes(1);
    expect(rejectPending).toHaveBeenCalledWith('n1', 'Node disconnected: n1', 'non-work');
  });

  it('a node that reconnects before grace expiry is never disconnected', () => {
    const { lifecycle, rejectPending, onTrueDisconnect, state } = makeLifecycle({ durable: true });
    lifecycle.beginGrace('n1');
    state.connected = true; // socket replaced before the timer fires
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 10);

    expect(rejectPending).not.toHaveBeenCalled();
    expect(onTrueDisconnect).not.toHaveBeenCalled();
  });

  it('clearAll cancels every outstanding timer', () => {
    const { lifecycle, rejectPending, onTrueDisconnect } = makeLifecycle({ durable: true });
    lifecycle.beginGrace('n1');
    lifecycle.beginGrace('n2');
    lifecycle.clearAll();
    vi.advanceTimersByTime(DISCONNECT_GRACE_MS + PARKED_WORK_RPC_WINDOW_MS + 20);

    expect(rejectPending).not.toHaveBeenCalled();
    expect(onTrueDisconnect).not.toHaveBeenCalled();
  });
});
