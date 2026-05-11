/**
 * DurableApprovalStore — SQLite-backed persistence for permission approvals.
 *
 * The in-memory PermissionRegistry loses all pending approvals on crash/restart.
 * This store persists them to SQLite so they survive, enabling:
 *   - Cross-window approval (approve from a second Electron window)
 *   - Post-restart resumption ("you approved this 2m ago, still valid?")
 *   - Audit trail ("who approved this shell command at 2am?")
 *
 * Inspired by nanoclaw:src/modules/approvals/onecli-approvals.ts (claude2.md §6.1).
 *
 * Schema (inlined — no separate migrations file needed for single-writer SQLite):
 *
 *   pending_approvals(
 *     approval_id TEXT PK,
 *     instance_id TEXT NOT NULL,
 *     action_kind TEXT NOT NULL,   -- 'shell' | 'write' | 'mcp' | 'tool' | ...
 *     payload_json TEXT NOT NULL,
 *     expires_at INTEGER NOT NULL,
 *     status TEXT NOT NULL,        -- 'pending' | 'approved' | 'denied' | 'expired'
 *     created_at INTEGER NOT NULL,
 *     resolved_at INTEGER,
 *     resolved_by TEXT            -- 'user' | 'timeout' | 'parent_deny' | ...
 *   )
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';

const logger = getLogger('DurableApprovalStore');

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type ApprovalActionKind = 'shell' | 'write' | 'mcp' | 'tool' | string;
export type ApprovalResolvedBy = 'user' | 'timeout' | 'parent_deny' | 'auto' | string;

export interface ApprovalRecord {
  approvalId: string;
  instanceId: string;
  actionKind: ApprovalActionKind;
  payload: unknown;
  expiresAt: number;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: ApprovalResolvedBy;
}

interface ApprovalRow {
  approval_id: string;
  instance_id: string;
  action_kind: string;
  payload_json: string;
  expires_at: number;
  status: string;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    instanceId: row.instance_id,
    actionKind: row.action_kind,
    payload: JSON.parse(row.payload_json),
    expiresAt: row.expires_at,
    status: row.status as ApprovalStatus,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: (row.resolved_by ?? undefined) as ApprovalResolvedBy | undefined,
  };
}

export class DurableApprovalStore {
  constructor(private readonly db: SqliteDriver) {
    this.ensureSchema();
    this.sweepExpired();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        approval_id  TEXT PRIMARY KEY,
        instance_id  TEXT NOT NULL,
        action_kind  TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at   INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   INTEGER NOT NULL,
        resolved_at  INTEGER,
        resolved_by  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pending_approvals_instance
        ON pending_approvals(instance_id);

      CREATE INDEX IF NOT EXISTS idx_pending_approvals_status
        ON pending_approvals(status, expires_at);

      CREATE TABLE IF NOT EXISTS approval_audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id TEXT NOT NULL,
        event       TEXT NOT NULL,
        detail_json TEXT,
        at          INTEGER NOT NULL
      );
    `);
  }

  /** Sweep approvals that have passed their expiry deadline on startup. */
  sweepExpired(): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE pending_approvals
         SET status = 'expired', resolved_at = ?
         WHERE status = 'pending' AND expires_at < ?`,
      )
      .run(now, now);
    if (result.changes > 0) {
      logger.info('Swept expired approvals on startup', { count: result.changes });
    }
    return result.changes;
  }

  create(record: Omit<ApprovalRecord, 'status' | 'createdAt'>): ApprovalRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pending_approvals
           (approval_id, instance_id, action_kind, payload_json, expires_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        record.approvalId,
        record.instanceId,
        record.actionKind,
        JSON.stringify(record.payload),
        record.expiresAt,
        now,
      );
    this.audit(record.approvalId, 'created');
    return this.get(record.approvalId)!;
  }

  resolve(
    approvalId: string,
    status: 'approved' | 'denied',
    resolvedBy: ApprovalResolvedBy,
  ): ApprovalRecord | undefined {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE pending_approvals
         SET status = ?, resolved_at = ?, resolved_by = ?
         WHERE approval_id = ? AND status = 'pending'`,
      )
      .run(status, now, resolvedBy, approvalId);
    if (result.changes === 0) return undefined;
    this.audit(approvalId, status, { resolvedBy });
    return this.get(approvalId);
  }

  get(approvalId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get<ApprovalRow>(approvalId);
    return row ? toRecord(row) : undefined;
  }

  listPending(instanceId?: string): ApprovalRecord[] {
    const now = Date.now();
    const rows = instanceId
      ? this.db
          .prepare(
            `SELECT * FROM pending_approvals
             WHERE status = 'pending' AND expires_at >= ? AND instance_id = ?`,
          )
          .all<ApprovalRow>(now, instanceId)
      : this.db
          .prepare(
            `SELECT * FROM pending_approvals
             WHERE status = 'pending' AND expires_at >= ?`,
          )
          .all<ApprovalRow>(now);
    return rows.map(toRecord);
  }

  private audit(approvalId: string, event: string, detail?: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO approval_audit_log (approval_id, event, detail_json, at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(approvalId, event, detail ? JSON.stringify(detail) : null, Date.now());
  }
}
