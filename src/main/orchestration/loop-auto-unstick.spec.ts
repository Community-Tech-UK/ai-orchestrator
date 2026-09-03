import { describe, expect, it, vi } from 'vitest';
import { createLoopPendingInput, defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import {
  applyLoopAutoUnstickOnStall,
  AUTO_UNSTICK_MAX_ATTEMPTS,
  buildAutoUnstickIntervention,
  pickAutoUnstickSignal,
  runLoopAutoUnstick,
} from './loop-auto-unstick';

function state(overrides: Partial<LoopState> = {}): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: defaultLoopConfig('/tmp/ws', 'do the thing'),
    status: 'running',
    startedAt: 0,
    endedAt: null,
    totalIterations: 1,
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
    iterationsOnCurrentStage: 1,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
    ...overrides,
  };
}

function sig(id: string, verdict = 'CRITICAL', message = `${id} stuck`): {
  id: string;
  verdict: string;
  message: string;
} {
  return { id, verdict, message };
}

describe('pickAutoUnstickSignal', () => {
  it('prefers tool-repetition over a quieter CRITICAL', () => {
    const picked = pickAutoUnstickSignal(
      [sig('A'), sig('I'), sig('G', 'CRITICAL', 'Edit 43×')],
    );
    expect(picked?.id).toBe('G');
    expect(picked?.message).toContain('Edit');
  });

  it('leaves identical-work-hash to pause / plan-regen / branch-select', () => {
    expect(pickAutoUnstickSignal([sig('A')])).toBeNull();
  });

  it('ignores WARN and not-by-hint signals', () => {
    expect(pickAutoUnstickSignal([sig('G', 'WARN'), sig('F'), sig('BLOCKED')])).toBeNull();
  });
});

describe('buildAutoUnstickIntervention', () => {
  it('names the detector message and tells the agent to change approach', () => {
    const text = buildAutoUnstickIntervention(
      { id: 'G', message: 'Tool Edit called 43× in one iteration' },
      1,
      2,
    );
    expect(text).toContain('AUTOMATIC UNSTICK (1/2)');
    expect(text).toContain('Tool Edit called 43×');
    expect(text).toContain('Stop repeating the same tool');
    expect(text).toContain('binding direction');
  });
});

describe('applyLoopAutoUnstickOnStall', () => {
  it('injects once on a fixable CRITICAL and records in-flight state', () => {
    const target = state();
    const emit = vi.fn(() => true);
    const result = applyLoopAutoUnstickOnStall({
      state: target,
      seq: 6,
      verdict: 'CRITICAL',
      signals: [sig('G', 'CRITICAL', 'Tool Edit called 43× in one iteration')],
      verifyPassed: false,
      attempts: 0,
      emit,
    });

    expect(result).toEqual({ injected: true, attempts: 1 });
    expect(target.pendingInterventions).toHaveLength(1);
    expect(target.pendingInterventions[0]?.source).toBe('auto-unstick');
    expect(target.pendingInterventions[0]?.message).toContain('Tool Edit called 43×');
    expect(target.autoUnstick).toEqual({
      seq: 6,
      attempt: 1,
      max: AUTO_UNSTICK_MAX_ATTEMPTS,
      signalId: 'G',
    });
    expect(emit).toHaveBeenCalledWith('loop:auto-unstick', expect.objectContaining({
      loopRunId: 'loop-1',
      seq: 6,
      attempt: 1,
      signalId: 'G',
    }));
  });

  it('stops after the attempt cap', () => {
    const target = state();
    const result = applyLoopAutoUnstickOnStall({
      state: target,
      seq: 8,
      verdict: 'CRITICAL',
      signals: [sig('G')],
      verifyPassed: false,
      attempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      emit: () => true,
    });
    expect(result).toEqual({ injected: false, attempts: AUTO_UNSTICK_MAX_ATTEMPTS });
    expect(target.pendingInterventions).toEqual([]);
  });

  it('yields to a queued human hint', () => {
    const target = state({
      pendingInterventions: [createLoopPendingInput('use fixtures', { source: 'human' })],
    });
    const result = applyLoopAutoUnstickOnStall({
      state: target,
      seq: 3,
      verdict: 'CRITICAL',
      signals: [sig('G')],
      verifyPassed: false,
      attempts: 0,
      emit: () => true,
    });
    expect(result.injected).toBe(false);
    expect(target.pendingInterventions).toHaveLength(1);
  });

  it('resets the streak on OK or a passing verify', () => {
    const target = state({
      autoUnstick: { seq: 2, attempt: 1, max: 2, signalId: 'G' },
    });
    expect(applyLoopAutoUnstickOnStall({
      state: target,
      seq: 3,
      verdict: 'OK',
      signals: [],
      verifyPassed: false,
      attempts: 1,
      emit: () => true,
    })).toEqual({ injected: false, attempts: 0 });
    expect(target.autoUnstick).toBeUndefined();

    target.autoUnstick = { seq: 3, attempt: 1, max: 2, signalId: 'G' };
    expect(applyLoopAutoUnstickOnStall({
      state: target,
      seq: 4,
      verdict: 'CRITICAL',
      signals: [sig('G')],
      verifyPassed: true,
      attempts: 1,
      emit: () => true,
    })).toEqual({ injected: false, attempts: 0 });
  });

  it('does not steal identical-work-hash from plan-regen or pause', () => {
    const target = state({
      autoUnstick: { seq: 2, attempt: 1, max: 2, signalId: 'G' },
    });
    const result = applyLoopAutoUnstickOnStall({
      state: target,
      seq: 4,
      verdict: 'CRITICAL',
      signals: [sig('A', 'CRITICAL', 'Identical work hash repeated 3x')],
      verifyPassed: false,
      attempts: 1,
      emit: () => true,
    });
    expect(result).toEqual({ injected: false, attempts: 1 });
    expect(target.pendingInterventions).toEqual([]);
    expect(target.autoUnstick?.attempt).toBe(1);
  });
});

describe('runLoopAutoUnstick', () => {
  it('persists the attempt count through the coordinator setters', () => {
    let attempts = 0;
    const target = state();
    const injected = runLoopAutoUnstick({
      state: target,
      seq: 1,
      verdict: 'CRITICAL',
      signals: [sig('I')],
      verifyPassed: false,
      getAttempts: () => attempts,
      setAttempts: (count) => { attempts = count; },
      emit: () => true,
    });
    expect(injected).toBe(true);
    expect(attempts).toBe(1);
  });
});
