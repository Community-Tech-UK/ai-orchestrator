import { randomUUID } from 'node:crypto';
import type { LoopState } from '../../shared/types/loop.types';
import { reconstructLoopSpend, type LoopSpendPortion, type LoopSpendRow } from '../../shared/types/loop-spend.types';
import type { FreshEyesReviewerResult } from './loop-fresh-eyes-reviewer';
import { getLoopStoreService } from './loop-store';
import { getLogger } from '../logging/logger';
const logger = getLogger('LoopSpendLedger');
const clean = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
type SpendInput = Omit<LoopSpendRow, 'id' | 'loopRunId' | 'createdAt' | 'iterationSeq'> & { seq?: number; fold?: boolean; knownCents?: number };
type Insert = (row: LoopSpendRow) => void;
const insert: Insert = (row) => { getLoopStoreService().store.insertSpend(row); };
export function recordLoopSpend(state: LoopState, input: SpendInput, persist: Insert = insert): void {
  const tokens = clean(input.tokens); const costCents = clean(input.costCents);
  if (input.fold !== false) { state.totalTokens += tokens; state.totalCostCents += costCents; }
  const buckets = state.spendByPurpose ??= {};
  const bucket = buckets[input.purpose] ??= { tokens: 0, costCents: 0, knownCents: 0, calls: 0 };
  bucket.tokens += tokens; bucket.costCents += costCents; bucket.calls += 1;
  bucket.unknownCalls = (bucket.unknownCalls ?? 0) + (input.basis === 'unknown' ? 1 : 0);
  bucket.estimatedCalls = (bucket.estimatedCalls ?? 0) + (input.basis === 'computed' || input.basis === 'legacy-estimate' ? 1 : 0);
  bucket.knownCents += input.knownCents !== undefined ? Math.min(costCents, clean(input.knownCents)) : input.basis === 'provider-reported' ? costCents : 0;
  try { persist({ id: randomUUID(), loopRunId: state.id, iterationSeq: input.seq, purpose: input.purpose, detail: input.detail, provider: input.provider, model: input.model, tokens, costCents, cacheReadTokens: input.cacheReadTokens === undefined ? undefined : clean(input.cacheReadTokens), cacheWriteTokens: input.cacheWriteTokens === undefined ? undefined : clean(input.cacheWriteTokens), basis: input.basis, createdAt: Date.now() }); }
  catch (error) { logger.warn('Could not persist loop spend; budget still includes it', { loopRunId: state.id, error: String(error) }); }
}
export function noteBuilderSpend(state: LoopState, input: { tokens: number; costCents: number; costKnown?: boolean; basis?: LoopSpendRow['basis'] }): void {
  // Builder spend already folded by the coordinator and persisted in its round row.
  recordLoopSpend(state, { purpose: 'builder', tokens: input.tokens, costCents: input.costCents, basis: input.basis ?? (input.costKnown ? 'provider-reported' : 'computed'), fold: false }, () => undefined);
}
export function foldFreshEyesSpend(state: LoopState, seq: number, review: FreshEyesReviewerResult, persist: Insert = insert): void {
  if (review.spend !== undefined) {
    for (const call of review.spend) recordLoopSpend(state, { purpose: 'review', detail: 'fresh-eyes', seq, provider: call.provider, model: call.model, tokens: call.tokens, cacheReadTokens: call.cacheReadTokens, cacheWriteTokens: call.cacheWriteTokens, costCents: call.costUsd === null ? 0 : Math.ceil(call.costUsd * 100), basis: call.costSource === 'provider' || call.costSource === 'free' ? 'provider-reported' : call.costSource === 'priced' ? 'computed' : 'unknown' }, persist);
  } else if (review.tokensUsed !== undefined || review.costCents !== undefined) {
    recordLoopSpend(state, { purpose: 'review', detail: 'fresh-eyes', seq, tokens: review.tokensUsed ?? 0, costCents: review.costCents ?? 0, basis: 'legacy-estimate' }, persist);
  }
}

export function foldPingPongSpend(state: LoopState, seq: number, tokens: number, costCents: number, basis?: LoopSpendRow['basis'], exactCostCents?: number, spendRecords?: number, persist: Insert = insert, spendBreakdown?: readonly LoopSpendPortion[]): void {
  const cost = clean(costCents);
  const entry = { purpose: 'review' as const, detail: 'ping-pong', seq };
  const portions = spendBreakdown?.length ? spendBreakdown : reconstructLoopSpend(tokens, cost, basis, exactCostCents, spendRecords);
  state.totalTokens += clean(tokens);
  state.totalCostCents += cost;
  for (const portion of portions) recordLoopSpend(state, { ...entry, ...portion, fold: false }, persist);
}
