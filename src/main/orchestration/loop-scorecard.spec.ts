import { describe, expect, it } from 'vitest';
import { buildLoopScorecard, scorecardLines } from './loop-scorecard';
import type { LoopIteration } from '../../shared/types/loop.types';
describe('truthful scorecard', () => {
  it('rebuilt spend and known-stop denominator stay separate from run and legacy totals', () => {
    const iterations = [
      { seq:0,tokens:10,costCents:100,costKnown:true,finishReason:'max_turns',promptBytes:20,completionSignalsFired:[{id:'ledger-complete',openCount:0}] },
      { seq:1,tokens:20,costCents:50,completionSignalsFired:[] },
    ] as unknown as LoopIteration[];
    const card = buildLoopScorecard({run:{totalTokens:50,totalCostCents:200},iterations,spendRows:[],ledger:undefined});
    expect(card.costCents).toBe(200); expect(card.unattributedCents).toBe(50); expect(card.legacyRounds).toBe(1);
    expect(card.stepLimitedRounds).toBe(1); expect(card.recordedStopRounds).toBe(1); expect(card.roundsAfterLedgerClosed).toBe(1);
    expect(scorecardLines(card).join('\n')).toContain('1 of 1 with a recorded reason');
    expect(scorecardLines(card).join('\n')).not.toMatch(/NaN|Infinity/);
    expect(card.finishedTasks).toBeNull();
  });
});
