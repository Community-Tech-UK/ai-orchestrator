import { describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import { decideFinishOutcome, isLedgerClosed, resetFinishBudget, updateFinishPhase, type FinishCheck } from './loop-finish-phase';

function state(): LoopState {
  return { id: 'finish-test', config: { ...defaultLoopConfig('/tmp', 'finish'), completion: { ...defaultLoopConfig('/tmp', 'finish').completion, mode: 'review-driven' } }, currentStage: 'IMPLEMENT', loopTasksLedgerResolvedAtStart: false, pendingInterventions: [], ledgerConvergence: { version: 1, knownTaskStates: { a: 'done' }, plannedLeafIds: ['a'], discoveredLeafIds: [], noMeaningfulTransitionIterations: 0 } } as unknown as LoopState;
}
const iteration = (seq: number) => ({ seq, stage: 'IMPLEMENT' } as LoopIteration);
const check = (result: FinishCheck['result']): FinishCheck => ({ check: 'verify', result, detail: result });

describe('finish phase', () => {
  it('enters on a closed nonempty IMPLEMENT ledger, queues cards once per round, and reopens', () => {
    const s = state(); const emit = vi.fn();
    updateFinishPhase(s, iteration(4), emit);
    expect(s.finishPhase).toEqual({ enteredAtSeq: 4, roundsUsed: 0, maxRounds: 3 });
    expect(s.pendingInterventions[0].message).toContain('Finish round 1 of 3');
    expect(s.pendingInterventions[0].message).toContain('Needs human');
    updateFinishPhase(s, iteration(5), emit);
    updateFinishPhase(s, iteration(5), emit);
    expect(s.finishPhase?.roundsUsed).toBe(1);
    expect(s.pendingInterventions).toHaveLength(2);
    s.ledgerConvergence!.knownTaskStates['a'] = 'todo';
    updateFinishPhase(s, iteration(6), emit);
    expect(s.finishPhase).toBeUndefined();
    expect(s.pendingInterventions).toHaveLength(0);
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it('never enters for empty, invalid, originally closed, PLAN or gated ledgers', () => {
    for (const mutate of [
      (s: LoopState) => { s.ledgerConvergence!.knownTaskStates = {}; },
      (s: LoopState) => { s.ledgerConvergence!.inventoryInvalid = true; },
      (s: LoopState) => { s.loopTasksLedgerResolvedAtStart = true; },
      (s: LoopState) => { s.currentStage = 'PLAN'; },
      (s: LoopState) => { s.config.completion.mode = 'gated'; },
    ]) { const s = state(); mutate(s); updateFinishPhase(s, iteration(0)); expect(s.finishPhase).toBeUndefined(); }
    expect(isLedgerClosed(undefined)).toBe(false);
  });
  it('one clean round completes only with all checks green', () => {
    const s = state(); updateFinishPhase(s, iteration(0));
    expect(decideFinishOutcome({ state: s, clean: true, checks: [check('passed')] })?.kind).toBe('completed');
    expect(decideFinishOutcome({ state: s, clean: true, checks: [check('skipped')] })?.kind).toBe('completed-with-notes');
    expect(decideFinishOutcome({ state: s, clean: true, checks: [check('already-failing')] })?.kind).toBe('completed-with-notes');
    expect(decideFinishOutcome({ state: s, clean: true, checks: [check('failed')] })).toBeNull();
  });
  it('at budget exhaustion failures and strict skipped checks need sign-off', () => {
    const s = state(); updateFinishPhase(s, iteration(0)); updateFinishPhase(s, iteration(3));
    expect(decideFinishOutcome({ state: s, clean: false, checks: [check('skipped')] })?.kind).toBe('completed-with-notes');
    expect(decideFinishOutcome({ state: s, clean: false, checks: [check('already-failing')] })?.kind).toBe('completed-with-notes');
    expect(decideFinishOutcome({ state: s, clean: false, checks: [check('failed')] })?.kind).toBe('needs-sign-off');
    s.config.planFile = 'plan.md';
    expect(decideFinishOutcome({ state: s, clean: true, checks: [check('skipped')] })?.kind).toBe('needs-sign-off');
    resetFinishBudget(s); expect(s.finishPhase?.roundsUsed).toBe(0);
  });
});
