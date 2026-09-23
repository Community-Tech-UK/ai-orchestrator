import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_066_070: Migration[] = [
  {
    // Decision log (token/memory plan Tasks 8-9): heuristic observation events
    // extracted from a live instance's transcript when restart-with-summary
    // compaction runs with `compactionDecisionLogEnabled` on. Keyed by AIO
    // instance id, not RLM session id — that compaction path has no RLM session.
    // `compaction_marker_id` is nullable: the marker row is written after the
    // restart completes. Deliberately no FK, following
    // `039_add_session_compaction_markers`.
    name: '066_session_observation_events',
    up: `
      CREATE TABLE IF NOT EXISTS session_observation_events (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        compaction_marker_id TEXT,
        timestamp INTEGER NOT NULL,
        turn INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('decision', 'discovery', 'error', 'tool_result', 'task_progress', 'preference')),
        priority INTEGER NOT NULL CHECK (priority IN (1, 2, 3)),
        content TEXT NOT NULL,
        metadata_json TEXT,
        source_type TEXT NOT NULL DEFAULT 'heuristic' CHECK (source_type IN ('heuristic', 'llm_extracted')),
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_observation_events_instance
        ON session_observation_events(instance_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_observation_events_type
        ON session_observation_events(type);
      CREATE INDEX IF NOT EXISTS idx_session_observation_events_priority
        ON session_observation_events(priority);
    `,
    down: `
      DROP INDEX IF EXISTS idx_session_observation_events_priority;
      DROP INDEX IF EXISTS idx_session_observation_events_type;
      DROP INDEX IF EXISTS idx_session_observation_events_instance;
      DROP TABLE IF EXISTS session_observation_events;
    `,
  },
  {
    name: '067_skill_budget_skips',
    up: `
      CREATE TABLE IF NOT EXISTS skill_budget_skips (
        id TEXT PRIMARY KEY,
        skill_name TEXT NOT NULL,
        skill_source TEXT NOT NULL,
        instance_id TEXT,
        session_id TEXT,
        turn_key TEXT,
        reason TEXT NOT NULL CHECK (reason = 'budget-exceeded'),
        tokens INTEGER NOT NULL,
        budget INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_budget_skips_time
        ON skill_budget_skips(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_budget_skips_skill_time
        ON skill_budget_skips(skill_name, created_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_skill_budget_skips_skill_time;
      DROP INDEX IF EXISTS idx_skill_budget_skips_time;
      DROP TABLE IF EXISTS skill_budget_skips;
    `,
  },
];
