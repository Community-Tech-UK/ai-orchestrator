import type { SessionKind } from './session-kind.types';
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
  /** Helper-agent spend already inside the parent turn's cost (from `includedInParentTurn` rows). */
  helperCost?: number;
}
/** One of the largest single turns this week, by tokens processed (Oct-2 Phase D Step 1). */
export interface CostBiggestTurn {
  /** When the turn was recorded (the latest receipt for a Codex round). */
  at: number;
  /** The Harness session that ran it, when known. */
  instanceId?: string;
  kind: SessionKind | 'unknown';
  provider: string;
  model?: string;
  /** Input (cached input included) plus output, helper threads included. */
  processedTokens: number;
  /** Codex rounds only: what the helper threads spent of the total. */
  helperTokens?: number;
  helperShare?: number;
  /** Codex rounds only: Harness stopped the round at its ceiling. */
  stopRequested?: boolean;
  source: 'codex-round' | 'turn-cost';
}
/** Codex's own credit estimates for the threads that ended this week (Step 11.1). */
export interface CostCodexCreditsSummary {
  threads: number;
  credits: number;
  /** Only the threads Codex could put a dollar figure on; null when none could. */
  estimatedUsd: number | null;
  byKind: { kind: SessionKind; threads: number; credits: number }[];
}
export interface CostPurposeSummary {
  enabled: boolean;
  /** The ten biggest turns of the last seven days inside the range. */
  biggestTurns?: CostBiggestTurn[];
  codexCredits?: CostCodexCreditsSummary;
  byPurpose: CostPurposeRow[];
  byProvider: CostPurposeRow[];
  totals: CostPurposeRow;
  /** Total helper-agent spend already inside parent turns (from `includedInParentTurn` rows). */
  totalHelperCost?: number;
}

export interface CostPurposeRange { startTime?: number; endTime?: number }
