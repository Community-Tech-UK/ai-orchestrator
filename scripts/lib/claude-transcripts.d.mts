/** Types for scripts/lib/claude-transcripts.mjs (consumed by its specs). */

export declare const RETURN_GAP_MS: number;
export declare const COLD_GAP_MS: number;
export declare const RESUME_KEPT_SHARE: number;
export declare const CACHE_READ_MULT: number;
export declare const CACHE_WRITE_5M_MULT: number;
export declare const CACHE_WRITE_1H_MULT: number;

export interface TranscriptRequest {
  at: number | null;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  model: string | null;
  context: number;
}

export interface TranscriptRestart {
  at: number | null;
  gapMs: number | null;
  /** true / false, or null when the transcript cannot say whether the ended process edited. */
  edited: boolean | null;
  priorContext: number;
  firstCacheRead: number;
  compactedInGap: boolean;
}

export interface ResumeRestart {
  at: number | null;
  gapMs: number | null;
  category: 'edited' | 'no-edits' | 'cold' | 'unknown';
  unknownReason: 'gap' | 'edits' | 'context' | 'compaction' | null;
  keptCacheShare: number | null;
  kept: boolean | null;
}

export interface ParsedTranscript {
  requests: TranscriptRequest[];
  restarts?: TranscriptRestart[];
  compactions: { at: number | null; preTokens: number | null; postTokens: number | null }[];
  entrypoint: string | null;
  isHarness: boolean;
}

export declare const CLAUDE_PRICES: Record<'opus' | 'sonnet' | 'haiku' | 'fable', { input: number; output: number }>;

export declare function rateForModel(
  model: string | null | undefined,
): { input: number; output: number } | undefined;

export declare function priceFor(
  model: string | null,
  overrides?: Record<string, { inputPerMTok: number; outputPerMTok: number }> | null,
): { inputPerMTok: number; outputPerMTok: number; known: boolean };

export declare function median(values: number[]): number | null;
export declare function p90(values: number[]): number | null;
export declare function mean(values: number[]): number | null;

export declare function listTranscripts(projectsDir: string): Array<{ path: string; kind: 'main' | 'subagent'; sessionId: string }>;
export declare function parseTranscript(path: string): Promise<ParsedTranscript & { unknownUsageRecords: number }>;
export declare function measuredSummaryFloors(parsed: ParsedTranscript): number[];
export interface ActivityReturn {
  at: number;
  gapMs: number;
  cold: boolean;
  keptCacheShare: number;
  /** Whole cache write; the 5-minute/1-hour split is kept beside it for pricing. */
  rewrittenTokens: number;
  rewrittenTokens5m: number;
  rewrittenTokens1h: number;
}

export declare function activityReturns(parsed: ParsedTranscript): ActivityReturn[];
export declare function resumeRestarts(parsed: { restarts?: TranscriptRestart[] }): ResumeRestart[];
export declare function isGitCommitCommand(command: string): boolean;
export declare function defaultProjectsDir(): string;
export declare function transcriptProjectsDirs(userData: string, explicit?: string | null): string[];
export declare function isRecent(path: string, sinceMs: number): boolean;

export interface SubagentMeta {
  agentType: string;
  description: string;
  toolUseId: string;
  spawnDepth: number;
  requestShape: string;
  requestNonInteractive: boolean;
}

export declare function readSubagentMeta(path: string): SubagentMeta | null;
export declare function parseTaskToolOutcomes(path: string): Map<string, {
  isError: boolean; parentTurnId?: string | null; startedAt?: number | null; returnedAt?: number | null;
}>;
export declare function modelFamily(model: string | null | undefined): 'opus' | 'sonnet' | 'haiku' | 'other';
