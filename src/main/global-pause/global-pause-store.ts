import { randomUUID } from 'node:crypto';
import type { GlobalPauseEntry, GlobalPausePhase } from '@contracts/schemas/global-pause';
import type { SqliteDriver } from '../db/sqlite-driver';

export interface PauseBatch {
  id: string;
  phase: Exclude<GlobalPausePhase, 'none'>;
  since: number;
  reason: string | null;
}
type EntrySeed = Pick<GlobalPauseEntry, 'kind' | 'targetId' | 'displayName' | 'wasBusy'>
  & Partial<Pick<GlobalPauseEntry, 'workspace' | 'provider' | 'originalInstanceId' | 'historyThreadId' | 'providerSessionId'>>;
type EntryPatch = Partial<Pick<GlobalPauseEntry, 'state' | 'noteText' | 'noteKind' | 'voidReason' | 'targetId'>>;

const ENTRY_COLUMNS = `id, kind, target_id AS targetId, display_name AS displayName, workspace, provider,
  original_instance_id AS originalInstanceId, history_thread_id AS historyThreadId,
  provider_session_id AS providerSessionId, was_busy AS wasBusy, note_text AS noteText,
  note_kind AS noteKind, state, void_reason AS voidReason, created_at AS createdAt, updated_at AS updatedAt`;

/** One durable pause owns its entries; note copies are erased on every terminal path. */
export class GlobalPauseStore {
  constructor(private readonly db: SqliteDriver) {}

  getOpenBatch(): PauseBatch | null {
    return this.db.prepareCached(`SELECT id, phase, created_at AS since, reason FROM global_pause_batches
      WHERE phase NOT IN ('resumed','discarded','expired') LIMIT 1`).get<PauseBatch>() ?? null;
  }

  createBatch(phase: PauseBatch['phase'], reason: string | null, now = Date.now()): PauseBatch {
    const batch = { id: randomUUID(), phase, reason, since: now };
    this.db.prepareCached('INSERT INTO global_pause_batches(id,phase,reason,created_at) VALUES (?,?,?,?)')
      .run(batch.id, phase, reason, now);
    return batch;
  }

  setPhase(id: string, phase: PauseBatch['phase'], now = Date.now()): void {
    this.db.prepareCached(`UPDATE global_pause_batches SET phase=?, ready_at=CASE WHEN ?='ready' THEN ? ELSE ready_at END WHERE id=?`)
      .run(phase, phase, now, id);
  }

  finishBatch(id: string, phase: 'resumed' | 'discarded' | 'expired', now = Date.now()): void {
    const column = { resumed: 'resumed_at', discarded: 'discarded_at', expired: 'expired_at' }[phase];
    this.db.transaction(() => {
      this.db.prepareCached(`UPDATE global_pause_batches SET phase=?, ${column}=? WHERE id=?`).run(phase, now, id);
      this.db.prepareCached('UPDATE global_pause_entries SET note_text=NULL,updated_at=? WHERE batch_id=?').run(now, id);
    })();
  }

  entries(batchId: string): GlobalPauseEntry[] {
    return this.db.prepareCached(`SELECT ${ENTRY_COLUMNS} FROM global_pause_entries WHERE batch_id=? ORDER BY created_at,id`)
      .all<GlobalPauseEntry>(batchId).map((entry) => ({ ...entry, wasBusy: Boolean(entry.wasBusy) }));
  }

  addEntry(batchId: string, seed: EntrySeed, now = Date.now()): GlobalPauseEntry {
    this.db.prepareCached(`INSERT INTO global_pause_entries
      (id,batch_id,kind,target_id,display_name,workspace,provider,original_instance_id,history_thread_id,provider_session_id,was_busy,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,kind,target_id) DO NOTHING`)
      .run(randomUUID(), batchId, seed.kind, seed.targetId, seed.displayName, seed.workspace ?? null, seed.provider ?? null,
        seed.originalInstanceId ?? null, seed.historyThreadId ?? null, seed.providerSessionId ?? null, seed.wasBusy ? 1 : 0, now, now);
    const entry = this.entries(batchId).find((candidate) => candidate.kind === seed.kind && candidate.targetId === seed.targetId);
    if (!entry) throw new Error('Pause entry could not be saved');
    return entry;
  }

  /** Refresh only work observed in this explicit pause; absent entries retain their notes. */
  refreshSnapshot(batchId: string, seed: EntrySeed, now = Date.now(), preserveReadyIdle = false): GlobalPauseEntry {
    return this.db.transaction(() => {
      const matches = this.entries(batchId).filter((entry) => entry.kind === seed.kind && (entry.targetId === seed.targetId
        || (seed.kind === 'session' && (!entry.provider || !seed.provider || entry.provider === seed.provider)
          && ((seed.historyThreadId && entry.historyThreadId === seed.historyThreadId)
            || (seed.providerSessionId && entry.providerSessionId === seed.providerSessionId)))));
      const entry = matches[0];
      if (!entry) return this.addEntry(batchId, seed, now);
      // Older batches may already contain both runtime aliases. Keep one actionable entry.
      for (const duplicate of matches.slice(1)) this.db.prepareCached('DELETE FROM global_pause_entries WHERE id=?').run(duplicate.id);
      const keepNote = preserveReadyIdle && !seed.wasBusy && entry.state === 'ready';
      this.db.prepareCached(`UPDATE global_pause_entries SET target_id=?,display_name=?,workspace=?,provider=?,
        original_instance_id=?,history_thread_id=?,provider_session_id=?,was_busy=?,state=?,note_text=?,note_kind=?,void_reason=?,updated_at=? WHERE id=?`)
        .run(seed.targetId, seed.displayName, seed.workspace ?? entry.workspace, seed.provider ?? entry.provider,
          entry.originalInstanceId ?? seed.originalInstanceId ?? null, seed.historyThreadId ?? entry.historyThreadId,
          seed.providerSessionId ?? entry.providerSessionId, (keepNote ? entry.wasBusy : seed.wasBusy) ? 1 : 0,
          keepNote ? 'ready' : 'pending', keepNote ? entry.noteText : null, keepNote ? entry.noteKind : 'none',
          keepNote ? entry.voidReason : null, now, entry.id);
      const refreshed = this.entries(batchId).find((candidate) => candidate.id === entry.id);
      if (!refreshed) throw new Error('Pause snapshot could not be refreshed');
      return refreshed;
    })();
  }

  setEntry(id: string, patch: EntryPatch, now = Date.now()): void {
    const columns: Record<keyof EntryPatch, string> = {
      state: 'state', noteText: 'note_text', noteKind: 'note_kind', voidReason: 'void_reason', targetId: 'target_id',
    };
    const keys = Object.keys(patch) as (keyof EntryPatch)[];
    if (keys.length === 0) return;
    this.db.prepareCached(`UPDATE global_pause_entries SET ${keys.map((key) => `${columns[key]}=?`).join(',')},updated_at=? WHERE id=?`)
      .run(...keys.map((key) => patch[key]), now, id);
  }

  voidTarget(targetId: string, reason: string, now = Date.now()): void {
    this.db.prepareCached(`UPDATE global_pause_entries SET state='void',note_text=NULL,void_reason=?,updated_at=?
      WHERE (target_id=? OR original_instance_id=? OR history_thread_id=? OR provider_session_id=?)
      AND state NOT IN ('resumed','void') AND batch_id IN
      (SELECT id FROM global_pause_batches WHERE phase NOT IN ('resumed','discarded','expired'))`)
      .run(reason, now, targetId, targetId, targetId, targetId);
  }

  purgeEndedBefore(cutoff: number): void {
    this.db.prepareCached(`DELETE FROM global_pause_batches WHERE phase IN ('resumed','discarded','expired')
      AND COALESCE(resumed_at,discarded_at,expired_at) < ?`).run(cutoff);
  }
}
