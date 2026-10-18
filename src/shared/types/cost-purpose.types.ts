import type { ModelCallPurpose } from './cost-attribution.types';
export interface CostPurposeRow {
  key: string;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cost: number;
  estimatedCost: number;
  estimatedShare: number;
  unknownCostCalls: number;
  /** Legacy resident totals without enough identity to reconcile safely. */
  historicalCostUnknownCalls?: number;
  freeCalls: number;
}
export interface CostPurposeSummary {
  enabled: boolean;
  byPurpose: (CostPurposeRow & {key:ModelCallPurpose|'unknown'})[];
  byProvider: CostPurposeRow[];
  totals: CostPurposeRow;
}
export interface CostPurposeRange { startTime?: number; endTime?: number }
