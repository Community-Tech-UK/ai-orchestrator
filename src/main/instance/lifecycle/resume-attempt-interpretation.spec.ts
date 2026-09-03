import { describe, expect, it } from 'vitest';
import { interpretUnconfirmedResumeAttempt } from './resume-attempt-interpretation';
import type { ResumeAttemptResult } from '../../cli/adapters/base-cli-adapter';

describe('interpretUnconfirmedResumeAttempt', () => {
  it('treats a fresh-fallback as unrecoverable', () => {
    const result: ResumeAttemptResult = {
      source: 'fresh-fallback',
      confirmed: false,
      requestedSessionId: 'sess-1',
    };
    expect(interpretUnconfirmedResumeAttempt('inst-1', result, false)).toBe('unrecoverable');
  });

  it('treats a wrong echoed session id as unrecoverable', () => {
    const result: ResumeAttemptResult = {
      source: 'native',
      confirmed: false,
      requestedSessionId: 'sess-1',
      actualSessionId: 'sess-other',
      reason: 'mismatch',
    };
    expect(interpretUnconfirmedResumeAttempt('inst-1', result, false)).toBe('unrecoverable');
  });

  it('treats an attempted but unconfirmed native resume as inconclusive', () => {
    const result: ResumeAttemptResult = {
      source: 'native',
      confirmed: false,
      requestedSessionId: 'sess-1',
      reason: 'no echo yet',
    };
    expect(interpretUnconfirmedResumeAttempt('inst-1', result, false)).toBe('inconclusive');
  });

  it('omits session ids from the crash-recovery classification path', () => {
    const result: ResumeAttemptResult = {
      source: 'fresh-fallback',
      confirmed: false,
      requestedSessionId: 'sess-secret',
    };
    expect(interpretUnconfirmedResumeAttempt('inst-1', result, true)).toBe('unrecoverable');
  });
});
