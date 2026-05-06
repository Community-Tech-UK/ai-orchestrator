/**
 * RLM Schema Module
 *
 * Table creation SQL and migrations.
 * Note: This file uses better-sqlite3's db.exec() method for executing SQL,
 * not child_process.exec(). This is safe as it's database SQL execution.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import * as crypto from 'crypto';
import type { Migration } from './rlm-types';
import type { MigrationRow } from '../rlm-database.types';

interface TableInfoRow {
  name: string;
}

function ensureContextSectionSummaryColumns(
  db: SqliteDriver
): void {
  const columns = db
    .prepare(`PRAGMA table_info(context_sections)`)
    .all() as TableInfoRow[];
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('pending_summary')) {
    db.exec(`
      ALTER TABLE context_sections
      ADD COLUMN pending_summary INTEGER DEFAULT 0
    `);
  }

  if (!columnNames.has('summary_priority')) {
    db.exec(`
      ALTER TABLE context_sections
      ADD COLUMN summary_priority INTEGER DEFAULT 0
    `);
  }

  if (!columnNames.has('last_summary_attempt')) {
    db.exec(`
      ALTER TABLE context_sections
      ADD COLUMN last_summary_attempt INTEGER
    `);
  }
}

/**
 * Migrations to be applied in order
 */
export const MIGRATIONS: Migration[] = [
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
  // Migration 016: orchestration automation triggers, webhook ingress, and artifact registry.
  {
    name: '016_unified_orchestration_runtime',
    up: `
      PRAGMA foreign_keys=OFF;

      DROP INDEX IF EXISTS idx_automation_runs_schedule_dedupe;
      DROP INDEX IF EXISTS idx_automation_runs_scheduled;
      DROP INDEX IF EXISTS idx_automation_runs_instance;
      DROP INDEX IF EXISTS idx_automation_runs_automation_status;

      ALTER TABLE automation_runs RENAME TO automation_runs_legacy;

      CREATE TABLE automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
        trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'catchUp', 'manual', 'webhook', 'channel', 'providerRuntime', 'orchestrationEvent')),
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        instance_id TEXT,
        error TEXT,
        output_summary TEXT,
        output_full_ref TEXT,
        idempotency_key TEXT,
        trigger_source_json TEXT,
        delivery_mode TEXT NOT NULL DEFAULT 'notify',
        seen_at INTEGER,
        config_snapshot_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
      );

      INSERT INTO automation_runs
        (id, automation_id, status, trigger, scheduled_at, started_at, finished_at,
         instance_id, error, output_summary, output_full_ref, idempotency_key,
         trigger_source_json, delivery_mode, seen_at, config_snapshot_json, created_at, updated_at)
      SELECT
        id, automation_id, status, trigger, scheduled_at, started_at, finished_at,
        instance_id, error, output_summary, NULL, NULL, NULL, 'notify',
        seen_at, config_snapshot_json, created_at, updated_at
      FROM automation_runs_legacy;

      DROP TABLE automation_runs_legacy;

      CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_status
        ON automation_runs(automation_id, status);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_instance
        ON automation_runs(instance_id);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_scheduled
        ON automation_runs(automation_id, scheduled_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_schedule_dedupe
        ON automation_runs(automation_id, scheduled_at)
        WHERE trigger IN ('scheduled', 'catchUp');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_external_idempotency
        ON automation_runs(automation_id, trigger, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS webhook_routes (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        secret_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        allow_unsigned_dev INTEGER NOT NULL DEFAULT 0,
        max_body_bytes INTEGER NOT NULL DEFAULT 262144,
        allowed_automation_ids_json TEXT NOT NULL DEFAULT '[]',
        allowed_events_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event_type TEXT,
        status TEXT NOT NULL,
        status_code INTEGER,
        error TEXT,
        payload_hash TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        processed_at INTEGER,
        trigger_source_json TEXT,
        UNIQUE(route_id, delivery_id),
        FOREIGN KEY (route_id) REFERENCES webhook_routes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_route
        ON webhook_deliveries(route_id, received_at DESC);

      CREATE TABLE IF NOT EXISTS artifact_registry (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        protected INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(path, owner_type, owner_id)
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_registry_owner
        ON artifact_registry(owner_type, owner_id);
      CREATE INDEX IF NOT EXISTS idx_artifact_registry_cleanup
        ON artifact_registry(protected, last_seen_at);

      PRAGMA foreign_keys=ON;
    `,
    down: `
      DROP INDEX IF EXISTS idx_artifact_registry_cleanup;
      DROP INDEX IF EXISTS idx_artifact_registry_owner;
      DROP TABLE IF EXISTS artifact_registry;
      DROP INDEX IF EXISTS idx_webhook_deliveries_route;
      DROP TABLE IF EXISTS webhook_deliveries;
      DROP TABLE IF EXISTS webhook_routes;
      DROP INDEX IF EXISTS idx_automation_runs_external_idempotency;
    `,
  },
  // Migration 017: persistent channel route pins for Discord/WhatsApp.
  {
    name: '017_channel_route_pins',
    up: `
      CREATE TABLE IF NOT EXISTS channel_route_pins (
        platform TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('chat', 'dm')),
        route_key TEXT NOT NULL,
        pin_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (platform, scope, route_key)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_route_pins_platform
        ON channel_route_pins(platform, scope);
    `,
    down: `
      DROP INDEX IF EXISTS idx_channel_route_pins_platform;
      DROP TABLE IF EXISTS channel_route_pins;
    `,
  },
  // Migration 018: persistent codebase mining manifests and status.
  {
    name: '018_codebase_mining_status',
    up: `
      CREATE TABLE IF NOT EXISTS codebase_mining_status (
        normalized_path TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        content_fingerprint TEXT,
        files_json TEXT NOT NULL DEFAULT '[]',
        facts_extracted INTEGER NOT NULL DEFAULT 0,
        hints_created INTEGER NOT NULL DEFAULT 0,
        files_read INTEGER NOT NULL DEFAULT 0,
        errors_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_codebase_mining_status_status
        ON codebase_mining_status(status, updated_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_codebase_mining_status_status;
      DROP TABLE IF EXISTS codebase_mining_status;
    `,
  },
  // Migration 019: project-root registry metadata on top of codebase mining status.
  {
    name: '019_project_root_registry',
    up: `
      DROP INDEX IF EXISTS idx_codebase_mining_status_status;
      ALTER TABLE codebase_mining_status RENAME TO codebase_mining_status_old;

      CREATE TABLE codebase_mining_status (
        normalized_path TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        project_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        discovery_source TEXT NOT NULL DEFAULT 'manual',
        auto_mine INTEGER NOT NULL DEFAULT 1,
        is_paused INTEGER NOT NULL DEFAULT 0,
        is_excluded INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('never', 'running', 'completed', 'failed')),
        content_fingerprint TEXT,
        files_json TEXT NOT NULL DEFAULT '[]',
        facts_extracted INTEGER NOT NULL DEFAULT 0,
        hints_created INTEGER NOT NULL DEFAULT 0,
        files_read INTEGER NOT NULL DEFAULT 0,
        errors_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER,
        completed_at INTEGER,
        last_active_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      INSERT INTO codebase_mining_status (
        normalized_path, root_path, project_key, display_name, discovery_source,
        auto_mine, is_paused, is_excluded, status, content_fingerprint, files_json,
        facts_extracted, hints_created, files_read, errors_json, started_at,
        completed_at, last_active_at, created_at, updated_at, metadata_json
      )
      SELECT
        normalized_path,
        normalized_path,
        normalized_path,
        normalized_path,
        'manual',
        1,
        0,
        0,
        status,
        content_fingerprint,
        files_json,
        facts_extracted,
        hints_created,
        files_read,
        errors_json,
        started_at,
        completed_at,
        updated_at,
        COALESCE(started_at, updated_at),
        updated_at,
        '{}'
      FROM codebase_mining_status_old;

      DROP TABLE codebase_mining_status_old;

      CREATE INDEX IF NOT EXISTS idx_codebase_mining_status_status
        ON codebase_mining_status(status, updated_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_codebase_mining_status_status;
      ALTER TABLE codebase_mining_status RENAME TO codebase_mining_status_new;

      CREATE TABLE codebase_mining_status (
        normalized_path TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        content_fingerprint TEXT,
        files_json TEXT NOT NULL DEFAULT '[]',
        facts_extracted INTEGER NOT NULL DEFAULT 0,
        hints_created INTEGER NOT NULL DEFAULT 0,
        files_read INTEGER NOT NULL DEFAULT 0,
        errors_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO codebase_mining_status (
        normalized_path, status, content_fingerprint, files_json,
        facts_extracted, hints_created, files_read, errors_json,
        started_at, completed_at, updated_at
      )
      SELECT
        normalized_path,
        CASE WHEN status = 'never' THEN 'failed' ELSE status END,
        content_fingerprint,
        files_json,
        facts_extracted,
        hints_created,
        files_read,
        errors_json,
        started_at,
        completed_at,
        updated_at
      FROM codebase_mining_status_new;

      DROP TABLE codebase_mining_status_new;

      CREATE INDEX IF NOT EXISTS idx_codebase_mining_status_status
        ON codebase_mining_status(status, updated_at);
    `,
  },
  // Migration 020: project memory source provenance and concrete evidence links.
  {
    name: '020_project_knowledge_sources',
    up: `
      CREATE TABLE IF NOT EXISTS project_knowledge_sources (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('manifest', 'readme', 'instruction_doc', 'config')),
        source_uri TEXT NOT NULL,
        source_title TEXT,
        content_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_uri)
      );

      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_kind
        ON project_knowledge_sources(project_key, source_kind);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_uri
        ON project_knowledge_sources(project_key, source_uri);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_seen
        ON project_knowledge_sources(project_key, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS project_knowledge_kg_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        triple_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, triple_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(triple_id) REFERENCES kg_triples(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_source
        ON project_knowledge_kg_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_triple
        ON project_knowledge_kg_links(project_key, triple_id);

      CREATE TABLE IF NOT EXISTS project_knowledge_wake_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        hint_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, hint_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(hint_id) REFERENCES wake_hints(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_source
        ON project_knowledge_wake_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_hint
        ON project_knowledge_wake_links(project_key, hint_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_hint;
      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_source;
      DROP TABLE IF EXISTS project_knowledge_wake_links;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_triple;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_source;
      DROP TABLE IF EXISTS project_knowledge_kg_links;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_seen;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_uri;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_kind;
      DROP TABLE IF EXISTS project_knowledge_sources;
    `,
  },
  // Migration 021: project code-index read model over codemem snapshots.
  {
    name: '021_project_code_index_bridge',
    up: `
      PRAGMA foreign_keys=OFF;

      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_hint;
      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_source;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_triple;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_source;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_seen;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_uri;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_kind;

      ALTER TABLE project_knowledge_wake_links RENAME TO project_knowledge_wake_links_020;
      ALTER TABLE project_knowledge_kg_links RENAME TO project_knowledge_kg_links_020;
      ALTER TABLE project_knowledge_sources RENAME TO project_knowledge_sources_020;

      CREATE TABLE project_knowledge_sources (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('manifest', 'readme', 'instruction_doc', 'config', 'code_file')),
        source_uri TEXT NOT NULL,
        source_title TEXT,
        content_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_uri)
      );

      INSERT INTO project_knowledge_sources (
        id, project_key, source_kind, source_uri, source_title, content_fingerprint,
        created_at, updated_at, last_seen_at, metadata_json
      )
      SELECT
        id, project_key, source_kind, source_uri, source_title, content_fingerprint,
        created_at, updated_at, last_seen_at, metadata_json
      FROM project_knowledge_sources_020;

      CREATE TABLE project_knowledge_kg_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        triple_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, triple_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(triple_id) REFERENCES kg_triples(id) ON DELETE CASCADE
      );

      INSERT INTO project_knowledge_kg_links (
        id, project_key, source_id, triple_id, source_span_json,
        evidence_strength, created_at, metadata_json
      )
      SELECT
        id, project_key, source_id, triple_id, source_span_json,
        evidence_strength, created_at, metadata_json
      FROM project_knowledge_kg_links_020;

      CREATE TABLE project_knowledge_wake_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        hint_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, hint_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(hint_id) REFERENCES wake_hints(id) ON DELETE CASCADE
      );

      INSERT INTO project_knowledge_wake_links (
        id, project_key, source_id, hint_id, source_span_json,
        evidence_strength, created_at, metadata_json
      )
      SELECT
        id, project_key, source_id, hint_id, source_span_json,
        evidence_strength, created_at, metadata_json
      FROM project_knowledge_wake_links_020;

      DROP TABLE project_knowledge_wake_links_020;
      DROP TABLE project_knowledge_kg_links_020;
      DROP TABLE project_knowledge_sources_020;

      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_kind
        ON project_knowledge_sources(project_key, source_kind);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_uri
        ON project_knowledge_sources(project_key, source_uri);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_seen
        ON project_knowledge_sources(project_key, last_seen_at DESC);

      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_source
        ON project_knowledge_kg_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_triple
        ON project_knowledge_kg_links(project_key, triple_id);

      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_source
        ON project_knowledge_wake_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_hint
        ON project_knowledge_wake_links(project_key, hint_id);

      CREATE TABLE IF NOT EXISTS project_code_index_status (
        project_key TEXT PRIMARY KEY,
        workspace_hash TEXT,
        status TEXT NOT NULL CHECK(status IN ('never','indexing','ready','failed','disabled','paused','excluded')),
        file_count INTEGER NOT NULL DEFAULT 0,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        sync_started_at INTEGER,
        last_indexed_at INTEGER,
        last_synced_at INTEGER,
        updated_at INTEGER NOT NULL,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS project_code_symbols (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        workspace_hash TEXT NOT NULL,
        symbol_id TEXT NOT NULL,
        path_from_root TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        container_name TEXT,
        start_line INTEGER NOT NULL,
        start_character INTEGER NOT NULL,
        end_line INTEGER,
        end_character INTEGER,
        signature TEXT,
        doc_comment TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, symbol_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_code_symbols_lookup
        ON project_code_symbols(project_key, name, kind);
      CREATE INDEX IF NOT EXISTS idx_project_code_symbols_source
        ON project_code_symbols(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_code_symbols_path
        ON project_code_symbols(project_key, path_from_root);

      PRAGMA foreign_keys=ON;
    `,
    down: `
      PRAGMA foreign_keys=OFF;

      DROP INDEX IF EXISTS idx_project_code_symbols_path;
      DROP INDEX IF EXISTS idx_project_code_symbols_source;
      DROP INDEX IF EXISTS idx_project_code_symbols_lookup;
      DROP TABLE IF EXISTS project_code_symbols;
      DROP TABLE IF EXISTS project_code_index_status;

      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_hint;
      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_source;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_triple;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_source;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_seen;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_uri;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_kind;

      ALTER TABLE project_knowledge_wake_links RENAME TO project_knowledge_wake_links_021;
      ALTER TABLE project_knowledge_kg_links RENAME TO project_knowledge_kg_links_021;
      ALTER TABLE project_knowledge_sources RENAME TO project_knowledge_sources_021;

      CREATE TABLE project_knowledge_sources (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('manifest', 'readme', 'instruction_doc', 'config')),
        source_uri TEXT NOT NULL,
        source_title TEXT,
        content_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_uri)
      );

      INSERT INTO project_knowledge_sources (
        id, project_key, source_kind, source_uri, source_title, content_fingerprint,
        created_at, updated_at, last_seen_at, metadata_json
      )
      SELECT
        id, project_key, source_kind, source_uri, source_title, content_fingerprint,
        created_at, updated_at, last_seen_at, metadata_json
      FROM project_knowledge_sources_021
      WHERE source_kind IN ('manifest', 'readme', 'instruction_doc', 'config');

      CREATE TABLE project_knowledge_kg_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        triple_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, triple_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(triple_id) REFERENCES kg_triples(id) ON DELETE CASCADE
      );

      INSERT INTO project_knowledge_kg_links (
        id, project_key, source_id, triple_id, source_span_json,
        evidence_strength, created_at, metadata_json
      )
      SELECT
        l.id, l.project_key, l.source_id, l.triple_id, l.source_span_json,
        l.evidence_strength, l.created_at, l.metadata_json
      FROM project_knowledge_kg_links_021 l
      JOIN project_knowledge_sources s ON s.id = l.source_id;

      CREATE TABLE project_knowledge_wake_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        hint_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, hint_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(hint_id) REFERENCES wake_hints(id) ON DELETE CASCADE
      );

      INSERT INTO project_knowledge_wake_links (
        id, project_key, source_id, hint_id, source_span_json,
        evidence_strength, created_at, metadata_json
      )
      SELECT
        l.id, l.project_key, l.source_id, l.hint_id, l.source_span_json,
        l.evidence_strength, l.created_at, l.metadata_json
      FROM project_knowledge_wake_links_021 l
      JOIN project_knowledge_sources s ON s.id = l.source_id;

      DROP TABLE project_knowledge_wake_links_021;
      DROP TABLE project_knowledge_kg_links_021;
      DROP TABLE project_knowledge_sources_021;

      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_kind
        ON project_knowledge_sources(project_key, source_kind);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_uri
        ON project_knowledge_sources(project_key, source_uri);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_seen
        ON project_knowledge_sources(project_key, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_source
        ON project_knowledge_kg_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_triple
        ON project_knowledge_kg_links(project_key, triple_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_source
        ON project_knowledge_wake_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_hint
        ON project_knowledge_wake_links(project_key, hint_id);

      PRAGMA foreign_keys=ON;
    `,
  },
  // Migration 022: project memory startup briefs
  {
    name: '022_project_memory_startup_briefs',
    up: `
      CREATE TABLE IF NOT EXISTS project_memory_startup_briefs (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL UNIQUE,
        project_key TEXT NOT NULL,
        rendered_text TEXT NOT NULL,
        sections_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        max_chars INTEGER NOT NULL,
        rendered_chars INTEGER NOT NULL,
        source_count INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        provider TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_project_memory_startup_briefs_project_created
        ON project_memory_startup_briefs(project_key, created_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_project_memory_startup_briefs_project_created;
      DROP TABLE IF EXISTS project_memory_startup_briefs;
    `,
  },
  // Migration 023: Browser Gateway managed profiles and audit log.
  {
    name: '023_browser_gateway',
    up: `
      CREATE TABLE IF NOT EXISTS browser_profiles (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('session', 'isolated')),
        -- Milestone 1 only launches Google Chrome. Future Chromium/Edge/extension
        -- support must widen this CHECK in a new migration before storing those values.
        browser TEXT NOT NULL CHECK (browser = 'chrome'),
        user_data_dir TEXT,
        allowed_origins_json TEXT NOT NULL,
        default_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('stopped', 'starting', 'running', 'stopping', 'locked', 'error')),
        debug_port INTEGER,
        debug_endpoint TEXT,
        process_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_launched_at INTEGER,
        last_used_at INTEGER,
        last_login_check_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS browser_audit_entries (
        id TEXT PRIMARY KEY,
        instance_id TEXT,
        provider TEXT NOT NULL,
        profile_id TEXT,
        target_id TEXT,
        action TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        action_class TEXT NOT NULL,
        origin TEXT,
        url TEXT,
        decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'requires_user')),
        outcome TEXT NOT NULL CHECK (outcome IN ('not_run', 'succeeded', 'failed')),
        summary TEXT NOT NULL,
        redaction_applied INTEGER NOT NULL DEFAULT 1,
        screenshot_artifact_id TEXT,
        request_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_browser_profiles_status ON browser_profiles(status);
      CREATE INDEX IF NOT EXISTS idx_browser_audit_created ON browser_audit_entries(created_at);
      CREATE INDEX IF NOT EXISTS idx_browser_audit_profile ON browser_audit_entries(profile_id);
      CREATE INDEX IF NOT EXISTS idx_browser_audit_instance ON browser_audit_entries(instance_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_browser_audit_instance;
      DROP INDEX IF EXISTS idx_browser_audit_profile;
      DROP INDEX IF EXISTS idx_browser_audit_created;
      DROP INDEX IF EXISTS idx_browser_profiles_status;
      DROP TABLE IF EXISTS browser_audit_entries;
      DROP TABLE IF EXISTS browser_profiles;
    `,
  },
  // Migration 024: Browser Gateway grants and approval requests.
  {
    name: '024_browser_gateway_grants_and_approvals',
    up: `
      CREATE TABLE IF NOT EXISTS browser_permission_grants (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('per_action', 'session', 'autonomous')),
        instance_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        profile_id TEXT,
        target_id TEXT,
        allowed_origins_json TEXT NOT NULL,
        allowed_action_classes_json TEXT NOT NULL,
        allow_external_navigation INTEGER NOT NULL DEFAULT 0,
        upload_roots_json TEXT,
        autonomous INTEGER NOT NULL DEFAULT 0,
        requested_by TEXT NOT NULL,
        decided_by TEXT NOT NULL CHECK (decided_by IN ('user', 'timeout', 'revoked')),
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
        reason TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        consumed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS browser_approval_requests (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        instance_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        target_id TEXT,
        tool_name TEXT NOT NULL,
        action TEXT NOT NULL,
        action_class TEXT NOT NULL,
        origin TEXT,
        url TEXT,
        selector TEXT,
        element_context_json TEXT,
        file_path TEXT,
        detected_file_type TEXT,
        proposed_grant_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
        grant_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER
      );

      ALTER TABLE browser_audit_entries ADD COLUMN grant_id TEXT;
      ALTER TABLE browser_audit_entries ADD COLUMN autonomous INTEGER;

      CREATE INDEX IF NOT EXISTS idx_browser_grants_instance_profile_expiry
        ON browser_permission_grants(instance_id, profile_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_browser_grants_target
        ON browser_permission_grants(target_id);
      CREATE INDEX IF NOT EXISTS idx_browser_approvals_status_created
        ON browser_approval_requests(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_browser_approvals_instance
        ON browser_approval_requests(instance_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_browser_approvals_instance;
      DROP INDEX IF EXISTS idx_browser_approvals_status_created;
      DROP INDEX IF EXISTS idx_browser_grants_target;
      DROP INDEX IF EXISTS idx_browser_grants_instance_profile_expiry;
      DROP TABLE IF EXISTS browser_approval_requests;
      DROP TABLE IF EXISTS browser_permission_grants;
    `,
  },
  // Migration 025: add operator-result project memory sources.
  {
    name: '025_operator_result_project_sources',
    up: `
      PRAGMA foreign_keys=OFF;

      DROP INDEX IF EXISTS idx_project_code_symbols_path;
      DROP INDEX IF EXISTS idx_project_code_symbols_source;
      DROP INDEX IF EXISTS idx_project_code_symbols_lookup;
      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_hint;
      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_source;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_triple;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_source;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_seen;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_uri;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_kind;

      ALTER TABLE project_code_symbols RENAME TO project_code_symbols_024;
      ALTER TABLE project_knowledge_wake_links RENAME TO project_knowledge_wake_links_024;
      ALTER TABLE project_knowledge_kg_links RENAME TO project_knowledge_kg_links_024;
      ALTER TABLE project_knowledge_sources RENAME TO project_knowledge_sources_024;

      CREATE TABLE project_knowledge_sources (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('manifest', 'readme', 'instruction_doc', 'config', 'code_file', 'operator_result')),
        source_uri TEXT NOT NULL,
        source_title TEXT,
        content_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_uri)
      );

      INSERT INTO project_knowledge_sources (
        id, project_key, source_kind, source_uri, source_title, content_fingerprint,
        created_at, updated_at, last_seen_at, metadata_json
      )
      SELECT
        id, project_key, source_kind, source_uri, source_title, content_fingerprint,
        created_at, updated_at, last_seen_at, metadata_json
      FROM project_knowledge_sources_024;

      CREATE TABLE project_knowledge_kg_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        triple_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, triple_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(triple_id) REFERENCES kg_triples(id) ON DELETE CASCADE
      );

      INSERT INTO project_knowledge_kg_links (
        id, project_key, source_id, triple_id, source_span_json,
        evidence_strength, created_at, metadata_json
      )
      SELECT
        id, project_key, source_id, triple_id, source_span_json,
        evidence_strength, created_at, metadata_json
      FROM project_knowledge_kg_links_024;

      CREATE TABLE project_knowledge_wake_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        hint_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, hint_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(hint_id) REFERENCES wake_hints(id) ON DELETE CASCADE
      );

      INSERT INTO project_knowledge_wake_links (
        id, project_key, source_id, hint_id, source_span_json,
        evidence_strength, created_at, metadata_json
      )
      SELECT
        id, project_key, source_id, hint_id, source_span_json,
        evidence_strength, created_at, metadata_json
      FROM project_knowledge_wake_links_024;

      CREATE TABLE project_code_symbols (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        workspace_hash TEXT NOT NULL,
        symbol_id TEXT NOT NULL,
        path_from_root TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        container_name TEXT,
        start_line INTEGER NOT NULL,
        start_character INTEGER NOT NULL,
        end_line INTEGER,
        end_character INTEGER,
        signature TEXT,
        doc_comment TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, symbol_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE
      );

      INSERT INTO project_code_symbols (
        id, project_key, source_id, workspace_hash, symbol_id, path_from_root,
        name, kind, container_name, start_line, start_character, end_line,
        end_character, signature, doc_comment, created_at, updated_at, metadata_json
      )
      SELECT
        id, project_key, source_id, workspace_hash, symbol_id, path_from_root,
        name, kind, container_name, start_line, start_character, end_line,
        end_character, signature, doc_comment, created_at, updated_at, metadata_json
      FROM project_code_symbols_024;

      DROP TABLE project_code_symbols_024;
      DROP TABLE project_knowledge_wake_links_024;
      DROP TABLE project_knowledge_kg_links_024;
      DROP TABLE project_knowledge_sources_024;

      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_kind
        ON project_knowledge_sources(project_key, source_kind);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_uri
        ON project_knowledge_sources(project_key, source_uri);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_seen
        ON project_knowledge_sources(project_key, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_source
        ON project_knowledge_kg_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_triple
        ON project_knowledge_kg_links(project_key, triple_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_source
        ON project_knowledge_wake_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_hint
        ON project_knowledge_wake_links(project_key, hint_id);
      CREATE INDEX IF NOT EXISTS idx_project_code_symbols_lookup
        ON project_code_symbols(project_key, name, kind);
      CREATE INDEX IF NOT EXISTS idx_project_code_symbols_source
        ON project_code_symbols(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_code_symbols_path
        ON project_code_symbols(project_key, path_from_root);

      PRAGMA foreign_keys=ON;
    `,
    down: `
      PRAGMA foreign_keys=OFF;

      DROP INDEX IF EXISTS idx_project_code_symbols_path;
      DROP INDEX IF EXISTS idx_project_code_symbols_source;
      DROP INDEX IF EXISTS idx_project_code_symbols_lookup;
      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_hint;
      DROP INDEX IF EXISTS idx_project_knowledge_wake_links_project_source;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_triple;
      DROP INDEX IF EXISTS idx_project_knowledge_kg_links_project_source;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_seen;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_uri;
      DROP INDEX IF EXISTS idx_project_knowledge_sources_project_kind;

      ALTER TABLE project_code_symbols RENAME TO project_code_symbols_025;
      ALTER TABLE project_knowledge_wake_links RENAME TO project_knowledge_wake_links_025;
      ALTER TABLE project_knowledge_kg_links RENAME TO project_knowledge_kg_links_025;
      ALTER TABLE project_knowledge_sources RENAME TO project_knowledge_sources_025;

      CREATE TABLE project_knowledge_sources (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('manifest', 'readme', 'instruction_doc', 'config', 'code_file')),
        source_uri TEXT NOT NULL,
        source_title TEXT,
        content_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_uri)
      );

      INSERT INTO project_knowledge_sources (
        id, project_key, source_kind, source_uri, source_title, content_fingerprint,
        created_at, updated_at, last_seen_at, metadata_json
      )
      SELECT
        id, project_key, source_kind, source_uri, source_title, content_fingerprint,
        created_at, updated_at, last_seen_at, metadata_json
      FROM project_knowledge_sources_025
      WHERE source_kind IN ('manifest', 'readme', 'instruction_doc', 'config', 'code_file');

      CREATE TABLE project_knowledge_kg_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        triple_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, triple_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(triple_id) REFERENCES kg_triples(id) ON DELETE CASCADE
      );

      INSERT INTO project_knowledge_kg_links (
        id, project_key, source_id, triple_id, source_span_json,
        evidence_strength, created_at, metadata_json
      )
      SELECT
        l.id, l.project_key, l.source_id, l.triple_id, l.source_span_json,
        l.evidence_strength, l.created_at, l.metadata_json
      FROM project_knowledge_kg_links_025 l
      JOIN project_knowledge_sources s ON s.id = l.source_id;

      CREATE TABLE project_knowledge_wake_links (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        hint_id TEXT NOT NULL,
        source_span_json TEXT NOT NULL DEFAULT '{"kind":"whole_source"}',
        evidence_strength REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, source_id, hint_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE,
        FOREIGN KEY(hint_id) REFERENCES wake_hints(id) ON DELETE CASCADE
      );

      INSERT INTO project_knowledge_wake_links (
        id, project_key, source_id, hint_id, source_span_json,
        evidence_strength, created_at, metadata_json
      )
      SELECT
        l.id, l.project_key, l.source_id, l.hint_id, l.source_span_json,
        l.evidence_strength, l.created_at, l.metadata_json
      FROM project_knowledge_wake_links_025 l
      JOIN project_knowledge_sources s ON s.id = l.source_id;

      CREATE TABLE project_code_symbols (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        source_id TEXT NOT NULL,
        workspace_hash TEXT NOT NULL,
        symbol_id TEXT NOT NULL,
        path_from_root TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        container_name TEXT,
        start_line INTEGER NOT NULL,
        start_character INTEGER NOT NULL,
        end_line INTEGER,
        end_character INTEGER,
        signature TEXT,
        doc_comment TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(project_key, symbol_id),
        FOREIGN KEY(source_id) REFERENCES project_knowledge_sources(id) ON DELETE CASCADE
      );

      INSERT INTO project_code_symbols (
        id, project_key, source_id, workspace_hash, symbol_id, path_from_root,
        name, kind, container_name, start_line, start_character, end_line,
        end_character, signature, doc_comment, created_at, updated_at, metadata_json
      )
      SELECT
        c.id, c.project_key, c.source_id, c.workspace_hash, c.symbol_id, c.path_from_root,
        c.name, c.kind, c.container_name, c.start_line, c.start_character, c.end_line,
        c.end_character, c.signature, c.doc_comment, c.created_at, c.updated_at, c.metadata_json
      FROM project_code_symbols_025 c
      JOIN project_knowledge_sources s ON s.id = c.source_id;

      DROP TABLE project_code_symbols_025;
      DROP TABLE project_knowledge_wake_links_025;
      DROP TABLE project_knowledge_kg_links_025;
      DROP TABLE project_knowledge_sources_025;

      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_kind
        ON project_knowledge_sources(project_key, source_kind);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_project_uri
        ON project_knowledge_sources(project_key, source_uri);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_sources_seen
        ON project_knowledge_sources(project_key, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_source
        ON project_knowledge_kg_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_kg_links_project_triple
        ON project_knowledge_kg_links(project_key, triple_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_source
        ON project_knowledge_wake_links(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_wake_links_project_hint
        ON project_knowledge_wake_links(project_key, hint_id);
      CREATE INDEX IF NOT EXISTS idx_project_code_symbols_lookup
        ON project_code_symbols(project_key, name, kind);
      CREATE INDEX IF NOT EXISTS idx_project_code_symbols_source
        ON project_code_symbols(project_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_project_code_symbols_path
        ON project_code_symbols(project_key, path_from_root);

      PRAGMA foreign_keys=ON;
    `,
  },
  // Migration 026: thread destinations for automation wakeups.
  {
    name: '026_automation_thread_destinations',
    up: `
      CREATE TABLE IF NOT EXISTS automation_thread_destinations (
        automation_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        session_id TEXT,
        history_entry_id TEXT,
        revive_if_archived INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(automation_id) REFERENCES automations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_automation_thread_destinations_instance
        ON automation_thread_destinations(instance_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_automation_thread_destinations_instance;
      DROP TABLE IF EXISTS automation_thread_destinations;
    `,
  },
  // Migration 027: orchestrator-owned MCP server registry.
  {
    name: '027_orchestrator_mcp_servers',
    up: `
      CREATE TABLE IF NOT EXISTS orchestrator_mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('orchestrator','orchestrator-bootstrap','orchestrator-codemem')),
        transport TEXT NOT NULL CHECK (transport IN ('stdio','sse','http')),
        command TEXT,
        args_json TEXT,
        url TEXT,
        headers_json TEXT,
        env_json TEXT,
        env_secrets_encrypted_json TEXT,
        auto_connect INTEGER NOT NULL DEFAULT 0 CHECK (auto_connect IN (0,1)),
        inject_into_json TEXT NOT NULL DEFAULT '["claude","codex","gemini","copilot"]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orchestrator_mcp_scope
        ON orchestrator_mcp_servers(scope);
    `,
    down: `
      DROP INDEX IF EXISTS idx_orchestrator_mcp_scope;
      DROP TABLE IF EXISTS orchestrator_mcp_servers;
    `,
  },
  // Migration 028: canonical shared MCP server registry.
  {
    name: '028_shared_mcp_servers',
    up: `
      CREATE TABLE IF NOT EXISTS shared_mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        transport TEXT NOT NULL CHECK (transport IN ('stdio','sse','http')),
        command TEXT,
        args_json TEXT,
        url TEXT,
        headers_json TEXT,
        env_json TEXT,
        env_secrets_encrypted_json TEXT,
        targets_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS shared_mcp_servers;
    `,
  },
  // Migration 029: encrypt secret-like MCP headers separately from public header metadata.
  {
    name: '029_mcp_header_secret_storage',
    up: `
      ALTER TABLE orchestrator_mcp_servers ADD COLUMN headers_secrets_encrypted_json TEXT;
      ALTER TABLE shared_mcp_servers ADD COLUMN headers_secrets_encrypted_json TEXT;
    `,
    down: `
      ALTER TABLE shared_mcp_servers DROP COLUMN headers_secrets_encrypted_json;
      ALTER TABLE orchestrator_mcp_servers DROP COLUMN headers_secrets_encrypted_json;
    `,
  },
];

/**
 * Create all tables for the RLM database.
 * Uses better-sqlite3's exec method for SQL execution (not child_process).
 */
export function createTables(db: SqliteDriver): void {
  // Context Stores table
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_stores (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      total_tokens INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      access_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL,
      config_json TEXT,
      UNIQUE(instance_id)
    );

    CREATE INDEX IF NOT EXISTS idx_stores_instance
      ON context_stores(instance_id);
    CREATE INDEX IF NOT EXISTS idx_stores_accessed
      ON context_stores(last_accessed);
  `);

  // Context Sections table
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_sections (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      checksum TEXT,
      depth INTEGER DEFAULT 0,
      summarizes_json TEXT,
      parent_summary_id TEXT,
      pending_summary INTEGER DEFAULT 0,
      summary_priority INTEGER DEFAULT 0,
      last_summary_attempt INTEGER,
      file_path TEXT,
      language TEXT,
      source_url TEXT,
      created_at INTEGER NOT NULL,
      content_file TEXT,
      content_inline TEXT,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sections_store
      ON context_sections(store_id);
    CREATE INDEX IF NOT EXISTS idx_sections_type
      ON context_sections(type);
    CREATE INDEX IF NOT EXISTS idx_sections_offset
      ON context_sections(store_id, start_offset);
    CREATE INDEX IF NOT EXISTS idx_sections_depth
      ON context_sections(store_id, depth);
  `);
  ensureContextSectionSummaryColumns(db);

  // Search Index table (inverted index)
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT NOT NULL,
      term TEXT NOT NULL,
      section_id TEXT NOT NULL,
      line_number INTEGER,
      position INTEGER,
      snippet TEXT,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES context_sections(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_search_store_term
      ON search_index(store_id, term);
    CREATE INDEX IF NOT EXISTS idx_search_section
      ON search_index(section_id);
  `);

  // RLM Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS rlm_sessions (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      total_queries INTEGER DEFAULT 0,
      total_root_tokens INTEGER DEFAULT 0,
      total_sub_query_tokens INTEGER DEFAULT 0,
      estimated_direct_tokens INTEGER DEFAULT 0,
      token_savings_percent REAL DEFAULT 0,
      queries_json TEXT,
      recursive_calls_json TEXT,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_store
      ON rlm_sessions(store_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_instance
      ON rlm_sessions(instance_id);
  `);

  // Outcomes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      success INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      duration_ms INTEGER,
      token_usage INTEGER,
      agent_id TEXT,
      model TEXT,
      error_type TEXT,
      prompt_hash TEXT,
      tools_json TEXT,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outcomes_task
      ON outcomes(task_type);
    CREATE INDEX IF NOT EXISTS idx_outcomes_timestamp
      ON outcomes(timestamp);
    CREATE INDEX IF NOT EXISTS idx_outcomes_agent
      ON outcomes(agent_id);
  `);

  // Patterns table
  db.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      effectiveness REAL NOT NULL,
      sample_size INTEGER NOT NULL,
      last_updated INTEGER NOT NULL,
      metadata_json TEXT,
      UNIQUE(type, key)
    );

    CREATE INDEX IF NOT EXISTS idx_patterns_type
      ON patterns(type);
    CREATE INDEX IF NOT EXISTS idx_patterns_effectiveness
      ON patterns(effectiveness);
  `);

  // Experiences table
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL UNIQUE,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      success_patterns_json TEXT,
      failure_patterns_json TEXT,
      example_prompts_json TEXT,
      last_updated INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_experiences_task
      ON experiences(task_type);
  `);

  // Insights table
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      confidence REAL NOT NULL,
      supporting_patterns_json TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_insights_type
      ON insights(type);
    CREATE INDEX IF NOT EXISTS idx_insights_confidence
      ON insights(confidence);
  `);

  // Vectors table (for semantic search)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      content_preview TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (store_id) REFERENCES context_stores(id) ON DELETE CASCADE,
      FOREIGN KEY (section_id) REFERENCES context_sections(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_vectors_store
      ON vectors(store_id);
    CREATE INDEX IF NOT EXISTS idx_vectors_section
      ON vectors(section_id);
  `);
}

/**
 * Create the migrations tracking table.
 */
export function createMigrationsTable(db: SqliteDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL,
      checksum TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_migrations_name ON _migrations(name);
  `);
}

/**
 * Compute checksum for a migration.
 */
export function computeMigrationChecksum(migration: Migration): string {
  return crypto.createHash('sha256').update(migration.up).digest('hex').substring(0, 16);
}

/**
 * Get all applied migrations.
 */
export function getAppliedMigrations(db: SqliteDriver): MigrationRow[] {
  const stmt = db.prepare(`SELECT * FROM _migrations ORDER BY id ASC`);
  return stmt.all() as MigrationRow[];
}

/**
 * Run pending migrations.
 *
 * @param db - Database instance
 * @param onMigrationApplied - Callback when a migration is applied
 * @param onMigrationsComplete - Callback when all migrations are complete
 */
export function runMigrations(
  db: SqliteDriver,
  onMigrationApplied?: (name: string) => void,
  onMigrationsComplete?: (applied: number) => void
): void {
  const appliedMigrations = getAppliedMigrations(db);
  const appliedNames = new Set(appliedMigrations.map(m => m.name));

  // Verify checksums of applied migrations haven't changed
  for (const applied of appliedMigrations) {
    const migration = MIGRATIONS.find(m => m.name === applied.name);
    if (migration) {
      const expectedChecksum = computeMigrationChecksum(migration);
      if (applied.checksum !== expectedChecksum) {
        throw new Error(
          `Migration checksum mismatch for "${applied.name}". ` +
          `Expected ${expectedChecksum}, got ${applied.checksum}. ` +
          `Migration files should not be modified after being applied.`
        );
      }
    }
  }

  // Apply pending migrations in a transaction
  const pendingMigrations = MIGRATIONS.filter(m => !appliedNames.has(m.name));

  if (pendingMigrations.length === 0) {
    return;
  }

  const applyMigrations = db.transaction(() => {
    for (const migration of pendingMigrations) {
      try {
        db.exec(migration.up);

        const checksum = computeMigrationChecksum(migration);
        const insertStmt = db.prepare(`
          INSERT INTO _migrations (name, applied_at, checksum)
          VALUES (?, ?, ?)
        `);
        insertStmt.run(migration.name, Date.now(), checksum);

        onMigrationApplied?.(migration.name);
      } catch (error) {
        throw new Error(
          `Failed to apply migration "${migration.name}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  });

  applyMigrations();
  onMigrationsComplete?.(pendingMigrations.length);
}

/**
 * Get schema information.
 */
export function getSchemaInfo(
  db: SqliteDriver,
  schemaVersion: number
): {
  version: number;
  appliedMigrations: MigrationRow[];
  pendingMigrations: string[];
} {
  const applied = getAppliedMigrations(db);
  const appliedNames = new Set(applied.map(m => m.name));
  const pending = MIGRATIONS
    .filter(m => !appliedNames.has(m.name))
    .map(m => m.name);

  return {
    version: schemaVersion,
    appliedMigrations: applied,
    pendingMigrations: pending,
  };
}
