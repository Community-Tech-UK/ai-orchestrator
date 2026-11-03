import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  computeMigrationChecksum,
  createMigrationsTable,
  createTables,
  getAppliedMigrations,
  MIGRATIONS,
  runMigrations,
} from './rlm-schema';

const concurrentStartupScript = String.raw`
  require('tsx/cjs');
  const { execFileSync } = require('node:child_process');
  const { defaultDriverFactory } = require('./src/main/db/better-sqlite3-driver.ts');
  const { createTables, createMigrationsTable, getAppliedMigrations, runMigrations } =
    require('./src/main/persistence/rlm/rlm-schema.ts');
  const [dbPath, role] = process.argv.slice(1);
  const db = defaultDriverFactory(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  createTables(db);
  createMigrationsTable(db);
  try {
    if (role === 'first') {
      let competed = false;
      const compete = () => {
        competed = true;
        execFileSync(process.execPath, ['-e', process._eval, dbPath, 'second'], {
          env: process.env, timeout: 10000, stdio: 'pipe',
        });
      };
      const exec = db.exec.bind(db);
      db.exec = (sql) => {
        // The competing startup completes while the first waits for its lock.
        if (!competed && sql === 'BEGIN IMMEDIATE') compete();
        exec(sql);
      };
      const prepare = db.prepare.bind(db);
      db.prepare = (sql) => {
        const stmt = prepare(sql);
        if (!competed && sql === 'SELECT * FROM _migrations ORDER BY id ASC') {
          const all = stmt.all.bind(stmt);
          stmt.all = () => {
            // Reproduce the old ordering: another process migrates after a
            // startup reads its pending snapshot but before it takes a lock.
            const rows = all();
            compete();
            return rows;
          };
        }
        return stmt;
      };
    }
    runMigrations(db);
    if (role === 'first') console.log(JSON.stringify(getAppliedMigrations(db)));
  } finally {
    db.close();
  }
`;

describe('RLM migration startup', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
  });

  afterEach(() => db.close());

  it('refreshes pending migrations after another process wins the startup lock', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'rlm-startup-'));
    try {
      const electronPath = createRequire(import.meta.url)('electron') as string;
      const output = execFileSync(electronPath, [
        '-e', concurrentStartupScript, join(scratch, 'rlm.db'), 'first',
      ], {
        cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 20000,
      });
      const applied = JSON.parse(output) as { name: string; checksum: string }[];
      expect(applied.map(({ name, checksum }) => ({ name, checksum }))).toEqual(
        MIGRATIONS.map((migration) => ({
          name: migration.name,
          checksum: computeMigrationChecksum(migration),
        })),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rolls back failed migrations and releases the lock for a later startup', () => {
    expect(() => runMigrations(db, () => { throw new Error('startup interrupted'); }))
      .toThrow('startup interrupted');
    expect(getAppliedMigrations(db)).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_outcomes_task_success'").get())
      .toBeUndefined();
    runMigrations(db);
    expect(getAppliedMigrations(db)).toHaveLength(MIGRATIONS.length);
  });

  it('keeps checksum validation and releases the lock after a mismatch', () => {
    runMigrations(db);
    const first = MIGRATIONS[0]!;
    db.prepare('UPDATE _migrations SET checksum = ? WHERE name = ?').run('changed', first.name);
    expect(() => runMigrations(db)).toThrow(`Migration checksum mismatch for "${first.name}"`);
    db.prepare('UPDATE _migrations SET checksum = ? WHERE name = ?')
      .run(computeMigrationChecksum(first), first.name);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('preserves migration errors when SQLite has already rolled back a full database', () => {
    const electronPath = createRequire(import.meta.url)('electron') as string;
    const output = execFileSync(electronPath, ['-e', String.raw`
      require('tsx/cjs');
      const { defaultDriverFactory } = require('./src/main/db/better-sqlite3-driver.ts');
      const { createTables, createMigrationsTable, getAppliedMigrations, MIGRATIONS, runMigrations } =
        require('./src/main/persistence/rlm/rlm-schema.ts');
      const db = defaultDriverFactory(':memory:');
      try {
        createTables(db);
        createMigrationsTable(db);
        runMigrations(db);
        const before = getAppliedMigrations(db);
        const pages = db.pragma('page_count', { simple: true });
        db.pragma('max_page_count = ' + (pages + 1));
        MIGRATIONS.push({ name: 'test_full_database', up:
          'CREATE TABLE test_full_database (data BLOB);' +
          'INSERT INTO test_full_database VALUES (zeroblob(65536));' });
        let failure;
        try { runMigrations(db); } catch (error) { failure = error; }
        MIGRATIONS.pop();
        const rolledBack = !db.prepare(
          "SELECT name FROM sqlite_master WHERE name = 'test_full_database'"
        ).get();
        const unchanged = JSON.stringify(getAppliedMigrations(db)) === JSON.stringify(before);
        runMigrations(db);
        console.log(JSON.stringify({
          message: failure?.message,
          sqlCode: failure?.cause?.cause?.code,
          rollbackMessage: failure?.errors?.[1]?.message,
          rolledBack, unchanged,
        }));
      } finally { db.close(); }
    `], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 20000,
    });
    const result = JSON.parse(output) as {
      message: string; sqlCode: string; rollbackMessage: string;
      rolledBack: boolean; unchanged: boolean;
    };
    expect(result.message).toContain('Failed to apply migration "test_full_database"');
    expect(result.message).toContain('database or disk is full');
    expect(result.sqlCode).toBe('SQLITE_FULL');
    expect(result.rollbackMessage).toContain('no transaction is active');
    expect(result.rolledBack).toBe(true);
    expect(result.unchanged).toBe(true);
  });
});
