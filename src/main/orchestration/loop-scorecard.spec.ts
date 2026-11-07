import { describe, expect, it } from 'vitest';
import { buildLoopScorecard, scorecardLines, type ScorecardInputs } from './loop-scorecard';
import type { LoopIteration } from '../../shared/types/loop.types';
describe('truthful scorecard', () => {
  it('counts short tool-free turns without treating missing historical observations as zero activity', () => {
    const base = { seq: 0, tokens: 0, costCents: 0, completionSignalsFired: [] };
    const iterations = [
      { ...base, toolCallCount: 0, outputCharacters: 23 },
      { ...base, toolCallCount: 1, outputCharacters: 14 },
      { ...base, toolCallCount: 0, outputCharacters: 1500 },
      base,
    ] satisfies ScorecardInputs['iterations'];
    const card = buildLoopScorecard({ run: { totalTokens: 0, totalCostCents: 0 }, iterations, spendRows: [] });
    expect(scorecardLines(card)).toContain('Status-only turns: 1 of 3 with recorded activity (no tools and at most 400 characters)');
  });
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
