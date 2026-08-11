import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_056_060: Migration[] = [
  {
    // WS-A4: GovernedProposal store + memory promotion review inbox.
    // `governed_proposals` is the durable, human-reviewable queue of
    // agent-derived memory/skill/hook/rule candidates awaiting a decision.
    // `proposal_audit` is the append-only decision trail for every mutation.
    // Spec: docs/plans/2026-07-*-governed-proposal-review-inbox (WS-A4).
    name: '056_governed_proposals',
    up: `
      CREATE TABLE IF NOT EXISTS governed_proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('memory', 'skill', 'hook', 'rule')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
        provenance TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        source_session_id TEXT,
        source_message_id TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT,
        decision_rationale TEXT,
        reinforcements INTEGER NOT NULL DEFAULT 1,
        related_ids_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_governed_proposals_kind
        ON governed_proposals(kind);
      CREATE INDEX IF NOT EXISTS idx_governed_proposals_status
        ON governed_proposals(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_governed_proposals_created_at
        ON governed_proposals(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_governed_proposals_source_session
        ON governed_proposals(source_session_id);

      CREATE TABLE IF NOT EXISTS proposal_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (
          action IN ('created', 'approved', 'rejected', 'edited', 'superseded', 'reinforced', 'backfilled')
        ),
        actor TEXT,
        timestamp INTEGER NOT NULL,
        reason TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (proposal_id) REFERENCES governed_proposals(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_proposal_audit_proposal
        ON proposal_audit(proposal_id, timestamp DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_proposal_audit_proposal;
      DROP TABLE IF EXISTS proposal_audit;
      DROP INDEX IF EXISTS idx_governed_proposals_source_session;
      DROP INDEX IF EXISTS idx_governed_proposals_created_at;
      DROP INDEX IF EXISTS idx_governed_proposals_status;
      DROP INDEX IF EXISTS idx_governed_proposals_kind;
      DROP TABLE IF EXISTS governed_proposals;
    `,
  },
  {
    // WS-B8: learning-loop scan checkpoints. One row per workspace scope
    // ('__global__' when unscoped) recording the durable cursor for the
    // bounded, checkpointed fail->fix correction scan
    // (`src/main/learning/learning-scan-service.ts`) plus a snapshot of the
    // last run's counters for the "scan status" IPC read. Spec:
    // docs/plans/2026-07-30-sibling-audit-round2_plan.md (WS-B8).
    name: '057_learning_scan_checkpoints',
    up: `
      CREATE TABLE IF NOT EXISTS learning_scan_checkpoints (
        scope_key TEXT PRIMARY KEY,
        last_scanned_ended_at INTEGER NOT NULL DEFAULT 0,
        last_scanned_entry_id TEXT,
        last_scan_started_at INTEGER,
        last_scan_completed_at INTEGER,
        sessions_scanned_last_run INTEGER NOT NULL DEFAULT 0,
        sessions_scanned_total INTEGER NOT NULL DEFAULT 0,
        proposals_created_last_run INTEGER NOT NULL DEFAULT 0,
        proposals_reinforced_last_run INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS learning_scan_checkpoints;
    `,
  },
  {
    // Credential authorizations: persist the three optional scope fields that
    // the record type has always carried but the SQLite store never wrote, so
    // they survive a restart.
    //  - allowed_selectors_json: losing it silently WIDENS an authorization
    //    (the control allowlist disappears), so this one is a real hole.
    //  - allowed_secret_types_json: losing it breaks every secret_fill grant.
    //  - allowed_sender_domains_json: sender domains permitted to carry this
    //    origin's one-time codes (e.g. GOV.UK Notify for a *.gov.uk service),
    //    which the origin-relation rule alone would refuse.
    // Spec: docs/plans/browser-gateway-credential-login_plan.md
    name: '058_credential_authorization_scope_fields',
    up: `
      ALTER TABLE browser_credential_authorizations
        ADD COLUMN allowed_secret_types_json TEXT;
      ALTER TABLE browser_credential_authorizations
        ADD COLUMN allowed_selectors_json TEXT;
      ALTER TABLE browser_credential_authorizations
        ADD COLUMN allowed_sender_domains_json TEXT;
    `,
    down: `
      -- SQLite cannot drop columns on older engines; leaving them is harmless
      -- because the store treats each as optional.
    `,
  },
];
