import { describe, expect, it } from 'vitest';
import {
  classifyCodexWindow,
  codexLimitResetAt,
  codexRateLimitsToQuotaWindows,
  mergeCodexRateLimitSnapshots,
  parseCodexAccountRateLimitsRead,
  parseCodexAccountRead,
  parseCodexRateLimitSnapshot,
} from './account-rate-limits';

describe('Codex account rate limits', () => {
  it('parses a read response and classifies windows by duration, not position', () => {
    const read = parseCodexAccountRateLimitsRead({
      ordinaryUsageAllowed: false,
      accountId: 'acct-1',
      rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2_000 },
        secondary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_000 },
        planType: 'pro',
      },
    });
    expect(read.ordinaryUsageAllowed).toBe(false);
    expect(read.accountId).toBe('acct-1');
    expect(classifyCodexWindow(read.rateLimits!.primary!)).toBe('weekly');
    expect(classifyCodexWindow(read.rateLimits!.secondary!)).toBe('five-hour');
    const windows = codexRateLimitsToQuotaWindows(read.rateLimits!);
    expect(windows.map((window) => [window.id, window.used, window.resetsAt])).toEqual([
      ['codex.weekly', 40, 2_000_000],
      ['codex.5h', 100, 1_000_000],
    ]);
  });

  it('takes the soonest exhausted reset, else the primary reset', () => {
    const exhausted = parseCodexRateLimitSnapshot({
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 50 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 10 },
    });
    expect(codexLimitResetAt(exhausted)).toBe(10_000);
    const notExhausted = parseCodexRateLimitSnapshot({ primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 7 } });
    expect(codexLimitResetAt(notExhausted)).toBe(7_000);
    expect(codexLimitResetAt(null)).toBeNull();
  });

  it('merges a sparse update into the last known snapshot', () => {
    const previous = parseCodexRateLimitSnapshot({
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 },
      secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 2 },
    });
    const update = parseCodexRateLimitSnapshot({ primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1 } })!;
    const merged = mergeCodexRateLimitSnapshots(previous, update);
    expect(merged.primary?.usedPercent).toBe(60);
    expect(merged.secondary?.usedPercent).toBe(5);
  });

  it('field-picks identity and ignores malformed payloads', () => {
    expect(parseCodexAccountRead({ account: { email: 'me@example.com', planType: 'plus', token: 'x' } })).toEqual({ email: 'me@example.com', planType: 'plus' });
    expect(parseCodexAccountRead('nonsense')).toEqual({ email: null, planType: null });
    expect(parseCodexAccountRateLimitsRead(null)).toEqual({ ordinaryUsageAllowed: null, rateLimits: null, accountId: null });
  });
});
