/**
 * "Where your usage went" shared contract.
 *
 * Anthropic explains Claude spend as nine named causes. Each cause here is a
 * share of the last 7 days of Claude usage that happened under one condition
 * (for example "the prompt was over 150K tokens"). The shares overlap, so they
 * do not add up to 100%.
 *
 * Pure types only: this file is imported by the main process, the preload
 * bridge and the renderer.
 */

/** Anthropic's nine causes, in the order the card shows them. */
export const USAGE_CAUSE_IDS = [
  'cacheMiss',
  'longContext',
  'helperHeavy',
  'parallelSessions',
  'longRunning',
  'maxEffort',
  'workflows',
  'alwaysOnContext',
  'bigToolResults',
] as const;

export type UsageCauseId = typeof USAGE_CAUSE_IDS[number];

/** One measurable result for a cause. `share` is null when it cannot be measured. */
export interface UsageCauseResult {
  id: UsageCauseId;
  /** Fraction (0..1) of the scope's weighted usage under this cause. */
  share: number | null;
  /** Whole-number percent of `share`, for display only. 9.5% reads as 10 here but is not shown. */
  percent: number | null;
  /** True when the cause is measured and its exact `share` is 10% or more. */
  shown: boolean;
  /** Requests that fall under the cause. */
  requests: number;
  /** Distinct sessions that contributed requests to the cause. */
  sessions: number;
  /** A supporting size in tokens, for causes that have one (typical start size). */
  typicalTokens?: number;
  /** Typical active hours, for the long-running cause. */
  typicalHours?: number;
  /** True when the real share can only be higher (effort was not recorded for all usage). */
  atLeast?: boolean;
  /** Why the cause could not be measured. Present exactly when `share` is null. */
  unavailable?: 'effort-not-recorded';
}

export type UsageInsightScope =
  | { kind: 'all' }
  | { kind: 'session'; instanceId: string };

/** Plain facts about gaps in the evidence. The renderer words them. */
export type UsageInsightNote =
  | { code: 'files-skipped-large'; count: number }
  | { code: 'files-skipped-limit'; count: number }
  | { code: 'requests-trimmed'; count: number }
  | { code: 'lines-skipped'; count: number }
  | { code: 'files-unreadable'; count: number }
  | { code: 'cost-log-unreadable'; count: number }
  | { code: 'session-links-unavailable' }
  | { code: 'prices-approximate'; count: number }
  | { code: 'effort-partly-recorded'; knownPercent: number }
  | { code: 'no-claude-usage' };

export interface UsageInsightReport {
  generatedAt: number;
  windowStart: number;
  windowEnd: number;
  scope: UsageInsightScope;
  totals: {
    requests: number;
    sessions: number;
    /** Sessions that Harness started (linked through the cost log). */
    harnessSessions: number;
  };
  /** Always nine entries, in {@link USAGE_CAUSE_IDS} order. */
  causes: UsageCauseResult[];
  coverage: {
    /** Fraction of weighted usage whose effort setting is known. */
    effortKnown: number;
    /** Fraction of weighted usage from sessions Harness started. */
    harnessLinked: number;
  };
  notes: UsageInsightNote[];
}

export interface UsageScanProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
}

/** Why one session cannot be broken down: not open, not Claude, or running on another computer. */
export type UsageInsightUnsupportedReason = 'unknown-instance' | 'not-claude' | 'remote';

export type UsageInsightResponse =
  | {
    status: 'ready';
    report: UsageInsightReport;
    /** A newer read is in progress; the report shown is the previous one. */
    refreshing: boolean;
    /** The last refresh failed; the report shown is the previous one. */
    refreshError?: string;
  }
  | { status: 'scanning'; progress: UsageScanProgress }
  | { status: 'unsupported'; reason: UsageInsightUnsupportedReason }
  | { status: 'error'; message: string };

export interface UsageInsightRequest {
  /** Limit the report to one session. Omitted means every Claude session. */
  instanceId?: string;
  /** Ask for a fresh read of the transcripts instead of the cached one. */
  refresh?: boolean;
}

/** One deduplicated Claude request, ready for aggregation. */
export interface UsageRequestFact {
  sessionId: string;
  at: number;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Made by a helper agent inside the session. */
  helper: boolean;
  /** A tool result over the size limit was sitting in the prompt. */
  bigResult: boolean;
}

/** What is known about one session outside its individual requests. */
export interface UsageSessionFact {
  sessionId: string;
  /** Prompt size of the session's first request, in tokens. */
  startPromptTokens?: number;
  /** The Harness session this transcript belongs to, when the cost log links it. */
  instanceId?: string;
  /** Top-most Harness session in the helper chain, else the session itself. */
  groupKey: string;
  /** True when Harness started this session as a helper for another one. */
  isHelperSession: boolean;
  /** Effort setting over time, oldest first, for sessions Harness started. */
  efforts: { at: number; effort: string }[];
}
