import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from './rlm-schema';

const startupScript = String.raw`
  require('tsx/cjs');
  const { execFileSync } = require('node:child_process');
  const { defaultDriverFactory } = require('./src/main/db/better-sqlite3-driver.ts');
  const { createTables, createMigrationsTable, getAppliedMigrations, runMigrations } =
    require('./src/main/persistence/rlm/rlm-schema.ts');
  const [dbPath, role] = process.argv.slice(1);
  const db = defaultDriverFactory(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  const compete = (nextRole) => execFileSync(process.execPath,
    ['-e', process._eval, dbPath, nextRole], { env: process.env, timeout: 10000, stdio: 'pipe' });
  const seedLegacyColumns = () => {
    createTables(db);
    // Persisted profiles from before summary scheduling lack these fields.
    for (const column of ['pending_summary', 'summary_priority', 'last_summary_attempt']) {
      db.exec('ALTER TABLE context_sections DROP COLUMN ' + column);
    }
  };
  try {
    if (role === 'lock-check') {
      db.exec('BEGIN IMMEDIATE');
      db.exec('ROLLBACK');
    } else if (role === 'failure') {
      seedLegacyColumns();
      const exec = db.exec.bind(db);
      db.exec = (sql) => exec(sql.includes('ADD COLUMN summary_priority')
        ? sql + '; INSERT INTO missing_column_upgrade_table VALUES (1);' : sql);
      let error;
      try { createTables(db); } catch (failure) { error = failure.message; }
      db.exec = exec;
      const afterFailure = db.prepare('PRAGMA table_info(context_sections)').all().map(row => row.name);
      compete('lock-check');
      createTables(db);
      const afterRecovery = db.prepare('PRAGMA table_info(context_sections)').all().map(row => row.name);
      console.log(JSON.stringify({ error, afterFailure, afterRecovery }));
    } else {
      if (role === 'first') {
        seedLegacyColumns();
        let competed = false;
        const competeOnce = () => { competed = true; compete('second'); };
        const exec = db.exec.bind(db);
        db.exec = (sql) => {
          if (!competed && sql === 'BEGIN IMMEDIATE') competeOnce();
          return exec(sql);
        };
        const prepare = db.prepare.bind(db);
        db.prepare = (sql) => {
          const stmt = prepare(sql);
          if (!competed && sql === 'PRAGMA table_info(context_sections)') {
            const all = stmt.all.bind(stmt);
            stmt.all = () => { const rows = all(); competeOnce(); return rows; };
          }
          return stmt;
        };
      }
      createTables(db);
      createMigrationsTable(db);
      runMigrations(db);
      if (role === 'first') {
        // A no-pending restart must release its lock to another real connection.
        runMigrations(db);
        compete('lock-check');
        console.log(JSON.stringify({ columns: db.prepare('PRAGMA table_info(context_sections)').all()
          .map(row => row.name), migrations: getAppliedMigrations(db).map(row => row.name) }));
      }
    }
  } finally { db.close(); }
`;

describe('RLM persisted context column startup', () => {
  it('serializes legacy column discovery with concurrent upgrades and releases startup locks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rlm-legacy-startup-'));
    try {
      const electronPath = createRequire(import.meta.url)('electron') as string;
      const output = execFileSync(electronPath, [
        '-e', startupScript, join(directory, 'rlm.db'), 'first',
      ], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8', timeout: 30000 });
      const result = JSON.parse(output) as { columns: string[]; migrations: string[] };
      expect(result.columns).toEqual(expect.arrayContaining([
        'pending_summary', 'summary_priority', 'last_summary_attempt',
      ]));
      expect(result.migrations).toEqual(MIGRATIONS.map(migration => migration.name));
      expect(new Set(result.migrations).size).toBe(result.migrations.length);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back partial column changes on SQL failure and releases the connection for recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rlm-legacy-failure-'));
    try {
      const electronPath = createRequire(import.meta.url)('electron') as string;
      const output = execFileSync(electronPath, [
        '-e', startupScript, join(directory, 'rlm.db'), 'failure',
      ], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8', timeout: 30000 });
      const result = JSON.parse(output) as { error: string; afterFailure: string[]; afterRecovery: string[] };
      expect(result.error).toContain('no such table: missing_column_upgrade_table');
      for (const column of ['pending_summary', 'summary_priority', 'last_summary_attempt']) {
        expect(result.afterFailure).not.toContain(column);
        expect(result.afterRecovery).toContain(column);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
