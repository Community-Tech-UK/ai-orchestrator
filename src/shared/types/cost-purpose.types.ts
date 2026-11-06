export interface CostPurposeRow {
  /** Stable raw grouping key. Convert it to a label only at the display boundary. */
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
  /** Legacy resident Claude totals cannot safely be differenced. */
  historicalCostUnknownCalls?: number;
  freeCalls: number;
}

export interface CostPurposeSummary {
  enabled: boolean;
  byPurpose: CostPurposeRow[];
  byProvider: CostPurposeRow[];
  totals: CostPurposeRow;
}

export interface CostPurposeRange { startTime?: number; endTime?: number }
