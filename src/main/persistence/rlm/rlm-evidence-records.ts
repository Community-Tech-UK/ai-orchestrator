/**
 * RLM Evidence Records Module
 *
 * CRUD operations for evidence_records — durable storage for each completion-
 * attempt evidence record keyed by (loop_id, target).
 *
 * Callers use `EvidenceState` to distinguish three authority levels:
 *
 *   'fixed'    — operator-accepted result when no verify command is configured.
 *   'verified' — external verify command exited 0 (strongest mechanical authority).
 *   'reviewed' — cross-model fresh-eyes review cleared the work.
 *
 * These states are kept as distinct values in the `state` column so callers can
 * query each level independently.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';

// ---- Types ----------------------------------------------------------------

/** The three distinct evidence states. */
export type EvidenceState = 'fixed' | 'verified' | 'reviewed';

export interface EvidenceRecordRow {
  id: string;
  loop_id: string;
  target: string;
  kind: string;
  state: EvidenceState;
  timestamp: number;
  source_metadata: string;
  created_at: number;
}

export interface EvidenceRecord {
  id: string;
  loopId: string;
  target: string;
  kind: string;
  state: EvidenceState;
  timestamp: number;
  sourceMetadata: Record<string, unknown>;
  createdAt: number;
}

function toRecord(row: EvidenceRecordRow): EvidenceRecord {
  return {
    id: row.id,
    loopId: row.loop_id,
    target: row.target,
    kind: row.kind,
    state: row.state,
    timestamp: row.timestamp,
    sourceMetadata: (() => {
      try { return JSON.parse(row.source_metadata) as Record<string, unknown>; }
      catch { return {}; }
    })(),
    createdAt: row.created_at,
  };
}

// ---- Write -----------------------------------------------------------------

export interface InsertEvidenceParams {
  id: string;
  loopId: string;
  target: string;
  kind: string;
  state: EvidenceState;
  timestamp: number;
  sourceMetadata?: Record<string, unknown>;
  createdAt: number;
}

/**
 * Insert a new evidence record. Uses INSERT OR REPLACE so that if the same
 * (loopId, target, state) is re-recorded (e.g. after a restart), the row is
 * refreshed rather than duplicated.
 */
export function insertEvidenceRecord(db: SqliteDriver, params: InsertEvidenceParams): void {
  db.prepare(`
    INSERT OR REPLACE INTO evidence_records
      (id, loop_id, target, kind, state, timestamp, source_metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.loopId,
    params.target,
    params.kind,
    params.state,
    params.timestamp,
    JSON.stringify(params.sourceMetadata ?? {}),
    params.createdAt,
  );
}

// ---- Read ------------------------------------------------------------------

/**
 * Return all records for a specific target within a loop, optionally filtered
 * by state.
 */
export function getEvidenceForTarget(
  db: SqliteDriver,
  loopId: string,
  target: string,
  state?: EvidenceState,
): EvidenceRecord[] {
  const rows = state
    ? db.prepare(`
        SELECT * FROM evidence_records
        WHERE loop_id = ? AND target = ? AND state = ?
        ORDER BY timestamp DESC
      `).all<EvidenceRecordRow>(loopId, target, state)
    : db.prepare(`
        SELECT * FROM evidence_records
        WHERE loop_id = ? AND target = ?
        ORDER BY timestamp DESC
      `).all<EvidenceRecordRow>(loopId, target);
  return rows.map(toRecord);
}

/**
 * Return all records for a loop, newest first.
 * Optionally filter to a specific state.
 */
export function listEvidenceForLoop(
  db: SqliteDriver,
  loopId: string,
  state?: EvidenceState,
): EvidenceRecord[] {
  const rows = state
    ? db.prepare(`
        SELECT * FROM evidence_records
        WHERE loop_id = ? AND state = ?
        ORDER BY timestamp DESC
      `).all<EvidenceRecordRow>(loopId, state)
    : db.prepare(`
        SELECT * FROM evidence_records
        WHERE loop_id = ?
        ORDER BY timestamp DESC
      `).all<EvidenceRecordRow>(loopId);
  return rows.map(toRecord);
}

/**
 * Delete all evidence records for a loop (e.g., on loop teardown/reset).
 */
export function deleteEvidenceForLoop(db: SqliteDriver, loopId: string): number {
  const result = db.prepare(
    `DELETE FROM evidence_records WHERE loop_id = ?`,
  ).run(loopId);
  return result.changes;
}
