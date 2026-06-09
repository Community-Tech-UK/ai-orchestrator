import type { SqliteDriver } from '../db/sqlite-driver';
import type { LoopCheckpoint } from './loop-checkpoint';

interface LoopCheckpointRow {
  loop_run_id: string;
  version: number;
  chat_id: string;
  status: string;
  state_json: string;
  history_tail_json: string;
  convergence_note: string | null;
  plan_regeneration_count: number;
  pending_context_reset: number;
  updated_at: number;
}

function rowToLoopCheckpoint(row: LoopCheckpointRow): LoopCheckpoint {
  return {
    version: 1,
    loopRunId: row.loop_run_id,
    chatId: row.chat_id,
    status: row.status as LoopCheckpoint['status'],
    state: JSON.parse(row.state_json) as LoopCheckpoint['state'],
    historyTail: JSON.parse(row.history_tail_json) as LoopCheckpoint['historyTail'],
    convergenceNote: row.convergence_note,
    planRegenerationCount: row.plan_regeneration_count,
    pendingContextReset: row.pending_context_reset === 1,
    updatedAt: row.updated_at,
  };
}

export function upsertLoopCheckpoint(db: SqliteDriver, checkpoint: LoopCheckpoint): void {
  db.prepare(`
    INSERT INTO loop_checkpoints (
      loop_run_id, version, chat_id, status, state_json, history_tail_json,
      convergence_note, plan_regeneration_count, pending_context_reset, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(loop_run_id) DO UPDATE SET
      version = excluded.version,
      chat_id = excluded.chat_id,
      status = excluded.status,
      state_json = excluded.state_json,
      history_tail_json = excluded.history_tail_json,
      convergence_note = excluded.convergence_note,
      plan_regeneration_count = excluded.plan_regeneration_count,
      pending_context_reset = excluded.pending_context_reset,
      updated_at = excluded.updated_at
  `).run(
    checkpoint.loopRunId,
    checkpoint.version,
    checkpoint.chatId,
    checkpoint.status,
    JSON.stringify(checkpoint.state),
    JSON.stringify(checkpoint.historyTail),
    checkpoint.convergenceNote,
    checkpoint.planRegenerationCount,
    checkpoint.pendingContextReset ? 1 : 0,
    checkpoint.updatedAt,
  );
}

export function getLoopCheckpoint(db: SqliteDriver, loopRunId: string): LoopCheckpoint | null {
  const row = db.prepare('SELECT * FROM loop_checkpoints WHERE loop_run_id = ?')
    .get<LoopCheckpointRow>(loopRunId);
  return row ? rowToLoopCheckpoint(row) : null;
}

export function listResumableLoopCheckpoints(db: SqliteDriver, limit = 50): LoopCheckpoint[] {
  const rows = db.prepare(`
    SELECT c.*
    FROM loop_checkpoints c
    JOIN loop_runs r ON r.id = c.loop_run_id
    WHERE r.status IN ('paused', 'provider-limit')
    ORDER BY c.updated_at DESC
    LIMIT ?
  `).all<LoopCheckpointRow>(Math.max(1, Math.min(limit, 200)));
  return rows.map(rowToLoopCheckpoint);
}
