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
];
