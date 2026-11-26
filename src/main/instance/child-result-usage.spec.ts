import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { getCostTracker } from '../core/system/cost-tracker';
import { recordCompletionCost } from './communication-completion-cost';
import { childSpendTokens } from './child-result-usage';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../context/cache-analytics-service', () => ({
  getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }),
}));

function claudeChild(occupancy: number, name = '1'): Instance {
  return {
    id: `claude-helper-${name}`,
    sessionId: `claude-helper-session-${name}`,
    provider: 'claude',
    currentModel: 'claude-opus-5',
    parentId: 'parent-1',
    agentId: 'helper',
    metadata: {},
    contextUsage: { used: occupancy, total: 200_000, percentage: (occupancy / 200_000) * 100 },
    totalTokensUsed: occupancy,
    status: 'idle',
    outputBuffer: [],
    createdAt: Date.now(),
    restartEpoch: 0,
    requestCount: 0,
  } as unknown as Instance;
}

/** The result-line usage shape `claude-output-parser` hands to `recordCompletionCost`. */
function claudeCompletion(inputTokens: number, outputTokens: number): CliResponse {
  return {
    id: `result-${inputTokens}`,
    role: 'assistant',
    content: 'done',
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  } as CliResponse;
}

beforeEach(() => getCostTracker().clearEntries());

describe('childSpendTokens (part 6a)', () => {
  it('reports the recorded ledger spend after a real Claude completion even when occupancy is much larger', () => {
    const child = claudeChild(180_000);
    recordCompletionCost(child.id, child, claudeCompletion(30_000, 10_000));
    expect(getCostTracker().getEntries()).toHaveLength(1);
    expect(childSpendTokens(child)).toBe(40_000);
  });

  it('totals every recorded turn of the child', () => {
    const child = claudeChild(180_000);
    recordCompletionCost(child.id, child, claudeCompletion(30_000, 10_000));
    recordCompletionCost(child.id, child, claudeCompletion(5_000, 2_000));
    expect(childSpendTokens(child)).toBe(47_000);
  });

  it('answers the child-id form of the query from the same ledger', () => {
    const child = claudeChild(180_000);
    recordCompletionCost(child.id, child, claudeCompletion(30_000, 10_000));
    expect(childSpendTokens('claude-helper-1')).toBe(40_000);
    expect(childSpendTokens({ id: 'claude-helper-1' })).toBe(40_000);
  });

  it('ignores other children\'s ledger rows', () => {
    const child = claudeChild(180_000);
    const sibling = claudeChild(10_000, '2');
    recordCompletionCost(sibling.id, sibling, claudeCompletion(1_000, 500));
    expect(childSpendTokens(child)).toBeUndefined();
  });

  it('reports nothing for a child with no ledger record (Claude occupancy never counts)', () => {
    const child = claudeChild(180_000);
    expect(childSpendTokens(child)).toBeUndefined();
    expect(childSpendTokens({ contextUsage: {} })).toBeUndefined();
    expect(childSpendTokens({})).toBeUndefined();
    expect(childSpendTokens(undefined)).toBeUndefined();
  });

  it('keeps the adapter lifetime spend counter only as a fallback when the ledger holds no record', () => {
    const counterOnly = claudeChild(180_000);
    counterOnly.contextUsage.cumulativeTokens = 40_000;
    expect(childSpendTokens(counterOnly)).toBe(40_000);

    const child = claudeChild(180_000);
    child.contextUsage.cumulativeTokens = 999_000;
    recordCompletionCost(child.id, child, claudeCompletion(30_000, 10_000));
    expect(childSpendTokens(child)).toBe(40_000);
  });

  it('ignores non-finite recorded values', () => {
    expect(childSpendTokens({ contextUsage: { cumulativeTokens: Number.NaN } })).toBeUndefined();
    expect(childSpendTokens({ contextUsage: { cumulativeTokens: Number.POSITIVE_INFINITY } })).toBeUndefined();
    expect(childSpendTokens({ contextUsage: { cumulativeTokens: 0 } })).toBe(0);
  });
});
