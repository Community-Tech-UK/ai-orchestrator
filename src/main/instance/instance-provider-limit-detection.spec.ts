import { describe, it, expect } from 'vitest';
import {
  detectErrorProviderLimit,
  detectCompletionProviderLimit,
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
});
