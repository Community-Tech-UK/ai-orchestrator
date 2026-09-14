import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ sessionHandoffStateEnabled: false }) }),
}));

import type { ConversationData } from '../../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import { buildToolOutcomeMessage } from '../../../shared/types/tool-outcome';
import type { InstanceManager } from '../../instance/instance-manager';
import {
  _resetToolOutcomeStoreForTesting,
  getToolOutcomes,
} from '../../learning/tool-outcome-store';
import { HistoryRestoreCoordinator } from '../history-restore-coordinator';

/**
 * LT-196: an archived transcript carries `tool_outcome` records, but a live
 * instance must never hold one in `outputBuffer` — roughly twenty readers copy
 * that buffer onward unfiltered. Restore must keep the record out of the buffer
 * and the continuity preamble, and hand it to the side store instead so that
 * re-archiving the thread does not lose the miner's signal.
 */

const now = Date.now();
const failure = buildToolOutcomeMessage(
  { toolUseId: 'tu-1', isError: true, resultText: 'todo: SECRET_FAILURE_TEXT' },
  'outcome-1',
  now - 5_000,
);

function msg(id: string, type: OutputMessage['type'], content: string, offset: number): OutputMessage {
  return { id, type, content, timestamp: now - offset };
}

function conversation(): ConversationData {
  return {
    entry: {
      id: 'entry-1',
      displayName: 'Thread',
      createdAt: now - 10_000,
      endedAt: now - 1_000,
      workingDirectory: '/repo',
      messageCount: 4,
      firstUserMessage: 'Run grep',
      lastUserMessage: 'Continue',
      status: 'completed',
      originalInstanceId: 'old-instance',
      parentId: null,
      sessionId: 'native-session',
      historyThreadId: 'history-thread',
      provider: 'claude',
    },
    messages: [
      msg('u1', 'user', 'Run grep', 9_000),
      { ...msg('t1', 'tool_use', '', 6_000), metadata: { id: 'tu-1', input: { command: 'grep --bogus x' } } },
      failure,
      msg('a1', 'assistant', 'Fixed it', 4_000),
    ],
  };
}

describe('HistoryRestoreCoordinator — LT-196 tool_outcome records', () => {
  const createInstance = vi.fn();
  const queueContinuityPreamble = vi.fn();
  let manager: InstanceManager;
  let coordinator: HistoryRestoreCoordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetToolOutcomeStoreForTesting();
    createInstance.mockImplementation(async (config: { initialOutputBuffer?: OutputMessage[] }) => ({
      id: 'restored-instance',
      historyThreadId: 'history-thread',
      status: 'idle',
      contextUsage: { used: 0, total: 200_000, percentage: 0 },
      outputBuffer: config.initialOutputBuffer ?? [],
      readyPromise: Promise.resolve(),
    }) as unknown as Instance);
    manager = {
      createInstance,
      getInstance: () => undefined,
      terminateInstance: vi.fn(),
      queueContinuityPreamble,
    } as unknown as InstanceManager;
    coordinator = new HistoryRestoreCoordinator({
      history: () => ({ loadConversation: vi.fn().mockResolvedValue(conversation()), markNativeResumeFailed: vi.fn() }),
      outputStorage: () => ({ storeMessages: vi.fn().mockResolvedValue(undefined) }),
      isRemoteNodeReachable: () => true,
      postSpawnTimeoutMs: 0,
      pollIntervalMs: 1,
    });
  });

  it('keeps the record out of the buffer and preamble on replay fallback, and re-seeds the side store', async () => {
    const result = await coordinator.restore(manager, 'entry-1', { forceFallback: true });

    const config = createInstance.mock.calls[0]?.[0] as { initialOutputBuffer: OutputMessage[] };
    // The fallback appends its restore notice after spawn; only the archived ids matter here.
    expect(config.initialOutputBuffer.map((m) => m.id).slice(0, 3)).toEqual(['u1', 't1', 'a1']);
    expect(config.initialOutputBuffer.some((m) => m.type === 'tool_outcome')).toBe(false);
    expect(result.restoredMessages.some((m) => m.type === 'tool_outcome')).toBe(false);
    const preamble = queueContinuityPreamble.mock.calls[0]?.[1] as string;
    expect(preamble).not.toContain('SECRET_FAILURE_TEXT');
    expect(getToolOutcomes('restored-instance')).toEqual([failure]);
  });

  it('keeps the record out of the buffer on a confirmed native resume, and re-seeds the side store', async () => {
    const live = { id: 'restored-instance', status: 'idle', outputBuffer: [] } as unknown as Instance;
    Object.assign(manager, {
      getInstance: (id: string) => (id === 'restored-instance' ? live : undefined),
      getAdapter: () => ({
        getResumeAttemptResult: () => ({
          source: 'native', confirmed: true, requestedSessionId: 'native-session', actualSessionId: 'native-session',
        }),
      }),
    });

    const result = await coordinator.restore(manager, 'entry-1');

    expect(result.restoreMode).toBe('native-resume');
    expect(createInstance).toHaveBeenCalledTimes(1);
    const config = createInstance.mock.calls[0]?.[0] as { resume?: boolean; initialOutputBuffer: OutputMessage[] };
    expect(config.resume).toBe(true);
    expect(config.initialOutputBuffer.some((m) => m.type === 'tool_outcome')).toBe(false);
    expect(getToolOutcomes(result.instanceId)).toEqual([failure]);
  });
});
