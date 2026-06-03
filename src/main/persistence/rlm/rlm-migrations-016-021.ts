import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_016_021: Migration[] = [
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
];
