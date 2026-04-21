/**
 * Production SQLite driver: a thin passthrough to `better-sqlite3`.
 *
 * better-sqlite3's `Database` class is a structural superset of
 * `SqliteDriver` — every method we expose on the interface has an
 * identical signature on the underlying class. That lets us skip a
 * runtime wrapper entirely: the `as unknown as SqliteDriver` cast is
 * type-only, costing nothing at runtime.
 *
 * This is the ONLY production file that should import `better-sqlite3`.
 * Everything else imports `SqliteDriver` from `./sqlite-driver` and
 * accepts this factory (or a test factory) via dependency injection.
 */

import Database from 'better-sqlite3';
import type { SqliteDriver, SqliteDriverFactory, SqliteDriverOptions } from './sqlite-driver';

/**
 * Default driver factory — opens a real better-sqlite3 Database.
 * Suitable for production use (main process inside Electron).
 */
export const defaultDriverFactory: SqliteDriverFactory = (
  filename: string,
  options?: SqliteDriverOptions,
): SqliteDriver => {
  // better-sqlite3 accepts the same `{ readonly }` option shape.
  const db = new Database(filename, options);
  // Structural cast: every SqliteDriver method is already present on `db`
  // with matching signatures. No runtime wrapping.
  return db as unknown as SqliteDriver;
};
