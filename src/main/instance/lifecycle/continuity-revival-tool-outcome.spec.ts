/**
 * LT-196: crash recovery rebuilds a replacement from the archived transcript,
 * which holds `tool_outcome` records. Those records must not make the archive
 * unrecoverable, must not enter the replacement's live buffer or its replay
 * preamble, and must reach the replacement's side store so the miner keeps them
 * when the recovered thread is archived again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationData } from '../../../shared/types/history.types';
import type { Instance, InstanceCreateConfig, OutputMessage } from '../../../shared/types/instance.types';
import { buildToolOutcomeMessage } from '../../../shared/types/tool-outcome';
import { _resetToolOutcomeStoreForTesting, getToolOutcomes } from '../../learning/tool-outcome-store';
import type { ResolvedRecoveryCandidate } from '../../session/session-recovery-candidate-service';
import type { SessionState } from '../../session/session-continuity.types';
import { reviveContinuitySession } from './continuity-revival';

const NOW = Date.UTC(2026, 8, 13, 12);

const outcome = buildToolOutcomeMessage(
  { toolUseId: 'tu-1', isError: true, resultText: 'todo: SECRET_FAILURE_TEXT' },
  'outcome-1',
  NOW - 6_000,
);

function resolved(): ResolvedRecoveryCandidate {
  const messages: OutputMessage[] = [
    { id: 'u1', type: 'user', content: 'Run grep', timestamp: NOW - 8_000 },
    { id: 't1', type: 'tool_use', content: '', timestamp: NOW - 7_000, metadata: { id: 'tu-1' } },
    outcome,
    { id: 'a1', type: 'assistant', content: 'Fixed', timestamp: NOW - 5_000 },
  ];
  const history: ConversationData = {
    entry: {
      id: 'history-entry-1',
      displayName: 'Recovered',
      historyThreadId: 'history-thread-1',
      createdAt: NOW - 20_000,
      endedAt: NOW - 4_000,
      workingDirectory: '/repo',
      messageCount: messages.length,
      firstUserMessage: 'Run grep',
      lastUserMessage: 'Run grep',
      status: 'terminated',
      originalInstanceId: 'source-1',
      parentId: null,
      sessionId: 'archived-session',
      provider: 'claude',
    },
    messages,
  };
  const state = {
    instanceId: 'source-1',
    historyThreadId: 'history-thread-1',
    displayName: 'Recovered',
    agentId: 'build',
    modelId: 'opus',
    provider: 'claude',
    workingDirectory: '/repo',
    conversationHistory: [],
    contextUsage: { used: 0, total: 1_000 },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
    resumeCursor: null,
  } as unknown as SessionState;
  return {
    candidate: {
      recoveryKey: 'history:claude:history-thread-1',
      sourceInstanceId: 'source-1',
      historyThreadId: 'history-thread-1',
      provider: 'claude',
      modelId: 'opus',
      displayName: 'Recovered',
      workingDirectory: '/repo',
      lastActivityAt: NOW - 1_000,
      historyCoveredThrough: NOW - 4_000,
      recoveredMessageCount: 0,
      reason: 'newer-than-history',
      nativeResumeAvailable: false,
    },
    continuityState: state,
    historyConversation: history,
  } as ResolvedRecoveryCandidate;
}

describe('crash recovery — LT-196 tool_outcome records', () => {
  beforeEach(() => _resetToolOutcomeStoreForTesting());

  it('recovers, keeps the record out of the buffer and preamble, and re-seeds the side store', async () => {
    const createRecoveryInstance = vi.fn(async (config: InstanceCreateConfig) => ({
      instance: { id: 'replacement-1', status: 'idle', ...config } as unknown as Instance,
      publish: vi.fn(),
      rollback: vi.fn(async () => undefined),
    }));
    const queueContinuityPreamble = vi.fn();

    const result = await reviveContinuitySession({
      resumeSession: vi.fn(),
      createInstance: vi.fn(),
      createRecoveryInstance,
      queueContinuityPreamble,
      now: () => NOW,
    }, { sourceInstanceId: 'source-1', reason: 'crash-recovery', resolvedCandidate: resolved() });

    expect(result.instanceId).toBe('replacement-1');
    const buffer = createRecoveryInstance.mock.calls[0][0].initialOutputBuffer ?? [];
    expect(buffer.map((m) => m.id)).toEqual(['u1', 't1', 'a1']);
    expect(String(queueContinuityPreamble.mock.calls[0]?.[1])).not.toContain('SECRET_FAILURE_TEXT');
    expect(getToolOutcomes('replacement-1')).toEqual([outcome]);
  });
});
