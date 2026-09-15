import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { RecoverableSessionSelectionInput } from '../session/recoverable-session-selection';
import {
  buildArchiveInstanceFromLastStopSession,
  historyThreadIdFromLastStopSession,
  ingestMissingLastStopSessionsIntoHistory,
  providerFromLastStopSession,
} from './ingest-missing-last-stop-history';

function session(
  overrides: Partial<RecoverableSessionSelectionInput> & Pick<RecoverableSessionSelectionInput, 'instanceId' | 'recoveryKey'>,
): RecoverableSessionSelectionInput {
  return {
    displayName: 'Thread',
    workingDirectory: '/tmp/project',
    capturedAt: 100,
    lastActivityAt: 200,
    isLive: true,
    messageCount: 10,
    hasAssistantOutput: true,
    provider: 'claude',
    ...overrides,
  };
}

describe('ingestMissingLastStopSessionsIntoHistory', () => {
  it('reads the history thread id from the recovery key when the field is absent', () => {
    expect(historyThreadIdFromLastStopSession({
      recoveryKey: 'history:claude:thread-abc',
    })).toBe('thread-abc');
  });

  it('prefers the explicit historyThreadId over the recovery key', () => {
    expect(historyThreadIdFromLastStopSession({
      historyThreadId: 'explicit-thread',
      recoveryKey: 'history:claude:other-thread',
    })).toBe('explicit-thread');
  });

  it('derives the provider from the recovery key', () => {
    expect(providerFromLastStopSession({
      recoveryKey: 'history:codex:thread-1',
    })).toBe('codex');
  });

  it('builds an archive instance that keeps the source id and thread', () => {
    const instance = buildArchiveInstanceFromLastStopSession(session({
      instanceId: 'inst-live',
      recoveryKey: 'history:claude:thread-live',
      displayName: 'Provider Account Pools',
      sessionId: 'provider-session',
      modelId: 'opus',
    }));

    expect(instance).toMatchObject({
      id: 'inst-live',
      historyThreadId: 'thread-live',
      displayName: 'Provider Account Pools',
      provider: 'claude',
      sessionId: 'provider-session',
      providerSessionId: 'provider-session',
      workingDirectory: '/tmp/project',
      status: 'idle',
    });
  });

  it('archives last-stop sessions whose thread is missing from history', async () => {
    const archived: string[] = [];
    const result = await ingestMissingLastStopSessionsIntoHistory({
      sessions: [
        session({ instanceId: 'missing', recoveryKey: 'history:claude:thread-missing' }),
        session({ instanceId: 'present', recoveryKey: 'history:claude:thread-present' }),
      ],
      hasHistoryThread: (threadId) => threadId === 'thread-present',
      archiveInstance: async (instance: Instance) => {
        archived.push(instance.id);
      },
    });

    expect(archived).toEqual(['missing']);
    expect(result).toEqual({
      ingested: ['missing'],
      skipped: ['present'],
      failed: [],
    });
  });

  it('archives only one last-stop generation per missing thread', async () => {
    const archived: string[] = [];
    const result = await ingestMissingLastStopSessionsIntoHistory({
      sessions: [
        session({ instanceId: 'first', recoveryKey: 'history:claude:thread-dup' }),
        session({ instanceId: 'second', recoveryKey: 'history:claude:thread-dup' }),
      ],
      hasHistoryThread: () => false,
      archiveInstance: async (instance: Instance) => {
        archived.push(instance.id);
      },
    });

    expect(archived).toEqual(['first']);
    expect(result.ingested).toEqual(['first']);
    expect(result.skipped).toEqual(['second']);
  });

  it('skips sessions the caller says have no transcript to archive', async () => {
    const archiveInstance = vi.fn();
    const result = await ingestMissingLastStopSessionsIntoHistory({
      sessions: [
        session({ instanceId: 'empty', recoveryKey: 'history:codex:thread-empty' }),
      ],
      hasHistoryThread: () => false,
      shouldIngest: () => false,
      archiveInstance,
    });

    expect(archiveInstance).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(['empty']);
  });

  it('records archive failures without aborting later sessions', async () => {
    const archived: string[] = [];
    const result = await ingestMissingLastStopSessionsIntoHistory({
      sessions: [
        session({ instanceId: 'boom', recoveryKey: 'history:claude:thread-boom' }),
        session({ instanceId: 'ok', recoveryKey: 'history:claude:thread-ok' }),
      ],
      hasHistoryThread: () => false,
      archiveInstance: async (instance: Instance) => {
        if (instance.id === 'boom') {
          throw new Error('disk full');
        }
        archived.push(instance.id);
      },
    });

    expect(archived).toEqual(['ok']);
    expect(result.ingested).toEqual(['ok']);
    expect(result.failed).toEqual([{ instanceId: 'boom', error: 'disk full' }]);
  });
});
