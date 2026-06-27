import { describe, expect, it } from 'vitest';

import { isProviderNotice } from './provider-notice';

describe('isProviderNotice', () => {
  it('flags real provider rate/usage-limit notices', () => {
    const notices = [
      "You've hit your session limit · resets 6:30pm",
      'You have hit your usage limit',
      'Claude usage limit reached',
      'Session limit reached. Try again later.',
      '5-hour limit reached ∙ resets 3am',
      'Your limit resets at 6pm',
      'Too many requests',
      'quota exceeded',
      'Error: You have exceeded your monthly quota (Request ID: <redacted>)',
      'Monthly quota reached. Try again later.',
    ];
    for (const text of notices) {
      expect(isProviderNotice(text), text).toBe(true);
    }
  });

  it('does not flag legitimate titles/answers that merely mention limits', () => {
    const legit = [
      'Fix the session-limit retry bug',
      'Session limit reset handling',
      'Add rate limiting to the API',
      'Build the monthly quota dashboard',
      'Investigate the broken deployment',
      'Refactor the AuthService session cache',
      'Implement loopfixex.md',
    ];
    for (const text of legit) {
      expect(isProviderNotice(text), text).toBe(false);
    }
  });

  it('treats empty/nullish input as not a notice', () => {
    expect(isProviderNotice('')).toBe(false);
    expect(isProviderNotice('   ')).toBe(false);
    expect(isProviderNotice(null)).toBe(false);
    expect(isProviderNotice(undefined)).toBe(false);
  });
});
