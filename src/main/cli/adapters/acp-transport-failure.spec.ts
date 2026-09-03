import { describe, expect, it } from 'vitest';

import {
  classifyMissingUsage,
  describeTruncatedAcpTurn,
  MISSING_USAGE_WARN_MIN_DURATION_MS,
} from './acp-transport-failure';

describe('classifyMissingUsage', () => {
  it('flags a session that reported usage and then stopped', () => {
    expect(classifyMissingUsage({ hasReportedUsage: true, durationMs: 100 }))
      .toBe('usage-regression');
  });

  it('flags a long turn from a session that has never reported usage', () => {
    // The motivating incident: the session's FIRST turn, so there is no prior
    // usage to regress from — duration is the only thing that makes the
    // silence suspicious. That turn ran ~2,213,000ms.
    expect(
      classifyMissingUsage({
        hasReportedUsage: false,
        durationMs: MISSING_USAGE_WARN_MIN_DURATION_MS,
      }),
    ).toBe('substantial-turn');
    expect(classifyMissingUsage({ hasReportedUsage: false, durationMs: 2_213_113 }))
      .toBe('substantial-turn');
  });

  it('stays quiet for a short turn from an agent that does not report usage', () => {
    expect(
      classifyMissingUsage({
        hasReportedUsage: false,
        durationMs: MISSING_USAGE_WARN_MIN_DURATION_MS - 1,
      }),
    ).toBeNull();
    expect(classifyMissingUsage({ hasReportedUsage: false, durationMs: 0 })).toBeNull();
  });
});

describe('describeTruncatedAcpTurn', () => {
  const FAILURE =
    'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)';

  it('builds a resumable error notice carrying the raw provider error', () => {
    const report = describeTruncatedAcpTurn({
      adapter: 'cursor-acp',
      failure: FAILURE,
      stopReason: 'end_turn',
      providerUsageReported: false,
      durationMs: 2_213_113,
      contentLength: 2876,
    });

    // Informational, not an error: the detection can misfire, so a wrong
    // note must not read as a failed turn.
    expect(report.notice.type).toBe('system');
    expect(report.notice.content).toContain(FAILURE);
    expect(report.notice.content).toContain('continue');
    // Must not assert truncation outright.
    expect(report.notice.content).toContain('may be cut off');
    expect(report.notice.metadata).toMatchObject({
      source: 'acp-transport-failure',
      truncatedTurn: true,
      recoverable: true,
      providerUsageReported: false,
      stopReason: 'end_turn',
    });
    expect(report.logFields).toMatchObject({
      adapter: 'cursor-acp',
      failure: FAILURE,
      durationMs: 2_213_113,
      contentLength: 2876,
    });
  });
});
