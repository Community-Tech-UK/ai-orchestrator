import { describe, expect, it } from 'vitest';
import { queueItemSpendLabel } from './plan-queue-spend-label';

describe('queue spend estimates', () => {
  it.each([
    [{ tokens: 10, costUsd: 3, exactUsd: 0 }, '$3.00 (estimated)'],
    [{ tokens: 10, costUsd: 3, exactUsd: 2 }, '$3.00 (estimated)'],
    [{ tokens: 10, costUsd: 3, exactUsd: 3 }, '$3.00'],
    [{ tokens: 10, costUsd: 0, exactUsd: 0 }, '$0.00'],
    [{ tokens: 10, costUsd: 3, exactUsd: 2, unpricedTokens: 5 }, '$3.00 known (estimated) · 5 tokens not priced'],
    [{ tokens: 10, costUsd: 0, exactUsd: 0, unpricedTokens: 10 }, '10 tokens not priced'],
    [{ tokens: 1, costUsd: 0, exactUsd: 0, unpricedTokens: 1 }, '1 token not priced'],
    [{ tokens: 17_200_400, costUsd: 379.93, exactUsd: 379.93, unpricedTokens: 17_200_000 }, '$379.93 known · 17.2M tokens not priced'],
    [{ tokens: 17_200_000, costUsd: 0, exactUsd: 0, unpricedTokens: 17_200_000 }, '17.2M tokens not priced'],
  ])('labels the available pricing honestly: %j', (spend, label) => {
    expect(queueItemSpendLabel(spend)).toBe(label);
  });
});
