import { describe, it, expect } from 'vitest';
import {
  cooldownMsFor,
  isLongCooldownLane,
  ModelCooldownTracker,
  COOLDOWN_LANES,
} from './failover-cooldown';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('failover-cooldown / cooldownMsFor', () => {
  it('puts billing on a much longer lane than rate-limit', () => {
    expect(cooldownMsFor('billing', 1)).toBe(5 * HOUR);
    expect(cooldownMsFor('rate_limit', 1)).toBe(1 * MIN);
    expect(cooldownMsFor('billing', 1)).toBeGreaterThan(cooldownMsFor('rate_limit', 1) * 100);
  });

  it('escalates exponentially within a lane but caps at maxMs', () => {
    expect(cooldownMsFor('rate_limit', 1)).toBe(1 * MIN);
    expect(cooldownMsFor('rate_limit', 2)).toBe(4 * MIN);
    expect(cooldownMsFor('rate_limit', 3)).toBe(16 * MIN);
    // factor 4 → 64min would exceed the 1h cap → clamped.
    expect(cooldownMsFor('rate_limit', 4)).toBe(1 * HOUR);
    expect(cooldownMsFor('rate_limit', 99)).toBe(1 * HOUR);
  });

  it('billing escalates 5h → 10h → capped 24h', () => {
    expect(cooldownMsFor('billing', 1)).toBe(5 * HOUR);
    expect(cooldownMsFor('billing', 2)).toBe(10 * HOUR);
    expect(cooldownMsFor('billing', 3)).toBe(20 * HOUR);
    expect(cooldownMsFor('billing', 4)).toBe(24 * HOUR); // 40h clamped
  });

  it('clamps consecutiveFailures < 1 to the base', () => {
    expect(cooldownMsFor('rate_limit', 0)).toBe(1 * MIN);
    expect(cooldownMsFor('rate_limit', -3)).toBe(1 * MIN);
  });

  it('falls back to the unknown lane for an unrecognized reason', () => {
    // @ts-expect-error exercising runtime robustness
    expect(cooldownMsFor('nonsense', 1)).toBe(COOLDOWN_LANES.unknown.baseMs);
  });

  it('classifies the operator-action lanes as long', () => {
    expect(isLongCooldownLane('billing')).toBe(true);
    expect(isLongCooldownLane('auth')).toBe(true);
    expect(isLongCooldownLane('permission')).toBe(true);
    expect(isLongCooldownLane('rate_limit')).toBe(false);
    expect(isLongCooldownLane('timeout')).toBe(false);
  });
});

describe('failover-cooldown / ModelCooldownTracker', () => {
  it('cools down a single model key without affecting others', () => {
    const t = new ModelCooldownTracker();
    t.set('anthropic::opus', 'rate_limit', 1, 0);
    expect(t.isOnCooldown('anthropic::opus', 0)).toBe(true);
    expect(t.isOnCooldown('anthropic::haiku', 0)).toBe(false);
  });

  it('expires after the lane duration and lazily prunes', () => {
    const t = new ModelCooldownTracker();
    const at = t.set('m', 'rate_limit', 1, 1_000);
    expect(at).toBe(1_000 + 1 * MIN);
    expect(t.isOnCooldown('m', 1_000 + 1 * MIN - 1)).toBe(true);
    expect(t.isOnCooldown('m', 1_000 + 1 * MIN)).toBe(false); // boundary clears
    expect(t.remainingMs('m', 1_000 + 1 * MIN)).toBe(0);
  });

  it('reports remaining time and reason while active', () => {
    const t = new ModelCooldownTracker();
    t.set('m', 'billing', 1, 0);
    expect(t.remainingMs('m', HOUR)).toBe(5 * HOUR - HOUR);
    expect(t.reasonFor('m', 0)).toBe('billing');
    expect(t.reasonFor('absent', 0)).toBeNull();
  });

  it('clear and reset work', () => {
    const t = new ModelCooldownTracker();
    t.set('a', 'rate_limit', 1, 0);
    t.set('b', 'billing', 1, 0);
    t.clear('a');
    expect(t.isOnCooldown('a', 0)).toBe(false);
    expect(t.isOnCooldown('b', 0)).toBe(true);
    t.reset();
    expect(t.isOnCooldown('b', 0)).toBe(false);
  });
});
