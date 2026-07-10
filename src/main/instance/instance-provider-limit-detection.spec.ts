import { describe, it, expect } from 'vitest';
import {
  detectErrorProviderLimit,
  detectCompletionProviderLimit,
  readAdapterRateLimitTelemetry,
} from './instance-provider-limit-detection';

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
