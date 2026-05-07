import { describe, expect, it } from 'vitest';

describe('operator barrel exports', () => {
  it('does not expose retired deterministic operator engine APIs', async () => {
    const operator = await import('./index') as Record<string, unknown>;

    expect(operator['OperatorThreadService']).toBeUndefined();
    expect(operator['getOperatorThreadService']).toBeUndefined();
    expect(operator['OperatorEngine']).toBeUndefined();
    expect(operator['getOperatorEngine']).toBeUndefined();
    expect(operator['planOperatorRequest']).toBeUndefined();
    expect(operator['ProjectAgentExecutor']).toBeUndefined();
    expect(operator['OperatorVerificationExecutor']).toBeUndefined();
    expect(operator['buildOperatorFixWorkerPrompt']).toBeUndefined();
    expect(operator['OperatorStallDetector']).toBeUndefined();
    expect(operator['OperatorFollowUpScheduler']).toBeUndefined();
    expect(operator['OperatorMemoryPromoter']).toBeUndefined();
  });
});
