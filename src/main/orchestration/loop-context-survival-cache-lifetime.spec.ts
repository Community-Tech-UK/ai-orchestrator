import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { CompactionCoordinator } from '../context/compaction-coordinator';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import {
  CONTEXT_CACHE_TTL_MS,
  defaultLoopContextSurvivalManager,
  _resetContextSurvivalIdleTrackingForTesting,
} from './loop-context-survival';
import { loopCacheLifetimeFields } from './loop-cache-lifetime';
import { observeClaudeCacheLifetime } from '../cli/adapters/claude-cache-lifetime';
import type { LoopChildResult } from './loop-coordinator.types';

const MIN = 60_000;

function makeState(id: string): LoopState {
  const config = defaultLoopConfig('/tmp/aio-loop-cache-lifetime', 'finish the task');
  config.caps.maxTokens = 10_000;
  return {
    id,
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: 0,
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
  };
}

function iteration(seq: number, startedAt: number, endedAt: number): LoopIteration {
  return {
    id: `iter-${seq}`,
    loopRunId: 'loop',
    seq,
    stage: 'IMPLEMENT',
    startedAt,
    endedAt,
    childInstanceId: null,
    tokens: 400,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: `hash-${seq}`,
    outputSimilarityToPrev: null,
    outputExcerpt: 'iteration output',
    outputFull: 'iteration output',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
  };
}

function childResult(cacheLifetimeMs?: number): LoopChildResult {
  return {
    childInstanceId: null,
    output: 'iteration output',
    tokens: 400,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
    ...(cacheLifetimeMs === undefined ? {} : { cacheLifetimeMs }),
  };
}

/** Two sealed iterations `gapMs` apart, the second carrying `lifetimeMs` (if any). */
async function secondIterationDecision(loopId: string, gapMs: number, lifetimeMs?: number) {
  const state = makeState(loopId);
  const t0 = 1_000_000;
  await defaultLoopContextSurvivalManager.onIterationSealed({
    state,
    iteration: iteration(0, t0, t0 + MIN),
    childResult: childResult(lifetimeMs),
  });
  return defaultLoopContextSurvivalManager.onIterationSealed({
    state,
    iteration: iteration(1, t0 + MIN + gapMs, t0 + 2 * MIN + gapMs),
    childResult: childResult(lifetimeMs),
  });
}

describe('loop stale-cache rule uses the measured cache lifetime', () => {
  afterEach(() => {
    CompactionCoordinator._resetForTesting();
    _resetContextSurvivalIdleTrackingForTesting();
  });

  it('still assumes one hour when no reply has reported a lifetime', async () => {
    expect(CONTEXT_CACHE_TTL_MS).toBe(60 * MIN);
    expect((await secondIterationDecision('assumed-short', 30 * MIN)).action).toBe('none');
    const stale = await secondIterationDecision('assumed-long', 90 * MIN);
    expect(stale.action).toBe('micro');
    expect(stale.reason).toContain('cache TTL');
    expect(stale.reason).toContain('assumed');
  });

  it('treats a gap as stale once it passes a measured 5 minute cache, even though it is under an hour', async () => {
    const decision = await secondIterationDecision('measured-5m', 10 * MIN, 5 * MIN);
    expect(decision.action).toBe('micro');
    expect(decision.forceContextReset).toBe(false);
    expect(decision.reason).toContain('~5min');
    expect(decision.reason).toContain('measured');
  });

  it('does not call a gap stale while a measured long cache is still warm', async () => {
    const decision = await secondIterationDecision('measured-2h', 90 * MIN, 120 * MIN);
    expect(decision.action).toBe('none');
  });
});

describe('loopCacheLifetimeFields', () => {
  it('reads the lifetime a Claude adapter has measured', () => {
    const adapter = new EventEmitter();
    expect(loopCacheLifetimeFields(adapter)).toEqual({});
    observeClaudeCacheLifetime(adapter, {
      type: 'assistant',
      message: { usage: { cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5_000 } } },
    }, 1_000);
    expect(loopCacheLifetimeFields(adapter)).toEqual({ cacheLifetimeMs: 60 * MIN });
  });

  it('adds nothing for adapters that never measured one or are not objects', () => {
    expect(loopCacheLifetimeFields(undefined)).toEqual({});
    expect(loopCacheLifetimeFields(null)).toEqual({});
    expect(loopCacheLifetimeFields('claude')).toEqual({});
    expect(loopCacheLifetimeFields({})).toEqual({});
  });
});
