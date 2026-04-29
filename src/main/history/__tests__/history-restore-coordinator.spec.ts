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

  it('throws a typed error when the history entry is missing', async () => {
    loadConversation.mockResolvedValue(null);

    await expect(coordinator.restore(manager, 'missing')).rejects.toMatchObject({
      code: 'HISTORY_NOT_FOUND',
    } satisfies Partial<HistoryRestoreError>);
  });
});
