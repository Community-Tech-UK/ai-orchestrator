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
];
