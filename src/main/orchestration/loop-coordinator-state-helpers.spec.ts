import { describe, expect, it } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { checkLoopHardCaps, materializeLoopConfig } from './loop-coordinator-state-helpers';

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
  it('normalizes legacy numeric maxTokens inputs to no token cap', () => {
    const config = materializeLoopConfig({
      initialPrompt: 'do work',
      workspaceCwd: '/tmp/workspace',
      caps: { ...defaultLoopConfig('/tmp/workspace', 'do work').caps, maxTokens: 1_000_000 },
    });

    expect(config.caps.maxTokens).toBeNull();
  });

  it('does not stop on token usage when maxTokens is null', () => {
    expect(checkLoopHardCaps(stateWithTokens(7_242_440, null))).toBeNull();
  });

  it('does not stop on token usage even when an old numeric maxTokens cap is present', () => {
    expect(checkLoopHardCaps(stateWithTokens(7_242_440, 1_000_000))).toBeNull();
  });
});
