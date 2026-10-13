import type { SqliteDriver } from '../src/main/db/sqlite-driver';
import { runConversationLedgerMigrations } from '../src/main/conversation-ledger/conversation-ledger-schema';

export const EVIDENCE_MAINTENANCE_INDEXES = [
  'idx_evidence_records_maintenance', 'idx_evidence_records_live_blob',
  'idx_evidence_cards_live_blob', 'idx_evidence_deletion_queue_pending_blob',
];

/** Synthetic metadata only. Caller owns an isolated database, never a user profile. */
export function seedEvidenceMaintenanceFixture(
  db: SqliteDriver,
  options: { rows?: number; schemaVersion?: 6 | 7 } = {},
): { conversationId: string; evidenceRows: number; cardRows: number } {
  const rows = options.rows ?? 400_000;
  if (!Number.isSafeInteger(rows) || rows < 1) throw new Error('INVALID_FIXTURE_ROWS');
  runConversationLedgerMigrations(db);
  if (options.schemaVersion === 6) {
    db.transaction(() => {
      for (const index of EVIDENCE_MAINTENANCE_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
      db.prepare('DELETE FROM conversation_ledger_migrations WHERE version = 7').run();
    })();
  }
  const conversationId = 'placeholder-benchmark-conversation';
  db.transaction(() => {
    db.prepare(`INSERT INTO conversation_threads
      (id, provider, source_kind, created_at, updated_at)
      VALUES (?, 'codex', 'orchestrator', 1, 1)`).run(conversationId);
    const record = db.prepare(`INSERT INTO evidence_records (
      id, conversation_id, provider, tool_name, source_kind, status, blob_ref,
      keyed_content_id, byte_count, mime_type, sensitivity, provenance_trust,
      capture_mode, capture_completeness, key_version, capture_key,
      created_at, completed_at, updated_at
    ) VALUES (?, ?, 'codex', 'placeholder-tool', 'other', 'complete', ?, ?, 1,
      'text/plain', 'normal', 'runtime-authenticated', 'post-retention',
      'complete', 1, ?, 1, 2, 2)`);
    const card = db.prepare(`INSERT INTO evidence_cards (
      id, conversation_id, evidence_id, blob_ref, extractor_kind, extractor_version,
      status, sensitivity, byte_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'placeholder', '1', 'validated', 'normal', 1, 2, 2)`);
    for (let i = 0; i < rows; i++) {
      const suffix = String(i).padStart(7, '0');
      const id = `placeholder-evidence-${suffix}`;
      record.run(id, conversationId, `placeholder/record-${suffix}.aioev`, 'a'.repeat(64), id);
      card.run(`placeholder-card-${suffix}`, conversationId, id, `placeholder/card-${suffix}.aioev`);
    }
  })();
  return { conversationId, evidenceRows: rows, cardRows: rows };
}
