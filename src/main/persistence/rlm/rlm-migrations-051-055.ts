import { AUTOMATION_DEDUPE_UP_SQL } from './automation-dedupe-schema';
import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_051_055: Migration[] = [
  {
    // Fable WS12: hash-pinned trust for project-sourced instruction files.
    name: '051_instruction_file_trust',
    up: `
      CREATE TABLE IF NOT EXISTS instruction_file_trust (
        canonical_path TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'user'
      );
    `,
    down: `
      DROP TABLE IF EXISTS instruction_file_trust;
    `,
  },
  {
    // One-off consolidation of byte-identical duplicate automations left behind
    // before agent-initiated creation became idempotent. See
    // `automation-dedupe-schema.ts` for the safety rules this merge obeys.
    name: '052_dedupe_identical_automations',
    up: AUTOMATION_DEDUPE_UP_SQL,
    // Deliberate no-op: a merge cannot be reversed. The loser rows are gone and
    // their surviving runs now belong to the keeper.
    down: '-- Irreversible: the merged automations no longer exist.',
  },
  {
    // Skill observability: one row per skill injection/activation, plus a
    // persistent per-skill control (enabled | suggest-only | disabled) honoured
    // by the loader at selection time. Spec:
    // 2026-07-23-skill-observability-and-design-skills_spec_planned.md
    name: '053_skill_attribution',
    up: `
      CREATE TABLE IF NOT EXISTS skill_activations (
        id TEXT PRIMARY KEY,
        skill_name TEXT NOT NULL,
        skill_source TEXT NOT NULL DEFAULT 'builtin',
        instance_id TEXT,
        session_id TEXT,
        turn_key TEXT,
        matched_by TEXT NOT NULL,
        matched_trigger TEXT,
        match_score REAL,
        tokens_injected INTEGER NOT NULL DEFAULT 0,
        auto_selected INTEGER NOT NULL DEFAULT 1,
        followed_by_error INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skill_activations_skill_time
        ON skill_activations(skill_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skill_activations_instance_time
        ON skill_activations(instance_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS skill_controls (
        skill_name TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'enabled',
        reason TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
    down: `
      DROP INDEX IF EXISTS idx_skill_activations_skill_time;
      DROP INDEX IF EXISTS idx_skill_activations_instance_time;
      DROP TABLE IF EXISTS skill_activations;
      DROP TABLE IF EXISTS skill_controls;
    `,
  },
  {
    name: '054_local_ai_guard',
    up: `
      CREATE TABLE IF NOT EXISTS local_ai_targets (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        location_type TEXT NOT NULL,
        worker_node_id TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        base_url TEXT NOT NULL CHECK (
          base_url = rtrim(base_url, '/')
          AND instr(base_url, '?') = 0
          AND instr(base_url, '#') = 0
          AND (
            instr(substr(base_url, instr(base_url, '://') + 3), '@') = 0
            OR (
              instr(substr(base_url, instr(base_url, '://') + 3), '/') > 0
              AND instr(substr(base_url, instr(base_url, '://') + 3), '@')
                > instr(substr(base_url, instr(base_url, '://') + 3), '/')
            )
          )
        ),
        config_json TEXT NOT NULL,
        paused_until INTEGER,
        retired_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_ai_targets_active_endpoint_identity
        ON local_ai_targets(location_type, worker_node_id, provider, endpoint_id, rtrim(base_url, '/'))
        WHERE lifecycle != 'retired';

      CREATE TABLE IF NOT EXISTS local_ai_health_samples (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        layer TEXT NOT NULL,
        check_type TEXT NOT NULL,
        ok INTEGER NOT NULL,
        required INTEGER NOT NULL,
        affected_roles_json TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        failure_code TEXT,
        message TEXT,
        evidence_json TEXT NOT NULL,
        origin TEXT NOT NULL,
        FOREIGN KEY (target_id) REFERENCES local_ai_targets(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_local_ai_health_samples_target_time
        ON local_ai_health_samples(target_id, checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_health_samples_time
        ON local_ai_health_samples(checked_at DESC);

      CREATE TABLE IF NOT EXISTS local_ai_incidents (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        state TEXT NOT NULL,
        severity TEXT NOT NULL,
        failure_code TEXT NOT NULL,
        affected_layers_json TEXT NOT NULL,
        affected_roles_json TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        resolved_at INTEGER,
        fallback_count INTEGER NOT NULL DEFAULT 0,
        known_cost_usd REAL NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        budget_crossed_at INTEGER,
        fallback_notification_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (fallback_notification_state IN ('pending', 'claimed', 'failed', 'delivered', 'discarded')),
        fallback_notification_claim_token TEXT,
        fallback_notification_claimed_at INTEGER,
        fallback_notification_delivered_at INTEGER,
        fallback_notification_attempts INTEGER NOT NULL DEFAULT 0,
        budget_notification_state TEXT NOT NULL DEFAULT 'not-applicable'
          CHECK (budget_notification_state IN ('not-applicable', 'pending', 'claimed', 'failed', 'delivered', 'discarded')),
        budget_notification_claim_token TEXT,
        budget_notification_claimed_at INTEGER,
        budget_notification_delivered_at INTEGER,
        budget_notification_attempts INTEGER NOT NULL DEFAULT 0,
        recovery_notification_state TEXT NOT NULL DEFAULT 'not-applicable'
          CHECK (recovery_notification_state IN ('not-applicable', 'pending', 'claimed', 'failed', 'delivered', 'discarded')),
        recovery_notification_claim_token TEXT,
        recovery_notification_claimed_at INTEGER,
        recovery_notification_delivered_at INTEGER,
        recovery_notification_attempts INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (target_id) REFERENCES local_ai_targets(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_local_ai_incidents_target_time
        ON local_ai_incidents(target_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_incidents_state
        ON local_ai_incidents(state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_incidents_notification_outbox
        ON local_ai_incidents(
          fallback_notification_state, budget_notification_state, recovery_notification_state,
          updated_at ASC, id ASC
        );
      CREATE INDEX IF NOT EXISTS idx_local_ai_incidents_fallback_notification_due
        ON local_ai_incidents(fallback_notification_state, fallback_notification_claimed_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_incidents_budget_notification_due
        ON local_ai_incidents(budget_notification_state, budget_notification_claimed_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_incidents_recovery_notification_due
        ON local_ai_incidents(recovery_notification_state, recovery_notification_claimed_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS local_ai_routing_events (
        id TEXT PRIMARY KEY,
        target_id TEXT,
        retention_target_key TEXT GENERATED ALWAYS AS (COALESCE(target_id, '')) STORED,
        incident_id TEXT,
        slot TEXT NOT NULL,
        intended_route TEXT NOT NULL,
        actual_route TEXT NOT NULL,
        policy TEXT NOT NULL,
        disposition TEXT NOT NULL,
        decision_reason TEXT NOT NULL DEFAULT 'health'
          CHECK (decision_reason IN ('health', 'policy', 'daily-budget', 'incident-budget', 'confirmation')),
        provider TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        known_cost_usd REAL,
        estimated_cost_usd REAL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        incident_accounted_at INTEGER,
        paid_notification_state TEXT NOT NULL DEFAULT 'not-applicable'
          CHECK (paid_notification_state IN ('not-applicable', 'pending', 'claimed', 'failed', 'delivered', 'discarded')),
        paid_notification_claim_token TEXT,
        paid_notification_claimed_at INTEGER,
        paid_notification_delivered_at INTEGER,
        paid_notification_attempts INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (target_id) REFERENCES local_ai_targets(id) ON DELETE SET NULL,
        FOREIGN KEY (incident_id) REFERENCES local_ai_incidents(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_local_ai_routing_events_target_time
        ON local_ai_routing_events(target_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_routing_events_incident_time
        ON local_ai_routing_events(incident_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_routing_events_time
        ON local_ai_routing_events(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_routing_events_retention_stream
        ON local_ai_routing_events(retention_target_key, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_routing_events_notification_outbox
        ON local_ai_routing_events(paid_notification_state, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_local_ai_routing_events_paid_notification_due
        ON local_ai_routing_events(paid_notification_state, paid_notification_claimed_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS local_ai_fallback_requests (
        id TEXT PRIMARY KEY,
        routing_event_id TEXT NOT NULL,
        incident_id TEXT,
        slot TEXT NOT NULL,
        status TEXT NOT NULL,
        estimated_input_tokens INTEGER NOT NULL,
        estimated_cost_usd REAL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolution TEXT,
        FOREIGN KEY (routing_event_id) REFERENCES local_ai_routing_events(id) ON DELETE CASCADE,
        FOREIGN KEY (incident_id) REFERENCES local_ai_incidents(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_local_ai_fallback_requests_pending
        ON local_ai_fallback_requests(status, expires_at)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_local_ai_fallback_requests_pending_order
        ON local_ai_fallback_requests(status, created_at ASC, id ASC)
        WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS local_ai_daily_aggregates (
        id TEXT PRIMARY KEY,
        target_id TEXT,
        day TEXT NOT NULL,
        aggregate_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (target_id) REFERENCES local_ai_targets(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_local_ai_daily_aggregates_target_day
        ON local_ai_daily_aggregates(target_id, day);
      CREATE INDEX IF NOT EXISTS idx_local_ai_daily_aggregates_day
        ON local_ai_daily_aggregates(day ASC, id ASC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_local_ai_daily_aggregates_day;
      DROP INDEX IF EXISTS idx_local_ai_daily_aggregates_target_day;
      DROP INDEX IF EXISTS idx_local_ai_fallback_requests_pending_order;
      DROP INDEX IF EXISTS idx_local_ai_fallback_requests_pending;
      DROP INDEX IF EXISTS idx_local_ai_routing_events_paid_notification_due;
      DROP INDEX IF EXISTS idx_local_ai_routing_events_notification_outbox;
      DROP INDEX IF EXISTS idx_local_ai_routing_events_retention_stream;
      DROP INDEX IF EXISTS idx_local_ai_routing_events_time;
      DROP INDEX IF EXISTS idx_local_ai_routing_events_incident_time;
      DROP INDEX IF EXISTS idx_local_ai_routing_events_target_time;
      DROP INDEX IF EXISTS idx_local_ai_incidents_recovery_notification_due;
      DROP INDEX IF EXISTS idx_local_ai_incidents_budget_notification_due;
      DROP INDEX IF EXISTS idx_local_ai_incidents_fallback_notification_due;
      DROP INDEX IF EXISTS idx_local_ai_incidents_notification_outbox;
      DROP INDEX IF EXISTS idx_local_ai_incidents_state;
      DROP INDEX IF EXISTS idx_local_ai_incidents_target_time;
      DROP INDEX IF EXISTS idx_local_ai_health_samples_time;
      DROP INDEX IF EXISTS idx_local_ai_health_samples_target_time;
      DROP INDEX IF EXISTS idx_local_ai_targets_active_endpoint_identity;
      DROP TABLE IF EXISTS local_ai_daily_aggregates;
      DROP TABLE IF EXISTS local_ai_fallback_requests;
      DROP TABLE IF EXISTS local_ai_routing_events;
      DROP TABLE IF EXISTS local_ai_incidents;
      DROP TABLE IF EXISTS local_ai_health_samples;
      DROP TABLE IF EXISTS local_ai_targets;
    `,
  },
  {
    name: '055_local_ai_recovery_attempts',
    up: `
      CREATE TABLE IF NOT EXISTS local_ai_recovery_attempts (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (
          action IN ('recheck-layer', 'deep-check', 'validate-models', 'reconnect-worker', 'restart-ollama')
        ),
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        claimed_at INTEGER NOT NULL,
        completed_at INTEGER,
        outcome TEXT NOT NULL CHECK (
          outcome IN ('claimed', 'unsupported', 'failed', 'not-recovered', 'recovered')
        ),
        supported INTEGER CHECK (supported IS NULL OR supported IN (0, 1)),
        attempted INTEGER CHECK (attempted IS NULL OR attempted IN (0, 1)),
        recovered INTEGER CHECK (recovered IS NULL OR recovered IN (0, 1)),
        FOREIGN KEY (target_id) REFERENCES local_ai_targets(id) ON DELETE CASCADE,
        UNIQUE (target_id, attempt_number),
        CHECK (
          (
            outcome = 'claimed'
            AND completed_at IS NULL
            AND supported IS NULL
            AND attempted IS NULL
            AND recovered IS NULL
          )
          OR
          (
            completed_at IS NOT NULL
            AND completed_at >= claimed_at
            AND supported IS NOT NULL
            AND attempted IS NOT NULL
            AND recovered IS NOT NULL
            AND (
              (outcome = 'unsupported' AND supported = 0 AND attempted = 0 AND recovered = 0)
              OR (outcome = 'failed' AND supported = 1 AND attempted IN (0, 1) AND recovered = 0)
              OR (outcome = 'not-recovered' AND supported = 1 AND attempted = 1 AND recovered = 0)
              OR (outcome = 'recovered' AND supported = 1 AND attempted = 1 AND recovered = 1)
            )
          )
        )
      );

      CREATE INDEX IF NOT EXISTS idx_local_ai_recovery_attempts_target_time
        ON local_ai_recovery_attempts(target_id, claimed_at DESC, id DESC);
    `,
    down: `
      DROP INDEX IF EXISTS idx_local_ai_recovery_attempts_target_time;
      DROP TABLE IF EXISTS local_ai_recovery_attempts;
    `,
  },
];
