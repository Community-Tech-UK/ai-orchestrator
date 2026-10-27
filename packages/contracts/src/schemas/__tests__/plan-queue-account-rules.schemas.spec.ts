import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_ACCOUNT_RULES, PlanQueueAccountRulesSchema } from '@contracts/schemas/plan-queue';

describe('PlanQueueAccountRulesSchema', () => {
  it('accepts empty lists and the default', () => {
    expect(PlanQueueAccountRulesSchema.safeParse(DEFAULT_PLAN_QUEUE_ACCOUNT_RULES).success).toBe(true);
  });

  it('accepts accounts on one list each, keyed by provider and id', () => {
    const result = PlanQueueAccountRulesSchema.safeParse({
      never: [{ provider: 'claude', accountId: 'suas-claude' }],
      last: [{ provider: 'copilot', accountId: 'work-seat' }],
    });
    expect(result.success).toBe(true);
  });

  it('refuses an account on both lists', () => {
    const result = PlanQueueAccountRulesSchema.safeParse({
      never: [{ provider: 'codex', accountId: 'pro-2' }],
      last: [{ provider: 'codex', accountId: 'pro-2' }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses an account listed twice on one list', () => {
    const result = PlanQueueAccountRulesSchema.safeParse({
      never: [{ provider: 'codex', accountId: 'pro-2' }, { provider: 'codex', accountId: 'pro-2' }],
      last: [],
    });
    expect(result.success).toBe(false);
  });

  it('treats the same id under different providers as different accounts', () => {
    const result = PlanQueueAccountRulesSchema.safeParse({
      never: [{ provider: 'claude', accountId: 'shared' }],
      last: [{ provider: 'copilot', accountId: 'shared' }],
    });
    expect(result.success).toBe(true);
  });

  it('refuses an unknown provider and unknown keys', () => {
    expect(PlanQueueAccountRulesSchema.safeParse({ never: [{ provider: 'gemini', accountId: 'a' }], last: [] }).success).toBe(false);
    expect(PlanQueueAccountRulesSchema.safeParse({ never: [{ provider: 'claude', accountId: 'a', extra: 1 }], last: [] }).success).toBe(false);
    expect(PlanQueueAccountRulesSchema.safeParse({ never: [], last: [], extra: [] }).success).toBe(false);
  });
});
