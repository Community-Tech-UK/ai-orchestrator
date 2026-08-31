import { describe, expect, it } from 'vitest';
import {
  getCanonicalRecoveryKey,
  selectRecoverableSessions,
  type RecoverableSessionSelectionInput,
} from './recoverable-session-selection';

function makeSession(
  overrides: Partial<RecoverableSessionSelectionInput> = {},
): RecoverableSessionSelectionInput {
  const instanceId = overrides.instanceId ?? 'instance-default';
  return {
    instanceId,
    sessionId: `session-${instanceId}`,
    provider: 'claude',
    displayName: 'Placeholder session',
    workingDirectory: '/workspace',
    capturedAt: 1,
    recoveryKey: `placeholder:${instanceId}`,
    lastActivityAt: 1,
    isLive: false,
    messageCount: 1,
    hasAssistantOutput: true,
    ...overrides,
  };
}

describe('selectRecoverableSessions', () => {
  it('keeps every live session ahead of the 20 newest non-live sessions', () => {
    const stale = Array.from({ length: 25 }, (_, index) => makeSession({
      instanceId: `stale-${index + 1}`,
      recoveryKey: `stale:${index + 1}`,
      lastActivityAt: index + 1,
    }));
    const live = [
      makeSession({ instanceId: 'live-earlier', recoveryKey: 'live:earlier', isLive: true, lastActivityAt: 50 }),
      makeSession({ instanceId: 'live-later', recoveryKey: 'live:later', isLive: true, lastActivityAt: 60 }),
    ];

    const selected = selectRecoverableSessions([...stale, ...live]);

    expect(selected).toHaveLength(22);
    expect(selected.slice(0, 2).map((session) => session.instanceId)).toEqual([
      'live-later',
      'live-earlier',
    ]);
    expect(selected.slice(2).map((session) => session.instanceId)).toEqual([
      'stale-25', 'stale-24', 'stale-23', 'stale-22', 'stale-21',
      'stale-20', 'stale-19', 'stale-18', 'stale-17', 'stale-16',
      'stale-15', 'stale-14', 'stale-13', 'stale-12', 'stale-11',
      'stale-10', 'stale-9', 'stale-8', 'stale-7', 'stale-6',
    ]);
  });

  it('keeps more than 20 canonical live sessions without applying the fallback cap', () => {
    const live = Array.from({ length: 23 }, (_, index) => makeSession({
      instanceId: `live-${index + 1}`,
      recoveryKey: `live:${index + 1}`,
      isLive: true,
      lastActivityAt: index + 1,
    }));

    const selected = selectRecoverableSessions(live);

    expect(selected).toHaveLength(23);
    expect(selected.every((session) => session.isLive)).toBe(true);
    expect(selected[0]?.instanceId).toBe('live-23');
  });

  it('deduplicates generations by canonical key, preferring live then newest activity', () => {
    const selected = selectRecoverableSessions([
      makeSession({
        instanceId: 'older-live-generation',
        historyThreadId: 'logical-thread',
        recoveryKey: 'history:claude:logical-thread',
        isLive: true,
        lastActivityAt: 10,
      }),
      makeSession({
        instanceId: 'newer-stopped-generation',
        historyThreadId: 'logical-thread',
        recoveryKey: 'history:claude:logical-thread',
        isLive: false,
        lastActivityAt: 20,
      }),
      makeSession({
        instanceId: 'newest-stopped-generation',
        historyThreadId: 'other-thread',
        recoveryKey: 'history:claude:other-thread',
        lastActivityAt: 30,
      }),
    ]);

    expect(selected.map((session) => session.instanceId)).toEqual([
      'older-live-generation',
      'newest-stopped-generation',
    ]);
  });

  it('uses stable tie-breakers for both duplicate selection and output ordering', () => {
    const selected = selectRecoverableSessions([
      makeSession({ instanceId: 'generation-z', recoveryKey: 'thread:one', lastActivityAt: 10 }),
      makeSession({ instanceId: 'generation-a', recoveryKey: 'thread:one', lastActivityAt: 10 }),
      makeSession({ instanceId: 'output-b', recoveryKey: 'thread:beta', lastActivityAt: 10 }),
      makeSession({ instanceId: 'output-a', recoveryKey: 'thread:alpha', lastActivityAt: 10 }),
    ]);

    expect(selected.map((session) => session.instanceId)).toEqual([
      'output-a',
      'output-b',
      'generation-a',
    ]);
  });

  it('excludes stateless and empty records before selecting recoverable sessions', () => {
    const selected = selectRecoverableSessions([
      makeSession({ instanceId: 'stateless', provider: 'gemini', recoveryKey: 'session:gemini:stateless' }),
      makeSession({
        instanceId: 'empty',
        sessionId: undefined,
        resumeCursor: null,
        recoveryKey: 'instance:empty',
      }),
      makeSession({ instanceId: 'recoverable', recoveryKey: 'session:claude:recoverable' }),
    ]);

    expect(selected.map((session) => session.instanceId)).toEqual(['recoverable']);
  });

  it('derives canonical identity by history thread before cursor, provider session, and source instance', () => {
    const cursorFallback = makeSession({
      instanceId: 'source-fallback',
      sessionId: undefined,
      resumeCursor: {
        provider: 'claude',
        threadId: '[redacted-resume-cursor]',
        workspacePath: '/workspace',
        capturedAt: 1,
        scanSource: 'native',
      },
    });

    expect(getCanonicalRecoveryKey(makeSession({ historyThreadId: 'history-id' })))
      .toBe('history:claude:history-id');
    expect(getCanonicalRecoveryKey(cursorFallback))
      .toBe('cursor:claude:[redacted-resume-cursor]');
    expect(getCanonicalRecoveryKey(makeSession({ historyThreadId: undefined })))
      .toBe('session:claude:session-instance-default');
    expect(getCanonicalRecoveryKey(makeSession({
      instanceId: 'source-only',
      sessionId: undefined,
      resumeCursor: null,
    }))).toBe('instance:source-only');
  });

  it('falls back without throwing when persisted optional identities have invalid runtime types', () => {
    const malformed = {
      ...makeSession({ instanceId: 'safe-source' }),
      provider: 42,
      historyThreadId: false,
      sessionId: { invalid: true },
      resumeCursor: { provider: 7, threadId: ['invalid'] },
    } as unknown as Parameters<typeof getCanonicalRecoveryKey>[0];

    expect(() => getCanonicalRecoveryKey(malformed)).not.toThrow();
    expect(getCanonicalRecoveryKey(malformed)).toBe('instance:safe-source');
  });
});
