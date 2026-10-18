import type { SqliteDriver } from '../db/sqlite-driver';
import type { LoopState } from '../../shared/types/loop.types';

/** Caller must first establish that the run is absent from the live coordinator. */
export function closeStoredLoopRun(db: SqliteDriver, loopRunId: string): boolean {
  return db.transaction(() => {
    const run = db.prepare(`SELECT started_at FROM loop_runs WHERE id = ?
      AND status IN ('paused', 'provider-limit') AND ended_at IS NULL`).get<{ started_at: number }>(loopRunId);
    if (!run) return false;
    const last = db.prepare('SELECT ended_at FROM loop_iterations WHERE loop_run_id = ? ORDER BY seq DESC LIMIT 1')
      .get<{ ended_at: number | null }>(loopRunId);
    const endedAt = last?.ended_at ?? run.started_at;
    const reason = 'closed: stranded after app restart';
    const checkpoint = db.prepare('SELECT state_json FROM loop_checkpoints WHERE loop_run_id = ?')
      .get<{ state_json: string }>(loopRunId);
    db.prepare("UPDATE loop_runs SET status = 'cancelled', ended_at = ?, end_reason = ? WHERE id = ?")
      .run(endedAt, reason, loopRunId);
    if (checkpoint) {
      const state = JSON.parse(checkpoint.state_json) as LoopState;
      state.status = 'cancelled';
      state.endedAt = endedAt;
      state.endReason = reason;
      db.prepare("UPDATE loop_checkpoints SET status = 'cancelled', state_json = ?, updated_at = ? WHERE loop_run_id = ?")
        .run(JSON.stringify(state), Date.now(), loopRunId);
    }
    return true;
  })();
}
