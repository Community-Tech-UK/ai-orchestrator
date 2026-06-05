import { describe, expect, it } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { checkLoopHardCaps } from './loop-coordinator-state-helpers';

function stateWithTokens(totalTokens: number, maxTokens: number | null): LoopState {
  const config = defaultLoopConfig('/tmp/workspace', 'do work');
  config.caps.maxTokens = maxTokens;
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    totalIterations: 1,
    totalTokens,
    totalCostCents: 0,
    currentStage: 'IMPLEMENT',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    tokensSinceLastTestImprovement: totalTokens,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 1,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    lastCompletionEvidenceHash: null,
    repeatedCompletionEvidenceCount: 0,
    terminalIntentHistory: [],
  };
}

describe('LoopCoordinator state helpers', () => {
  it('does not stop on token usage when maxTokens is null', () => {
    expect(checkLoopHardCaps(stateWithTokens(7_242_440, null))).toBeNull();
  });

  it('still stops on token usage when a numeric maxTokens cap is configured', () => {
    expect(checkLoopHardCaps(stateWithTokens(7_242_440, 1_000_000))).toBe('tokens');
  });
});
