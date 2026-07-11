import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  detectErrorProviderLimit,
  detectCompletionProviderLimit,
  readAdapterRateLimitTelemetry,
  parseResetHintFromText,
} from './instance-provider-limit-detection';

/** Local (not UTC) epoch-ms for a fixed test day at the given hour/minute. */
function localTime(hour: number, minute = 0, day = 1): number {
  return new Date(2024, 5, day, hour, minute, 0, 0).getTime();
}

describe('detectErrorProviderLimit', () => {
  it('detects a structured rate-limit error and surfaces its reset time', () => {
    const resetAt = Date.now() + 60_000;
    const signal = detectErrorProviderLimit(
      { rateLimit: { limit: 100, remaining: 0, resetAt } },
      'Rate limited',
    );
    expect(signal).not.toBeNull();
    expect(signal?.resetAtHint).toBe(resetAt);
  });

  it('detects a structured quota error and surfaces its reset time', () => {
    const resetAt = Date.now() + 120_000;
    const signal = detectErrorProviderLimit(
      { quota: { exhausted: true, resetAt } },
      'Quota exhausted',
    );
    expect(signal?.resetAtHint).toBe(resetAt);
  });

  it('detects a bare provider notice message with no structured reset time', () => {
    const signal = detectErrorProviderLimit({}, "You've hit your session limit");
    expect(signal).not.toBeNull();
    expect(signal?.resetAtHint).toBeNull();
  });

  it('ignores an ordinary error that is not a provider limit', () => {
    expect(detectErrorProviderLimit(new Error('Fix the session-limit retry bug'), 'Fix the session-limit retry bug')).toBeNull();
    expect(detectErrorProviderLimit({}, 'ENOENT: file not found')).toBeNull();
  });

  it('classifies a generic error as a limit when telemetry reports a live rejected window', () => {
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    const signal = detectErrorProviderLimit({}, 'stream closed unexpectedly', {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: resetsAtSec,
    });
    expect(signal).not.toBeNull();
    expect(signal?.resetAtHint).toBe(resetsAtSec * 1000);
  });

  it('does not classify on telemetry whose reset time already passed', () => {
    const resetsAtSec = Math.floor(Date.now() / 1000) - 60;
    expect(detectErrorProviderLimit({}, 'stream closed unexpectedly', {
      status: 'rejected',
      resetsAt: resetsAtSec,
    })).toBeNull();
  });

  it('does not classify on non-rejected telemetry statuses', () => {
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;
    expect(detectErrorProviderLimit({}, 'stream closed unexpectedly', {
      status: 'allowed_warning',
      resetsAt: resetsAtSec,
    })).toBeNull();
  });

  it('prefers structured error diagnostics over the telemetry reset time', () => {
    const diagnosticsResetAt = Date.now() + 60_000;
    const telemetryResetsAtSec = Math.floor(Date.now() / 1000) + 7200;
    const signal = detectErrorProviderLimit(
      { rateLimit: { resetAt: diagnosticsResetAt } },
      'Rate limited',
      { status: 'rejected', resetsAt: telemetryResetsAtSec },
    );
    expect(signal?.resetAtHint).toBe(diagnosticsResetAt);
  });
});

describe('detectCompletionProviderLimit', () => {
  it('detects a limit notice returned as assistant content on an exit-0 turn', () => {
    const signal = detectCompletionProviderLimit({
      content: "You've hit your session limit · resets 6:30pm",
    });
    expect(signal).not.toBeNull();
    expect(signal?.reason).toContain('completed turn');
  });

  it('prefers a structured reset time from the completion metadata', () => {
    const resetAt = Date.now() + 90_000;
    const signal = detectCompletionProviderLimit({
      content: '5-hour limit reached',
      metadata: { rateLimit: { resetAt } },
    });
    expect(signal?.resetAtHint).toBe(resetAt);
  });

  it('ignores an ordinary completed turn', () => {
    expect(detectCompletionProviderLimit({ content: 'Here is the refactored function.' })).toBeNull();
    expect(detectCompletionProviderLimit({ content: '' })).toBeNull();
  });

  it('falls back to the telemetry reset time when the notice carries no metadata', () => {
    const resetsAtSec = Math.floor(Date.now() / 1000) + 1800;
    const signal = detectCompletionProviderLimit(
      { content: '5-hour limit reached' },
      { status: 'rejected', resetsAt: resetsAtSec },
    );
    expect(signal?.resetAtHint).toBe(resetsAtSec * 1000);
  });

  it('does not classify an ordinary completion just because telemetry is throttled', () => {
    const resetsAtSec = Math.floor(Date.now() / 1000) + 1800;
    expect(detectCompletionProviderLimit(
      { content: 'Here is the refactored function.' },
      { status: 'rejected', resetsAt: resetsAtSec },
    )).toBeNull();
  });
});

describe('parseResetHintFromText', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses the live incident string to today\'s reset time', () => {
    const now = localTime(15, 42);
    const text = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:01 PM. - [codex_error_info: usageLimitExceeded]";
    expect(parseResetHintFromText(text, now)).toBe(localTime(17, 1));
  });

  it('keeps today\'s time when it has not passed yet (now 4pm, resets 5:01pm)', () => {
    const now = localTime(16, 0);
    expect(parseResetHintFromText('try again at 5:01 PM', now)).toBe(localTime(17, 1));
  });

  it('rolls to tomorrow when the clock time already passed (now 6pm, resets 5:01pm)', () => {
    const now = localTime(18, 0);
    expect(parseResetHintFromText('try again at 5:01 PM', now)).toBe(localTime(17, 1, 2));
  });

  it('rolls "resets 6:30pm" forward a day when now is 7pm', () => {
    const now = localTime(19, 0);
    expect(parseResetHintFromText('resets 6:30pm', now)).toBe(localTime(18, 30, 2));
  });

  it('parses "resets at 11am"', () => {
    const now = localTime(9, 0);
    expect(parseResetHintFromText('resets at 11am', now)).toBe(localTime(11, 0));
  });

  it('parses 24-hour clock format ("try again at 17:01")', () => {
    const now = localTime(10, 0);
    expect(parseResetHintFromText('try again at 17:01', now)).toBe(localTime(17, 1));
  });

  it('treats 12:00 PM as noon', () => {
    const now = localTime(9, 0);
    expect(parseResetHintFromText('resets at 12:00 PM', now)).toBe(localTime(12, 0));
  });

  it('treats 12:00 AM as midnight, rolling forward when already past', () => {
    const now = localTime(9, 0);
    expect(parseResetHintFromText('resets at 12:00 AM', now)).toBe(localTime(0, 0, 2));
  });

  it('parses "in 45 minutes"', () => {
    const now = localTime(10, 0);
    expect(parseResetHintFromText('try again in 45 minutes', now)).toBe(now + 45 * 60_000);
  });

  it('parses "in 2 hours"', () => {
    const now = localTime(10, 0);
    expect(parseResetHintFromText('try again in 2 hours', now)).toBe(now + 2 * 3_600_000);
  });

  it('parses "in 3 hours 25 minutes"', () => {
    const now = localTime(10, 0);
    expect(parseResetHintFromText('try again in 3 hours 25 minutes', now)).toBe(now + (3 * 3_600_000 + 25 * 60_000));
  });

  it('parses "retry in 90 seconds"', () => {
    const now = localTime(10, 0);
    expect(parseResetHintFromText('retry in 90 seconds', now)).toBe(now + 90_000);
  });

  it('does not let a spurious earlier "in " shadow a real duration later in the text', () => {
    const now = localTime(10, 0);
    const text = "Rate limit configured in your account settings. You've hit your usage limit; try again in 45 minutes.";
    expect(parseResetHintFromText(text, now)).toBe(now + 45 * 60_000);
  });

  it('parses an ISO reset timestamp', () => {
    const now = Date.UTC(2026, 6, 11, 15, 42);
    expect(parseResetHintFromText('resets at 2026-07-11T17:01:00Z', now)).toBe(
      Date.parse('2026-07-11T17:01:00Z'),
    );
  });

  it('returns null for garbage or empty input', () => {
    expect(parseResetHintFromText('nothing useful here', localTime(10, 0))).toBeNull();
    expect(parseResetHintFromText('', localTime(10, 0))).toBeNull();
  });

  it('rejects results more than 8 days out', () => {
    expect(parseResetHintFromText('try again in 300 hours', localTime(10, 0))).toBeNull();
  });

  it('feeds detectErrorProviderLimit via text-parse fallback when no structured/telemetry hint exists', () => {
    const now = localTime(15, 42);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const signal = detectErrorProviderLimit(
      {},
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:01 PM. - [codex_error_info: usageLimitExceeded]",
    );
    expect(signal?.resetAtHint).toBe(localTime(17, 1));
  });
});

describe('readAdapterRateLimitTelemetry', () => {
  it('reads telemetry from an adapter exposing getLastRateLimitInfo', () => {
    const info = { status: 'rejected', resetsAt: 123 };
    expect(readAdapterRateLimitTelemetry({ getLastRateLimitInfo: () => info })).toBe(info);
  });

  it('returns null for adapters without telemetry', () => {
    expect(readAdapterRateLimitTelemetry({})).toBeNull();
    expect(readAdapterRateLimitTelemetry(null)).toBeNull();
  });
});
