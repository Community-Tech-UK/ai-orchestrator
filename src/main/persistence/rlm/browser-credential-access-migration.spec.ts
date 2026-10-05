import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { computeMigrationChecksum, createMigrationsTable, createTables, MIGRATIONS, runMigrations } from './rlm-schema';
import { SqliteCredentialAuthorizationStore } from '../../browser-gateway/browser-unattended-sqlite-stores';
import { CredentialAuthorizationService } from '../../browser-gateway/browser-credential-authorization-store';

const databases: SqliteDriver[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe('saved login access scope migration', () => {
  it('preserves legacy consent and approval history while enforcing newly persisted scope', () => {
    const database = defaultDriverFactory(':memory:');
    databases.push(database);
    createTables(database);
    createMigrationsTable(database);
    const migration = MIGRATIONS.find((item) => item.name === '071_browser_credential_access_scopes')!;
    for (const old of MIGRATIONS.slice(0, MIGRATIONS.indexOf(migration))) {
      database.exec(old.up);
      database.prepare('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)')
        .run(old.name, 1, computeMigrationChecksum(old));
    }
    database.prepare(`INSERT INTO browser_credential_authorizations
      (id, profile_id, allowed_origins_json, purposes_json, vault_folder, created_at, expires_at)
      VALUES ('old-consent', 'computer', ?, '["login"]', 'AIO-Agent', 1, 10000)`)
      .run(JSON.stringify([{ scheme: 'https', hostPattern: 'test.example', includeSubdomains: false }]));
    database.prepare(`INSERT INTO browser_approval_requests
      (id, request_id, instance_id, provider, profile_id, tool_name, action, action_class,
      proposed_grant_json, status, created_at, expires_at)
      VALUES ('old-request', 'old-request', 'session', 'codex', 'computer', 'browser.click', 'click', 'input', '{}', 'denied', 1, 100)`)
      .run();
    const oldRow = database.prepare('SELECT * FROM browser_credential_authorizations').get();
    runMigrations(database);
    runMigrations(database);
    expect(database.prepare('SELECT * FROM browser_credential_authorizations').get())
      .toEqual({ ...oldRow as object, task_scope: null, vault_item_ref: null, computer_id: null });
    expect(database.prepare('SELECT status, credential_access_json FROM browser_approval_requests').get())
      .toEqual({ status: 'denied', credential_access_json: null });

    const store = new SqliteCredentialAuthorizationStore(database);
    const service = new CredentialAuthorizationService(store, () => 10);
    const input = { profileId: 'computer', origin: 'https://test.example', purpose: 'login' as const };
    expect(service.check(input).authorized).toBe(true);
    const old = service.find('old-consent')!;
    service.create({ ...old, profileId: 'new-computer', taskScope: 'logical-session', vaultItemRef: 'item-1', computerId: 'node-1' }, 'new-consent');
    const restored = new CredentialAuthorizationService(new SqliteCredentialAuthorizationStore(database), () => 10);
    expect(restored.check({ ...input, profileId: 'new-computer' })).toMatchObject({ authorized: false, reason: 'task_scope_not_authorized' });
    expect(restored.check({ ...input, profileId: 'new-computer', taskScope: 'logical-session', vaultItemRef: 'item-1', computerId: 'node-1' }).authorized).toBe(true);
    expect(restored.check({ ...input, profileId: 'new-computer', taskScope: 'logical-session', vaultItemRef: 'item-1', computerId: 'node-2' }).authorized).toBe(false);
    expect(restored.check({ ...input, profileId: 'new-computer', taskScope: 'logical-session', vaultItemRef: 'other-item', computerId: 'node-1' }).authorized).toBe(false);
  });
});
