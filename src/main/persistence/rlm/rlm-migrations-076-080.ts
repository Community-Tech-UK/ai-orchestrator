import type { Migration } from './rlm-types';

export const RLM_MIGRATIONS_076_080: Migration[] = [
  {
    // A denied/failed browser decision's reason code used to reach only the
    // tool result: the audit row carried the prose summary alone, so the exact
    // failure step and cause (LT-703's `dispatch:credential_selector_outside_…`)
    // were not queryable from the forensic record at all.
    name: '076_browser_audit_reason',
    up: `
      ALTER TABLE browser_audit_entries ADD COLUMN reason TEXT;
    `,
    down: `
      ALTER TABLE browser_audit_entries DROP COLUMN reason;
    `,
  },
];
