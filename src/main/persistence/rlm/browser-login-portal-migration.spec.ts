import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { computeMigrationChecksum, createMigrationsTable, createTables, MIGRATIONS, runMigrations } from './rlm-schema';
import { LoginFingerprintStore } from '../../browser-gateway/browser-login-recipe-store';
import { SqliteLoginRecipeStore } from '../../browser-gateway/browser-unattended-sqlite-stores';
import { RLM_MIGRATIONS_081_085 } from './rlm-migrations-081-085';

describe('081_browser_login_portal_accounts legacy upgrade', () => {
  let db: SqliteDriver;
  const migration = RLM_MIGRATIONS_081_085.find((m) => m.name === '081_browser_login_portal_accounts')!;
  const origin = 'https://supplier.example';
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
    // Build the actual pre-upgrade schema, including checksum ledger. The new
    // migration must run through the real startup runner, not only raw DDL.
    for (const migration of MIGRATIONS.filter((m) => m.name < '081')) {
      db.exec(migration.up);
      db.prepare('INSERT INTO _migrations(name, applied_at, checksum) VALUES (?, ?, ?)')
        .run(migration.name, 1, computeMigrationChecksum(migration));
    }
    db.prepare(`INSERT INTO browser_login_recipes
      (scope, scope_kind, origin, login_url, logged_in_markers_json, relogin_json,
       created_at, updated_at, last_outcome, last_outcome_reason, last_outcome_at)
      VALUES (?, 'node', ?, ?, ?, ?, 10, 20, 'relogin_failed', 'TEST_ONLY_old_outcome', 30)`)
      .run('windows-pc', origin, `${origin}/publicagroup/home`, '["Logout"]',
        JSON.stringify({ vaultItemRef: 'TEST_ONLY_legacy', passwordSelector: '#password' }));
  });
  afterEach(() => db.close());

  it('preserves legacy data and diagnostics but refuses automatic portal/account inference', () => {
    runMigrations(db);
    const store = new LoginFingerprintStore(new SqliteLoginRecipeStore(db));
    expect(store.list()).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^legacy-/), scope: 'windows-pc', origin,
      portalPath: null, accountRef: '', loginUrl: `${origin}/publicagroup/home`,
      loggedInMarkers: ['Logout'], relogin: { vaultItemRef: 'TEST_ONLY_legacy', passwordSelector: '#password' },
      createdAt: 10, updatedAt: 20, lastOutcome: 'relogin_failed',
      lastOutcomeReason: 'TEST_ONLY_old_outcome', lastOutcomeAt: 30,
    })]);
    for (const portal of ['publicagroup', 'cpcatapult']) {
      expect(store.resolve('existing-tab:n.windows-pc:9:9', `${origin}/${portal}/home`))
        .toEqual({ reason: 'login_recipe_legacy_scope_unknown' });
    }
    runMigrations(db);
    expect(store.list()).toHaveLength(1);
  });

  it('selects re-recorded portals after a service restart and retains the unusable legacy row', () => {
    runMigrations(db);
    const store = new LoginFingerprintStore(new SqliteLoginRecipeStore(db));
    for (const portal of ['publicagroup', 'cpcatapult']) {
      store.remember({ profileId: 'existing-tab:n.windows-pc:1:1', origin,
        loginUrl: `${origin}/${portal}/home`, loggedInMarkers: ['Logout'],
        relogin: { vaultItemRef: `TEST_ONLY_${portal}`, passwordSelector: '#password' } });
    }
    const restarted = new LoginFingerprintStore(new SqliteLoginRecipeStore(db));
    expect(restarted.list()).toHaveLength(3);
    for (const portal of ['publicagroup', 'cpcatapult']) {
      expect(restarted.resolve('existing-tab:n.windows-pc:2:2', `${origin}/${portal}/tenders/current`).recipe)
        .toMatchObject({ portalPath: `/${portal}`, accountRef: `TEST_ONLY_${portal}` });
    }
    expect(restarted.resolve('existing-tab:n.windows-pc:2:2', `${origin}/educationportal/home`))
      .toEqual({ reason: 'login_recipe_legacy_scope_unknown' });
  });

  it('preserves all account data on downgrade without collapsing it into an origin-wide recipe', () => {
    runMigrations(db);
    const store = new LoginFingerprintStore(new SqliteLoginRecipeStore(db));
    for (const portal of ['publicagroup', 'cpcatapult']) {
      store.remember({ profileId: 'existing-tab:n.windows-pc:1:1', origin,
        loginUrl: `${origin}/${portal}/home`, loggedInMarkers: ['Logout'],
        relogin: { vaultItemRef: `TEST_ONLY_${portal}`, passwordSelector: '#password' } });
    }
    db.exec(migration.down);
    expect(db.prepare('SELECT count(*) AS n FROM browser_login_recipes').get<{ n: number }>()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM browser_login_portal_recipes').get<{ n: number }>()).toEqual({ n: 3 });
  });

  it('can downgrade repeatedly and upgrade again without losing or exposing modern portal recipes', () => {
    runMigrations(db);
    const store = new LoginFingerprintStore(new SqliteLoginRecipeStore(db));
    store.remember({ profileId: 'existing-tab:n.windows-pc:1:1', origin,
      loginUrl: `${origin}/cpcatapult/home`, loggedInMarkers: ['Logout'],
      relogin: { vaultItemRef: 'TEST_ONLY_cpcatapult', passwordSelector: '#password' } });
    const before = store.list();
    db.exec(migration.down);
    db.exec(migration.down);
    expect(db.prepare('SELECT * FROM browser_login_recipes WHERE scope = ? AND origin = ?')
      .get('windows-pc', origin)).toBeUndefined();
    db.exec(migration.up);
    expect(store.list()).toEqual(before);
  });
});
