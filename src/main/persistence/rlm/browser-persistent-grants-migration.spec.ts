import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { computeMigrationChecksum, createMigrationsTable, createTables, MIGRATIONS, runMigrations } from './rlm-schema';
import { BrowserGrantStore } from '../../browser-gateway/browser-grant-store';
import { PERSISTENT_BROWSER_GRANT_EXPIRES_AT } from '@contracts/types/browser';

const dbs: SqliteDriver[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe('persistent browser grant migration', () => {
  it('preserves pre-existing grants, approval references and indexes while adding opt-in consent', () => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
    const migration = MIGRATIONS.find((candidate) => candidate.name === '064_browser_persistent_grants')!;
    for (const old of MIGRATIONS.slice(0, MIGRATIONS.indexOf(migration))) {
      db.exec(old.up);
      db.prepare('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)')
        .run(old.name, 1, computeMigrationChecksum(old));
    }
    db.prepare(`INSERT INTO browser_permission_grants (
      id, mode, instance_id, provider, profile_id, target_id, node_id, allowed_origins_json,
      allowed_action_classes_json, allow_external_navigation, upload_roots_json, autonomous,
      requested_by, decided_by, decision, reason, expires_at, created_at, revoked_at, consumed_at
    ) VALUES ('old-grant', 'autonomous', 'old-instance', 'codex', 'profile', 'target', 'worker', ?, ?,
      0, ?, 1, 'operator', 'user', 'allow', 'Original reason', 100, 1, 20, 30)`)
      .run(JSON.stringify([{ scheme: 'https', hostPattern: 'example.com', includeSubdomains: false }]),
        JSON.stringify(['credential']), JSON.stringify(['/test/uploads']));
    const before = db.prepare('SELECT * FROM browser_permission_grants').get<Record<string, unknown>>();
    db.prepare(`INSERT INTO browser_approval_requests (
      id, request_id, instance_id, provider, profile_id, tool_name, action, action_class,
      proposed_grant_json, status, grant_id, created_at, expires_at
    ) VALUES ('approval', 'approval', 'old-instance', 'codex', 'profile', 'browser.click',
      'click', 'credential', '{}', 'approved', 'old-grant', 1, 100)`).run();

    runMigrations(db);
    runMigrations(db);

    expect(db.prepare('SELECT * FROM browser_permission_grants').get()).toEqual({ ...before, user_approved_credentials: 0 });
    expect(db.prepare('SELECT grant_id FROM browser_approval_requests').get()).toEqual({ grant_id: 'old-grant' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'browser_permission_grants'")
      .all<{ name: string }>().map(({ name }) => name)).toEqual(expect.arrayContaining([
      'idx_browser_grants_instance_profile_expiry', 'idx_browser_grants_instance_node_expiry',
      'idx_browser_grants_target', 'idx_browser_grants_persistent_scope',
    ]));
    const store = new BrowserGrantStore(db);
    const saved = store.createGrant({
      mode: 'persistent', instanceId: 'new-instance', provider: 'claude', nodeId: 'worker',
      allowedOrigins: [{ scheme: 'https', hostPattern: 'example.com', includeSubdomains: false }],
      allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: true,
      userApprovedCredentials: true, requestedBy: 'operator', decidedBy: 'user', decision: 'allow',
      expiresAt: PERSISTENT_BROWSER_GRANT_EXPIRES_AT,
    });
    expect(new BrowserGrantStore(db).getGrant(saved.id)).toEqual(saved);
    expect(store.getGrant('old-grant')?.userApprovedCredentials).toBeUndefined();
  });
});
