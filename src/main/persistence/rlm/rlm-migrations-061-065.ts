import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_061_065: Migration[] = [
  {
    // Workspace Secret Card: user-supplied credentials captured by a masked inline
    // card, encrypted with Electron safeStorage, and handed to agents only as an
    // opaque `secret://<name>` reference.
    //
    // `workspace_secrets` holds the ciphertext plus metadata safe to display.
    // `workspace_secret_audit` is the append-only trail of every mutation and every
    // resolution — it records that a secret was used, never the value.
    //
    // Deliberately NO foreign key on workspace_id: workspace identity in this app is
    // derived from the working directory at read time (`toWorkspaceId`, and the
    // stricter `toSecretWorkspaceId` used here), not persisted. There is no
    // `workspaces` table for an FK to reference. This follows the precedent set by
    // `034_automation_workspace_id`.
    //
    // Spec: docs/plans/2026-08-23-workspace-secret-card_spec_planned.md (§5.4, §6).
    name: '061_workspace_secrets',
    up: `
      CREATE TABLE IF NOT EXISTS workspace_secrets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT '',
        value_enc TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        UNIQUE(workspace_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_secrets_workspace
        ON workspace_secrets(workspace_id);

      CREATE TABLE IF NOT EXISTS workspace_secret_audit (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        secret_name TEXT NOT NULL,
        event TEXT NOT NULL CHECK (event IN ('created', 'updated', 'resolved', 'declined', 'forgotten')),
        instance_id TEXT,
        purpose TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_secret_audit_workspace
        ON workspace_secret_audit(workspace_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspace_secret_audit_secret
        ON workspace_secret_audit(workspace_id, secret_name, at DESC);
    `,
    down: `
      DROP TABLE IF EXISTS workspace_secret_audit;
      DROP TABLE IF EXISTS workspace_secrets;
    `,
  },
  {
    // Workspace-bound MCP connectors. Distinct from orchestrator/shared/provider-user
    // scopes: those are reusable across workspaces and must never persist secret://.
    // These records are keyed by canonical toSecretWorkspaceId + target provider and
    // keep opaque secret:// env refs (ordinary sensitive fields still use MCP
    // encrypted-at-rest storage). Spawn materialises matching local instances only.
    name: '062_workspace_mcp_connectors',
    up: `
      CREATE TABLE IF NOT EXISTS workspace_mcp_connectors (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        transport TEXT NOT NULL CHECK (transport IN ('stdio','sse','http')),
        command TEXT,
        args_json TEXT,
        url TEXT,
        headers_json TEXT,
        headers_secrets_encrypted_json TEXT,
        env_json TEXT,
        env_secrets_encrypted_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(workspace_id, provider, name)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_mcp_connectors_workspace
        ON workspace_mcp_connectors(workspace_id, provider);
    `,
    down: `
      DROP TABLE IF EXISTS workspace_mcp_connectors;
    `,
  },
  {
    // Provider account pools: a usage limit belongs to the Claude/Codex account
    // profile that hit it, not to the whole provider. Existing rows default to
    // '' which means the legacy profile, so they keep gating exactly as before.
    // Spec: docs/superpowers/specs/2026-09-13-provider-account-pools_spec_planned.md §6.5.
    name: '063_provider_limit_events_account_profile',
    up: `
      ALTER TABLE provider_limit_events ADD COLUMN account_profile_id TEXT NOT NULL DEFAULT '';
      DROP INDEX IF EXISTS idx_provider_limit_events_active;
      CREATE INDEX IF NOT EXISTS idx_provider_limit_events_active
        ON provider_limit_events(provider, account_profile_id, model, resume_at DESC, detected_at DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_provider_limit_events_active;
      ALTER TABLE provider_limit_events DROP COLUMN account_profile_id;
      CREATE INDEX IF NOT EXISTS idx_provider_limit_events_active
        ON provider_limit_events(provider, model, resume_at DESC, detected_at DESC);
    `,
  },
  {
    name: '064_browser_persistent_grants',
    // SQLite cannot alter the original mode CHECK constraint. Rebuild within
    // runMigrations' transaction, preserving every grant and all lookup indexes.
    up: `
      CREATE TABLE browser_permission_grants_next (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('per_action', 'session', 'autonomous', 'persistent')),
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
        consumed_at INTEGER,
        node_id TEXT,
        user_approved_credentials INTEGER NOT NULL DEFAULT 0 CHECK (user_approved_credentials IN (0, 1))
      );
      INSERT INTO browser_permission_grants_next (
        id, mode, instance_id, provider, profile_id, target_id, allowed_origins_json,
        allowed_action_classes_json, allow_external_navigation, upload_roots_json,
        autonomous, requested_by, decided_by, decision, reason, expires_at,
        created_at, revoked_at, consumed_at, node_id
      ) SELECT id, mode, instance_id, provider, profile_id, target_id, allowed_origins_json,
        allowed_action_classes_json, allow_external_navigation, upload_roots_json,
        autonomous, requested_by, decided_by, decision, reason, expires_at,
        created_at, revoked_at, consumed_at, node_id FROM browser_permission_grants;
      DROP TABLE browser_permission_grants;
      ALTER TABLE browser_permission_grants_next RENAME TO browser_permission_grants;
      CREATE INDEX idx_browser_grants_instance_profile_expiry
        ON browser_permission_grants(instance_id, profile_id, expires_at);
      CREATE INDEX idx_browser_grants_target ON browser_permission_grants(target_id);
      CREATE INDEX idx_browser_grants_instance_node_expiry
        ON browser_permission_grants(instance_id, node_id, expires_at);
      CREATE INDEX idx_browser_grants_persistent_scope
        ON browser_permission_grants(mode, profile_id, node_id, expires_at);
    `,
    // Reverting must expire standing grants, never turn them into unbounded
    // legacy autonomous grants. The expanded mode constraint is harmless.
    down: `
      UPDATE browser_permission_grants SET expires_at = created_at, mode = 'autonomous'
        WHERE mode = 'persistent';
      DROP INDEX idx_browser_grants_persistent_scope;
      ALTER TABLE browser_permission_grants DROP COLUMN user_approved_credentials;
    `,
  },
  {
    // Login fingerprints and re-login recipes for browser.check_session. They
    // were an in-memory Map keyed by the tab's own profileId, so a restart lost
    // every recipe and a shared tab's recipe never reached the next tab.
    // `scope` is the credential-authorization scope (credentialScopeForProfile):
    // the managed profileId, or the node scope for shared tabs. relogin_json
    // holds a vault item reference and selectors only, never a secret.
    name: '065_browser_login_recipes',
    up: `
      CREATE TABLE IF NOT EXISTS browser_login_recipes (
        scope TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('profile', 'node')),
        origin TEXT NOT NULL,
        login_url TEXT NOT NULL,
        logged_in_markers_json TEXT NOT NULL,
        relogin_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_outcome TEXT,
        last_outcome_reason TEXT,
        last_outcome_at INTEGER,
        PRIMARY KEY (scope, origin)
      );
    `,
    down: `
      DROP TABLE IF EXISTS browser_login_recipes;
    `,
  },
];
