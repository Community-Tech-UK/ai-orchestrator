import { describe, expect, it } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import {
  DEFAULT_LOOP_MAX_COST_CENTS,
  DEFAULT_LOOP_MAX_ITERATIONS,
  defaultLoopConfig,
} from '../../shared/types/loop.types';
import { checkLoopHardCaps, cloneLoopStateForBroadcast, materializeLoopConfig } from './loop-coordinator-state-helpers';

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

function stateWithCost(totalCostCents: number, maxCostCents: number | null): LoopState {
  const state = stateWithTokens(0, null);
  state.totalCostCents = totalCostCents;
  state.config.caps.maxCostCents = maxCostCents;
  return state;
}

function stateWithIterations(totalIterations: number, maxIterations?: number | null): LoopState {
  const state = stateWithTokens(0, null);
  return {
    ...state,
    totalIterations,
    config: {
      ...state.config,
      caps: {
        ...state.config.caps,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      },
    },
  };
}

describe('LoopCoordinator state helpers', () => {
  it('preserves explicit numeric maxTokens inputs as a token cap', () => {
    const config = materializeLoopConfig({
      initialPrompt: 'do work',
      workspaceCwd: '/tmp/workspace',
      caps: { ...defaultLoopConfig('/tmp/workspace', 'do work').caps, maxTokens: 1_000_000 },
    });

    expect(config.caps.maxTokens).toBe(1_000_000);
  });

  it('defaults to a 50-hour wall-time cap', () => {
    const config = defaultLoopConfig('/tmp/workspace', 'do work');

    expect(config.caps.maxWallTimeMs).toBe(50 * 60 * 60 * 1000);
  });

  it('materializes omitted maxIterations as the default iteration cap', () => {
    const config = materializeLoopConfig({
      initialPrompt: 'do work',
      workspaceCwd: '/tmp/workspace',
    });

    expect(config.caps.maxIterations).toBe(DEFAULT_LOOP_MAX_ITERATIONS);
  });

  it('materializes omitted maxCostCents as the default cost cap', () => {
    const config = materializeLoopConfig({
      initialPrompt: 'do work',
      workspaceCwd: '/tmp/workspace',
    });

    expect(config.caps.maxCostCents).toBe(DEFAULT_LOOP_MAX_COST_CENTS);
  });

  it('stops on iteration count when the default maxIterations cap is reached', () => {
    expect(checkLoopHardCaps(stateWithIterations(DEFAULT_LOOP_MAX_ITERATIONS))).toBe('iterations');
  });

  it('does not stop on iteration count when maxIterations is explicitly null', () => {
    expect(checkLoopHardCaps(stateWithIterations(10_000, null))).toBeNull();
  });

  it('does not stop on token usage when maxTokens is null', () => {
    expect(checkLoopHardCaps(stateWithTokens(7_242_440, null))).toBeNull();
  });

  it('stops on token usage when maxTokens is configured', () => {
    expect(checkLoopHardCaps(stateWithTokens(7_242_440, 1_000_000))).toBe('tokens');
  });

  it('does not stop on cost when maxCostCents is null', () => {
    expect(checkLoopHardCaps(stateWithCost(53_203, null))).toBeNull();
  });

  it('strips runtime next-objective planner functions from broadcast state', () => {
    const state = stateWithTokens(0, null);
    state.config.nextObjectivePlanner = async () => 'next focus';

    const cloned = cloneLoopStateForBroadcast(state);

    expect(state.config.nextObjectivePlanner).toBeTypeOf('function');
    expect(cloned.config.nextObjectivePlanner).toBeUndefined();
  });
});
