import type { Migration } from './rlm-types';

/**
 * RLM migrations 041–045.
 *
 * Continuation bucket after the 036–040 range. Keep migrations additive and
 * safe for existing user databases.
 */
export const RLM_MIGRATIONS_041_045: Migration[] = [
  {
    name: '041_browser_permission_grants_node_scope',
    up: `
      ALTER TABLE browser_permission_grants ADD COLUMN node_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_browser_grants_instance_node_expiry
        ON browser_permission_grants(instance_id, node_id, expires_at);
    `,
    down: `
      DROP INDEX IF EXISTS idx_browser_grants_instance_node_expiry;
      -- SQLite cannot drop columns portably on older runtimes; leave node_id in place.
    `,
  },
];
