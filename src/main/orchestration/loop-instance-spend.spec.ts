import { describe, expect, it } from 'vitest';
import { collectInstanceSpend } from './loop-instance-spend';
import { recordCostAttribution } from '../core/system/cost-attribution';
describe('reviewer instance accounting', () => {
  it('preserves unpriced usage when all or part of the reviewer cost is unknown', () => {
    const collector = collectInstanceSpend('unknown-review');
    recordCostAttribution({ source: 'instance-turn', taskType: 'child', instanceId: 'unknown-review', provider: 'opencode', model: 'unknown-model', usage: { inputTokens: 10 } });
    recordCostAttribution({ source: 'instance-turn', taskType: 'child', instanceId: 'unknown-review', provider: 'claude', usage: { inputTokens: 20, cost: 0.4 } });
    expect(collector.stop()).toMatchObject({ tokens: 30, costUsd: 0.4, exactUsd: 0.4, records: 2, unknownRecords: 1, basis: 'unknown' });
  });
  it('uses turn attribution, ignores other instances, and stops observing', () => {
    const collector = collectInstanceSpend('review');
    for (const instanceId of ['review','other']) recordCostAttribution({ source:'instance-turn', taskType:'child', instanceId, provider:'claude', usage:{inputTokens:10,outputTokens:20,cacheReadTokens:100,cost:0.4} });
    expect(collector.stop()).toMatchObject({tokens:30,costUsd:0.4,exactUsd:0.4,records:1,unknownRecords:0,basis:'provider-reported',spendBreakdown:[{tokens:30,costCents:40,basis:'provider-reported'}]});
    recordCostAttribution({source:'instance-turn',taskType:'child',instanceId:'review',usage:{cost:4}});
    expect(collector.stop().costUsd).toBe(0.4);
  });

  it('allocates rounded cents without losing computed or unknown turns', () => {
    const collector = collectInstanceSpend('mixed-review');
    recordCostAttribution({ source: 'instance-turn', taskType: 'review', instanceId: 'mixed-review', provider: 'claude', usage: { inputTokens: 10, cost: 0.101 } });
    recordCostAttribution({ source: 'instance-turn', taskType: 'review', instanceId: 'mixed-review', provider: 'codex', model: 'gpt-5.5', usage: { inputTokens: 200 } });
    recordCostAttribution({ source: 'instance-turn', taskType: 'review', instanceId: 'mixed-review', provider: 'opencode', model: 'unknown-model', usage: { inputTokens: 10 } });
    const spend = collector.stop();
    expect(spend.spendBreakdown).toEqual([
      expect.objectContaining({ tokens: 10, costCents: 11, basis: 'provider-reported' }),
      expect.objectContaining({ tokens: 200, costCents: 0, basis: 'computed' }),
      expect.objectContaining({ tokens: 10, costCents: 0, basis: 'unknown' }),
    ]);
    expect(spend.spendBreakdown.reduce((sum, row) => sum + row.costCents, 0)).toBe(Math.ceil(spend.costUsd * 100));
    expect(spend.costUsd).toBeCloseTo(0.102);
  });

  it('retains explicit zero-dollar provider and free-seat reports', () => {
    const collector = collectInstanceSpend('free-review');
    recordCostAttribution({ source: 'instance-turn', taskType: 'review', instanceId: 'free-review', provider: 'claude', usage: { inputTokens: 10, cost: 0 } });
    recordCostAttribution({ source: 'instance-turn', taskType: 'review', instanceId: 'free-review', provider: 'copilot', usage: { inputTokens: 20 } });
    expect(collector.stop()).toMatchObject({ costUsd: 0, unknownRecords: 0, basis: 'provider-reported', spendBreakdown: [{ tokens: 10, costCents: 0, basis: 'provider-reported' }, { tokens: 20, costCents: 0, basis: 'provider-reported' }] });
  });
});
