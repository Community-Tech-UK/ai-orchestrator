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
];
