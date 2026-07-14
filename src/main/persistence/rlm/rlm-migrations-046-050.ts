import type { Migration } from './rlm-types';

/** Add durable human-review workflow state to the main-process SQLite database. */
export const RLM_MIGRATIONS_046_050: Migration[] = [
  {
    name: '046_doc_review_sessions',
    up: `
      CREATE TABLE IF NOT EXISTS doc_review_sessions (
        review_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        session_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_doc_review_sessions_status_created
        ON doc_review_sessions(status, created_at DESC);
      CREATE TABLE IF NOT EXISTS doc_review_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
    down: `
      DROP INDEX IF EXISTS idx_doc_review_sessions_status_created;
      DROP TABLE IF EXISTS doc_review_sessions;
      DROP TABLE IF EXISTS doc_review_metadata;
    `,
  },
  {
    name: '047_provider_limit_events',
    up: `
      CREATE TABLE IF NOT EXISTS provider_limit_events (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        detected_at INTEGER NOT NULL,
        resume_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        instance_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_provider_limit_events_active
        ON provider_limit_events(provider, model, resume_at DESC, detected_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_provider_limit_events_active;
      DROP TABLE IF EXISTS provider_limit_events;
    `,
  },
];
