import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';
import { getCostTracker } from '../core/system/cost-tracker';
import { subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';
import { recordCompletionCost } from './communication-completion-cost';

vi.mock('../context/cache-analytics-service', () => ({
  getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }),
}));

function instance(): Instance {
  return {
    sessionId: 'native-original', provider: 'claude', currentModel: 'claude-sonnet-4-6-20260401',
    agentId: 'build', parentId: 'parent-original', metadata: { planQueueRole: 'verifier', rtkArm: 'on',
      rtkTrialEligible: true, rtkTrialKey: 'instance-original' },
    reasoningEffort: 'high', contextUsage: { used: 0, total: 200_000, percentage: 0 },
  } as unknown as Instance;
}

function response(usage: CliResponse['usage']): CliResponse {
  return { id: 'turn', content: 'done', role: 'assistant', usage };
}

describe('recordCompletionCost billing settlement', () => {
  const rows: CostAttributionRecord[] = [];
  let unsubscribe: () => void;

  beforeEach(() => {
    process.env['AIO_COST_ATTRIBUTION'] = '0';
    getCostTracker().clearEntries();
    rows.length = 0;
    unsubscribe = subscribeCostAttribution(row => rows.push(row));
  });

  afterEach(() => {
    unsubscribe();
    getCostTracker().clearEntries();
    delete process.env['AIO_COST_ATTRIBUTION'];
  });

  it('books a deferred native bill once under the response identity after the instance changes', () => {
    const owner = instance();
    const turn = response({ inputTokens: 100, outputTokens: 10 });
    const settle = deferResponseUsage(turn);
    const notified = vi.fn();
    recordCompletionCost('instance-original', owner, turn, notified);
    expect(rows).toHaveLength(0);

    owner.sessionId = 'native-new';
    owner.currentModel = 'claude-opus-5';
    owner.parentId = null;
    owner.metadata = { rtkArm: 'off', rtkTrialKey: 'different-item' };
    owner.reasoningEffort = 'low';
    turn.usage = { inputTokens: 100, outputTokens: 10, cost: 0.25,
      byModel: [{ model: 'claude-sonnet-4-6-20260401', inputTokens: 100,
        outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 }] };
    settle();
    settle();

    expect(notified).toHaveBeenCalledOnce();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'plan-queue', purposeDetail: 'verifier',
      sessionId: 'native-original', rtkArm: 'on', reasoningEffort: 'high',
      rtkTrialEligible: true, rtkTrialKey: 'instance-original', rtkTrialSurface: 'interactive',
      parentId: 'parent-original', model: 'claude-sonnet-4-6-20260401',
      costSource: 'provider', costKnown: true, usage: { cost: 0.25 } });
    expect(getCostTracker().getEntries()).toEqual([expect.objectContaining({
      sessionId: 'native-original', model: 'claude-sonnet-4-6-20260401', cost: 0.25,
      byModel: [expect.objectContaining({ costUsd: 0.25 })],
    })]);
    expect(owner.contextUsage.costEstimate).toBeCloseTo(0.25);
  });

  it('keeps native zero distinct from unknown dollars', () => {
    const owner = instance();
    recordCompletionCost('zero', owner, response({ inputTokens: 0, outputTokens: 0, cost: 0 }));
    owner.currentModel = 'unknown-claude-model';
    recordCompletionCost('unknown', owner, response({ inputTokens: 5 }));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ costSource: 'provider', costKnown: true,
      usage: { cost: 0 } });
    expect(rows[1]).toMatchObject({ costSource: 'unknown', costKnown: false });
    expect(rows[1].usage?.cost).toBeUndefined();
  });

  // Base (0190f9133) handed the tracker `undefined` for dollars nobody evidenced, so
  // the tracker estimated from its rate table. A hard 0 would understate spend and
  // `contextUsage.costEstimate`; only the attribution row says "unknown".
  it('never books unknown provider dollars as a hard zero: the tracker estimates, the row stays unknown', () => {
    const owner = instance();
    // Estimated token counts are not billing evidence, so the cost resolves to unknown.
    recordCompletionCost('estimated', owner, response({ inputTokens: 1_000, outputTokens: 100, isEstimated: true }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costSource: 'unknown', costKnown: false, isEstimated: true });
    expect(rows[0].usage?.cost).toBeUndefined();
    const expected = getCostTracker().calculateCost('claude-sonnet-4-6-20260401', 1_000, 100, 0, 0, 0);
    expect(expected).toBeGreaterThan(0);
    const [entry] = getCostTracker().getEntries();
    expect(entry.cost).toBe(expected);
    expect(entry.isEstimated).toBe(true);
    expect(owner.contextUsage.costEstimate).toBe(expected);
  });

  it('estimates an unpriced model in the tracker instead of recording zero', () => {
    const owner = instance();
    owner.currentModel = 'unknown-claude-model';

    recordCompletionCost('unpriced', owner, response({ inputTokens: 2_000, outputTokens: 500 }));

    expect(rows[0]).toMatchObject({ costSource: 'unknown', costKnown: false });
    expect(rows[0].usage?.cost).toBeUndefined();
    const expected = getCostTracker().calculateCost('unknown-claude-model', 2_000, 500, 0, 0, 0);
    expect(expected).toBeGreaterThan(0);
    expect(getCostTracker().getEntries()[0].cost).toBe(expected);
    expect(owner.contextUsage.costEstimate).toBe(expected);
  });

  it('keeps a native zero and a free provider at zero in the tracker', () => {
    const native = instance();
    recordCompletionCost('native-zero', native, response({ inputTokens: 5, cost: 0 }));
    const free = instance();
    free.provider = 'copilot';
    recordCompletionCost('free', free, response({ inputTokens: 5, outputTokens: 5 }));

    expect(getCostTracker().getEntries().map((entry) => entry.cost)).toEqual([0, 0]);
    expect(native.contextUsage.costEstimate).toBe(0);
  });

  it('keeps free provider execution known even when its token counts are estimated', () => {
    const owner = instance();
    owner.provider = 'copilot';
    recordCompletionCost('free-estimate', owner, response({ inputTokens: 5, isEstimated: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costSource: 'free', costKnown: true,
      isEstimated: true, usage: { cost: 0 } });
    expect(getCostTracker().getEntries()[0].cost).toBe(0);
  });

  it('records a priced model as a priced cost instead of an unknown historical row', () => {
    recordCompletionCost('priced', instance(), response({ inputTokens: 1_000, outputTokens: 100 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costSource: 'priced', costKnown: true });
    expect(rows[0].usage?.cost).toBeGreaterThan(0);
  });

  it('does not mark another provider or a legacy arm-only row as trial eligible', () => {
    const otherProvider = instance();
    otherProvider.provider = 'codex';
    recordCompletionCost('mixed-provider', otherProvider, response({ inputTokens: 5, cost: 0 }));
    const legacy = instance();
    legacy.metadata = { rtkArm: 'off' };
    recordCompletionCost('legacy', legacy, response({ inputTokens: 5, cost: 0 }));
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.rtkTrialEligible)).toEqual([undefined, undefined]);
    expect(rows.map(row => row.rtkTrialKey)).toEqual([undefined, undefined]);
  });

  it('does not project a stale trial key onto a different instance', () => {
    const owner = instance();
    owner.metadata = { rtkArm: 'on', rtkTrialEligible: true, rtkTrialKey: 'another-instance' };
    recordCompletionCost('actual-instance', owner, response({ inputTokens: 5, cost: 0 }));
    expect(rows).toHaveLength(1);
    expect(rows[0].rtkTrialEligible).toBeUndefined();
    expect(rows[0].rtkTrialKey).toBeUndefined();
  });
});
