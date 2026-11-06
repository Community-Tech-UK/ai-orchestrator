/** Types for scripts/context-ceiling-replay.mjs (consumed by its specs). */
import type { ParsedTranscript, ResumeRestart, TranscriptRequest } from './lib/claude-transcripts.mjs';

export declare const CEILINGS: Array<number | null>;
export declare const SUMMARY_MARGIN: number;
export declare const DEFAULT_SUMMARY_FLOOR: number;
export declare const DEFAULT_SUMMARY_OUTPUT: number;
export declare const DECISION_RULE: {
  savingShareOf200k: number;
  maxP90OwnChat: number;
  maxP90Harness: number;
};

export interface CeilingRow {
  realUsd: number;
  simulatedUsd: number;
  savingUsd: number;
  sessions: number;
  summarisingShare: number;
  summariesP50: number | null;
  summariesP90: number | null;
}

export interface ReplayRow extends CeilingRow {
  /** Actual positive per-session summary counts, retained for combined quantiles. */
  summariesPerSession: number[];
}

export declare function replay(
  sessions: Array<{ className: string; requests: TranscriptRequest[] }>,
  floorTokens: number,
  summaryOutputTokens: number,
  priceOverrides?: Record<string, { inputPerMTok: number; outputPerMTok: number }> | null,
): Record<string, Record<string, ReplayRow>>;

export declare function simulateSession(
  requests: TranscriptRequest[],
  ceiling: number | null,
  floorTokens: number,
  summaryOutputTokens: number,
  priceOverrides?: Record<string, { inputPerMTok: number; outputPerMTok: number }> | null,
): { simulatedUsd: number; summaries: number };

export declare function realSessionUsd(
  requests: TranscriptRequest[],
  priceOverrides?: Record<string, { inputPerMTok: number; outputPerMTok: number }> | null,
): number;

export declare function pickCeiling(
  rows: Record<string, CeilingRow>,
  maxP90: number,
): { ceiling: number | null; reason: string };

export declare function classifySession(
  session: { kind: string; sessionId: string; isHarness: boolean },
  lookup: { purposeOf(sessionId: string): string | null },
): string;

export declare function combineRows(
  rowsByClass: Record<string, Record<string, ReplayRow>>,
  classNames: string[],
): Record<string, ReplayRow>;

export interface ResumeCacheSummary {
  restarts: number;
  returns: number;
  kept: number;
  keptShare: number | null;
  unknown: number;
  unknownReasons: Record<string, number>;
  keptShareLowerBound: number | null;
  excludedNoEdits: number;
  excludedCold: number;
}

export declare function summariseResumeCache(restarts: ResumeRestart[]): ResumeCacheSummary;

export declare function runReplay(argv?: string[]): Promise<Record<string, unknown>>;
