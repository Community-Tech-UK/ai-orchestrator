import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationData } from '../../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import type { InstanceManager } from '../../instance/instance-manager';
import {
  HistoryRestoreCoordinator,
  HistoryRestoreError,
} from '../history-restore-coordinator';

function message(id: string, type: OutputMessage['type'], content: string): OutputMessage {
  return {
    id,
    type,
    content,
    timestamp: Date.now(),
  } as OutputMessage;
}

function conversation(overrides: Partial<ConversationData['entry']> = {}): ConversationData {
  return {
    entry: {
      id: 'entry-1',
      displayName: 'Original thread',
      createdAt: Date.now() - 10_000,
      endedAt: Date.now() - 1_000,
      workingDirectory: '/repo',
      messageCount: 3,
      firstUserMessage: 'Review auth.ts',
      lastUserMessage: 'Continue',
      status: 'completed',
      originalInstanceId: 'old-instance',
      parentId: null,
      sessionId: 'native-session',
      historyThreadId: 'history-thread',
      provider: 'claude',
      ...overrides,
    },
    messages: [
      message('u1', 'user', 'Review auth.ts'),
      message('a1', 'assistant', 'Findings'),
      message('u2', 'user', 'Continue'),
    ],
  };
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    displayName: 'Restored',
    historyThreadId: 'history-thread',
    status: 'idle',
    contextUsage: { used: 0, total: 200_000, percentage: 0 },
    outputBuffer: [],
    readyPromise: Promise.resolve(),
    ...overrides,
  } as Instance;
}

describe('HistoryRestoreCoordinator', () => {
  const loadConversation = vi.fn();
  const markNativeResumeFailed = vi.fn();
  const storeMessages = vi.fn();
  const createInstance = vi.fn();
  const getInstance = vi.fn();
  const terminateInstance = vi.fn();
  const queueContinuityPreamble = vi.fn();

  let coordinator: HistoryRestoreCoordinator;
  let manager: InstanceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    loadConversation.mockResolvedValue(conversation());
    storeMessages.mockResolvedValue(undefined);
    createInstance.mockImplementation(async (config: { initialOutputBuffer?: OutputMessage[]; sessionId?: string; historyThreadId?: string }) =>
      makeInstance({
        id: config.sessionId === 'fork-session' ? 'fork-instance' : 'fallback-instance',
        historyThreadId: config.historyThreadId ?? 'history-thread',
        outputBuffer: config.initialOutputBuffer ?? [],
      }),
    );
    getInstance.mockImplementation((id: string) =>
      id === 'native-instance'
        ? makeInstance({ id: 'native-instance', status: 'idle' })
        : undefined,
    );

    manager = {
      createInstance,
      getInstance,
      terminateInstance,
      queueContinuityPreamble,
    } as unknown as InstanceManager;

    coordinator = new HistoryRestoreCoordinator({
      history: () => ({
        loadConversation,
        markNativeResumeFailed,
      }),
      outputStorage: () => ({
        storeMessages,
      }),
      isRemoteNodeReachable: () => true,
      postSpawnTimeoutMs: 0,
      pollIntervalMs: 1,
    });
  });

  it('forces replay fallback without attempting native resume', async () => {
    const result = await coordinator.restore(manager, 'entry-1', { forceFallback: true });

    expect(result.restoreMode).toBe('replay-fallback');
    expect(result.instanceId).toBe('fallback-instance');
    expect(createInstance).toHaveBeenCalledTimes(1);
    const config = createInstance.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config).toMatchObject({
      historyThreadId: 'history-thread',
    });
    expect(config['resume']).toBeUndefined();
    expect(config['sessionId']).toBeUndefined();
    expect(config['initialOutputBuffer']).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'u1' }),
    ]));
    expect(markNativeResumeFailed).not.toHaveBeenCalled();
    expect(queueContinuityPreamble).toHaveBeenCalledWith('fallback-instance', expect.any(String));
  });

  it('forks with new session and history-thread ids', async () => {
    const result = await coordinator.restore(manager, 'entry-1', {
      forkAs: {
        sessionId: 'fork-session',
        historyThreadId: 'fork-thread',
      },
    });

    expect(result).toMatchObject({
      instanceId: 'fork-instance',
      restoreMode: 'replay-fallback',
      sessionId: 'fork-session',
      historyThreadId: 'fork-thread',
    });
    const config = createInstance.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config).toMatchObject({
      sessionId: 'fork-session',
      historyThreadId: 'fork-thread',
    });
    expect(config['resume']).toBeUndefined();
  });

  it('fails closed when a history source has not backfilled an app-owned identity', async () => {
    loadConversation.mockResolvedValue(conversation({
      historyThreadId: null as unknown as string | undefined,
      sessionId: 'provider-native-collision',
    }));

    await expect(coordinator.restore(manager, 'entry-1', { forceFallback: true }))
      .rejects.toMatchObject({ code: 'HISTORY_IDENTITY_MISSING' });
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('throws a typed error when the history entry is missing', async () => {
    loadConversation.mockResolvedValue(null);

    await expect(coordinator.restore(manager, 'missing')).rejects.toMatchObject({
      code: 'HISTORY_NOT_FOUND',
    } satisfies Partial<HistoryRestoreError>);
  });

  describe('adapter resume proof (B1/B2)', () => {
    it('accepts native resume immediately when adapter confirms same session ID', async () => {
      // Create an instance whose adapter returns a confirmed native resume proof.
      const nativeInstance = makeInstance({ id: 'native-instance', status: 'idle' });
      getInstance.mockImplementation((id: string) =>
        id === 'native-instance' ? nativeInstance : undefined,
      );

      // Provide an adapter with confirmed getResumeAttemptResult via getAdapter.
      const confirmedAdapter = {
        getResumeAttemptResult: () => ({
          source: 'native' as const,
          confirmed: true,
          requestedSessionId: 'native-session',
          actualSessionId: 'native-session',
        }),
      };
      (manager as unknown as Record<string, unknown>)['getAdapter'] = (id: string) =>
        id === 'native-instance' ? confirmedAdapter : undefined;

      createInstance.mockImplementation(
        async (config: { sessionId?: string; historyThreadId?: string }) =>
          makeInstance({
            id: 'native-instance',
            historyThreadId: config.historyThreadId ?? 'history-thread',
          }),
      );

      const result = await coordinator.restore(manager, 'entry-1');

      expect(result.restoreMode).toBe('native-resume');
    });

    it('returns resume-unconfirmed when adapter confirms a different session ID', async () => {
      const nativeInstance = makeInstance({ id: 'native-instance', status: 'idle' });
      getInstance.mockImplementation((id: string) =>
        id === 'native-instance' ? nativeInstance : undefined,
      );

      const mismatchedAdapter = {
        getResumeAttemptResult: () => ({
          source: 'native' as const,
          confirmed: true,
          requestedSessionId: 'native-session',
          actualSessionId: 'wrong-native-session',
        }),
      };
      (manager as unknown as Record<string, unknown>)['getAdapter'] = (id: string) =>
        id === 'native-instance' ? mismatchedAdapter : undefined;

      createInstance.mockImplementation(
        async (config: { sessionId?: string; historyThreadId?: string; initialOutputBuffer?: OutputMessage[] }) =>
          makeInstance({
            id: 'native-instance',
            historyThreadId: config.historyThreadId ?? 'history-thread',
            outputBuffer: config.initialOutputBuffer ?? [],
          }),
      );

      const result = await coordinator.restore(manager, 'entry-1');

      expect(result.restoreMode).toBe('resume-unconfirmed');
      expect(queueContinuityPreamble).toHaveBeenCalledWith('native-instance', expect.any(String));
    });

    it('returns resume-unconfirmed when adapter reports fresh-fallback but instance is alive', async () => {
      // fresh-fallback means the adapter did NOT attempt native resume, so proof=false.
      // The instance is still alive → coordinator returns resume-unconfirmed (not replay-fallback),
      // because the instance is up and usable even without native resume confirmation.
      const aliveInstance = makeInstance({ id: 'fallback-proof-instance', status: 'idle' });
      getInstance.mockImplementation((id: string) =>
        id === 'fallback-proof-instance' ? aliveInstance : undefined,
      );

      const fallbackAdapter = {
        getResumeAttemptResult: () => ({
          source: 'fresh-fallback' as const,
          confirmed: false,
        }),
      };
      (manager as unknown as Record<string, unknown>)['getAdapter'] = (id: string) =>
        id === 'fallback-proof-instance' ? fallbackAdapter : undefined;

      createInstance.mockImplementation(
        async (config: { sessionId?: string; historyThreadId?: string; initialOutputBuffer?: OutputMessage[] }) =>
          makeInstance({
            id: 'fallback-proof-instance',
            historyThreadId: config.historyThreadId ?? 'history-thread',
            outputBuffer: config.initialOutputBuffer ?? [],
          }),
      );

      const result = await coordinator.restore(manager, 'entry-1');

      // Alive + unconfirmed → resume-unconfirmed (proof=false short-circuits the heuristic poll)
      expect(result.restoreMode).toBe('resume-unconfirmed');
      // markNativeResumeFailed is NOT called — the instance is alive, just unconfirmed
      expect(markNativeResumeFailed).not.toHaveBeenCalled();
    });
  });
});
