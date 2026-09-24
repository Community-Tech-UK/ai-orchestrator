import { describe, expect, it, vi } from 'vitest';

import { CompactionGate } from './compaction-gate';

describe('CompactionGate', () => {
  it('resolves a pending wait when settle() is called', async () => {
    const gate = new CompactionGate();
    const pending = gate.wait(60_000);

    gate.settle();

    // Resolves via settle(), not the 60s timeout — a hung wait would trip the
    // per-test deadline instead of passing here.
    await expect(pending).resolves.toBe('observed');
  });

  it('resolves every pending wait from a single settle()', async () => {
    const gate = new CompactionGate();
    const waits = [gate.wait(60_000), gate.wait(60_000), gate.wait(60_000)];

    gate.settle();

    await expect(Promise.all(waits)).resolves.toEqual(['observed', 'observed', 'observed']);
  });

  it('resolves on the timeout when settle() never fires', async () => {
    vi.useFakeTimers();
    try {
      const gate = new CompactionGate();
      let resolved = false;
      const pending = gate.wait(5_000);
      void pending.then(() => { resolved = true; });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe('timed-out');
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settle() after a wait has already timed out is a no-op (no throw)', async () => {
    vi.useFakeTimers();
    try {
      const gate = new CompactionGate();
      const pending = gate.wait(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;

      expect(() => gate.settle()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settle() with no waiters is a no-op', () => {
    const gate = new CompactionGate();
    expect(() => gate.settle()).not.toThrow();
  });

  it('moves a running compaction onto the longer running window and reports it stalled, not timed out', async () => {
    vi.useFakeTimers();
    try {
      const gate = new CompactionGate();
      let outcome: string | null = null;
      void gate.wait(1_000, 10_000).then((value) => { outcome = value; });

      await vi.advanceTimersByTimeAsync(900);
      gate.markRunning();
      // Past the start window: a running compaction is not treated as absent.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toBeNull();

      // A repeated start signal must not keep extending the deadline.
      gate.markRunning();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).toBe('stalled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a running compaction as observed when it settles inside the running window', async () => {
    vi.useFakeTimers();
    try {
      const gate = new CompactionGate();
      const pending = gate.wait(1_000, 10_000);
      gate.markRunning();
      await vi.advanceTimersByTimeAsync(7_000);

      gate.settle();

      await expect(pending).resolves.toBe('observed');
      expect(gate.hasPendingWaiters()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('markRunning() with no waiters is a no-op', () => {
    const gate = new CompactionGate();
    expect(() => gate.markRunning()).not.toThrow();
  });

  it('distinguishes cancellation from an unobserved timeout when compaction could not start', async () => {
    const gate = new CompactionGate();
    const pending = gate.wait(60_000);

    gate.cancel();

    await expect(pending).resolves.toBe('cancelled');
  });

  it('releases a running wait at once when the provider ends the compaction without completing it', async () => {
    const gate = new CompactionGate();
    const pending = gate.wait(60_000, 600_000);
    gate.markRunning();

    gate.fail();

    await expect(pending).resolves.toBe('failed');
    expect(gate.hasPendingWaiters()).toBe(false);
  });
});
