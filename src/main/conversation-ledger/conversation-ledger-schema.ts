import type { SqliteDriver } from '../db/sqlite-driver';

export const CONVERSATION_LEDGER_SCHEMA_VERSION = 4;

interface LedgerMigration {
  version: number;
  name: string;
  up: string;
}

const MIGRATIONS: LedgerMigration[] = [
  {
    version: 1,
    name: '001_initial_conversation_ledger',
    up: `
      CREATE TABLE IF NOT EXISTS conversation_threads (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        native_thread_id TEXT,
        native_session_id TEXT,
        native_source_kind TEXT,
        source_kind TEXT NOT NULL,
        source_path TEXT,
        workspace_path TEXT,
        title TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_synced_at INTEGER,
        writable INTEGER NOT NULL DEFAULT 0,
        native_visibility_mode TEXT NOT NULL DEFAULT 'none',
        sync_status TEXT NOT NULL DEFAULT 'never-synced',
        conflict_status TEXT NOT NULL DEFAULT 'none',
        parent_conversation_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_threads_provider_native
        ON conversation_threads(provider, native_thread_id)
        WHERE native_thread_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_conversation_threads_workspace_updated
        ON conversation_threads(workspace_path, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        native_message_id TEXT,
        native_turn_id TEXT,
        role TEXT NOT NULL,
        phase TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        token_input INTEGER,
        token_output INTEGER,
        raw_ref TEXT,
        raw_json TEXT,
        source_checksum TEXT,
        sequence INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_thread_native
        ON conversation_messages(thread_id, native_message_id)
        WHERE native_message_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_thread_sequence
        ON conversation_messages(thread_id, sequence);

      CREATE TABLE IF NOT EXISTS conversation_sync_cursors (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        cursor_kind TEXT NOT NULL,
        cursor_value TEXT NOT NULL,
        source_path TEXT,
        source_mtime INTEGER,
        last_seen_checksum TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sync_cursors_thread_kind
        ON conversation_sync_cursors(thread_id, cursor_kind);

      CREATE TABLE IF NOT EXISTS conversation_memory_links (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES conversation_messages(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL,
        memory_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: '002_conversation_checkpoints',
    up: `
      CREATE TABLE IF NOT EXISTS conversation_checkpoints (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        up_to_sequence INTEGER NOT NULL,
        up_to_native_id TEXT,
        summary TEXT NOT NULL,
        summarized_message_count INTEGER NOT NULL,
        summary_tokens INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_checkpoints_thread_seq
        ON conversation_checkpoints(thread_id, up_to_sequence);
    `,
  },
  {
    version: 3,
    name: '003_provider_event_captures',
    up: `
      CREATE TABLE IF NOT EXISTS provider_event_captures (
        event_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        session_id TEXT,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        raw_source TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_provider_event_captures_instance_created
        ON provider_event_captures(instance_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_provider_event_captures_created
        ON provider_event_captures(created_at ASC);
    `,
  },
  {
    version: 4,
    name: '004_context_evidence',
    up: `
      ALTER TABLE conversation_threads ADD COLUMN deleted_at TEXT NULL;

      DROP INDEX IF EXISTS idx_conversation_threads_provider_native;
      CREATE UNIQUE INDEX idx_conversation_threads_provider_native
        ON conversation_threads(provider, native_thread_id)
        WHERE native_thread_id IS NOT NULL AND deleted_at IS NULL;

      CREATE TABLE evidence_records (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_thread_ref TEXT,
        provider_session_ref TEXT,
        turn_ref TEXT,
        tool_call_ref TEXT,
        tool_name TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (
          source_kind IN ('command', 'file', 'database', 'web', 'mcp', 'browser', 'other')
        ),
        source_locator_redacted TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('staging', 'complete', 'failed', 'corrupt', 'deleted')
        ),
        blob_ref TEXT,
        keyed_content_id TEXT,
        byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
        token_estimate INTEGER CHECK (token_estimate IS NULL OR token_estimate >= 0),
        mime_type TEXT NOT NULL,
        sensitivity TEXT NOT NULL CHECK (
          sensitivity IN ('normal', 'sensitive', 'restricted')
        ),
        provenance_trust TEXT NOT NULL CHECK (
          provenance_trust IN ('runtime-authenticated', 'legacy-unverified')
        ),
        capture_mode TEXT NOT NULL CHECK (
          capture_mode IN ('pre-retention', 'post-retention', 'observed-only')
        ),
        capture_completeness TEXT NOT NULL CHECK (
          capture_completeness IN ('complete', 'bounded', 'metadata-only')
        ),
        truncation_reason TEXT,
        key_version INTEGER CHECK (key_version IS NULL OR key_version > 0),
        capture_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK (capture_completeness = 'complete' OR truncation_reason IS NOT NULL),
        CHECK (
          status != 'complete' OR (
            blob_ref IS NOT NULL AND length(blob_ref) > 0 AND
            keyed_content_id IS NOT NULL AND length(keyed_content_id) = 64 AND
            keyed_content_id NOT GLOB '*[^0-9a-f]*' AND
            key_version IS NOT NULL AND key_version > 0 AND
            completed_at IS NOT NULL AND completed_at >= created_at
          )
        )
      );

      CREATE UNIQUE INDEX idx_evidence_records_capture_key
        ON evidence_records(conversation_id, capture_key);
      CREATE INDEX idx_evidence_records_conversation_created
        ON evidence_records(conversation_id, created_at DESC);
      CREATE INDEX idx_evidence_records_conversation_status
        ON evidence_records(conversation_id, status, created_at DESC);
      CREATE UNIQUE INDEX idx_evidence_records_conversation_id_id
        ON evidence_records(conversation_id, id);

      CREATE TABLE evidence_cards (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL,
        blob_ref TEXT,
        extractor_kind TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('validated', 'partial', 'failed')),
        sensitivity TEXT NOT NULL CHECK (
          sensitivity IN ('normal', 'sensitive', 'restricted')
        ),
        byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
        token_estimate INTEGER CHECK (token_estimate IS NULL OR token_estimate >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id, evidence_id)
          REFERENCES evidence_records(conversation_id, id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX idx_evidence_cards_conversation_evidence
        ON evidence_cards(conversation_id, evidence_id, extractor_kind, extractor_version);

      CREATE TABLE evidence_access_log (
        id TEXT PRIMARY KEY,
        requester TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (
          operation IN ('list', 'search', 'read', 'compare', 'verify')
        ),
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        requested_ranges_json TEXT NOT NULL DEFAULT '[]',
        outcome_code TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_evidence_access_log_conversation_created
        ON evidence_access_log(conversation_id, created_at DESC);

      CREATE TABLE evidence_deletion_queue (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        evidence_id TEXT,
        blob_ref TEXT NOT NULL,
        grace_deadline INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        claim_token TEXT,
        claimed_until INTEGER,
        next_attempt_at INTEGER NOT NULL,
        last_error_code TEXT,
        completed_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_evidence_deletion_queue_claim
        ON evidence_deletion_queue(completed_at, next_attempt_at, claimed_until, attempts);
      CREATE UNIQUE INDEX idx_evidence_deletion_queue_blob
        ON evidence_deletion_queue(conversation_id, blob_ref);

      CREATE TABLE context_evidence_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
        provider TEXT,
        event_kind TEXT NOT NULL,
        recovery_epoch INTEGER NOT NULL DEFAULT 0 CHECK (recovery_epoch >= 0),
        threshold_code TEXT,
        action_code TEXT,
        proof_stage TEXT,
        occupancy_used INTEGER,
        occupancy_total INTEGER,
        cumulative_tokens INTEGER,
        output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
        provider_request_count INTEGER NOT NULL DEFAULT 0 CHECK (provider_request_count >= 0),
        new_evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (new_evidence_count >= 0),
        new_finding_count INTEGER NOT NULL DEFAULT 0 CHECK (new_finding_count >= 0),
        failure_code TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_context_evidence_events_conversation_created
        ON context_evidence_events(conversation_id, created_at DESC);
    `,
  },
];

export function createConversationLedgerMigrationsTable(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_ledger_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);
}

export function createConversationLedgerTables(db: SqliteDriver): void {
  db.exec(MIGRATIONS[0]!.up);
}

export function runConversationLedgerMigrations(db: SqliteDriver): void {
  createConversationLedgerMigrationsTable(db);
  const applied = new Set(
    db.prepare('SELECT version FROM conversation_ledger_migrations').all<{ version: number }>()
      .map(row => row.version)
  );

  const run = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      db.exec(migration.up);
      db.prepare(`
        INSERT INTO conversation_ledger_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(migration.version, migration.name, Date.now());
    }
  });

  run();
}
