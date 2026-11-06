import { randomUUID } from 'node:crypto';
import { getOperatorDatabase } from '../operator/operator-database';
import type { SessionReadAuditRow } from './session-transcript-reader';

/** The reader catches write errors, matching the messaging audit's fail-soft contract. */
export function writeSessionReadAuditRow(row: SessionReadAuditRow): void {
  getOperatorDatabase().db.prepare(`
    INSERT INTO session_messages (id, source_instance_id, source_display_name, target_instance_id,
      target_display_name, content_length, content_hash, hop_count, outcome, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), row.sourceId, row.sourceDisplayName, row.targetId, row.targetDisplayName,
    row.contentLength, row.contentHash, 0, row.outcome, row.reason, row.createdAt);
}
