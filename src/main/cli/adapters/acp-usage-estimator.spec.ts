import { describe, expect, it } from 'vitest';
import {
  buildAcpContextUsageEvent,
  estimateAcpCliUsage,
  hasMeasuredAcpUsage,
  toAcpCliUsage,
} from './acp-usage-estimator';

describe('hasMeasuredAcpUsage', () => {
  it('is false for undefined usage', () => {
    expect(hasMeasuredAcpUsage(undefined)).toBe(false);
  });

  it('is false for a usage object with no token fields (e.g. cost-only)', () => {
    expect(hasMeasuredAcpUsage({ costUsd: 0.01 })).toBe(false);
  });

  it('is true when any of inputTokens/outputTokens/totalTokens is present', () => {
    expect(hasMeasuredAcpUsage({ inputTokens: 0 })).toBe(true);
    expect(hasMeasuredAcpUsage({ outputTokens: 5 })).toBe(true);
    expect(hasMeasuredAcpUsage({ totalTokens: 5 })).toBe(true);
  });
});

describe('estimateAcpCliUsage (LT-100)', () => {
  it('estimates input/output tokens from prompt and response text and tags isEstimated', () => {
    const usage = estimateAcpCliUsage('hello there', 'hi back', '', 1234);
    expect(usage?.isEstimated).toBe(true);
    expect(usage?.inputTokens).toBeGreaterThan(0);
    expect(usage?.outputTokens).toBeGreaterThan(0);
    expect(usage?.totalTokens).toBe((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
    expect(usage?.duration).toBe(1234);
  });

  it('folds tool-activity text into the output-token estimate', () => {
    const withoutTools = estimateAcpCliUsage('hi', 'done', '', 0);
    const withTools = estimateAcpCliUsage('hi', 'done', 'a fairly long tool call payload here', 0);
    expect(withTools?.outputTokens ?? 0).toBeGreaterThan(withoutTools?.outputTokens ?? 0);
  });

  it('returns { duration } only, not a fabricated 0-token estimate, when there is no material at all', () => {
    const usage = estimateAcpCliUsage('', '', '', 500);
    expect(usage).toEqual({ duration: 500 });
  });

  it('returns undefined when there is no material and no duration either', () => {
    expect(estimateAcpCliUsage('', '', '', 0)).toBeUndefined();
  });
});

describe('toAcpCliUsage', () => {
  it('trusts real measured usage verbatim and does not tag it estimated', () => {
    const usage = toAcpCliUsage(
      { inputTokens: 3, outputTokens: 4, totalTokens: 7, costUsd: 0.01 },
      100,
      'prompt',
      'response',
      '',
    );
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7, cost: 0.01, duration: 100 });
    expect(usage && 'isEstimated' in usage).toBe(false);
  });

  it('falls back to the heuristic estimate when usage is undefined', () => {
    const usage = toAcpCliUsage(undefined, 100, 'a real prompt', 'a real response', '');
    expect(usage?.isEstimated).toBe(true);
  });

  it('falls back to the heuristic estimate when usage carries no token fields (e.g. only duration-shaped)', () => {
    const usage = toAcpCliUsage({}, 100, 'a real prompt', 'a real response', '');
    expect(usage?.isEstimated).toBe(true);
  });
});

describe('buildAcpContextUsageEvent (LT-018, unaffected by the LT-100 estimate)', () => {
  it('returns no event and the unchanged cumulative total when usage is absent', () => {
    const result = buildAcpContextUsageEvent(undefined, 500, 200_000);
    expect(result.event).toBeNull();
    expect(result.cumulativeTokensAfter).toBe(500);
    expect(result.usageKeys).toBeNull();
  });

  it('reports the usage object keys when usage exists but has no usable token fields', () => {
    const result = buildAcpContextUsageEvent({ costUsd: 0.01 }, 0, 200_000);
    expect(result.event).toBeNull();
    expect(result.usageKeys).toEqual(['costUsd']);
  });

  it('accumulates totalTokens across turns and computes a real percentage', () => {
    const first = buildAcpContextUsageEvent({ inputTokens: 900, outputTokens: 100, totalTokens: 1000 }, 0, 200_000);
    expect(first.event).toMatchObject({ used: 1000, cumulativeTokens: 1000 });
    const second = buildAcpContextUsageEvent(
      { inputTokens: 1900, outputTokens: 100, totalTokens: 2000 },
      first.cumulativeTokensAfter,
      200_000,
    );
    expect(second.event).toMatchObject({ used: 3000, cumulativeTokens: 3000 });
    expect(second.event?.percentage).toBeGreaterThan(0);
  });

  it('falls back to inputTokens + outputTokens when totalTokens is absent', () => {
    const result = buildAcpContextUsageEvent({ inputTokens: 40, outputTokens: 60 }, 0, 200_000);
    expect(result.event).toMatchObject({ used: 100, cumulativeTokens: 100 });
  });
});
