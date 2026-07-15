import { describe, expect, it } from 'vitest';

import { CodexTurnCostGovernor } from './turn-cost-governor';

describe('CodexTurnCostGovernor', () => {
  it('warns once at 2x the context window', () => {
    const governor = new CodexTurnCostGovernor();

    expect(governor.observe({ cumulativeTokens: 199_999, contextWindow: 100_000 }).action).toBe('continue');
    expect(governor.observe({ cumulativeTokens: 200_000, contextWindow: 100_000 }).action).toBe('warn');
    expect(governor.observe({ cumulativeTokens: 300_000, contextWindow: 100_000 }).action).toBe('continue');
  });

  it('requests recovery once at 4x the context window', () => {
    const governor = new CodexTurnCostGovernor();

    expect(governor.observe({ cumulativeTokens: 400_000, contextWindow: 100_000 }).action).toBe('recover');
    expect(governor.observe({ cumulativeTokens: 700_000, contextWindow: 100_000 }).action).toBe('continue');
  });

  it('requests urgent recovery when the first sample is already at 8x', () => {
    const governor = new CodexTurnCostGovernor();

    const decision = governor.observe({ cumulativeTokens: 800_000, contextWindow: 100_000 });

    expect(decision).toMatchObject({
      action: 'recover-urgent',
      spendSinceCompaction: 800_000,
      contextWindow: 100_000,
      multiple: 8,
    });
  });

  it('starts a new decision epoch only after observed compaction', () => {
    const governor = new CodexTurnCostGovernor();
    governor.observe({ cumulativeTokens: 400_000, contextWindow: 100_000 });

    governor.recordCompactionObserved(400_000);

    expect(governor.observe({ cumulativeTokens: 599_999, contextWindow: 100_000 }).action).toBe('continue');
    expect(governor.observe({ cumulativeTokens: 600_000, contextWindow: 100_000 }).action).toBe('warn');
    expect(governor.observe({ cumulativeTokens: 800_000, contextWindow: 100_000 }).action).toBe('recover');
  });

  it('treats a provider cumulative-counter rollback as a new epoch', () => {
    const governor = new CodexTurnCostGovernor();
    governor.observe({ cumulativeTokens: 400_000, contextWindow: 100_000 });

    expect(governor.observe({ cumulativeTokens: 10_000, contextWindow: 100_000 }).action).toBe('continue');
    expect(governor.observe({ cumulativeTokens: 210_000, contextWindow: 100_000 }).action).toBe('warn');
  });

  it('ignores malformed or non-positive samples', () => {
    const governor = new CodexTurnCostGovernor();

    expect(governor.observe({ cumulativeTokens: Number.NaN, contextWindow: 100_000 }).action).toBe('continue');
    expect(governor.observe({ cumulativeTokens: 1_000_000, contextWindow: 0 }).action).toBe('continue');
    expect(governor.observe({ cumulativeTokens: -1, contextWindow: 100_000 }).action).toBe('continue');
  });

  it('normalizes custom threshold multiples so recovery remains above warning', () => {
    const governor = new CodexTurnCostGovernor({
      warningMultiple: 3.8,
      recoveryMultiple: 2,
      urgentMultiple: Number.NaN,
    });

    expect(governor.getThresholds()).toEqual({
      warningMultiple: 3.8,
      recoveryMultiple: 3.8,
      urgentMultiple: 8,
    });
  });

  it('can retry recovery on a later sample when arming the interrupt failed', () => {
    const governor = new CodexTurnCostGovernor();
    expect(governor.observe({ cumulativeTokens: 400_000, contextWindow: 100_000 }).action).toBe('recover');

    governor.recordRecoveryAttemptFailed();

    expect(governor.observe({ cumulativeTokens: 450_000, contextWindow: 100_000 }).action).toBe('recover');
  });
});
