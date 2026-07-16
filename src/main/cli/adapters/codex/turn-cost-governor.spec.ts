import { describe, expect, it } from 'vitest';

import { CodexTurnCostGovernor } from './turn-cost-governor';

describe('CodexTurnCostGovernor telemetry', () => {
  it('reports cumulative pressure without owning an action threshold', () => {
    const governor = new CodexTurnCostGovernor();

    const observation = governor.observe({ cumulativeTokens: 800_000, contextWindow: 100_000 });

    expect(observation).toEqual({
      spendSinceCompaction: 800_000,
      contextWindow: 100_000,
      multiple: 8,
      counterResetObserved: false,
    });
    expect(observation).not.toHaveProperty('action');
  });

  it('starts a new telemetry epoch only after observed compaction', () => {
    const governor = new CodexTurnCostGovernor();
    governor.observe({ cumulativeTokens: 400_000, contextWindow: 100_000 });

    governor.recordCompactionObserved(400_000);

    expect(governor.observe({ cumulativeTokens: 600_000, contextWindow: 100_000 }))
      .toMatchObject({ spendSinceCompaction: 200_000, multiple: 2 });
  });

  it('reports a provider cumulative-counter rollback as observed proof', () => {
    const governor = new CodexTurnCostGovernor();
    governor.observe({ cumulativeTokens: 400_000, contextWindow: 100_000 });

    expect(governor.observe({ cumulativeTokens: 10_000, contextWindow: 100_000 }))
      .toEqual({
        spendSinceCompaction: 0,
        contextWindow: 100_000,
        multiple: 0,
        counterResetObserved: true,
      });
  });

  it('normalizes malformed or non-positive samples without inventing pressure', () => {
    const governor = new CodexTurnCostGovernor();

    expect(governor.observe({ cumulativeTokens: Number.NaN, contextWindow: 100_000 }))
      .toMatchObject({ spendSinceCompaction: 0, multiple: 0 });
    expect(governor.observe({ cumulativeTokens: 1_000_000, contextWindow: 0 }))
      .toMatchObject({ spendSinceCompaction: 0, multiple: 0 });
  });
});
