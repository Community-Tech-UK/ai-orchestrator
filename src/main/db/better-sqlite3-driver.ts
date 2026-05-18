/**
 * Production SQLite driver: a thin wrapper around `better-sqlite3` that adds
 * statement caching via `prepareCached()`.
 *
 * better-sqlite3's `Database` class is a structural superset of `SqliteDriver`
 * for all methods except `prepareCached`, which we add with a `Map<string,
 * Statement>` keyed by SQL text. Statements are compiled once and reused,
 * saving repeated SQLite compilation on hot paths (event-store append,
 * BM25 search, RLM CRUD).
 *
 * This is the ONLY production file that should import `better-sqlite3`.
 * Everything else imports `SqliteDriver` from `./sqlite-driver` and
 * accepts this factory (or a test factory) via dependency injection.
 */

import Database from 'better-sqlite3';
import type { SqliteDriver, SqliteStatement, SqliteDriverFactory, SqliteDriverOptions } from './sqlite-driver';

/** Wraps a better-sqlite3 Database and adds `prepareCached()`. */
class BetterSqlite3Driver implements SqliteDriver {
  private readonly stmtCache = new Map<string, SqliteStatement>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any) {}

  prepare(sql: string): SqliteStatement {
    return this.db.prepare(sql) as SqliteStatement;
  }

  prepareCached(sql: string): SqliteStatement {
    const cached = this.stmtCache.get(sql);
    if (cached) return cached;
    const stmt = this.prepare(sql);
    this.stmtCache.set(sql, stmt);
    return stmt;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(source: string): unknown;
  pragma(source: string, options: { simple: true }): unknown;
  pragma(source: string, options?: { simple: true }): unknown {
    if (options?.simple) {
      return this.db.pragma(source, { simple: true });
    }
    return this.db.pragma(source);
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return this.db.transaction(fn) as (...args: A) => R;
  }

  backup(destPath: string): void {
    this.db.backup(destPath);
  }

  close(): void {
    this.stmtCache.clear();
    this.db.close();
  }
}

/**
 * Default driver factory — opens a real better-sqlite3 Database with statement
 * caching. Suitable for production use (main process inside Electron).
 */
export const defaultDriverFactory: SqliteDriverFactory = (
  filename: string,
  options?: SqliteDriverOptions,
): SqliteDriver => {
  const db = new Database(filename, options);
  return new BetterSqlite3Driver(db);
};
