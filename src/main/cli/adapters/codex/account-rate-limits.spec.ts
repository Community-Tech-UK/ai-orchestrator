import { describe, expect, it } from 'vitest';
import {
  classifyCodexWindow,
  codexLimitResetAt,
  codexQuotaSnapshot,
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

  it('reads credits availability and reports usage access on the snapshot', () => {
    // Shapes from real `account/rateLimits/read` responses: a topped-up Pro account and an empty Pro Lite one.
    const toppedUp = parseCodexAccountRateLimitsRead({
      ordinaryUsageAllowed: false,
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 2_000 },
        secondary: null,
        credits: { hasCredits: true, unlimited: false, balance: '2500.0000000000' },
        spendControlReached: false,
        rateLimitReachedType: 'rate_limit_reached',
      },
    });
    expect(toppedUp.rateLimits?.creditsAvailable).toBe(true);
    expect(codexQuotaSnapshot(toppedUp.rateLimits!, toppedUp.ordinaryUsageAllowed).usageAccess)
      .toEqual({ ordinaryUsageAllowed: false, creditsAvailable: true });

    const empty = parseCodexRateLimitSnapshot({ credits: { hasCredits: false, unlimited: false, balance: '0' } });
    expect(empty?.creditsAvailable).toBe(false);
    expect(parseCodexRateLimitSnapshot({ credits: { unlimited: true }, spendControlReached: true })?.creditsAvailable).toBe(false);
    expect(parseCodexRateLimitSnapshot({ primary: null })?.creditsAvailable).toBeNull();
    expect(codexQuotaSnapshot(parseCodexRateLimitSnapshot({ primary: null })!).usageAccess).toBeUndefined();
  });

  it('keeps the last known credits availability across a sparse update', () => {
    const previous = parseCodexRateLimitSnapshot({ credits: { hasCredits: true, unlimited: false } });
    const update = parseCodexRateLimitSnapshot({ primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1 } })!;
    expect(mergeCodexRateLimitSnapshots(previous, update).creditsAvailable).toBe(true);
  });

  it('field-picks identity and ignores malformed payloads', () => {
    expect(parseCodexAccountRead({ account: { email: 'me@example.com', planType: 'plus', token: 'x' } })).toEqual({ email: 'me@example.com', planType: 'plus' });
    expect(parseCodexAccountRead('nonsense')).toEqual({ email: null, planType: null });
    expect(parseCodexAccountRateLimitsRead(null)).toEqual({ ordinaryUsageAllowed: null, rateLimits: null, accountId: null });
  });
});
