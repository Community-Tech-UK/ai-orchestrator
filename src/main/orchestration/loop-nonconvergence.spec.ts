import { describe, expect, it, vi } from 'vitest';
import {
  applyLoopNonConvergenceDiagnosis,
  diagnoseNonConvergence,
  maybeParkReviewDrivenRun,
  PARK_LEAF_AFTER_CRITICAL_ITERATIONS,
  recordParkedLeaf,
  shouldParkLeaf,
  resolveParkSignal,
  shouldParkReviewDrivenRun,
  trackLeafStall,
  type NonConvergenceInput,
} from './loop-nonconvergence';
import { AUTO_UNSTICK_ELIGIBLE_SIGNALS, AUTO_UNSTICK_MAX_ATTEMPTS } from './loop-auto-unstick';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';

function input(over: Partial<NonConvergenceInput> = {}): NonConvergenceInput {
  return {
    persistedReviewFindings: 0,
    reviewRounds: 0,
    verifyPassed: false,
    uncommittedFileCount: 0,
    earlyTouchedFiles: 0,
    lateTouchedFiles: 0,
    ...over,
  };
}

describe('diagnoseNonConvergence (L6)', () => {
  it('names a reviewer that keeps raising the same finding', () => {
    const diagnosis = diagnoseNonConvergence(input({ persistedReviewFindings: 2, reviewRounds: 4 }));

    expect(diagnosis.reason).toBe('code_review_non_converging');
    expect(diagnosis.message).toContain('4 rounds');
  });

  it('does not call a first-round finding non-convergence', () => {
    expect(diagnoseNonConvergence(input({ persistedReviewFindings: 2, reviewRounds: 1 })).reason)
      .toBe('no_progress');
  });

  it('names work that is done but uncommitted', () => {
    const diagnosis = diagnoseNonConvergence(input({ verifyPassed: true, uncommittedFileCount: 7 }));

    expect(diagnosis.reason).toBe('landable_uncommitted');
    expect(diagnosis.message).toContain('7 file(s)');
  });

  it('names a change that keeps widening', () => {
    const diagnosis = diagnoseNonConvergence(input({ earlyTouchedFiles: 3, lateTouchedFiles: 12 }));

    expect(diagnosis.reason).toBe('scope_expanded');
    expect(diagnosis.message).toContain('3 to 12');
  });

  it('does not call ordinary growth a scope expansion', () => {
    expect(diagnoseNonConvergence(input({ earlyTouchedFiles: 4, lateTouchedFiles: 6 })).reason)
      .toBe('no_progress');
  });

  // The generic reason stays available, but only as the honest last resort.
  it('falls back to no_progress rather than guessing', () => {
    expect(diagnoseNonConvergence(input()).reason).toBe('no_progress');
  });

  it('prefers the most actionable reason when several apply', () => {
    const diagnosis = diagnoseNonConvergence(input({
      persistedReviewFindings: 1,
      reviewRounds: 5,
      verifyPassed: true,
      uncommittedFileCount: 3,
      earlyTouchedFiles: 2,
      lateTouchedFiles: 20,
    }));

    expect(diagnosis.reason).toBe('code_review_non_converging');
  });
});

describe('shouldParkLeaf (L6)', () => {
  const diagnosis = diagnoseNonConvergence(input({ persistedReviewFindings: 1, reviewRounds: 5 }));

  function parkInput(over: Record<string, unknown> = {}) {
    return {
      leafId: 'task-7',
      criticalIterationsOnLeaf: PARK_LEAF_AFTER_CRITICAL_ITERATIONS,
      autoUnstickAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      autoUnstickMaxAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      diagnosis,
      seq: 12,
      ...over,
    };
  }

  it('parks a leaf that has exhausted every cheaper option', () => {
    expect(shouldParkLeaf(parkInput())).toEqual({
      id: 'task-7',
      reason: 'code_review_non_converging',
      note: diagnosis.message,
      parkedAtSeq: 12,
    });
  });

  // Parking is a claim about WHY. "We don't know" is not a reason to defer
  // someone's work.
  it('never parks on the generic no_progress reason', () => {
    expect(shouldParkLeaf(parkInput({ diagnosis: diagnoseNonConvergence(input()) }))).toBeNull();
  });

  it('never parks before auto-unstick has spent its attempts — the nudge is cheaper', () => {
    expect(shouldParkLeaf(parkInput({ autoUnstickAttempts: 0 }))).toBeNull();
  });

  it('never parks on the first critical iteration', () => {
    expect(shouldParkLeaf(parkInput({ criticalIterationsOnLeaf: 1 }))).toBeNull();
  });

  it('cannot park an unidentifiable leaf', () => {
    expect(shouldParkLeaf(parkInput({ leafId: null }))).toBeNull();
  });
});

describe('recordParkedLeaf (L6)', () => {
  function stateFor(): LoopState {
    return { id: 'loop-1', config: defaultLoopConfig('/tmp/x', 'goal') } as unknown as LoopState;
  }

  it('keeps the work visible rather than dropping it', () => {
    const state = stateFor();
    recordParkedLeaf(state, { id: 'a', reason: 'scope_expanded', note: 'n', parkedAtSeq: 1 });

    expect(state.parkedLeaves).toEqual([{ id: 'a', reason: 'scope_expanded', note: 'n', parkedAtSeq: 1 }]);
  });

  it('does not double-park the same leaf', () => {
    const state = stateFor();
    recordParkedLeaf(state, { id: 'a', reason: 'scope_expanded', note: 'n', parkedAtSeq: 1 });
    recordParkedLeaf(state, { id: 'a', reason: 'landable_uncommitted', note: 'other', parkedAtSeq: 9 });

    expect(state.parkedLeaves).toHaveLength(1);
    expect(state.parkedLeaves?.[0]?.parkedAtSeq).toBe(1);
  });
});

describe('shouldParkReviewDrivenRun (L14)', () => {
  function args(over: Record<string, unknown> = {}) {
    return {
      autoUnstickAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      autoUnstickMaxAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      verdict: 'CRITICAL',
      signalId: 'G',
      eligibleSignals: AUTO_UNSTICK_ELIGIBLE_SIGNALS,
      ...over,
    };
  }

  it('parks once auto-unstick has spent both attempts on an eligible signal', () => {
    expect(shouldParkReviewDrivenRun(args())).toBe(true);
  });

  it('does not park while auto-unstick still has an attempt left', () => {
    expect(shouldParkReviewDrivenRun(args({ autoUnstickAttempts: 1 }))).toBe(false);
  });

  it('does not park on a WARN verdict', () => {
    expect(shouldParkReviewDrivenRun(args({ verdict: 'WARN' }))).toBe(false);
  });

  // Signal A is deliberately outside auto-unstick's eligible set (G38), so a
  // run stalled only on A must never be parked by this rule.
  it('never parks on signal A', () => {
    expect(AUTO_UNSTICK_ELIGIBLE_SIGNALS.has('A')).toBe(false);
    expect(shouldParkReviewDrivenRun(args({ signalId: 'A' }))).toBe(false);
  });

  it('does not park without an identified signal', () => {
    expect(shouldParkReviewDrivenRun(args({ signalId: null }))).toBe(false);
  });
});

describe('maybeParkReviewDrivenRun (L14)', () => {
  function harness() {
    const state = {
      id: 'loop-1',
      status: 'running',
      config: defaultLoopConfig('/tmp/x', 'goal'),
    } as unknown as LoopState;
    return {
      state,
      emit: vi.fn(),
      convergenceNotes: new Map<string, string>(),
      memoryStore: { recordLearning: vi.fn() } as unknown as Parameters<typeof maybeParkReviewDrivenRun>[0]['memoryStore'],
      cloneForBroadcast: () => state,
    };
  }

  it('pauses rather than terminating, so an operator can hint and resume', () => {
    const h = harness();

    const parked = maybeParkReviewDrivenRun({
      ...h,
      seq: 9,
      verdict: 'CRITICAL',
      signal: { id: 'G', verdict: 'CRITICAL', message: 'same files, no test movement' },
      autoUnstickAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
    });

    expect(parked).toBe(true);
    expect(h.state.status).toBe('paused');
    expect(h.emit).toHaveBeenCalledWith(
      'loop:paused-no-progress',
      expect.objectContaining({ autoUnstickExhausted: true, seq: 9 }),
    );
    expect(h.convergenceNotes.get('loop-1')).toContain('auto-unstick exhausted on signal G');
  });

  it('leaves a still-recoverable run running', () => {
    const h = harness();

    const parked = maybeParkReviewDrivenRun({
      ...h,
      seq: 2,
      verdict: 'CRITICAL',
      signal: { id: 'G', verdict: 'CRITICAL', message: 'x' },
      autoUnstickAttempts: 0,
    });

    expect(parked).toBe(false);
    expect(h.state.status).toBe('running');
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('resolveParkSignal (L14)', () => {
  const evaluation = {
    primary: { id: 'A', verdict: 'CRITICAL', message: 'identical work hash' },
    signals: [
      { id: 'A', verdict: 'CRITICAL', message: 'identical work hash' },
      { id: 'B', verdict: 'CRITICAL', message: 'no test movement' },
    ],
  };

  // The renderer-boundary schema requires the full ProgressSignalEvidence
  // shape. A signal without `verdict` makes the whole `loop:paused-no-progress`
  // push fail validation and get dropped, so the operator never sees the park.
  it('always carries a verdict, including on the earlier-iteration fallback', () => {
    const inEvaluation = { autoUnstick: { seq: 4, attempt: 2, max: 2, signalId: 'B' } } as LoopState;
    const goneFromEvaluation = { autoUnstick: { seq: 4, attempt: 2, max: 2, signalId: 'E' } } as LoopState;

    expect(resolveParkSignal(inEvaluation, evaluation)?.verdict).toBe('CRITICAL');
    expect(resolveParkSignal(goneFromEvaluation, evaluation)?.verdict).toBe('CRITICAL');
    expect(resolveParkSignal({} as LoopState, evaluation)?.verdict).toBe('CRITICAL');
  });

  // The bug this exists to stop: the detector ranks A first, auto-unstick
  // excludes A and nudges B. Keying the park on `primary` sees an ineligible
  // signal and never parks, exactly when L14 is needed.
  it('prefers the signal auto-unstick actually acted on over the detector primary', () => {
    const state = { autoUnstick: { seq: 4, attempt: 2, max: 2, signalId: 'B' } } as LoopState;

    expect(resolveParkSignal(state, evaluation)?.id).toBe('B');
  });

  it('keeps the acted-on signal even when it left this iteration evaluation', () => {
    const state = { autoUnstick: { seq: 4, attempt: 2, max: 2, signalId: 'E' } } as LoopState;

    expect(resolveParkSignal(state, evaluation)?.id).toBe('E');
  });

  it('falls back to the detector primary when auto-unstick never acted', () => {
    expect(resolveParkSignal({} as LoopState, evaluation)?.id).toBe('A');
  });

  it('a run stalled only on A still never parks', () => {
    const state = {} as LoopState;
    const onlyA = {
      primary: { id: 'A', verdict: 'CRITICAL', message: 'x' },
      signals: [{ id: 'A', verdict: 'CRITICAL', message: 'x' }],
    };

    expect(shouldParkReviewDrivenRun({
      autoUnstickAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      autoUnstickMaxAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      verdict: 'CRITICAL',
      signalId: resolveParkSignal(state, onlyA)?.id ?? null,
      eligibleSignals: AUTO_UNSTICK_ELIGIBLE_SIGNALS,
    })).toBe(false);
  });

  // The whole point of the fix, end to end.
  it('parks when A co-occurs with the eligible signal auto-unstick nudged', () => {
    const state = { autoUnstick: { seq: 4, attempt: 2, max: 2, signalId: 'B' } } as LoopState;

    expect(shouldParkReviewDrivenRun({
      autoUnstickAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      autoUnstickMaxAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      verdict: 'CRITICAL',
      signalId: resolveParkSignal(state, evaluation)?.id ?? null,
      eligibleSignals: AUTO_UNSTICK_ELIGIBLE_SIGNALS,
    })).toBe(true);
  });
});

describe('applyLoopNonConvergenceDiagnosis (L6 wiring)', () => {
  function stateFor(over: Partial<LoopState> = {}): LoopState {
    return {
      id: 'loop-1',
      config: defaultLoopConfig('/tmp/x', 'goal'),
      ...over,
    } as unknown as LoopState;
  }
  const file = (path: string) => ({ path });

  it('records a named reason on state instead of a bare no-progress', () => {
    const state = stateFor({ unresolvedReviewThreads: ['t1'], pingPong: { roundCount: 4 } } as never);
    const emit = vi.fn();

    const diagnosis = applyLoopNonConvergenceDiagnosis({
      state,
      iteration: { filesChanged: [], verifyStatus: 'failed' },
      history: [],
      seq: 7,
      nextTodo: 'wire the adapter',
      autoUnstickAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      emit,
    });

    expect(diagnosis.reason).toBe('code_review_non_converging');
    expect(state.nonConvergence).toMatchObject({ reason: 'code_review_non_converging', seq: 7 });
  });

  it('parks the stuck leaf and reports it, without dropping the work', () => {
    const state = stateFor({ unresolvedReviewThreads: ['t1'], pingPong: { roundCount: 4 } } as never);
    const emit = vi.fn();
    const stall = (seq: number) => applyLoopNonConvergenceDiagnosis({
      state,
      iteration: { filesChanged: [], verifyStatus: 'failed' },
      history: [],
      seq,
      nextTodo: 'wire the adapter',
      autoUnstickAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      emit,
    });

    // Parking needs a REAL stall sequence on the same leaf, not a seeded count.
    stall(5);
    stall(6);
    stall(7);

    expect(state.parkedLeaves).toHaveLength(1);
    expect(state.parkedLeaves?.[0]?.id).toBe('wire the adapter');
    expect(emit).toHaveBeenCalledWith('loop:leaf-parked', expect.objectContaining({ seq: 7 }));
  });

  it('parks nothing on the generic reason, however long the stall', () => {
    const state = stateFor();
    const emit = vi.fn();
    let diagnosis = { reason: 'unset' } as { reason: string };
    for (const seq of [5, 6, 7, 8]) {
      diagnosis = applyLoopNonConvergenceDiagnosis({
        state,
        iteration: { filesChanged: [], verifyStatus: 'failed' },
        history: [],
        seq,
        nextTodo: 'wire the adapter',
        autoUnstickAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
        emit,
      });
    }

    expect(diagnosis.reason).toBe('no_progress');
    expect(state.parkedLeaves).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('reads scope expansion from the two halves of the run so far', () => {
    const state = stateFor();
    const history = [
      { filesChanged: [file('a.ts')] },
      { filesChanged: [file('a.ts')] },
      { filesChanged: [file('b.ts'), file('c.ts'), file('d.ts')] },
      { filesChanged: [file('e.ts'), file('f.ts')] },
    ];

    const diagnosis = applyLoopNonConvergenceDiagnosis({
      state,
      iteration: { filesChanged: [], verifyStatus: 'failed' },
      history,
      seq: 4,
      nextTodo: null,
      autoUnstickAttempts: 0,
      emit: vi.fn(),
    });

    expect(diagnosis.reason).toBe('scope_expanded');
  });

  it('cannot claim scope expansion on a run too short to split', () => {
    const diagnosis = applyLoopNonConvergenceDiagnosis({
      state: stateFor(),
      iteration: { filesChanged: [], verifyStatus: 'failed' },
      history: [{ filesChanged: [file('a.ts')] }],
      seq: 1,
      nextTodo: null,
      autoUnstickAttempts: 0,
      emit: vi.fn(),
    });

    expect(diagnosis.reason).toBe('no_progress');
  });
});

/**
 * L6 — the park gate needs its OWN counter. `state.repeatedEvidenceCount` only
 * advances inside the completion-attempt branch, so using it meant the ordinary
 * stuck-mid-work stall never reached the park threshold, and a run that had
 * failed completion earlier could park a brand-new leaf on its first stall.
 */
describe('trackLeafStall (L6)', () => {
  function stateFor(): LoopState {
    return { id: 'loop-1', config: defaultLoopConfig('/tmp/x', 'goal') } as unknown as LoopState;
  }

  it('counts consecutive stalls on the same leaf', () => {
    const state = stateFor();

    expect(trackLeafStall(state, 'task-a')).toBe(1);
    expect(trackLeafStall(state, 'task-a')).toBe(2);
    expect(trackLeafStall(state, 'task-a')).toBe(3);
  });

  // Moving onto new work is exactly what "this leaf is stuck" must not survive.
  it('resets when the loop moves to a different leaf', () => {
    const state = stateFor();
    trackLeafStall(state, 'task-a');
    trackLeafStall(state, 'task-a');

    expect(trackLeafStall(state, 'task-b')).toBe(1);
    expect(state.leafStall).toEqual({ leafId: 'task-b', criticalIterations: 1 });
  });

  it('clears when there is no identifiable leaf', () => {
    const state = stateFor();
    trackLeafStall(state, 'task-a');

    expect(trackLeafStall(state, null)).toBe(0);
    expect(state.leafStall).toBeUndefined();
  });

  it('is independent of repeatedEvidenceCount', () => {
    const state = stateFor();
    state.repeatedEvidenceCount = 99;

    expect(trackLeafStall(state, 'task-a')).toBe(1);
  });
});

describe('leaf parking uses the real stall sequence (L6 regression)', () => {
  function stateFor(): LoopState {
    return {
      id: 'loop-1',
      config: defaultLoopConfig('/tmp/x', 'goal'),
      unresolvedReviewThreads: ['t1'],
      pingPong: { roundCount: 4 },
    } as unknown as LoopState;
  }

  function stall(state: LoopState, nextTodo: string | null, seq: number) {
    return applyLoopNonConvergenceDiagnosis({
      state,
      iteration: { filesChanged: [], verifyStatus: 'failed' },
      history: [],
      seq,
      nextTodo,
      autoUnstickAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
      emit: vi.fn(),
    });
  }

  // The common case the old counter missed entirely: a run stuck mid-work that
  // never declares completion, so `repeatedEvidenceCount` stays 0 forever.
  it('parks after repeated stalls even though completion was never attempted', () => {
    const state = stateFor();
    expect(state.repeatedEvidenceCount ?? 0).toBe(0);

    stall(state, 'wire the adapter', 1);
    expect(state.parkedLeaves).toBeUndefined();
    stall(state, 'wire the adapter', 2);
    expect(state.parkedLeaves).toBeUndefined();
    stall(state, 'wire the adapter', 3);

    expect(state.parkedLeaves).toHaveLength(1);
    expect(state.parkedLeaves?.[0]?.id).toBe('wire the adapter');
  });

  // The inverse failure: stale unrelated evidence must not park a fresh leaf.
  it('never parks a brand-new leaf on its first stall', () => {
    const state = stateFor();
    state.repeatedEvidenceCount = 99;
    stall(state, 'wire the adapter', 1);
    stall(state, 'wire the adapter', 2);
    stall(state, 'wire the adapter', 3);
    expect(state.parkedLeaves).toHaveLength(1);

    stall(state, 'a completely different task', 4);

    expect(state.parkedLeaves).toHaveLength(1);
  });
});
