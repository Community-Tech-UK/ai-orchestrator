import type { LoopScorecard } from '../types/loop-spend.types';
import { formatMoneyRate, formatMean, formatRate, rate } from './safe-rate';
export function scorecardLines(card: LoopScorecard): string[] {
  const review = card.byPurpose.review?.costCents ?? 0;
  const estimatedCalls = Object.values(card.byPurpose).reduce((count, row) => count + (row.estimatedCalls ?? 0), 0);
  return [
    `Cost: $${(card.costCents / 100).toFixed(2)}, of which the agent's own work $${((card.byPurpose.builder?.costCents ?? 0) / 100).toFixed(2)} and second opinions $${(review / 100).toFixed(2)} (${formatRate(rate(review, card.costCents))})`,
    `Exact from the provider: ${formatMoneyRate(card.knownCents, card.costCents)}`,
    ...(estimatedCalls ? [`${estimatedCalls} recorded call(s) use estimated costs; an estimate can round to zero cents`] : []),
    `Rounds after the task list was already finished: ${card.roundsAfterLedgerClosed} of ${card.rounds}`,
    `Rounds that hit the step limit: ${card.stepLimitedRounds} of ${card.recordedStopRounds} with a recorded reason`,
    `Tokens per finished task: ${formatMean(card.tokens, card.finishedTasks ?? 0, 'tokens per task')}`,
    `Median instruction size: ${card.medianPromptBytes === null ? '-' : `${card.medianPromptBytes.toLocaleString('en-US')} bytes`}`,
    ...(card.legacyRounds ? [`Harness did not record where the cost came from for ${card.legacyRounds} older rounds; their stored estimates are included without re-pricing`] : []),
    ...(card.unattributedCents || card.unattributedTokens ? [`Unattributed: $${(card.unattributedCents / 100).toFixed(2)} and ${card.unattributedTokens} tokens`] : []),
    ...(card.unknownCalls ? [`${card.unknownCalls} model call(s) had no usable cost report; the dollar total is incomplete`] : []),
  ];
}
