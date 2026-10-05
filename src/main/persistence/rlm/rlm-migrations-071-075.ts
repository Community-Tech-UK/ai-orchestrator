import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_071_075: Migration[] = [
  {
    name: '071_browser_credential_access_scopes',
    up: `
      ALTER TABLE browser_credential_authorizations ADD COLUMN task_scope TEXT;
      ALTER TABLE browser_credential_authorizations ADD COLUMN vault_item_ref TEXT;
      ALTER TABLE browser_credential_authorizations ADD COLUMN computer_id TEXT;
      ALTER TABLE browser_approval_requests ADD COLUMN credential_access_json TEXT;
      CREATE INDEX idx_browser_credential_access_task ON browser_approval_requests
        (json_extract(credential_access_json, '$.taskScope'), created_at DESC, id DESC)
        WHERE credential_access_json IS NOT NULL;
      CREATE INDEX idx_browser_credential_access_grant ON browser_approval_requests (grant_id)
        WHERE credential_access_json IS NOT NULL;
    `,
    down: `
      DROP INDEX idx_browser_credential_access_task;
      DROP INDEX idx_browser_credential_access_grant;
      ALTER TABLE browser_approval_requests DROP COLUMN credential_access_json;
      ALTER TABLE browser_credential_authorizations DROP COLUMN computer_id;
      ALTER TABLE browser_credential_authorizations DROP COLUMN vault_item_ref;
      ALTER TABLE browser_credential_authorizations DROP COLUMN task_scope;
    `,
  },
];
