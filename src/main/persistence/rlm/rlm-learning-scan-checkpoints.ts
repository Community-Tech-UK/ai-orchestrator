/**
 * RLM Learning Scan Checkpoints Module (WS-B8)
 *
 * CRUD for `learning_scan_checkpoints` — one row per workspace scope
 * ('__global__' when unscoped) holding the durable cursor for the bounded,
 * manual-trigger fail->fix correction scan plus a snapshot of the last run's
 * counters (read by the "scan status" IPC channel). Schema: migration
 * 057_learning_scan_checkpoints.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';

export interface LearningScanCheckpointRow {
  scope_key: string;
  last_scanned_ended_at: number;
  last_scanned_entry_id: string | null;
  last_scan_started_at: number | null;
  last_scan_completed_at: number | null;
  sessions_scanned_last_run: number;
  sessions_scanned_total: number;
  proposals_created_last_run: number;
  proposals_reinforced_last_run: number;
  last_error: string | null;
  updated_at: number;
}

export interface LearningScanCheckpoint {
  scopeKey: string;
  lastScannedEndedAt: number;
  lastScannedEntryId: string | null;
  lastScanStartedAt: number | null;
  lastScanCompletedAt: number | null;
  sessionsScannedLastRun: number;
  sessionsScannedTotal: number;
  proposalsCreatedLastRun: number;
  proposalsReinforcedLastRun: number;
  lastError: string | null;
  updatedAt: number;
}

function toCheckpoint(row: LearningScanCheckpointRow): LearningScanCheckpoint {
  return {
    scopeKey: row.scope_key,
    lastScannedEndedAt: row.last_scanned_ended_at,
    lastScannedEntryId: row.last_scanned_entry_id,
    lastScanStartedAt: row.last_scan_started_at,
    lastScanCompletedAt: row.last_scan_completed_at,
    sessionsScannedLastRun: row.sessions_scanned_last_run,
    sessionsScannedTotal: row.sessions_scanned_total,
    proposalsCreatedLastRun: row.proposals_created_last_run,
    proposalsReinforcedLastRun: row.proposals_reinforced_last_run,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function getLearningScanCheckpoint(db: SqliteDriver, scopeKey: string): LearningScanCheckpoint | null {
  const row = db.prepare('SELECT * FROM learning_scan_checkpoints WHERE scope_key = ?')
    .get<LearningScanCheckpointRow>(scopeKey);
  return row ? toCheckpoint(row) : null;
}

export interface UpsertLearningScanCheckpointParams {
  scopeKey: string;
  lastScannedEndedAt: number;
  lastScannedEntryId: string | null;
  lastScanStartedAt: number;
  lastScanCompletedAt: number;
  sessionsScannedLastRun: number;
  proposalsCreatedLastRun: number;
  proposalsReinforcedLastRun: number;
  lastError: string | null;
}

/**
 * Record the outcome of a completed scan run for a scope. Upsert: the
 * cumulative `sessions_scanned_total` counter adds `sessionsScannedLastRun`
 * on top of any existing value (0 for a first run).
 */
export function upsertLearningScanCheckpoint(db: SqliteDriver, params: UpsertLearningScanCheckpointParams): void {
  db.prepare(`
    INSERT INTO learning_scan_checkpoints (
      scope_key, last_scanned_ended_at, last_scanned_entry_id,
      last_scan_started_at, last_scan_completed_at,
      sessions_scanned_last_run, sessions_scanned_total,
      proposals_created_last_run, proposals_reinforced_last_run,
      last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      last_scanned_ended_at = excluded.last_scanned_ended_at,
      last_scanned_entry_id = excluded.last_scanned_entry_id,
      last_scan_started_at = excluded.last_scan_started_at,
      last_scan_completed_at = excluded.last_scan_completed_at,
      sessions_scanned_last_run = excluded.sessions_scanned_last_run,
      sessions_scanned_total = learning_scan_checkpoints.sessions_scanned_total + excluded.sessions_scanned_last_run,
      proposals_created_last_run = excluded.proposals_created_last_run,
      proposals_reinforced_last_run = excluded.proposals_reinforced_last_run,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(
    params.scopeKey,
    params.lastScannedEndedAt,
    params.lastScannedEntryId,
    params.lastScanStartedAt,
    params.lastScanCompletedAt,
    params.sessionsScannedLastRun,
    params.sessionsScannedLastRun,
    params.proposalsCreatedLastRun,
    params.proposalsReinforcedLastRun,
    params.lastError,
    Date.now(),
  );
}
