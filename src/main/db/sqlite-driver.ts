/**
 * Minimal SQLite driver abstraction.
 *
 * Designed as a strict subset of better-sqlite3's API so that a real
 * `better-sqlite3` Database instance satisfies this interface structurally,
 * with zero runtime wrapping in production (see better-sqlite3-driver.ts).
 *
 * The goal is to decouple application logic from the native `better-sqlite3`
 * module so that:
 *   - Production keeps using `better-sqlite3` (fast native binary, ABI 143)
 *   - Tests can use a pure-WASM backend (e.g. sql.js) that has no ABI coupling
 *     to the Electron version, fixing the long-standing test/packaging
 *     ABI conflict.
 *
 * Surface area was derived from a full audit of `src/main/**` usage — only
 * methods that callers actually invoke are exposed. See the design doc in
 * the accompanying refactor plan for rationale.
 */

/** SQL parameter values accepted by prepared statements. */
export type SqlValue = string | number | bigint | Buffer | null;
export type SqlParam = SqlValue | undefined;

/** Return shape from statement.run(). */
export interface RunResult {
  /** Number of rows affected by the INSERT/UPDATE/DELETE. */
  changes: number;
  /**
   * Rowid of the last inserted row. Included for API compatibility with
   * better-sqlite3; the codebase never consumes this value, but preserving
   * it means `Database` still satisfies this interface structurally.
   */
  lastInsertRowid: number | bigint;
}

/** Callable transaction wrapper. */
export type TransactionFn<A extends unknown[], R> = (...args: A) => R;

/**
 * Prepared statement — the unit of query execution.
 *
 * Parameter types are `unknown[]` to match better-sqlite3's actual runtime
 * permissiveness and to allow callers that build heterogeneous parameter
 * arrays (e.g. conditional WHERE clauses) without casts. The `SqlValue` /
 * `SqlParam` exports above document the *expected* shape for callers that
 * want to stay strict locally.
 */
export interface SqliteStatement {
  /** Execute an INSERT/UPDATE/DELETE. */
  run(...params: unknown[]): RunResult;
  /** Fetch the first matching row, or undefined if none. */
  get<T = unknown>(...params: unknown[]): T | undefined;
  /** Fetch all matching rows. */
  all<T = unknown>(...params: unknown[]): T[];
}

/** Connection to a SQLite database. */
export interface SqliteDriver {
  /** Compile an SQL statement for (re)execution. */
  prepare(sql: string): SqliteStatement;

  /**
   * Run one or more semicolon-separated SQL statements directly against
   * the database. Used for DDL (CREATE TABLE) and VACUUM. No parameters,
   * no result rows. Mirrors better-sqlite3's db.exec(sql).
   */
  exec(sql: string): void;

  /**
   * Run a PRAGMA.
   *   - default: returns an array of row objects (e.g. `table_info(x)`)
   *   - { simple: true }: returns the first column of the first row as a scalar
   *
   * Matches better-sqlite3's two-form API so existing callers don't need to change.
   */
  pragma(source: string): unknown;
  pragma(source: string, options: { simple: true }): unknown;

  /**
   * Wrap `fn` in a transaction. The returned callable runs `fn` inside
   * BEGIN/COMMIT (rolling back on throw). Invoked with the same arguments
   * you would pass to `fn`.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): TransactionFn<A, R>;

  /**
   * Create a consistent snapshot of the database to `destPath` using
   * SQLite's backup API. Synchronous in better-sqlite3 (WAL-safe internally).
   *
   * Optional in test backends — sql.js does not support this and should throw.
   * Production code that calls this should run under the native driver only.
   */
  backup(destPath: string): void;

  /** Release all resources. Idempotent. */
  close(): void;
}

/** Options accepted when opening a database. */
export interface SqliteDriverOptions {
  /** Open the file in read-only mode. Used once, for backup integrity checks. */
  readonly?: boolean;
}

/** Factory that opens a database file and returns a driver. */
export type SqliteDriverFactory = (
  filename: string,
  options?: SqliteDriverOptions,
) => SqliteDriver;
