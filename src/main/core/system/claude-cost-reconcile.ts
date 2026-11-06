/**
 * Compares what Harness booked for each Claude session with Claude Code's own
 * running total for it.
 *
 * Pure apart from the two SQL helpers: the transcript reader is injected, so the
 * maths and the coverage rules are tested without files. The drift is signed
 * (negative = Harness booked less than Claude reports) and is judged on the
 * summed figures; one tiny session cannot raise the flag on its own.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  CLAUDE_COST_DRIFT_THRESHOLD_PCT,
  CLAUDE_COST_REPORT_TOP_SESSIONS,
  type ClaudeCostEra,
  type ClaudeCostReconcileCoverage,
  type ClaudeCostReconcileGroup,
  type ClaudeCostReconcileReport,
  type ClaudeCostReconcileSession,
} from '../../../shared/types/claude-cost-reconcile.types';
import type { ClaudeCostStateRead } from './claude-cost-state-reader';

export interface StoredClaudeSession {
  sessionId: string;
  models: string[];
  rows: number;
  storedUsd: number;
  firstAt: number;
  lastAt: number;
}

export interface ReconcileInput {
  sessions: StoredClaudeSession[];
  /** When per-turn booking went live; sessions with an older row are `repaired`. Null: no older booking exists. */
  bookingLiveAt: number | null;
  now: number;
  windowStart: number;
  thresholdPct?: number;
}

export interface ReconcileDeps {
  readState(sessionId: string): Promise<ClaudeCostStateRead | 'no-transcript'>;
  /** Called after each session so a long run hands the event loop back. */
  yieldTurn?(): Promise<void>;
}

const CLAUDE_MODEL = /^(?:claude-|(?:opus|sonnet|haiku|fable)(?:\[[^\]]*\])?$)/i;

/** Claude CLI rows carry the bare alias (`opus`, `sonnet[1m]`); resellers carry full `claude-…` ids. */
export function isClaudeCostModel(model: string): boolean {
  return CLAUDE_MODEL.test(model.trim());
}

const toGroup = (sessions: ClaudeCostReconcileSession[]): ClaudeCostReconcileGroup => {
  const storedUsd = sessions.reduce((sum, item) => sum + item.storedUsd, 0);
  const cliUsd = sessions.reduce((sum, item) => sum + item.cliUsd, 0);
  const gapUsd = storedUsd - cliUsd;
  return { sessions: sessions.length, storedUsd, cliUsd, gapUsd, driftPct: cliUsd > 0 ? (gapUsd / cliUsd) * 100 : null };
};

const MICRO = 1_000_000;
const micro = (usd: number): number => Math.round(usd * MICRO);

/**
 * Whether the stored total is more than `thresholdPct` away from Claude's total.
 * Judged in whole millionths of a dollar so that summing floats cannot tip an exact
 * 5% over the line; Claude reporting nothing while Harness booked something is drift.
 */
export function exceedsDriftThreshold(storedUsd: number, cliUsd: number, thresholdPct: number): boolean {
  return Math.abs(micro(storedUsd) - micro(cliUsd)) * 100 > thresholdPct * micro(cliUsd);
}

export async function reconcileClaudeCosts(input: ReconcileInput, deps: ReconcileDeps): Promise<ClaudeCostReconcileReport> {
  const thresholdPct = input.thresholdPct ?? CLAUDE_COST_DRIFT_THRESHOLD_PCT;
  const coverage: ClaudeCostReconcileCoverage = {
    candidates: input.sessions.length, notClaude: 0, noTranscript: 0, unsettled: 0, unknownModelCost: 0, compared: 0,
  };
  const compared: ClaudeCostReconcileSession[] = [];
  for (const stored of input.sessions) {
    if (!stored.models.some(isClaudeCostModel)) { coverage.notClaude++; continue; }
    const state = await deps.readState(stored.sessionId);
    if (state === 'no-transcript') coverage.noTranscript++;
    else if (state.kind !== 'settled') coverage.unsettled++;
    else if (state.hasUnknownModelCost) coverage.unknownModelCost++;
    else {
      const gapUsd = stored.storedUsd - state.totalCostUSD;
      compared.push({
        sessionId: stored.sessionId,
        era: input.bookingLiveAt !== null && stored.firstAt < input.bookingLiveAt ? 'repaired' : 'per-turn',
        storedUsd: stored.storedUsd,
        cliUsd: state.totalCostUSD,
        gapUsd,
        gapPct: state.totalCostUSD > 0 ? (gapUsd / state.totalCostUSD) * 100 : null,
        rows: stored.rows,
        lastRowAt: stored.lastAt,
      });
    }
    await deps.yieldTurn?.();
  }
  coverage.compared = compared.length;
  const total = toGroup(compared);
  const era = (name: ClaudeCostEra): ClaudeCostReconcileGroup => toGroup(compared.filter(item => item.era === name));
  return {
    version: 1,
    checkedAt: input.now,
    windowStart: input.windowStart,
    thresholdPct,
    status: compared.length === 0 ? 'insufficient-data' : exceedsDriftThreshold(total.storedUsd, total.cliUsd, thresholdPct) ? 'drift' : 'ok',
    total,
    byEra: { 'per-turn': era('per-turn'), repaired: era('repaired') },
    coverage,
    largestGaps: [...compared].sort((a, b) => Math.abs(b.gapUsd) - Math.abs(a.gapUsd)).slice(0, CLAUDE_COST_REPORT_TOP_SESSIONS),
  };
}

type Reader = Pick<SqliteDriver, 'prepare'>;

/**
 * Every session with a stored row at or after `windowStart`, summed over its whole
 * life (the CLI total is lifetime, so a window sum would never match it).
 */
export function loadStoredClaudeSessions(db: Reader, windowStart: number): StoredClaudeSession[] {
  const rows = db.prepare(
    `SELECT session_id, COUNT(*) AS rows, SUM(cost) AS cost, MIN(timestamp) AS first_at, MAX(timestamp) AS last_at,
            GROUP_CONCAT(DISTINCT model) AS models
       FROM cost_entries
      WHERE session_id != '' AND session_id IN (SELECT DISTINCT session_id FROM cost_entries WHERE timestamp >= ?)
      GROUP BY session_id`,
  ).all<{ session_id: string; rows: number; cost: number; first_at: number; last_at: number; models: string | null }>(windowStart);
  return rows.map(row => ({
    sessionId: row.session_id,
    models: row.models ? row.models.split(',') : [],
    rows: row.rows,
    storedUsd: row.cost ?? 0,
    firstAt: row.first_at,
    lastAt: row.last_at,
  }));
}

/** When per-turn booking went live (set by the schema migration), or null when never recorded. */
export function readBookingLiveAt(db: Reader): number | null {
  const marker = db.prepare('SELECT completed_at FROM maintenance_markers WHERE name = ?')
    .get<{ completed_at: number }>('a0-per-turn-booking-live');
  return marker && Number.isFinite(marker.completed_at) ? marker.completed_at : null;
}
