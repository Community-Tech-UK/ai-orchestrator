/**
 * Types for the RTK auto-approve hook trial report script (consumed by its
 * fixture spec; the script itself is plain ESM JavaScript).
 */

export interface TrialMetrics {
  onSessions: number;
  offSessions: number;
  onTurnsPerSession: number;
  offTurnsPerSession: number;
  onCallsPerSession: number;
  offCallsPerSession: number;
  rewrittenTotal: number;
  rewrittenFail: number;
  rewrittenUnresolved?: number;
  otherUnresolved?: number;
  otherTotal: number;
  otherFail: number;
  retryAfterRewrite: number;
  onMedianCharsRewritten: number | null;
  offMedianChars: number | null;
  onCostPerTurn: number | null;
  offCostPerTurn: number | null;
}

export interface CriterionVerdict {
  name: string;
  pass: boolean | null;
  detail: string;
}

export interface BootstrapInterval {
  point: number;
  lo: number;
  hi: number;
}

export declare function bootstrapMeanInterval(
  values: number[],
  opts?: { iterations?: number; seed?: number; confidence?: number },
): BootstrapInterval;

export declare function evaluateG1(
  m: TrialMetrics,
  rules?: { maxDeltaPp: number },
): CriterionVerdict;
export declare function evaluateG2(
  m: TrialMetrics,
  rules?: { maxRatio: number },
): CriterionVerdict;
export declare function evaluateG3(
  m: TrialMetrics,
  rules?: { maxRatio: number },
): CriterionVerdict;
export declare function evaluateG5(
  m: TrialMetrics,
  rules?: { maxRatePct: number },
): CriterionVerdict;
export declare function evaluateBenefit(
  m: TrialMetrics,
  rules?: { minReductionPct: number },
): CriterionVerdict;
export declare function evaluateCost(
  m: TrialMetrics,
  rules?: { maxIncreasePct: number },
): CriterionVerdict;
export declare function evaluateTrial(
  metrics: TrialMetrics,
  rules?: Record<string, unknown>,
): CriterionVerdict[];
export declare function recommendTrial(
  verdicts: CriterionVerdict[],
  state: { sampleReady: boolean; stopReached: boolean },
): 'pending' | 'off' | 'inconclusive' | 'on' | 'sessions-only';

export interface BashCall {
  id?: string;
  command: string;
  at: number | null;
  resultChars: number;
  resultObserved: boolean;
  failed: boolean;
  retryAfterRewrite?: boolean;
}

export declare function readBashCalls(path: string): Promise<{ calls: BashCall[]; unparsableLines: number }>;
export declare function readTrialCostRows(dir: string): Array<{
  sessionId: string;
  arm: 'on' | 'off';
  source: string;
  costUsd: number | null;
  newTokens: number;
}>;
export declare function readHookLines(dir: string): Array<Record<string, unknown>>;
