import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from './rlm-schema';
import { RLM_MIGRATIONS_041_045 } from './rlm-migrations-041-045';

const MIGRATION_044 = RLM_MIGRATIONS_041_045.find((m) => m.name === '044_automations_hidden');

/**
 * The curation half of migration 044, taken from the shipped migration rather
 * than restated here — the point of the test is that *that* name list is right.
 * The `automations` table is created by migration 015, so rows cannot exist
 * before the migration runner reaches 044; replaying just the UPDATE against
 * seeded rows is the only way to exercise the real curation.
 */
function curationSql(): string {
  const statements = (MIGRATION_044?.up ?? '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.toUpperCase().startsWith('UPDATE'));
  if (statements.length !== 1) {
    throw new Error(`Expected exactly one curation UPDATE in migration 044, found ${statements.length}`);
  }
  return `${statements[0]};`;
}

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

/** Minimal automations row — only the columns the migration and its curation touch. */
function insertAutomation(db: SqliteDriver, id: string, name: string): void {
  db.prepare(`
    INSERT INTO automations
      (id, name, description, enabled, active, workspace_id, schedule_type, schedule_json,
       trigger_json, missed_run_policy, concurrency_policy, action_json, next_fire_at,
       last_fired_at, last_run_id, created_at, updated_at)
    VALUES (?, ?, NULL, 1, 1, '/tmp', 'cron', '{"type":"cron","expression":"0 9 * * *","timezone":"UTC"}',
            '{"kind":"schedule"}', 'notify', 'skip', '{"prompt":"p","workingDirectory":"/tmp"}',
            NULL, NULL, NULL, 1000, 1000)
  `).run(id, name);
}

function hiddenOf(db: SqliteDriver, id: string): number | undefined {
  return db.prepare('SELECT hidden FROM automations WHERE id = ?')
    .get<{ hidden: number }>(id)?.hidden;
}

describe('automations hidden migration 044', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('records the migration and is idempotent on re-run', () => {
    const db = openMigratedDb();
    runMigrations(db);

    expect(
      db.prepare('SELECT name FROM _migrations WHERE name = ?')
        .get<{ name: string }>('044_automations_hidden'),
    ).toEqual({ name: '044_automations_hidden' });
  });

  it('defaults every automation to visible', () => {
    const db = openMigratedDb();
    insertAutomation(db, 'a1', 'Some new automation');

    expect(hiddenOf(db, 'a1')).toBe(0);
  });

  it('hides only the curated names and leaves every other automation visible', () => {
    const db = openMigratedDb();

    insertAutomation(db, 'hide-1', 'Leads panel uptime check');
    insertAutomation(db, 'hide-2', 'Work-finder health watchdog');
    insertAutomation(db, 'hide-3', 'Monday work-finder brief');
    // Deliberately visible: this one sends real LinkedIn invitations and must
    // never be silent. A name-pattern rule would have caught it.
    insertAutomation(db, 'keep-1', 'LinkedIn useful-20 guarded sender');
    insertAutomation(db, 'keep-2', 'Tender Radar daily run');
    // Near-miss on a curated name — exact match only, no fuzzy matching.
    insertAutomation(db, 'keep-3', 'Leads panel uptime check (old)');

    db.exec(curationSql());

    expect(hiddenOf(db, 'hide-1')).toBe(1);
    expect(hiddenOf(db, 'hide-2')).toBe(1);
    expect(hiddenOf(db, 'hide-3')).toBe(1);
    expect(hiddenOf(db, 'keep-1')).toBe(0);
    expect(hiddenOf(db, 'keep-2')).toBe(0);
    expect(hiddenOf(db, 'keep-3')).toBe(0);
  });

  it('curates exactly the seven automations recorded in the spec', () => {
    // Pins the shipped list so a later edit to the migration is a deliberate,
    // reviewed change rather than a silent one.
    const names = [...curationSql().matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(names).toEqual([
      'ComTech inbox review (bids and replies)',
      'Leads panel uptime check',
      'LinkedIn accept and reply live check',
      'Monday work-finder brief',
      'Process outreach review instructions',
      'Spark DPS RM6094 monthly MI return',
      'Work-finder health watchdog',
    ]);
  });
});
