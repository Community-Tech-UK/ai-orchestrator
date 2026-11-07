import { describe, expect, it } from 'vitest';
import type { Instance } from '../../../core/state/instance/instance.types';
import type { SessionSpendBreakdown } from '../../../../../shared/types/cost-session.types';
import { buildSessionStatus } from './session-status.model';
const now = 3600000;
const instance = { id: 'i', displayName: 'Fix layout', provider: 'claude', currentModel: 'opus', reasoningEffort: 'high',
  lastActivity: now - 60000, contextUsage: { used: 312000, total: 1000000, percentage: 31.2, occupancyReported: true } } as Instance;
const breakdown: SessionSpendBreakdown = { turns: 2, totalCostUsd: 4.2, estimatedShare: 0, mainCostUsd: 1.1, helperCostUsd: 3.1,
  byModel: [{ model: 'opus', costUsd: 4.2, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10, isMainModel: true }], copilotCache: [] };
describe('session status model', () => {
  it('includes reasoning effort after the runtime model label in both the card and copied text', () => {
    const runtimeSummary = { label: 'Local example model' } as NonNullable<Instance['runtimeSummary']>;
    const view = buildSessionStatus({ instance: { ...instance, runtimeSummary }, showCost: false, now });
    expect(view.rows.find(row => row.label === 'Model')?.lines).toEqual(['Local example model · effort high']);
    expect(view.text).toContain('Model: Local example model · effort high');
  });
  it('leads with plan usage, labels API equivalents and uses honest occupancy and shared cache TTL', () => {
    const view = buildSessionStatus({ instance, breakdown, quotaSnapshot: { provider: 'claude', ok: true, plan: 'max', source: 'admin-api', takenAt: now,
      windows: [{ id: 'claude.5h', label: '5-hour', kind: 'rolling-window', unit: 'percent', used: 82, limit: 100, remaining: 18, resetsAt: now + 1000 }] },
      permissionSentence: 'Asks before acting', accountLabel: 'Max A', showCost: true, now });
    expect(view.rows.findIndex(r => r.label === 'Plan usage')).toBeLessThan(view.rows.findIndex(r => r.label === 'Used in this session'));
    expect(view.text).toContain('API-price equivalent'); expect(view.text).toContain('312K of 1M (31%)');
    expect(view.text).toContain('59 min');
  });
  it('hides every dollar when showCost is off, and never assigns Copilot a dollar bill', () => {
    const hidden = buildSessionStatus({ instance, breakdown, showCost: false, now });
    expect(hidden.text).not.toContain('$'); expect(hidden.text).toContain('Cost figures are hidden');
    const copilot = buildSessionStatus({ instance: { ...instance, provider: 'copilot' }, breakdown: { ...breakdown, aiCreditsNano: 12.4e9 }, showCost: true, now });
    expect(copilot.text).toContain('12.4'); expect(copilot.text).toContain('AI credits'); expect(copilot.text).not.toContain('$');
  });
  it('states missing values, stale quota and aggregate-only context, with no cache claim for Codex', () => {
    const view = buildSessionStatus({ instance: { ...instance, provider: 'codex', contextUsage: { ...instance.contextUsage, occupancyIsAggregate: true, used: 1200000 } },
      quotaSnapshot: { provider: 'codex', ok: false, takenAt: 0, source: 'admin-api', windows: [] }, showCost: true, now });
    expect(view.text).toContain('May be out of date'); expect(view.text).toContain('Not available yet');
    expect(view.text).toContain('1.2M tokens used (no window figure)'); expect(view.rows.some(r => r.label === 'Cache')).toBe(false);
  });
  it.each([true, false])('keeps a partial known subtotal in the card and copied text, showCost=%s', showCost => {
    const view = buildSessionStatus({ instance, breakdown: { ...breakdown,
      byModel: [{ ...breakdown.byModel[0], costKnown: false }] }, showCost, now });
    const line = view.rows.find(row => row.label === 'Used in this session')!.lines.at(-1)!;
    if (showCost) {
      expect(line).toContain('≈$4.20 at API prices · some cost not available yet');
      expect(view.text).toContain(line);
    } else expect(view.text).not.toContain('$');
  });
  it('keeps unknown zero amounts unavailable and Copilot status credit-only', () => {
    const unknown = { ...breakdown, byModel: [{ ...breakdown.byModel[0], costUsd: 0, costKnown: false }] };
    const view = buildSessionStatus({ instance, breakdown: unknown, showCost: true, now });
    expect(view.rows.find(row => row.label === 'Used in this session')!.lines.at(-1)).toContain('cost not available yet');
    expect(view.rows.find(row => row.label === 'Used in this session')!.lines.at(-1)).not.toContain('$0.00');
    expect(buildSessionStatus({ instance: { ...instance, provider: 'copilot' }, breakdown: unknown, showCost: true, now }).text).not.toContain('$');
  });
});
