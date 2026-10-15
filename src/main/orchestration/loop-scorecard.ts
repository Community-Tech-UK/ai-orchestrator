import type { LoopIteration } from '../../shared/types/loop.types';
import type { LoopScorecard, LoopSpendByPurpose, LoopSpendRow, LoopUsageProvenance } from '../../shared/types/loop-spend.types';
export { scorecardLines } from '../../shared/util/loop-scorecard-format';
export interface ScorecardInputs {
  run: { totalCostCents: number; totalTokens: number };
  iterations: Pick<LoopIteration, 'seq' | 'tokens' | 'costCents' | 'costKnown' | 'finishReason' | 'promptBytes' | 'completionSignalsFired'>[];
  spendRows: LoopSpendRow[];
  ledger?: { knownTaskStates: Record<string, string> };
}
export function buildLoopScorecard({ run, iterations, spendRows, ledger }: ScorecardInputs): LoopScorecard {
  const byPurpose: LoopSpendByPurpose = {};
  let knownCents = 0; let reconstructedTokens = 0; let reconstructedCents = 0;
  const add = (purpose: keyof LoopSpendByPurpose, tokens: number, cents: number, basis: LoopUsageProvenance) => {
    const bucket = byPurpose[purpose] ??= { tokens: 0, costCents: 0, knownCents: 0, calls: 0 };
    bucket.tokens += tokens; bucket.costCents += cents; bucket.calls++;
    bucket.unknownCalls = (bucket.unknownCalls ?? 0) + (basis === 'unknown' ? 1 : 0);
    bucket.estimatedCalls = (bucket.estimatedCalls ?? 0) + (basis === 'computed' || basis === 'legacy-estimate' ? 1 : 0);
    if (basis === 'provider-reported') { bucket.knownCents += cents; knownCents += cents; }
    reconstructedCents += cents; reconstructedTokens += tokens;
  };
  for (const round of iterations) add('builder', round.tokens, round.costCents, round.costKnown === true ? 'provider-reported' : round.costKnown === false && round.costCents === 0 && round.tokens > 0 ? 'unknown' : round.costKnown === false ? 'computed' : 'legacy-estimate');
  for (const row of spendRows) add(row.purpose, row.tokens, row.costCents, row.basis);
  const stopReasons: Record<string, number> = {};
  for (const round of iterations) if (round.finishReason) stopReasons[round.finishReason] = (stopReasons[round.finishReason] ?? 0) + 1;
  const closed = iterations.filter(round => round.completionSignalsFired.some(signal => signal.id === 'ledger-complete' && signal.openCount === 0)).map(round => round.seq);
  const firstClosed = closed.length ? Math.min(...closed) : null;
  const sizes = iterations.flatMap(round => round.promptBytes === undefined ? [] : [round.promptBytes]).sort((a,b) => a-b);
  const middle = Math.floor(sizes.length / 2);
  const tasks = ledger ? Object.values(ledger.knownTaskStates) : undefined;
  return {
    costCents: Math.max(run.totalCostCents, reconstructedCents), tokens: Math.max(run.totalTokens, reconstructedTokens), knownCents,
    unattributedCents: Math.max(0, run.totalCostCents - reconstructedCents), unattributedTokens: Math.max(0, run.totalTokens - reconstructedTokens), byPurpose,
    legacyRounds: iterations.filter(round => round.costKnown === undefined).length,
    rounds: iterations.length, roundsAfterLedgerClosed: firstClosed === null ? 0 : iterations.filter(round => round.seq > firstClosed).length,
    stepLimitedRounds: iterations.filter(round => round.finishReason === 'max_turns' || round.finishReason === 'max_turn_requests').length,
    recordedStopRounds: iterations.filter(round => !!round.finishReason).length, stopReasons,
    medianPromptBytes: sizes.length ? sizes.length % 2 ? sizes[middle] : (sizes[middle-1]+sizes[middle])/2 : null,
    finishedTasks: tasks ? tasks.filter(state => state === 'done').length : null, totalTasks: tasks?.length ?? null,
    unknownCalls: spendRows.filter(row => row.basis === 'unknown').length + iterations.filter(row => row.costKnown === false && row.costCents === 0 && row.tokens > 0).length,
  };
}
