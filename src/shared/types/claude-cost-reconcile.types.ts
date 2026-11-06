/**
 * Daily check of Harness's booked Claude spend against Claude's own figure.
 *
 * Claude Code writes a `cost-state` record into each session transcript when a
 * process ends. Its `totalCostUSD` is the CLI's own running total for the whole
 * session, so it is the independent number Harness's cost store is compared with.
 */

/** Drift above this share of Claude's own total is flagged on the Costs page. */
export const CLAUDE_COST_DRIFT_THRESHOLD_PCT = 5;

/**
 * `per-turn`: every stored row for the session was booked after per-turn booking
 * went live. `repaired`: the session also has older rows, which were
 * reconstructed from cumulative totals and are expected to be less exact.
 */
export type ClaudeCostEra = 'per-turn' | 'repaired';

export type ClaudeCostReconcileStatus = 'ok' | 'drift' | 'insufficient-data';

export interface ClaudeCostReconcileGroup {
  sessions: number;
  storedUsd: number;
  cliUsd: number;
  /** `storedUsd - cliUsd`; negative means Harness booked less than Claude reports. */
  gapUsd: number;
  /** Signed gap as a percentage of `cliUsd`; null when Claude reports nothing. */
  driftPct: number | null;
}

export interface ClaudeCostReconcileSession {
  sessionId: string;
  era: ClaudeCostEra;
  storedUsd: number;
  cliUsd: number;
  gapUsd: number;
  gapPct: number | null;
  rows: number;
  lastRowAt: number;
}

export interface ClaudeCostReconcileCoverage {
  /** Sessions with at least one stored row in the window. */
  candidates: number;
  /** Not a Claude model, so not part of this check. */
  notClaude: number;
  /** Claude sessions with no transcript on this machine (removed or on another machine). */
  noTranscript: number;
  /** Process still running or killed mid-turn: the CLI total is not final yet. */
  unsettled: number;
  /** The CLI could not price a model, so its own total is incomplete. */
  unknownModelCost: number;
  compared: number;
}

export interface ClaudeCostReconcileReport {
  version: 1;
  checkedAt: number;
  /** Sessions with a stored row at or after this time were examined. */
  windowStart: number;
  thresholdPct: number;
  status: ClaudeCostReconcileStatus;
  total: ClaudeCostReconcileGroup;
  byEra: Record<ClaudeCostEra, ClaudeCostReconcileGroup>;
  coverage: ClaudeCostReconcileCoverage;
  /** Largest absolute gaps first, at most {@link CLAUDE_COST_REPORT_TOP_SESSIONS}. */
  largestGaps: ClaudeCostReconcileSession[];
}

export const CLAUDE_COST_REPORT_TOP_SESSIONS = 5;

/** What the renderer receives: the latest report plus the last failure, if any. */
export interface ClaudeCostReconcileSnapshot {
  latest: ClaudeCostReconcileReport | null;
  /** Newest first, summary fields only. */
  history: Pick<ClaudeCostReconcileReport, 'checkedAt' | 'status' | 'total'>[];
  running: boolean;
  lastError: string | null;
}
