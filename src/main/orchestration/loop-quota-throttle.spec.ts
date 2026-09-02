import { describe, it, expect } from 'vitest';
import { evaluateQuotaThrottle, isParkingDecision } from './loop-quota-throttle';
import { parseCursorUsageSummaryPayload } from '../core/system/provider-quota/cursor-usage-summary-probe';
import { parseGrokBillingPayload } from '../core/system/provider-quota/grok-billing-probe';
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

    it('does not fire on cumulative paid credits when the normal window has headroom', () => {
      const d = evaluateQuotaThrottle(snap([w({ used: 50 }), credits]));
      expect(d.action).toBe('continue');
    });

    it('fires when paid credits are the only usable quota signal', () => {
      const d = evaluateQuotaThrottle(snap([credits]));
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

    it('honours an explicit overage:false on a usd-denominated window', () => {
      const planInUsd = w({ id: 'plan', unit: 'usd', used: 30, limit: 100, remaining: 70, overage: false });
      const d = evaluateQuotaThrottle(snap([planInUsd]));
      expect(d.action).toBe('continue');
    });

    it('honours an explicit overage:true on a percent-denominated window', () => {
      const paidPercent = w({ id: 'cursor.on-demand', unit: 'percent', used: 12, limit: 100, remaining: 88, overage: true });
      const d = evaluateQuotaThrottle(snap([paidPercent]));
      expect(d.action).toBe('overage-guard');
      expect(d.window!.id).toBe('cursor.on-demand');
    });
  });

  // Regression: Cursor/Grok publish only utilization ratios. While those plan
  // windows were emitted as `usd`, every window looked like paid overage, so
  // `binding` was always null and the guard fired at any usage above 0% —
  // parking those loops before their first iteration, for the whole billing
  // cycle, at $0.00 spent.
  describe('percent-only providers (Cursor / Grok shape)', () => {
    const included = (used: number) =>
      w({ id: 'cursor.included', label: 'Included usage', unit: 'percent', used, limit: 100, remaining: 100 - used, overage: false });
    const onDemand = (used: number) =>
      w({ id: 'cursor.on-demand', label: 'On-demand spend', unit: 'percent', used, limit: 100, remaining: 100 - used, overage: true });

    it('runs normally at moderate included usage', () => {
      const d = evaluateQuotaThrottle(snap([included(42), onDemand(0)]));
      expect(d.action).toBe('continue');
      expect(isParkingDecision(d)).toBe(false);
    });

    it('still throttles the included window at >= 90%', () => {
      const resetsAt = Date.now() + 3_600_000;
      const d = evaluateQuotaThrottle(snap([w({ ...included(94), resetsAt }), onDemand(0)]));
      expect(d.action).toBe('throttle');
      expect(d.window!.id).toBe('cursor.included');
      expect(d.resumeAt).toBe(resetsAt);
    });

    it('still parks when the included window is exhausted', () => {
      const d = evaluateQuotaThrottle(snap([included(100), onDemand(0)]));
      expect(d.action).toBe('park-exhausted');
      expect(d.window!.id).toBe('cursor.included');
    });

    it('guards real on-demand spend once the plan window is gone', () => {
      const d = evaluateQuotaThrottle(snap([onDemand(8)]));
      expect(d.action).toBe('overage-guard');
      expect(d.window!.id).toBe('cursor.on-demand');
    });
  });

  /**
   * End-to-end over the seam that actually broke: real probe output fed to the
   * real throttle. The unit tests either side of this seam both passed while
   * every Cursor and Grok loop parked before its first iteration, because
   * neither of them asserted the window unit.
   */
  describe('live probe output', () => {
    it('lets a Cursor loop run at ordinary usage', () => {
      const windows = parseCursorUsageSummaryPayload({
        membershipType: 'pro',
        billingCycleEnd: '2026-07-01T00:00:00Z',
        individualUsage: {
          plan: { enabled: true, used: 4200, limit: 10000, totalPercentUsed: 42 },
          onDemand: { enabled: true, used: 0, limit: 10000 },
        },
      });

      const d = evaluateQuotaThrottle(snap(windows));
      expect(d.action).toBe('continue');
      expect(isParkingDecision(d)).toBe(false);
    });

    it('lets a Grok loop run at ordinary usage', () => {
      const windows = parseGrokBillingPayload({
        config: {
          monthlyLimit: { val: 100 },
          used: { val: 25 },
          onDemandCap: { val: 100 },
          history: [{ onDemandUsed: { val: 0 } }],
          billingPeriodEnd: '2026-08-01T00:00:00Z',
        },
      });

      const d = evaluateQuotaThrottle(snap(windows));
      expect(d.action).toBe('continue');
      expect(isParkingDecision(d)).toBe(false);
    });

    it('still parks a Cursor loop once the included plan window is spent', () => {
      const windows = parseCursorUsageSummaryPayload({
        billingCycleEnd: '2026-07-01T00:00:00Z',
        individualUsage: {
          plan: { enabled: true, used: 10000, limit: 10000, totalPercentUsed: 100 },
        },
      });

      const d = evaluateQuotaThrottle(snap(windows));
      expect(d.action).toBe('park-exhausted');
      expect(d.resumeAt).toBe(Date.parse('2026-07-01T00:00:00Z'));
    });
  });
});
