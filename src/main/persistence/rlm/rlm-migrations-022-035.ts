import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_022_035: Migration[] = [
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
  // Migration 030: per-machine bot display name for channel connections.
  {
    name: '030_channel_display_name',
    up: `
      ALTER TABLE channel_credentials ADD COLUMN display_name TEXT;
    `,
    down: `
      ALTER TABLE channel_credentials DROP COLUMN display_name;
    `,
  },
  // Migration 031: automation failure tracking for resilience (auto-disable
  // after repeated failures + a per-automation last-failure summary).
  {
    name: '031_automation_failure_tracking',
    up: `
      ALTER TABLE automations ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE automations ADD COLUMN last_failure_at INTEGER;
      ALTER TABLE automations ADD COLUMN last_failure_reason TEXT;
    `,
    down: `
      ALTER TABLE automations DROP COLUMN last_failure_reason;
      ALTER TABLE automations DROP COLUMN last_failure_at;
      ALTER TABLE automations DROP COLUMN consecutive_failures;
    `,
  },
  // Migration 032: per-run retry tracking for exponential backoff (B10b).
  // attempt   — 1-based attempt number for this run record (1 = first try).
  // max_attempts — maximum attempts allowed for this run's automation action.
  //               Stored on the run so retries inherit the config snapshot.
  {
    name: '032_automation_run_retry_tracking',
    up: `
      ALTER TABLE automation_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE automation_runs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1;
    `,
    down: `
      ALTER TABLE automation_runs DROP COLUMN max_attempts;
      ALTER TABLE automation_runs DROP COLUMN attempt;
    `,
  },
  // Migration 033: durable pending-retry state for automation runs (B10b).
  //
  // When a retry timer is armed in AutomationScheduler, these three fields are
  // written to the failed run so the scheduler can re-arm the timer after an
  // app restart.  They are cleared when the retry fires or is cancelled.
  //
  //   next_retry_at           — epoch ms when the retry should fire
  //   next_retry_attempt      — the 1-based attempt number of the planned retry
  //   next_retry_max_attempts — max attempts (carried from original run)
  {
    name: '033_automation_run_pending_retry_durability',
    up: `
      ALTER TABLE automation_runs ADD COLUMN next_retry_at INTEGER;
      ALTER TABLE automation_runs ADD COLUMN next_retry_attempt INTEGER;
      ALTER TABLE automation_runs ADD COLUMN next_retry_max_attempts INTEGER;
    `,
    down: `
      ALTER TABLE automation_runs DROP COLUMN next_retry_max_attempts;
      ALTER TABLE automation_runs DROP COLUMN next_retry_attempt;
      ALTER TABLE automation_runs DROP COLUMN next_retry_at;
    `,
  },
  // Migration 034: per-automation workspace id so automations can be grouped and
  // filtered by the project (working directory) they target. The value mirrors
  // the renderer's normalized project key (trim + lowercase; blank -> sentinel).
  // Keep the backfill in sync with `toWorkspaceId` in shared/utils/workspace-key.ts.
  {
    name: '034_automation_workspace_id',
    up: `
      ALTER TABLE automations ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '__no_workspace__';

      UPDATE automations
      SET workspace_id = COALESCE(
        NULLIF(lower(trim(json_extract(action_json, '$.workingDirectory'))), ''),
        '__no_workspace__'
      );

      CREATE INDEX IF NOT EXISTS idx_automations_workspace
        ON automations(workspace_id);
    `,
    down: `
      DROP INDEX IF EXISTS idx_automations_workspace;
      ALTER TABLE automations DROP COLUMN workspace_id;
    `,
  },
  // Migration 035: durable evidence records for the evidence-resolver ladder (A4).
  //
  // Persists each completion-attempt evidence record keyed by (loop_id, target)
  // so the coordinator can query history across restarts.
  //
  // state values:
  //   'fixed'    — the target was checked and no verify command is present
  //                (manually-reviewed; operator accepted the work).
  //   'verified' — independent external authority passed (verify command exited 0).
  //   'reviewed' — cross-model fresh-eyes review cleared the work (review authority).
  //
  // These three states are intentionally distinct columns of the same enum: they
  // have different authority levels and are queried separately by callers.
  {
    name: '035_evidence_records',
    up: `
      CREATE TABLE IF NOT EXISTS evidence_records (
        id               TEXT PRIMARY KEY,
        loop_id          TEXT NOT NULL,
        target           TEXT NOT NULL,
        kind             TEXT NOT NULL,
        state            TEXT NOT NULL CHECK(state IN ('fixed', 'verified', 'reviewed')),
        timestamp        INTEGER NOT NULL,
        source_metadata  TEXT NOT NULL DEFAULT '{}',
        created_at       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_records_loop
        ON evidence_records(loop_id, timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_evidence_records_target
        ON evidence_records(loop_id, target, state);
    `,
    down: `
      DROP INDEX IF EXISTS idx_evidence_records_target;
      DROP INDEX IF EXISTS idx_evidence_records_loop;
      DROP TABLE IF EXISTS evidence_records;
    `,
  },
];
