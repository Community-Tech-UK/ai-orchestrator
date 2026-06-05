import { describe, it, expect } from 'vitest';
import { evaluateQuotaThrottle, isParkingDecision } from './loop-quota-throttle';
import type {
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../shared/types/provider-quota.types';

function w(overrides: Partial<ProviderQuotaWindow>): ProviderQuotaWindow {
  return {
    kind: 'rolling-window',
    id: 'claude.5h',
    label: '5-hour session',
    unit: 'messages',
    used: 0,
    limit: 100,
    remaining: 100,
    resetsAt: null,
    ...overrides,
  };
}

function snap(windows: ProviderQuotaWindow[], ok = true): ProviderQuotaSnapshot {
  return { provider: 'claude', takenAt: Date.now(), source: 'admin-api', ok, windows };
}

describe('evaluateQuotaThrottle', () => {
  it('continues when there is headroom', () => {
    const d = evaluateQuotaThrottle(snap([w({ used: 40 })]));
    expect(d.action).toBe('continue');
    expect(isParkingDecision(d)).toBe(false);
  });

  it('continues on a null / failed / empty snapshot', () => {
    expect(evaluateQuotaThrottle(null).action).toBe('continue');
    expect(evaluateQuotaThrottle(snap([], false)).action).toBe('continue');
    expect(evaluateQuotaThrottle(snap([])).action).toBe('continue');
  });

  it('throttles at >= 90%', () => {
    const resetsAt = Date.now() + 3_600_000;
    const d = evaluateQuotaThrottle(snap([w({ used: 92, resetsAt })]));
    expect(d.action).toBe('throttle');
    expect(d.window!.id).toBe('claude.5h');
    expect(d.resumeAt).toBe(resetsAt);
    expect(isParkingDecision(d)).toBe(true);
  });

  it('downshifts when the all-model weekly bucket is constrained but sonnet has room', () => {
    const d = evaluateQuotaThrottle(
      snap([
        w({ id: 'claude.weekly', label: 'Weekly (all models)', used: 95 }),
        w({ id: 'claude.weekly-sonnet', label: 'Weekly (Sonnet)', used: 7 }),
      ]),
    );

    expect(d.action).toBe('downshift');
    expect(d.window!.id).toBe('claude.weekly');
    expect(d.downshift).toEqual({
      windowId: 'claude.weekly-sonnet',
      model: 'sonnet',
      reason: 'Weekly (Sonnet) has 93% remaining',
    });
    expect(isParkingDecision(d)).toBe(false);
  });

  it('uses a custom throttle threshold', () => {
    expect(evaluateQuotaThrottle(snap([w({ used: 80 })]), { throttlePct: 75 }).action).toBe('throttle');
    expect(evaluateQuotaThrottle(snap([w({ used: 80 })]), { throttlePct: 95 }).action).toBe('continue');
  });

  it('parks as exhausted at >= 100%', () => {
    const d = evaluateQuotaThrottle(snap([w({ used: 100 })]));
    expect(d.action).toBe('park-exhausted');
  });

  it('picks the most-utilized non-overage window as binding', () => {
    const d = evaluateQuotaThrottle(
      snap([
        w({ id: 'claude.5h', used: 10 }),
        w({ id: 'claude.weekly', label: 'Weekly', used: 95 }),
      ]),
    );
    expect(d.action).toBe('throttle');
    expect(d.window!.id).toBe('claude.weekly');
  });

  describe('overage guard', () => {
    const credits = w({ id: 'claude.credits', label: 'Credits', unit: 'usd', used: 5, limit: 100, remaining: 95 });

    it('fires when paid credits are being consumed', () => {
      const d = evaluateQuotaThrottle(snap([w({ used: 50 }), credits]));
      expect(d.action).toBe('overage-guard');
      expect(d.window!.id).toBe('claude.credits');
    });

    it('is skipped when allowOverage is true', () => {
      const d = evaluateQuotaThrottle(snap([w({ used: 50 }), credits]), { allowOverage: true });
      expect(d.action).toBe('continue');
    });

    it('does not treat an unused credits window as overage', () => {
      const unused = w({ id: 'claude.credits', unit: 'usd', used: 0, limit: 100, remaining: 100 });
      const d = evaluateQuotaThrottle(snap([w({ used: 50 }), unused]));
      expect(d.action).toBe('continue');
    });

    it('ignores the overage window when choosing the binding window', () => {
      // credits at 50% should not count as the binding throttle window
      const d = evaluateQuotaThrottle(snap([w({ used: 10 }), w({ id: 'claude.credits', unit: 'usd', used: 50, limit: 100, remaining: 50 })]), { allowOverage: true });
      expect(d.action).toBe('continue');
    });
  });
});
