export declare const COMPARISON_CAVEATS: string[];

export interface TranscriptCostComparison {
  stored: number;
  transcript: number;
  main: number;
  subagent: number;
  gapPct: number | null;
  pricingVersion: string;
  exceeded: boolean;
  largestGaps: Array<{ sessionId: string; stored: number; main: number; subagent: number; gap: number }>;
  storedOnly: string[];
  transcriptOnly: string[];
  unpricedModels: string[];
  byModel: unknown[];
  caveats: string[];
}

export declare function compareTranscriptCosts(options: {
  rows: Array<{ session_id?: string; instance_id?: string; cost?: number }>;
  roots: string[];
  start: number;
  end: number;
  prices?: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }>;
  maxDiffPct?: number;
  byModel?: unknown[];
}): TranscriptCostComparison;
