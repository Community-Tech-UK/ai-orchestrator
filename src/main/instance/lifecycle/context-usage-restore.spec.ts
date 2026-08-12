import { describe, it, expect } from 'vitest';
import { persistedOccupancyIsReal, resolveSwapContextUsage, restoreContextUsage } from './context-usage-restore';

describe('restoreContextUsage (LT-018)', () => {
  it('keeps the flag when the persisted record carries it', () => {
    const restored = restoreContextUsage({
      used: 50_000, total: 200_000, occupancyReported: true,
    });
    expect(restored.occupancyReported).toBe(true);
    expect(restored.percentage).toBeCloseTo(25, 5);
  });

  /**
   * Records written before the flag existed carry real numbers and no flag.
   * Treating them as unreported would regress a woken session to "no data" on
   * every context surface while the warning banner — which keys off
   * `percentage` alone — simultaneously offered to compact it.
   */
  it('infers the flag from a non-zero used, for records written before it existed', () => {
    const restored = restoreContextUsage({ used: 150_000, total: 200_000 });
    expect(restored.occupancyReported).toBe(true);
    expect(restored.percentage).toBeCloseTo(75, 5);
  });

  /**
   * The inference is only sound because every placeholder/reset path writes
   * `used: 0` — the create-time seed, the post-compaction reset, and
   * `restoreContext === false`. This is that half of the contract.
   */
  it('does NOT claim occupancy for the seeded placeholder', () => {
    const restored = restoreContextUsage({ used: 0, total: 200_000 });
    expect(restored.occupancyReported).toBeUndefined();
    expect(restored.percentage).toBe(0);
  });

  it('does not claim occupancy for a post-compaction reset that had no flag', () => {
    // `buildPostCompactionUsage` writes used: 0 and preserves the flag only when
    // it was already set, so an unflagged reset must stay unflagged.
    expect(persistedOccupancyIsReal({ used: 0, total: 200_000 })).toBe(false);
  });

  it('honours an explicit false with a zero used', () => {
    expect(persistedOccupancyIsReal({ used: 0, total: 1, occupancyReported: false })).toBe(false);
  });

  it('caps percentage at 100 when used exceeds total', () => {
    expect(restoreContextUsage({ used: 300_000, total: 200_000 }).percentage).toBe(100);
  });

  it('returns 0 percentage and no flag for a zero-width window', () => {
    const restored = restoreContextUsage({ used: 0, total: 0 });
    expect(restored.percentage).toBe(0);
    expect(restored.occupancyReported).toBeUndefined();
  });

  it('carries costEstimate through unchanged', () => {
    expect(restoreContextUsage({ used: 0, total: 10, costEstimate: 1.5 }).costEstimate).toBe(1.5);
  });
});

describe('resolveSwapContextUsage (LT-018)', () => {
  const reported = {
    used: 124_000, total: 200_000, percentage: 62, occupancyReported: true,
  } as const;

  it('carries occupancy across a genuine resume, rescaling to the new window', () => {
    const next = resolveSwapContextUsage({ ...reported }, 400_000, true);
    expect(next.used).toBe(124_000);
    expect(next.occupancyReported).toBe(true);
    expect(next.percentage).toBeCloseTo(31, 5);
  });

  it('clears occupancy when the session identity is minted fresh', () => {
    const next = resolveSwapContextUsage({ ...reported }, 128_000, false);
    expect(next.used).toBe(0);
    expect(next.percentage).toBe(0);
    expect(next.occupancyReported).toBeUndefined();
  });

  it('preserves accrued cost across a fresh-session swap', () => {
    const next = resolveSwapContextUsage({ ...reported, costEstimate: 3.5 }, 128_000, false);
    expect(next.costEstimate).toBe(3.5);
    expect(next.occupancyReported).toBeUndefined();
  });

  it('does not invent occupancy for an unreported instance that resumes', () => {
    const next = resolveSwapContextUsage({ used: 0, total: 200_000, percentage: 0 }, 200_000, true);
    expect(next.occupancyReported).toBeUndefined();
  });
});

describe('occupancyIsAggregate across hibernate/wake (LT-034)', () => {
  it('restores the aggregate flag so a woken session does not re-fabricate a window %', () => {
    const restored = restoreContextUsage({
      used: 190_000,
      total: 200_000,
      occupancyReported: true,
      occupancyIsAggregate: true,
    });
    expect(restored.occupancyIsAggregate).toBe(true);
    expect(restored.occupancyReported).toBe(true);
  });

  it('leaves the flag absent for a provider that reports real occupancy', () => {
    const restored = restoreContextUsage({
      used: 50_000,
      total: 200_000,
      occupancyReported: true,
    });
    expect(restored.occupancyIsAggregate).toBeUndefined();
  });

  it('does NOT infer aggregate from the numbers on a legacy record', () => {
    // Spend and occupancy are indistinguishable by value. A pre-field record is
    // treated as occupancy (today's behaviour) and self-corrects on the next
    // context event, which carries the adapter's real declaration.
    const restored = restoreContextUsage({ used: 190_000, total: 200_000 });
    expect(restored.occupancyIsAggregate).toBeUndefined();
    expect(restored.occupancyReported).toBe(true);
  });
});
