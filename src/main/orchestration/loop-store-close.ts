import type { SqliteDriver } from '../db/sqlite-driver';
import type { LoopState } from '../../shared/types/loop.types';

/**
 * How long a loop parked on a usage limit, with no resume left scheduled, may
 * sit before startup closes it. Without a scheduled resume only a manual
 * Resume can wake it; two weeks leaves room for that.
 */
export const STALE_PROVIDER_LIMIT_PARK_MS = 14 * 24 * 60 * 60_000;

/** Caller must first establish that the run is absent from the live coordinator. */
export function closeStoredLoopRun(db: SqliteDriver, loopRunId: string): boolean {
  return closeParkedRun(db, loopRunId, 'closed: stranded after app restart');
}

/**
 * Boot only, before worktree reconcile: close every loop parked on a usage
 * limit that has no resume scheduled (`scheduledResumes`, the loop IDs of
 * pending resume automations; a monthly allowance can park a loop for weeks)
 * and no activity for `STALE_PROVIDER_LIMIT_PARK_MS`, exactly as Close does.
 * Reconcile then removes its folder and keeps its branch. Returns the closed
 * run IDs.
 */
export function closeStaleProviderLimitParks(db: SqliteDriver, scheduledResumes: ReadonlySet<string>, now = Date.now()): string[] {
  const parked = db.prepare(`SELECT r.id, COALESCE(
      (SELECT MAX(COALESCE(i.ended_at, i.started_at)) FROM loop_iterations i WHERE i.loop_run_id = r.id), r.started_at
    ) AS last_activity FROM loop_runs r WHERE r.status = 'provider-limit' AND r.ended_at IS NULL`)
    .all<{ id: string; last_activity: number }>();
  return parked
    .filter((run) => !scheduledResumes.has(run.id) && now - run.last_activity > STALE_PROVIDER_LIMIT_PARK_MS)
    .filter((run) => closeParkedRun(db, run.id, 'closed: parked on a usage limit for over two weeks'))
    .map((run) => run.id);
}

function closeParkedRun(db: SqliteDriver, loopRunId: string, reason: string): boolean {
  return db.transaction(() => {
    const run = db.prepare(`SELECT started_at FROM loop_runs WHERE id = ?
      AND status IN ('paused', 'provider-limit') AND ended_at IS NULL`).get<{ started_at: number }>(loopRunId);
    if (!run) return false;
    const last = db.prepare('SELECT ended_at FROM loop_iterations WHERE loop_run_id = ? ORDER BY seq DESC LIMIT 1')
      .get<{ ended_at: number | null }>(loopRunId);
    const endedAt = last?.ended_at ?? run.started_at;
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
