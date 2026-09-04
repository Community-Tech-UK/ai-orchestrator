import { describe, expect, it } from 'vitest';

import {
  classifyMissingUsage,
  classifyTurnEndingFailure,
  describeTruncatedAcpTurn,
  turnEndingFailureMetadata,
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
      kind: 'transport',
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

describe('classifyTurnEndingFailure', () => {
  /**
   * Verbatim tail of instance `uk95fj93z` (cursor/grok-4.6-high-fast,
   * 2026-09-03): a 73.9-minute turn with 1411 tool calls that reported
   * `stopReason: 'end_turn'` and was recorded as a clean completion.
   */
  const REFUSAL = 'Error: RetriableError: [resource_exhausted] Error';
  const TRANSPORT =
    'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)';
  const REAL_WORK =
    'Implementing W1.4 (structured handoff + tighter rehydrate caps), then continuing '
    + 'through the remaining Wave 1 tasks in order.';

  it('classifies the captured cursor refusal that ended a 74-minute turn', () => {
    expect(classifyTurnEndingFailure(`${REAL_WORK}\n\n${REFUSAL}`)).toEqual({
      kind: 'refusal',
      failure: REFUSAL,
    });
  });

  it('classifies a severed stream as transport, not refusal', () => {
    expect(classifyTurnEndingFailure(`${REAL_WORK}\n\n${TRANSPORT}`)).toEqual({
      kind: 'transport',
      failure: TRANSPORT,
    });
  });

  it('returns null for a turn that ended normally', () => {
    expect(classifyTurnEndingFailure(`${REAL_WORK}\n\nAll gates are green.`)).toBeNull();
    expect(classifyTurnEndingFailure('')).toBeNull();
  });
});

describe('turnEndingFailureMetadata', () => {
  it('keeps the two causes on separate keys', () => {
    expect(turnEndingFailureMetadata({ kind: 'transport', failure: 'boom' })).toEqual({
      truncatedTurn: true,
      transportFailure: 'boom',
    });
    expect(turnEndingFailureMetadata({ kind: 'refusal', failure: 'boom' })).toEqual({
      truncatedTurn: true,
      providerRefusal: 'boom',
    });
  });
});

describe('describeTruncatedAcpTurn for a refusal', () => {
  const REFUSAL = 'Error: RetriableError: [resource_exhausted] Error';

  it('explains that the provider declined rather than the network failing', () => {
    const report = describeTruncatedAcpTurn({
      adapter: 'cursor-acp',
      kind: 'refusal',
      failure: REFUSAL,
      stopReason: 'end_turn',
      providerUsageReported: true,
      durationMs: 4_432_608,
      contentLength: 2139,
    });

    expect(report.notice.type).toBe('system');
    expect(report.notice.content).toContain(REFUSAL);
    // Same hedge as the transport notice: the detection is text classification.
    expect(report.notice.content).toContain('may be cut off');
    // The two things a status code alone does not tell the user.
    expect(report.notice.content).toContain('quota or capacity limit');
    expect(report.notice.content).toContain('fresh session');
    // Must not blame the network for a refusal.
    expect(report.notice.content).not.toContain('transport');
    expect(report.notice.metadata).toMatchObject({
      source: 'acp-provider-refusal',
      failureKind: 'refusal',
      truncatedTurn: true,
      recoverable: true,
    });
    expect(report.logMessage).toContain('refusal');
    expect(report.logFields).toMatchObject({ kind: 'refusal', failure: REFUSAL });
  });

  it('keeps the transport wording on the transport kind', () => {
    const report = describeTruncatedAcpTurn({
      adapter: 'cursor-acp',
      kind: 'transport',
      failure: 'Error: RetriableError: [unavailable] PING timed out',
      providerUsageReported: false,
      durationMs: 1000,
      contentLength: 10,
    });
    expect(report.notice.content).toContain('transport error');
    expect(report.notice.metadata).toMatchObject({ source: 'acp-transport-failure' });
  });
});
