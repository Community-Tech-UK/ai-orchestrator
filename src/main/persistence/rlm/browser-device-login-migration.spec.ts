import { describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from './rlm-schema';
import { RLM_MIGRATIONS_081_085 } from './rlm-migrations-081-085';
import { BrowserApprovalStore } from '../../browser-gateway/browser-approval-store';

describe('083_browser_device_login_approvals', () => {
  it('preserves ordinary approvals when upgrading and leaves their device metadata absent', () => {
    const db = defaultDriverFactory(':memory:');
    try {
      createTables(db); createMigrationsTable(db); runMigrations(db);
      const migration = RLM_MIGRATIONS_081_085.find(item => item.name === '083_browser_device_login_approvals')!;
      db.exec(migration.down);
      db.prepare('DELETE FROM _migrations WHERE name = ?').run(migration.name);
      db.prepare(`INSERT INTO browser_approval_requests
        (id, request_id, instance_id, provider, profile_id, tool_name, action, action_class, proposed_grant_json, status, created_at, expires_at)
        VALUES ('legacy-placeholder', 'legacy-placeholder', 'session-placeholder', 'codex', 'profile-placeholder', 'browser.click', 'click', 'input', ?, 'approved', 1, 61000)`)
        .run(JSON.stringify({ mode: 'per_action', allowedOrigins: [], allowedActionClasses: ['input'], allowExternalNavigation: false, autonomous: false }));
      runMigrations(db); runMigrations(db);
      const row = new BrowserApprovalStore(db).getRequest('legacy-placeholder')!;
      expect(row.status).toBe('approved');
      expect(row).not.toHaveProperty('deviceLogin');
      expect(db.prepare('SELECT device_login_json FROM browser_approval_requests').get()).toEqual({ device_login_json: null });
    } finally { db.close(); }
  });
});
