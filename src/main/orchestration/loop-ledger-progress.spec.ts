import { describe, it, expect } from 'vitest';
import type { CompletionSignalEvidence } from '../../shared/types/loop-state.types';
import {
  DEFAULT_MAX_LEDGER_STALL_ITERATIONS,
  extractLedgerOpenCount,
  updateLedgerProgress,
  isLedgerStalled,
} from './loop-ledger-progress';

function sig(partial: Partial<CompletionSignalEvidence>): CompletionSignalEvidence {
  return { id: 'ledger-complete', sufficient: false, detail: '', ...partial } as CompletionSignalEvidence;
}

describe('extractLedgerOpenCount', () => {
  it('returns the openCount from the ledger-complete signal', () => {
    expect(extractLedgerOpenCount([sig({ id: 'ledger-complete', openCount: 4 })])).toBe(4);
    expect(extractLedgerOpenCount([sig({ id: 'ledger-complete', openCount: 0 })])).toBe(0);
  });

  it('returns null when no ledger-complete signal is present', () => {
    expect(extractLedgerOpenCount([sig({ id: 'self-declared', openCount: undefined })])).toBeNull();
    expect(extractLedgerOpenCount([])).toBeNull();
  });

  it('returns null when ledger-complete carries no structured openCount', () => {
    expect(extractLedgerOpenCount([sig({ id: 'ledger-complete', openCount: undefined })])).toBeNull();
  });

  it('floors and clamps a non-integer / negative openCount', () => {
    expect(extractLedgerOpenCount([sig({ id: 'ledger-complete', openCount: 3.9 })])).toBe(3);
    expect(extractLedgerOpenCount([sig({ id: 'ledger-complete', openCount: -1 })])).toBe(0);
  });
});

describe('updateLedgerProgress', () => {
  it('sets the first reading as the best with a zeroed counter', () => {
    const u = updateLedgerProgress({}, 6);
    expect(u).toEqual({ ledgerOpenCountBest: 6, ledgerNoImprovementIterations: 0, improved: true });
  });

  it('resets the counter when a strictly lower low is reached', () => {
    const u = updateLedgerProgress({ ledgerOpenCountBest: 6, ledgerNoImprovementIterations: 3 }, 2);
    expect(u).toEqual({ ledgerOpenCountBest: 2, ledgerNoImprovementIterations: 0, improved: true });
  });

  it('increments the counter when the ledger does not improve (same count)', () => {
    const u = updateLedgerProgress({ ledgerOpenCountBest: 2, ledgerNoImprovementIterations: 1 }, 2);
    expect(u).toEqual({ ledgerOpenCountBest: 2, ledgerNoImprovementIterations: 2, improved: false });
  });

  it('increments the counter when the ledger RE-EXPANDS above the best', () => {
    const u = updateLedgerProgress({ ledgerOpenCountBest: 2, ledgerNoImprovementIterations: 0 }, 9);
    expect(u).toEqual({ ledgerOpenCountBest: 2, ledgerNoImprovementIterations: 1, improved: false });
  });
});

describe('isLedgerStalled', () => {
  it('is false while open items remain but the counter is under the limit', () => {
    expect(isLedgerStalled({ ledgerNoImprovementIterations: 7 }, 4, 8)).toBe(false);
  });

  it('is true once the counter reaches the limit with open items remaining', () => {
    expect(isLedgerStalled({ ledgerNoImprovementIterations: 8 }, 4, 8)).toBe(true);
  });

  it('is never a stall when the ledger is fully resolved (openCount 0)', () => {
    expect(isLedgerStalled({ ledgerNoImprovementIterations: 99 }, 0, 8)).toBe(false);
  });

  it('uses the default limit when none is provided', () => {
    expect(isLedgerStalled({ ledgerNoImprovementIterations: DEFAULT_MAX_LEDGER_STALL_ITERATIONS }, 1)).toBe(true);
    expect(isLedgerStalled({ ledgerNoImprovementIterations: DEFAULT_MAX_LEDGER_STALL_ITERATIONS - 1 }, 1)).toBe(false);
  });

  it('treats a non-positive limit as 1', () => {
    expect(isLedgerStalled({ ledgerNoImprovementIterations: 1 }, 1, 0)).toBe(true);
  });
});

describe('non-convergent oscillation (the loop-1782864004679 repro)', () => {
  it('detects a stall after the open-count plateaus and re-expands', () => {
    // Observed sequence of open-counts across iterations: converges to 2, then
    // oscillates 9,5,4,4,4,4,4,4 without ever beating 2 again.
    const counts = [6, 4, 3, 2, 9, 5, 4, 4, 4, 4, 4, 4, 4];
    let tracker: { ledgerOpenCountBest?: number; ledgerNoImprovementIterations?: number } = {};
    const stalledAt: number[] = [];
    counts.forEach((open, i) => {
      tracker = updateLedgerProgress(tracker, open);
      if (isLedgerStalled(tracker, open, 8)) stalledAt.push(i);
    });
    // best (2) is reached at index 3; 8 consecutive non-improvements later
    // (index 11) the stall fires — well before any 50-iteration cap.
    expect(tracker.ledgerOpenCountBest).toBe(2);
    expect(stalledAt[0]).toBe(11);
  });

  it('never stalls a loop that closes items monotonically', () => {
    let tracker: { ledgerOpenCountBest?: number; ledgerNoImprovementIterations?: number } = {};
    for (let open = 10; open >= 0; open--) {
      tracker = updateLedgerProgress(tracker, open);
      expect(isLedgerStalled(tracker, open, 8)).toBe(false);
    }
  });
});
