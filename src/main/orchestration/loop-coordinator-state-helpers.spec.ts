import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LoopState } from '../../shared/types/loop.types';
import {
  DEFAULT_LOOP_MAX_ITERATIONS,
  defaultLoopConfig,
} from '../../shared/types/loop.types';
import {
  checkLoopHardCaps,
  cloneLoopStateForBroadcast,
  firstExistingBlockedFile,
  materializeLoopConfig,
  reconcileRestoredLoopState,
} from './loop-coordinator-state-helpers';

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
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: totalTokens,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 1,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
    recentEvidenceHashes: [],
    repeatedEvidenceCount: 0,
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

  it('materializes omitted maxCostCents as no estimated cost cap', () => {
    const config = materializeLoopConfig({
      initialPrompt: 'do work',
      workspaceCwd: '/tmp/workspace',
    });

    expect(config.caps.maxCostCents).toBe(3_000); // WS6 finite default
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

// P1 isolation acceptance: when isolateLoopWorkspaces is true, a stale root
// BLOCKED.md must not pause a sibling loop. Only the scoped per-run path is
// checked; the root fallback is deliberately skipped.
describe('firstExistingBlockedFile — P1 BLOCKED.md scope guard', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'blocked-scope-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function makeState(isolateLoopWorkspaces: boolean): LoopState {
    const config = defaultLoopConfig(workspace, 'test goal');
    config.isolateLoopWorkspaces = isolateLoopWorkspaces;
    return {
      id: 'loop-scope-test',
      chatId: 'chat-1',
      config,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      totalIterations: 0,
      totalTokens: 0,
      totalCostCents: 0,
      currentStage: 'IMPLEMENT',
      pendingInterventions: [],
      completedFileRenameObserved: false,
      doneSentinelPresentAtStart: false,
      planChecklistFullyCheckedAtStart: false,
      uncompletedPlanFilesAtStart: [],
      manualReviewOnly: false,
      tokensSinceLastTestImprovement: 0,
      highestTestPassCount: 0,
      iterationsOnCurrentStage: 0,
      recentWarnIterationSeqs: [],
      completionAttempts: 0,
      loopTasksLedgerResolvedAtStart: false,
      recentEvidenceHashes: [],
      repeatedEvidenceCount: 0,
      terminalIntentHistory: [],
    };
  }

  it('non-isolated loop: finds root BLOCKED.md as a fallback', async () => {
    // Write ONLY the root BLOCKED.md (not the scoped one).
    await writeFile(join(workspace, 'BLOCKED.md'), 'blocker');
    const result = await firstExistingBlockedFile(makeState(false));
    expect(result).toBe(join(workspace, 'BLOCKED.md'));
  });

  it('isolated loop: ignores root BLOCKED.md even when it exists', async () => {
    // Write ONLY the root BLOCKED.md — a stale artifact from another run.
    await writeFile(join(workspace, 'BLOCKED.md'), 'stale blocker from other run');
    // Isolated loop must NOT find the root file (it would pause the wrong loop).
    const result = await firstExistingBlockedFile(makeState(true));
    expect(result).toBeNull();
  });
});

describe('reconcileRestoredLoopState', () => {
  function makeRestoredState(over: Partial<LoopState> = {}): LoopState {
    const config = defaultLoopConfig('/tmp/ws', 'test goal');
    return {
      id: 'loop-restore-test',
      chatId: 'chat-1',
      config,
      status: 'paused',
      startedAt: 1,
      endedAt: null,
      totalIterations: 0,
      totalTokens: 0,
      totalCostCents: 0,
      currentStage: 'IMPLEMENT',
      pendingInterventions: [],
      completedFileRenameObserved: false,
      doneSentinelPresentAtStart: false,
      planChecklistFullyCheckedAtStart: false,
      uncompletedPlanFilesAtStart: [],
      manualReviewOnly: false,
      tokensSinceLastTestImprovement: 0,
      highestTestPassCount: 0,
      iterationsOnCurrentStage: 0,
      recentWarnIterationSeqs: [],
      completionAttempts: 0,
      loopTasksLedgerResolvedAtStart: false,
      ...over,
    };
  }

  it('pauses an interrupted running checkpoint and notes it', () => {
    const state = makeRestoredState({ status: 'running' });
    const notes = reconcileRestoredLoopState(state);
    expect(state.status).toBe('paused');
    expect(state.endReason).toBe('app-restart');
    expect(notes.some((n) => n.includes('interrupted paused state'))).toBe(true);
  });

  it('clears the cached clean fresh-eyes verdict fail-closed (D6 #7)', () => {
    const state = makeRestoredState({
      freshEyesCleanForWorkState: true,
      lastVerifiedWorkHash: 'anchor-hash',
    });
    const notes = reconcileRestoredLoopState(state);
    expect(state.freshEyesCleanForWorkState).toBe(false);
    // The staleness anchor must SURVIVE restore (clearing it would fail open).
    expect(state.lastVerifiedWorkHash).toBe('anchor-hash');
    expect(notes.some((n) => n.includes('fresh-eyes'))).toBe(true);
  });

  it('drops an in-flight ping-pong reviewer pointer', () => {
    const state = makeRestoredState({
      pingPong: {
        roundCount: 2,
        inFlightReviewerInstanceId: 'reviewer-9',
        inFlightRound: 3,
      } as LoopState['pingPong'],
    });
    const notes = reconcileRestoredLoopState(state);
    expect(state.pingPong?.inFlightReviewerInstanceId).toBeUndefined();
    expect(state.pingPong?.inFlightRound).toBeUndefined();
    expect(notes.some((n) => n.includes('reviewer-9'))).toBe(true);
  });

  it('returns no notes for an already-clean paused state', () => {
    expect(reconcileRestoredLoopState(makeRestoredState())).toEqual([]);
  });
});
