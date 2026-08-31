import { describe, expect, it } from 'vitest';
import type { InstanceStatus } from '../../shared/types/instance.types';
import {
  createArchiveInstanceSummary,
  getArchiveHistoryIdentity,
  shouldArchiveInstance,
} from './should-archive-instance';

function summary(overrides: Partial<ReturnType<typeof createArchiveInstanceSummary>> = {}) {
  return {
    instanceId: 'instance-placeholder-alpha',
    status: 'hibernated' as InstanceStatus,
    provider: 'claude' as const,
    historyThreadId: 'thread-placeholder-alpha',
    providerSessionId: 'session-placeholder-alpha',
    sessionId: 'session-placeholder-alpha',
    supersededBy: undefined,
    outputMessageCount: 2,
    lastMeaningfulMessageAt: 200,
    metadata: {},
    ...overrides,
  };
}

function matchingCoverage(overrides: Partial<Parameters<typeof shouldArchiveInstance>[1]> = {}) {
  return {
    provider: 'claude' as const,
    historyThreadId: 'thread-placeholder-alpha',
    sessionId: 'session-placeholder-alpha',
    coveredThrough: 200,
    messageCount: 2,
    historyEntryId: 'entry-placeholder-alpha',
    ...overrides,
  };
}

describe('shouldArchiveInstance', () => {
  it('skips a hibernated generation only when matching history covers the last meaningful message', () => {
    expect(shouldArchiveInstance(summary(), matchingCoverage())).toEqual(
      expect.objectContaining({
        shouldArchive: false,
        reason: 'covered-superseded-or-hibernated',
      }),
    );
  });

  it('skips a superseded generation at the exact coverage boundary', () => {
    expect(shouldArchiveInstance(
      summary({ status: 'superseded', supersededBy: 'replacement-placeholder' }),
      matchingCoverage({ coveredThrough: 200 }),
    )).toEqual(expect.objectContaining({ shouldArchive: false }));
  });

  it.each([
    ['idle' as InstanceStatus],
    ['busy' as InstanceStatus],
    ['waiting_for_input' as InstanceStatus],
  ])('archives current generation status %s even when another history row is covered', (status) => {
    expect(shouldArchiveInstance(
      summary({ status, supersededBy: 'replacement-placeholder' }),
      matchingCoverage({ coveredThrough: 999 }),
    )).toEqual(expect.objectContaining({
      shouldArchive: true,
      reason: 'current-generation',
    }));
  });

  it('archives a hibernated generation when coverage is unknown', () => {
    expect(shouldArchiveInstance(summary(), undefined)).toEqual(
      expect.objectContaining({
        shouldArchive: true,
        reason: 'coverage-unknown',
      }),
    );
  });

  it('archives when matching history stops before the last meaningful message', () => {
    expect(shouldArchiveInstance(
      summary(),
      matchingCoverage({ coveredThrough: 199 }),
    )).toEqual(expect.objectContaining({
      shouldArchive: true,
      reason: 'not-covered',
    }));
  });

  it('archives when matching history has enough time coverage but too few messages', () => {
    expect(shouldArchiveInstance(
      summary({ outputMessageCount: 3 }),
      matchingCoverage({ coveredThrough: 999, messageCount: 2 }),
    )).toEqual(expect.objectContaining({
      shouldArchive: true,
      reason: 'not-covered',
    }));
  });

  it.each([
    [
      'provider',
      matchingCoverage({ provider: 'codex' }),
    ],
    [
      'history thread',
      matchingCoverage({ historyThreadId: 'thread-placeholder-beta' }),
    ],
    [
      'provider session',
      matchingCoverage({ historyThreadId: undefined, sessionId: 'session-placeholder-beta' }),
    ],
  ])('archives when coverage has a mismatched %s identity', (_label, coverage) => {
    expect(shouldArchiveInstance(summary(), coverage)).toEqual(
      expect.objectContaining({
        shouldArchive: true,
        reason: 'coverage-identity-mismatch',
      }),
    );
  });

  it('archives when a history-thread summary only has same-session coverage', () => {
    expect(shouldArchiveInstance(
      summary(),
      matchingCoverage({
        historyThreadId: undefined,
        sessionId: 'session-placeholder-alpha',
        coveredThrough: 999,
        messageCount: 2,
      }),
    )).toEqual(expect.objectContaining({
      shouldArchive: true,
      reason: 'coverage-identity-mismatch',
    }));
  });

  it('uses session coverage only when the summary has no history thread', () => {
    expect(shouldArchiveInstance(
      summary({ historyThreadId: undefined }),
      matchingCoverage({
        historyThreadId: undefined,
        sessionId: 'session-placeholder-alpha',
        coveredThrough: 999,
        messageCount: 2,
      }),
    )).toEqual(expect.objectContaining({
      shouldArchive: false,
      reason: 'covered-superseded-or-hibernated',
    }));
  });

  it('archives hidden automation output without a recorded success even when coverage matches', () => {
    expect(shouldArchiveInstance(
      summary({
        metadata: {
          automationId: 'automation-placeholder',
          automationHidden: true,
        },
      }),
      matchingCoverage({ coveredThrough: 999 }),
    )).toEqual(expect.objectContaining({
      shouldArchive: true,
      reason: 'automation-needs-visibility',
    }));
  });

  it('archives when there is no meaningful message to compare against coverage', () => {
    expect(shouldArchiveInstance(
      summary({ outputMessageCount: 1, lastMeaningfulMessageAt: undefined }),
      matchingCoverage({ coveredThrough: 999 }),
    )).toEqual(expect.objectContaining({
      shouldArchive: true,
      reason: 'no-meaningful-message',
    }));
  });

  it('builds summaries from messages without retaining prompt or output text', () => {
    const built = createArchiveInstanceSummary({
      id: 'instance-placeholder-beta',
      status: 'hibernated',
      provider: 'claude',
      historyThreadId: 'thread-placeholder-beta',
      providerSessionId: 'session-placeholder-beta',
      sessionId: 'session-placeholder-beta',
      supersededBy: undefined,
      metadata: {},
      outputBuffer: [
        { id: 'message-1', type: 'system', content: 'ignored setup content', timestamp: 100 },
        { id: 'message-2', type: 'user', content: 'prompt content should stay out', timestamp: 150 },
        { id: 'message-3', type: 'assistant', content: 'output content should stay out', timestamp: 250 },
      ],
    });

    expect(built).toEqual(expect.objectContaining({
      outputMessageCount: 3,
      lastMeaningfulMessageAt: 250,
    }));
    expect(JSON.stringify(built)).not.toContain('prompt content');
    expect(JSON.stringify(built)).not.toContain('output content');
  });

  it('creates a history coverage identity only from stable logical thread fields', () => {
    expect(getArchiveHistoryIdentity(summary())).toEqual({
      recoveryKey: 'history:claude:thread-placeholder-alpha',
      provider: 'claude',
      historyThreadId: 'thread-placeholder-alpha',
      sessionId: 'session-placeholder-alpha',
    });
    expect(getArchiveHistoryIdentity(summary({
      historyThreadId: undefined,
      providerSessionId: '',
      sessionId: '',
    }))).toBeUndefined();
  });
});
