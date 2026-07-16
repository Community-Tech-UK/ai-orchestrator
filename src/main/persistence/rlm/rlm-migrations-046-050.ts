import type { Migration } from './rlm-types';
import { VERIFICATION_RUNS_UP_SQL } from './verification-run-schema';

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
  {
    name: '048_verification_runs',
    up: VERIFICATION_RUNS_UP_SQL,
    down: `
      DROP INDEX IF EXISTS idx_verification_runs_instance_started;
      DROP INDEX IF EXISTS idx_verification_runs_loop_started;
      DROP TABLE IF EXISTS verification_runs;
    `,
  },
  {
    name: '049_automation_trigger_configuration',
    up: `
      ALTER TABLE automations ADD COLUMN trigger_json TEXT NOT NULL DEFAULT '{"kind":"schedule"}';
    `,
    down: `
      ALTER TABLE automations DROP COLUMN trigger_json;
    `,
  },
  {
    // Fable WS5: automation runs that spawn a LOOP (instead of a one-shot
    // instance) link the loop run for provenance/outcome capture.
    name: '050_automation_run_loop_link',
    up: `
      ALTER TABLE automation_runs ADD COLUMN loop_run_id TEXT;
    `,
    down: `
      ALTER TABLE automation_runs DROP COLUMN loop_run_id;
    `,
  },
];
