import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_081_085: Migration[] = [
  {
    name: '081_browser_audit_command_id',
    up: `
      ALTER TABLE browser_audit_entries ADD COLUMN command_id TEXT;
      CREATE INDEX idx_browser_audit_command ON browser_audit_entries(command_id);
    `,
    down: `
      DROP INDEX idx_browser_audit_command;
      ALTER TABLE browser_audit_entries DROP COLUMN command_id;
    `,
  },
];
