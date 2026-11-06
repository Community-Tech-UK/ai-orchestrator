import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  createMigrationsTable, createTables, getAppliedMigrations, MIGRATIONS, runMigrations,
} from './rlm-schema';

describe('RLM migration ownership', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
  });

  afterEach(() => db.close());

  // Complete the other owner's work after discovery but before acquiring the
  // write lock. The WASM backend cannot share a file between two connections;
  // the compiled native regression covers that boundary with real connections.
  function beforeLock(otherOwner: () => void): SqliteDriver {
    let entered = false;
    const enter = () => {
      if (entered) return;
      entered = true;
      otherOwner();
    };
    return new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return <A extends unknown[], R>(operation: (...args: A) => R) => {
            enter();
            return target.transaction(operation);
          };
        }
        if (property === 'exec') {
          return (sql: string) => {
            if (/^BEGIN\b/i.test(sql)) enter();
            target.exec(sql);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('does not replay migrations another owner committed after discovery', () => {
    const applied: string[] = [];
    const completed: number[] = [];
    const connection = beforeLock(() => runMigrations(db));

    expect(() => runMigrations(connection, name => applied.push(name), count => completed.push(count)))
      .not.toThrow();
    expect(getAppliedMigrations(db).map(row => row.name)).toEqual(MIGRATIONS.map(m => m.name));
    expect(applied).toEqual([]);
    expect(completed).toEqual([]);
  });

  it('validates checksums again after acquiring ownership', () => {
    const connection = beforeLock(() => {
      runMigrations(db);
      db.prepare('UPDATE _migrations SET checksum = ? WHERE name = ?')
        .run('invalid-checksum', '001_add_optimized_indices');
    });
    expect(() => runMigrations(connection))
      .toThrow('Migration checksum mismatch for "001_add_optimized_indices"');
  });

  it('keeps real SQL failures visible and rolls back earlier migrations', () => {
    runMigrations(db);
    db.exec(`DELETE FROM _migrations WHERE name IN ('001_add_optimized_indices', '076_browser_audit_reason')`);

    expect(() => runMigrations(db)).toThrow(/Failed to apply migration "076_browser_audit_reason".*duplicate column name: reason/);
    expect(getAppliedMigrations(db).some(row => row.name === '001_add_optimized_indices')).toBe(false);
    expect(getAppliedMigrations(db).some(row => row.name === '076_browser_audit_reason')).toBe(false);
  });

  it('keeps the migration failure visible when SQLite has already rolled back', () => {
    db.exec(`CREATE TRIGGER fail_migration BEFORE INSERT ON _migrations
      BEGIN SELECT RAISE(ROLLBACK, 'placeholder migration failure'); END;`);
    expect(() => runMigrations(db))
      .toThrow(/Failed to apply migration "001_add_optimized_indices": .*placeholder migration failure/);
    expect(getAppliedMigrations(db)).toEqual([]);
  });

  it('reports only its own committed migrations and leaves a current database alone', () => {
    const applied: string[] = [];
    const completed: number[] = [];
    runMigrations(db, name => applied.push(name), count => completed.push(count));
    const firstRun = getAppliedMigrations(db);
    runMigrations(db, name => applied.push(name), count => completed.push(count));
    expect(applied).toEqual(MIGRATIONS.map(m => m.name));
    expect(completed).toEqual([MIGRATIONS.length]);
    expect(getAppliedMigrations(db)).toEqual(firstRun);
  });
});
