/**
 * SessionAdmissionStore — SQLite-backed audit trail for prompt admission
 * decisions (Phase A), extended in Phase B (WS-A1) to be the durable
 * ownership authority for the renderer's not-yet-sent send-while-busy queue.
 *
 * Schema/migration pattern copied from `../orchestration/durable-approval-store.ts`
 * (inline `CREATE TABLE IF NOT EXISTS`, no separate migrations file — single
 * writer SQLite). Shares the RLM database file, same as `DurableApprovalStore`
 * and `EvidenceStore`. New columns added in Phase B are applied via a guarded
 * `ALTER TABLE ... ADD COLUMN` (checked against `PRAGMA table_info`) so the
 * migration stays idempotent against rows created by Phase A.
 *
 * Two families of rows live in the same table:
 *  - Phase A audit rows (`recorded`/`suppressed`/`delivered`/`failed`/
 *    `cancelled`/`expired`, origins `channel`/`automation`/.../`user`) remain
 *    audit/observability only — attachments are lightweight refs, never full
 *    payloads, and losing this data must never block a real send decision.
 *  - Phase B queue rows (`queued`/`promoting`, origin `user`) ARE the durable
 *    payload: `message`/`context_block` are the full text and
 *    `attachment_files_json` holds content-store refs sufficient to
 *    reconstruct the send after a renderer crash (see
 *    `session-queue-attachments.ts`). `queue_position` orders a given
 *    instance's queued rows.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import type { QueuedAttachmentFileRef } from './session-queue-attachments';

const logger = getLogger('SessionAdmissionStore');

export type AdmissionState =
  | 'recorded'
  | 'suppressed'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'queued'
  | 'promoting';

const TERMINAL_STATES: readonly AdmissionState[] = ['delivered', 'failed', 'cancelled', 'expired'];

/** Terminal-state rows older than this are purged outright on sweep. */
export const ADMISSION_RETENTION_DAYS = 14;
/**
 * Per-instance cap on rows sitting in `suppressed` state, and separately on
 * rows sitting in `queued` state. Beyond this, the oldest excess rows are
 * marked `expired` on sweep — mirrors `MAX_QUEUED_PER_INSTANCE` in
 * `mobile-input-queue.ts`.
 */
export const MAX_PENDING_ADMISSIONS_PER_INSTANCE = 50;

/**
 * A `promoting` row whose promotion was never followed by an actual send
 * (e.g. the renderer crashed between the promote call and `sendInput`) is
 * demoted back to `queued` on the next startup sweep so the message is not
 * silently lost. Real promotions resolve within milliseconds, so this stays
 * generous without risking reclaiming a genuinely in-flight send.
 */
export const STALE_PROMOTION_RECLAIM_MS = 5 * 60 * 1000;

export interface AdmissionRecord {
  admissionId: string;
  instanceId: string;
  origin: string;
  message: string;
  attachmentRefs: string[];
  contextBlock: string | null;
  sourceMetadata: Record<string, unknown> | null;
  state: AdmissionState;
  suppressReason: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  errorText: string | null;
  queuePosition: number | null;
  attachmentFiles: QueuedAttachmentFileRef[];
}

export interface CreateAdmissionInput {
  admissionId: string;
  instanceId: string;
  origin: string;
  message: string;
  attachmentRefs?: string[];
  contextBlock?: string | null;
  sourceMetadata?: Record<string, unknown> | null;
  state: AdmissionState;
  suppressReason?: string | null;
}

export interface CreateQueuedInput {
  admissionId: string;
  instanceId: string;
  message: string;
  attachmentRefs?: string[];
  attachmentFiles?: QueuedAttachmentFileRef[];
  contextBlock?: string | null;
  sourceMetadata?: Record<string, unknown> | null;
}

export interface UpdateQueuedContentInput {
  message?: string;
  contextBlock?: string | null;
  attachmentRefs?: string[];
  attachmentFiles?: QueuedAttachmentFileRef[];
}

export interface UpdateAdmissionStateExtra {
  suppressReason?: string | null;
  errorText?: string | null;
}

export interface ListAdmissionsFilter {
  instanceId?: string;
  states?: AdmissionState[];
  limit?: number;
}

interface AdmissionRow {
  admission_id: string;
  instance_id: string;
  origin: string;
  message: string;
  attachment_refs_json: string;
  context_block: string | null;
  source_metadata_json: string | null;
  state: string;
  suppress_reason: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
  error_text: string | null;
  queue_position: number | null;
  attachment_files_json: string | null;
}

function toRecord(row: AdmissionRow): AdmissionRecord {
  let attachmentRefs: string[] = [];
  try {
    const parsed = JSON.parse(row.attachment_refs_json);
    if (Array.isArray(parsed)) attachmentRefs = parsed;
  } catch {
    // Corrupt JSON must never break a read; default to empty refs.
  }
  let sourceMetadata: Record<string, unknown> | null = null;
  if (row.source_metadata_json) {
    try {
      sourceMetadata = JSON.parse(row.source_metadata_json);
    } catch {
      sourceMetadata = null;
    }
  }
  let attachmentFiles: QueuedAttachmentFileRef[] = [];
  if (row.attachment_files_json) {
    try {
      const parsed = JSON.parse(row.attachment_files_json);
      if (Array.isArray(parsed)) attachmentFiles = parsed;
    } catch {
      // Corrupt JSON must never break a read; default to no staged attachments.
    }
  }
  return {
    admissionId: row.admission_id,
    instanceId: row.instance_id,
    origin: row.origin,
    message: row.message,
    attachmentRefs,
    contextBlock: row.context_block,
    sourceMetadata,
    state: row.state as AdmissionState,
    suppressReason: row.suppress_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    errorText: row.error_text,
    queuePosition: row.queue_position,
    attachmentFiles,
  };
}

export class SessionAdmissionStore {
  private static instance: SessionAdmissionStore | null = null;

  constructor(private readonly db: SqliteDriver) {
    this.ensureSchema();
  }

  static getInstance(db: SqliteDriver): SessionAdmissionStore {
    if (!SessionAdmissionStore.instance) {
      SessionAdmissionStore.instance = new SessionAdmissionStore(db);
    }
    return SessionAdmissionStore.instance;
  }

  /** Reset the singleton for test isolation. */
  static _resetForTesting(): void {
    SessionAdmissionStore.instance = null;
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_admissions (
        admission_id          TEXT PRIMARY KEY,
        instance_id           TEXT NOT NULL,
        origin                TEXT NOT NULL,
        message                TEXT NOT NULL,
        attachment_refs_json  TEXT NOT NULL DEFAULT '[]',
        context_block         TEXT,
        source_metadata_json  TEXT,
        state                 TEXT NOT NULL,
        suppress_reason       TEXT,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        delivered_at          INTEGER,
        error_text            TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_admissions_instance_state
        ON prompt_admissions(instance_id, state);
    `);
    // Phase B (WS-A1): durable send-queue columns, added via a guarded ALTER
    // so rows created by Phase A's inline CREATE TABLE upgrade in place.
    this.ensureColumn('queue_position', 'queue_position INTEGER');
    this.ensureColumn('attachment_files_json', 'attachment_files_json TEXT');
  }

  private ensureColumn(name: string, columnDdl: string): void {
    const columns = this.db.prepare('PRAGMA table_info(prompt_admissions)').all<{ name: string }>();
    if (columns.some((c) => c.name === name)) return;
    this.db.exec(`ALTER TABLE prompt_admissions ADD COLUMN ${columnDdl}`);
  }

  create(input: CreateAdmissionInput): AdmissionRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO prompt_admissions
           (admission_id, instance_id, origin, message, attachment_refs_json, context_block, source_metadata_json, state, suppress_reason, created_at, updated_at, delivered_at, error_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        input.admissionId,
        input.instanceId,
        input.origin,
        input.message,
        JSON.stringify(input.attachmentRefs ?? []),
        input.contextBlock ?? null,
        input.sourceMetadata ? JSON.stringify(input.sourceMetadata) : null,
        input.state,
        input.suppressReason ?? null,
        now,
        now,
      );
    return this.get(input.admissionId)!;
  }

  // ---- Phase B: durable send-queue rows -----------------------------------

  private nextQueuePosition(instanceId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(queue_position), -1) as maxPos FROM prompt_admissions
         WHERE instance_id = ? AND state IN ('queued', 'promoting')`,
      )
      .get<{ maxPos: number }>(instanceId);
    return (row?.maxPos ?? -1) + 1;
  }

  /** Insert a new `queued` row — the durable payload for a not-yet-sent user message. */
  createQueued(input: CreateQueuedInput): AdmissionRecord {
    const now = Date.now();
    const queuePosition = this.nextQueuePosition(input.instanceId);
    this.db
      .prepare(
        `INSERT INTO prompt_admissions
           (admission_id, instance_id, origin, message, attachment_refs_json, context_block, source_metadata_json, state, suppress_reason, created_at, updated_at, delivered_at, error_text, queue_position, attachment_files_json)
         VALUES (?, ?, 'user', ?, ?, ?, ?, 'queued', NULL, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        input.admissionId,
        input.instanceId,
        input.message,
        JSON.stringify(input.attachmentRefs ?? []),
        input.contextBlock ?? null,
        input.sourceMetadata ? JSON.stringify(input.sourceMetadata) : null,
        now,
        now,
        queuePosition,
        JSON.stringify(input.attachmentFiles ?? []),
      );
    return this.get(input.admissionId)!;
  }

  /**
   * Edit a queued row's content in place. Guarded to only apply while the row
   * is still `queued` (CAS via the WHERE clause) — a row already handed off
   * to `promoting`/terminal must not be silently rewritten out from under an
   * in-flight send.
   */
  updateQueuedContent(admissionId: string, patch: UpdateQueuedContentInput): AdmissionRecord | undefined {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE prompt_admissions
         SET message = COALESCE(?, message),
             context_block = CASE WHEN ? THEN ? ELSE context_block END,
             attachment_refs_json = COALESCE(?, attachment_refs_json),
             attachment_files_json = COALESCE(?, attachment_files_json),
             updated_at = ?
         WHERE admission_id = ? AND state = 'queued'`,
      )
      .run(
        patch.message ?? null,
        patch.contextBlock !== undefined ? 1 : 0,
        patch.contextBlock ?? null,
        patch.attachmentRefs ? JSON.stringify(patch.attachmentRefs) : null,
        patch.attachmentFiles ? JSON.stringify(patch.attachmentFiles) : null,
        now,
        admissionId,
      );
    if (result.changes === 0) return undefined;
    return this.get(admissionId);
  }

  /** Cancel a queued or in-flight-promoting row. CAS: no-op once terminal/recorded. */
  cancelQueued(admissionId: string): AdmissionRecord | undefined {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE prompt_admissions
         SET state = 'cancelled', updated_at = ?
         WHERE admission_id = ? AND state IN ('queued', 'promoting')`,
      )
      .run(now, admissionId);
    if (result.changes === 0) return undefined;
    return this.get(admissionId);
  }

  /**
   * Compare-and-swap `queued` -> `promoting`. Returns `undefined` when the row
   * is missing or already left the `queued` state — this is what makes
   * promotion idempotent: a duplicate promote request for the same
   * admissionId is a safe no-op instead of a second handoff.
   */
  promoteQueued(admissionId: string): AdmissionRecord | undefined {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE prompt_admissions
         SET state = 'promoting', updated_at = ?
         WHERE admission_id = ? AND state = 'queued'`,
      )
      .run(now, admissionId);
    if (result.changes === 0) return undefined;
    return this.get(admissionId);
  }

  /** Queued + in-flight rows for an instance, in send order. */
  listQueued(instanceId?: string): AdmissionRecord[] {
    const where = instanceId ? 'WHERE instance_id = ? AND state IN (\'queued\', \'promoting\')' : 'WHERE state IN (\'queued\', \'promoting\')';
    const rows = instanceId
      ? this.db.prepare(`SELECT * FROM prompt_admissions ${where} ORDER BY instance_id ASC, queue_position ASC, created_at ASC`).all<AdmissionRow>(instanceId)
      : this.db.prepare(`SELECT * FROM prompt_admissions ${where} ORDER BY instance_id ASC, queue_position ASC, created_at ASC`).all<AdmissionRow>();
    return rows.map(toRecord);
  }

  /** Reassign `queue_position` for an instance's queued rows to match `orderedIds`. Ids not currently `queued` are ignored. */
  reorderQueued(instanceId: string, orderedIds: string[]): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      `UPDATE prompt_admissions SET queue_position = ?, updated_at = ? WHERE admission_id = ? AND instance_id = ? AND state = 'queued'`,
    );
    orderedIds.forEach((admissionId, index) => {
      stmt.run(index, now, admissionId, instanceId);
    });
  }

  /**
   * Dedupe hook for `SessionAdmissionService.recordUserSend()`: find a
   * `promoting` row for this instance+message created recently enough to be
   * the one the renderer just handed off, so the caller can update it in
   * place instead of inserting a second row for the same send.
   */
  findRecentPromoting(instanceId: string, message: string, windowMs: number, now = Date.now()): AdmissionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM prompt_admissions
         WHERE instance_id = ? AND state = 'promoting' AND message = ? AND updated_at >= ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get<AdmissionRow>(instanceId, message, now - windowMs);
    return row ? toRecord(row) : undefined;
  }

  updateState(
    admissionId: string,
    state: AdmissionState,
    extra?: UpdateAdmissionStateExtra,
  ): AdmissionRecord | undefined {
    const now = Date.now();
    const deliveredAt = state === 'delivered' ? now : null;
    const result = this.db
      .prepare(
        `UPDATE prompt_admissions
         SET state = ?,
             updated_at = ?,
             suppress_reason = COALESCE(?, suppress_reason),
             error_text = COALESCE(?, error_text),
             delivered_at = COALESCE(?, delivered_at)
         WHERE admission_id = ?`,
      )
      .run(state, now, extra?.suppressReason ?? null, extra?.errorText ?? null, deliveredAt, admissionId);
    if (result.changes === 0) return undefined;
    return this.get(admissionId);
  }

  get(admissionId: string): AdmissionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM prompt_admissions WHERE admission_id = ?')
      .get<AdmissionRow>(admissionId);
    return row ? toRecord(row) : undefined;
  }

  list(filter: ListAdmissionsFilter = {}): AdmissionRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.instanceId) {
      clauses.push('instance_id = ?');
      params.push(filter.instanceId);
    }
    if (filter.states && filter.states.length > 0) {
      clauses.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    const rows = this.db
      .prepare(`SELECT * FROM prompt_admissions ${where} ORDER BY created_at DESC LIMIT ?`)
      .all<AdmissionRow>(...params, limit);
    return rows.map(toRecord);
  }

  /**
   * Bounded retention pass:
   *  - Purge terminal-state rows ({@link TERMINAL_STATES}) older than
   *    {@link ADMISSION_RETENTION_DAYS}.
   *  - Cap per-instance `suppressed` rows, and separately `queued` rows, at
   *    {@link MAX_PENDING_ADMISSIONS_PER_INSTANCE}; the oldest excess rows are
   *    marked `expired`/`cancelled` respectively (picked up by the purge pass
   *    on a later sweep).
   *  - Demote `promoting` rows older than {@link STALE_PROMOTION_RECLAIM_MS}
   *    back to `queued` — a promotion that was never followed by a real send
   *    (e.g. renderer crash between promote and `sendInput`) must not lose
   *    the message.
   *
   * Deliberately implemented without SQL window functions — the sql.js/WASM
   * test driver's SQLite build is not guaranteed to support them — so the cap
   * pass does a small per-instance scan instead. Suppressed-automated-write
   * and queued-message volume is expected to be low, so this stays cheap.
   */
  sweepExpired(now: number = Date.now()): { purged: number; capped: number; reclaimed: number } {
    const cutoff = now - ADMISSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const purge = this.db
      .prepare(
        `DELETE FROM prompt_admissions
         WHERE state IN (${TERMINAL_STATES.map(() => '?').join(', ')}) AND updated_at < ?`,
      )
      .run(...TERMINAL_STATES, cutoff);

    const capped = this.capPerInstance('suppressed', 'expired') + this.capPerInstance('queued', 'cancelled');

    const reclaimResult = this.db
      .prepare(`UPDATE prompt_admissions SET state = 'queued', updated_at = ? WHERE state = 'promoting' AND updated_at < ?`)
      .run(now, now - STALE_PROMOTION_RECLAIM_MS);
    const reclaimed = reclaimResult.changes;

    if (purge.changes > 0 || capped > 0 || reclaimed > 0) {
      logger.info('Swept prompt admissions', { purged: purge.changes, capped, reclaimed });
    }
    return { purged: purge.changes, capped, reclaimed };
  }

  private capPerInstance(state: AdmissionState, expireTo: AdmissionState): number {
    let capped = 0;
    const overCap = this.db
      .prepare(
        `SELECT instance_id, COUNT(*) as cnt FROM prompt_admissions
         WHERE state = ?
         GROUP BY instance_id
         HAVING cnt > ?`,
      )
      .all<{ instance_id: string; cnt: number }>(state, MAX_PENDING_ADMISSIONS_PER_INSTANCE);

    for (const row of overCap) {
      const excess = row.cnt - MAX_PENDING_ADMISSIONS_PER_INSTANCE;
      const oldest = this.db
        .prepare(
          `SELECT admission_id FROM prompt_admissions
           WHERE instance_id = ? AND state = ?
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all<{ admission_id: string }>(row.instance_id, state, excess);
      for (const stale of oldest) {
        this.updateState(stale.admission_id, expireTo);
        capped += 1;
      }
    }
    return capped;
  }
}
