export type LoopUsageProvenance = 'provider-reported' | 'computed' | 'legacy-estimate' | 'unknown';
export type LoopSpendPurpose = 'builder' | 'review' | 'verify' | 'context-action' | 'classification' | 'housekeeping';
export interface LoopSpendTotals { tokens: number; costCents: number; knownCents: number; calls: number; estimatedCalls?: number; unknownCalls?: number }
export type LoopSpendByPurpose = Partial<Record<LoopSpendPurpose, LoopSpendTotals>>;
/** One attributed turn, retained even when its allocated cents are zero. */
export interface LoopSpendPortion { tokens: number; costCents: number; basis: LoopUsageProvenance; provider?: string; model?: string }
/** Compatibility reconstruction when a reviewer lacks per-turn attribution. */
export function reconstructLoopSpend(tokens: number, costCents: number, basis?: LoopUsageProvenance, exactCostCents = 0, spendRecords = 0): LoopSpendPortion[] {
  const clean = (value: number) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  const cost = clean(costCents);
  const exact = Math.min(cost, clean(exactCostCents));
  const source = basis ?? (spendRecords ? exact === cost ? 'provider-reported' : 'computed' : cost > 0 ? 'legacy-estimate' : 'unknown');
  if (source === 'unknown' && cost > 0) return [
    ...reconstructLoopSpend(tokens, cost, exact === cost ? 'provider-reported' : 'computed', exact, spendRecords),
    { tokens: 0, costCents: 0, basis: 'unknown' },
  ];
  if (exact > 0 && (exact < cost || source === 'computed' || source === 'legacy-estimate')) return [
    { tokens: clean(tokens), costCents: exact, basis: 'provider-reported' },
    { tokens: 0, costCents: cost - exact, basis: source === 'legacy-estimate' ? source : 'computed' },
  ];
  return [{ tokens: clean(tokens), costCents: cost, basis: source }];
}
export interface LoopSpendRow {
  id: string; loopRunId: string; iterationSeq?: number; purpose: LoopSpendPurpose; detail?: string;
  provider?: string; model?: string; tokens: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  costCents: number; basis: LoopUsageProvenance; createdAt: number;
}
export function spendProvenanceOf(byPurpose?: LoopSpendByPurpose): { label: 'provider-reported' | 'partly-estimated' | 'estimated' | 'unknown' | 'none'; knownCents: number; totalCents: number } {
  const rows = Object.values(byPurpose ?? {});
  const totals = rows.reduce((sum, row) => ({ knownCents: sum.knownCents + row.knownCents, totalCents: sum.totalCents + row.costCents }), { knownCents: 0, totalCents: 0 });
  const unknown = rows.some(row => (row.unknownCalls ?? 0) > 0);
  const estimated = rows.some(row => (row.estimatedCalls ?? 0) > 0 || row.costCents > row.knownCents);
  const known = rows.some(row => row.knownCents > 0 || (row.estimatedCalls !== undefined && row.unknownCalls !== undefined && row.calls > row.unknownCalls + row.estimatedCalls));
  const label = unknown || estimated
    ? known ? 'partly-estimated' : estimated ? 'estimated' : 'unknown'
    : totals.totalCents > 0 ? 'provider-reported' : 'none';
  return { ...totals, label };
}
export interface LoopScorecard {
  costCents: number; tokens: number; knownCents: number; unattributedCents: number; unattributedTokens: number;
  byPurpose: LoopSpendByPurpose; legacyRounds: number; rounds: number; roundsAfterLedgerClosed: number;
  stepLimitedRounds: number; recordedStopRounds: number; stopReasons: Record<string, number>;
  medianPromptBytes: number | null; finishedTasks: number | null; totalTasks: number | null; unknownCalls: number;
}
