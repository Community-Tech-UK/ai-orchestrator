import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_001_015: Migration[] = [
// Migration 001: Add optimized indices for common query patterns
  {
    name: '001_add_optimized_indices',
    up: `
      -- Composite index for filtering outcomes by task type and success
      CREATE INDEX IF NOT EXISTS idx_outcomes_task_success
        ON outcomes(task_type, success);

      -- Index for model-specific outcome queries
      CREATE INDEX IF NOT EXISTS idx_outcomes_model
        ON outcomes(model);

      -- Index for cleaning up expired insights
      CREATE INDEX IF NOT EXISTS idx_insights_expires
        ON insights(expires_at);

      -- Index for time-based session queries
      CREATE INDEX IF NOT EXISTS idx_sessions_started
        ON rlm_sessions(started_at);

      -- Index for section checksum lookups (deduplication)
      CREATE INDEX IF NOT EXISTS idx_sections_checksum
        ON context_sections(checksum);

      -- Index for file path lookups in sections
      CREATE INDEX IF NOT EXISTS idx_sections_filepath
        ON context_sections(file_path);

      -- Composite index for section name lookups within a store
      CREATE INDEX IF NOT EXISTS idx_sections_store_name
        ON context_sections(store_id, name);
    `,
    down: `
      DROP INDEX IF EXISTS idx_outcomes_task_success;
      DROP INDEX IF EXISTS idx_outcomes_model;
      DROP INDEX IF EXISTS idx_insights_expires;
      DROP INDEX IF EXISTS idx_sessions_started;
      DROP INDEX IF EXISTS idx_sections_checksum;
      DROP INDEX IF EXISTS idx_sections_filepath;
      DROP INDEX IF EXISTS idx_sections_store_name;
    `
  },

  // Migration 002: Add codebase indexing tables
  {
    name: '002_add_codebase_indexing_tables',
    up: `
      -- Merkle tree storage for change detection
      CREATE TABLE IF NOT EXISTS codebase_trees (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        tree_blob BLOB NOT NULL,
        file_count INTEGER NOT NULL,
        total_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_codebase_trees_store
        ON codebase_trees(store_id);

      -- File metadata for dependency tracking
      CREATE TABLE IF NOT EXISTS file_metadata (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        lines INTEGER NOT NULL,
        hash TEXT NOT NULL,
        last_modified INTEGER NOT NULL,
        is_entry_point INTEGER DEFAULT 0,
        is_test_file INTEGER DEFAULT 0,
        is_config_file INTEGER DEFAULT 0,
        framework TEXT,
        imports_json TEXT,
        exports_json TEXT,
        symbols_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_file_metadata_store
        ON file_metadata(store_id);
      CREATE INDEX IF NOT EXISTS idx_file_metadata_path
        ON file_metadata(path);
      CREATE INDEX IF NOT EXISTS idx_file_metadata_hash
        ON file_metadata(hash);
      CREATE INDEX IF NOT EXISTS idx_file_metadata_language
        ON file_metadata(language);

      -- Search analytics
      CREATE TABLE IF NOT EXISTS search_events (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        query TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        results_count INTEGER NOT NULL,
        top_score REAL,
        clicked_indices TEXT,
        search_duration_ms INTEGER,
        hyde_used INTEGER DEFAULT 0,
        rerank_used INTEGER DEFAULT 0,
        FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_search_events_store
        ON search_events(store_id);
      CREATE INDEX IF NOT EXISTS idx_search_events_timestamp
        ON search_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_search_events_query_hash
        ON search_events(query_hash);
    `,
    down: `
      DROP TABLE IF EXISTS search_events;
      DROP TABLE IF EXISTS file_metadata;
      DROP TABLE IF EXISTS codebase_trees;
    `
  },

  // Migration 003: Add FTS5 full-text search table
  {
    name: '003_add_fts5_code_search',
    up: `
      -- Full-text search table using FTS5
      CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
        store_id,
        section_id,
        file_path,
        content,
        symbols,
        tokenize = 'porter unicode61'
      );

      -- Note: Triggers for keeping FTS in sync are handled in application code
      -- because FTS5 triggers require special handling
    `,
    down: `
      DROP TABLE IF EXISTS code_fts;
    `
  },

  // Migration 004: Add observation memory tables
  {
    name: '004_add_observation_tables',
    up: `
      -- Compressed observations from ObserverAgent
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        source_ids_json TEXT,
        instance_ids_json TEXT,
        themes_json TEXT,
        key_findings_json TEXT,
        success_signals INTEGER DEFAULT 0,
        failure_signals INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        ttl INTEGER NOT NULL,
        promoted INTEGER DEFAULT 0,
        token_count INTEGER DEFAULT 0,
        embedding_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_observations_timestamp
        ON observations(timestamp);
      CREATE INDEX IF NOT EXISTS idx_observations_promoted
        ON observations(promoted);

      -- Consolidated reflections from ReflectorAgent
      CREATE TABLE IF NOT EXISTS reflections (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        insight TEXT NOT NULL,
        observation_ids_json TEXT,
        patterns_json TEXT,
        confidence REAL DEFAULT 0,
        applicability_json TEXT,
        created_at INTEGER NOT NULL,
        ttl INTEGER NOT NULL,
        usage_count INTEGER DEFAULT 0,
        effectiveness_score REAL DEFAULT 0,
        promoted_to_procedural INTEGER DEFAULT 0,
        embedding_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_reflections_confidence
        ON reflections(confidence);
      CREATE INDEX IF NOT EXISTS idx_reflections_effectiveness
        ON reflections(effectiveness_score);
    `,
    down: `
      DROP TABLE IF EXISTS reflections;
      DROP TABLE IF EXISTS observations;
    `
  },

  // Migration 005: Add token stats table
  {
    name: '005_add_token_stats_table',
    up: `
      CREATE TABLE IF NOT EXISTS token_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        session_id TEXT,
        tool_type TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        char_count INTEGER NOT NULL,
        truncated INTEGER DEFAULT 0,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_token_stats_instance ON token_stats(instance_id);
      CREATE INDEX IF NOT EXISTS idx_token_stats_tool ON token_stats(tool_type);
      CREATE INDEX IF NOT EXISTS idx_token_stats_time ON token_stats(timestamp);
    `,
    down: `
      DROP INDEX IF EXISTS idx_token_stats_instance;
      DROP INDEX IF EXISTS idx_token_stats_tool;
      DROP INDEX IF EXISTS idx_token_stats_time;
      DROP TABLE IF EXISTS token_stats;
    `
  },

  // Migration 006: Add channel messages table
  {
    name: '006_add_channel_messages',
    up: `
      CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        instance_id TEXT,
        reply_to_message_id TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_channel_messages_chat
        ON channel_messages(platform, chat_id);
      CREATE INDEX IF NOT EXISTS idx_channel_messages_instance
        ON channel_messages(instance_id);
      CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
        ON channel_messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_channel_messages_timestamp
        ON channel_messages(platform, chat_id, timestamp);
    `,
    down: `
      DROP INDEX IF EXISTS idx_channel_messages_timestamp;
      DROP INDEX IF EXISTS idx_channel_messages_thread;
      DROP INDEX IF EXISTS idx_channel_messages_instance;
      DROP INDEX IF EXISTS idx_channel_messages_chat;
      DROP TABLE IF EXISTS channel_messages;
    `
  },

  // Migration 007: Add channel credentials table for token persistence
  {
    name: '007_add_channel_credentials',
    up: `
      CREATE TABLE IF NOT EXISTS channel_credentials (
        platform TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS channel_credentials;
    `
  },

  // Migration 008: Add permission decisions audit trail
  {
    name: '008_permission_decisions',
    up: `
      CREATE TABLE IF NOT EXISTS permission_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('allow', 'deny', 'ask')),
        decided_by TEXT,
        rule_id TEXT,
        reason TEXT,
        tool_name TEXT,
        is_cached INTEGER NOT NULL DEFAULT 0,
        decided_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_perm_decisions_instance ON permission_decisions(instance_id);
      CREATE INDEX idx_perm_decisions_scope ON permission_decisions(scope);
      CREATE INDEX idx_perm_decisions_created ON permission_decisions(created_at);
    `,
    down: `
      DROP TABLE IF EXISTS permission_decisions;
    `,
  },
  // Migration 009: Add workflow executions persistence
  {
    name: '009_workflow_executions',
    up: `
      CREATE TABLE IF NOT EXISTS workflow_executions (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'failed')),
        current_phase_id TEXT,
        phase_statuses_json TEXT NOT NULL DEFAULT '{}',
        phase_data_json TEXT NOT NULL DEFAULT '{}',
        pending_gate_json TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        agent_invocations INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_wf_exec_instance ON workflow_executions(instance_id);
      CREATE INDEX idx_wf_exec_status ON workflow_executions(status);
    `,
    down: `
      DROP TABLE IF EXISTS workflow_executions;
    `,
  },

  // Migration 010: Add channel access policies table for persistent pairing/allowlists
  {
    name: '010_channel_access_policies',
    up: `
      CREATE TABLE IF NOT EXISTS channel_access_policies (
        platform TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'pairing',
        allowed_senders_json TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS channel_access_policies;
    `,
  },

  // Migration 011: Knowledge graph — entities + triples with temporal validity
  // Inspired by mempalace knowledge_graph.py
  {
    name: '011_knowledge_graph',
    up: `
      CREATE TABLE IF NOT EXISTS kg_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'unknown',
        properties_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kg_entities_type
        ON kg_entities(type);
      CREATE INDEX IF NOT EXISTS idx_kg_entities_name
        ON kg_entities(name);

      CREATE TABLE IF NOT EXISTS kg_triples (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        source_closet TEXT,
        source_file TEXT,
        extracted_at INTEGER NOT NULL,
        FOREIGN KEY (subject) REFERENCES kg_entities(id),
        FOREIGN KEY (object) REFERENCES kg_entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_kg_triples_subject
        ON kg_triples(subject);
      CREATE INDEX IF NOT EXISTS idx_kg_triples_object
        ON kg_triples(object);
      CREATE INDEX IF NOT EXISTS idx_kg_triples_predicate
        ON kg_triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_kg_triples_valid
        ON kg_triples(valid_from, valid_to);
    `,
    down: `
      DROP TABLE IF EXISTS kg_triples;
      DROP TABLE IF EXISTS kg_entities;
    `,
  },

  // Migration 012: Verbatim segments — raw text storage for conversation mining
  // Stores exact text for high-fidelity retrieval (96.6% R@5 on LongMemEval)
  {
    name: '012_verbatim_segments',
    up: `
      CREATE TABLE IF NOT EXISTS verbatim_segments (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_file TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        wing TEXT NOT NULL,
        room TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 3.0,
        added_by TEXT NOT NULL DEFAULT 'system',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_verbatim_wing
        ON verbatim_segments(wing);
      CREATE INDEX IF NOT EXISTS idx_verbatim_room
        ON verbatim_segments(room);
      CREATE INDEX IF NOT EXISTS idx_verbatim_source
        ON verbatim_segments(source_file);
      CREATE INDEX IF NOT EXISTS idx_verbatim_importance
        ON verbatim_segments(importance DESC);

      CREATE TABLE IF NOT EXISTS conversation_imports (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        format TEXT NOT NULL,
        wing TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        segments_created INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        imported_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_convo_imports_status
        ON conversation_imports(status);
    `,
    down: `
      DROP TABLE IF EXISTS conversation_imports;
      DROP TABLE IF EXISTS verbatim_segments;
    `,
  },

  // Migration 013: Wake-up context — cold-start hints for agent initialization
  {
    name: '013_wake_context',
    up: `
      CREATE TABLE IF NOT EXISTS wake_hints (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 5.0,
        room TEXT NOT NULL DEFAULT 'general',
        source_reflection_id TEXT,
        source_session_id TEXT,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_wake_hints_importance
        ON wake_hints(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_wake_hints_room
        ON wake_hints(room);
    `,
    down: `
      DROP TABLE IF EXISTS wake_hints;
    `,
  },

  // Migration 014: Index to support SummarizationWorker scan.
  // The worker queries depth=0 sections without summaries every 60s; before this
  // index it did a full table scan + correlated LIKE subquery, blocking the
  // main thread for seconds on a large context_sections table.
  {
    name: '014_add_summary_scan_index',
    up: `
      CREATE INDEX IF NOT EXISTS idx_sections_summary_scan
        ON context_sections(depth, parent_summary_id, pending_summary, tokens DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_sections_summary_scan;
    `,
  },
  // Migration 015: Scheduled automations and automation run history.
  {
    name: '015_automations',
    up: `
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron', 'oneTime')),
        schedule_json TEXT NOT NULL,
        missed_run_policy TEXT NOT NULL CHECK(missed_run_policy IN ('skip', 'notify', 'runOnce')),
        concurrency_policy TEXT NOT NULL CHECK(concurrency_policy IN ('skip', 'queue')),
        action_json TEXT NOT NULL,
        next_fire_at INTEGER,
        last_fired_at INTEGER,
        last_run_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automations_active_next_fire
        ON automations(active, enabled, next_fire_at);
      CREATE INDEX IF NOT EXISTS idx_automations_last_fired
        ON automations(last_fired_at);

      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
        trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'catchUp', 'manual')),
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        instance_id TEXT,
        error TEXT,
        output_summary TEXT,
        seen_at INTEGER,
        config_snapshot_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_status
        ON automation_runs(automation_id, status);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_instance
        ON automation_runs(instance_id);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_scheduled
        ON automation_runs(automation_id, scheduled_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_schedule_dedupe
        ON automation_runs(automation_id, scheduled_at)
        WHERE trigger IN ('scheduled', 'catchUp');

      CREATE TABLE IF NOT EXISTS automation_attachments (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_ref_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_automation_attachments_automation
        ON automation_attachments(automation_id, position);
    `,
    down: `
      DROP TABLE IF EXISTS automation_attachments;
      DROP INDEX IF EXISTS idx_automation_runs_schedule_dedupe;
      DROP INDEX IF EXISTS idx_automation_runs_scheduled;
      DROP INDEX IF EXISTS idx_automation_runs_instance;
      DROP INDEX IF EXISTS idx_automation_runs_automation_status;
      DROP TABLE IF EXISTS automation_runs;
      DROP INDEX IF EXISTS idx_automations_last_fired;
      DROP INDEX IF EXISTS idx_automations_active_next_fire;
      DROP TABLE IF EXISTS automations;
    `,
  },
];
