import { describe, expect, it, vi } from 'vitest';

import { CompactionGate } from './compaction-gate';

describe('CompactionGate', () => {
  it('resolves a pending wait when settle() is called', async () => {
    const gate = new CompactionGate();
    const pending = gate.wait(60_000);

    gate.settle();

    // Resolves via settle(), not the 60s timeout — a hung wait would trip the
    // per-test deadline instead of passing here.
    await expect(pending).resolves.toBeUndefined();
  });

  it('resolves every pending wait from a single settle()', async () => {
    const gate = new CompactionGate();
    const waits = [gate.wait(60_000), gate.wait(60_000), gate.wait(60_000)];

    gate.settle();

    await expect(Promise.all(waits)).resolves.toEqual([undefined, undefined, undefined]);
  });

  it('resolves on the timeout when settle() never fires', async () => {
    vi.useFakeTimers();
    try {
      const gate = new CompactionGate();
      let resolved = false;
      const pending = gate.wait(5_000).then(() => { resolved = true; });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
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
});
