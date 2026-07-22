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
];
