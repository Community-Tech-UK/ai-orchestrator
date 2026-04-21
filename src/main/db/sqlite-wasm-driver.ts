/**
 * SQLite-WASM driver (test backend).
 *
 * Implements the SqliteDriver port using @sqlite.org/sqlite-wasm. Pure WASM,
 * no native binary, FTS5 included. Used only in the vitest process so tests
 * are decoupled from Electron's native-module ABI.
 *
 * Note on the methods below: anywhere this file references `.exec(sql)` it
 * means SQLite's SQL-execution method on a prepared database handle, not
 * child_process execution.
 */

import sqlite3InitModule, {
  type Sqlite3Static,
  type Database as OO1Database,
  type PreparedStatement,
  type BindingSpec,
} from '@sqlite.org/sqlite-wasm';

import type {
  SqliteDriver,
  SqliteStatement,
  RunResult,
  SqliteDriverOptions,
} from './sqlite-driver';

let sqlite3: Sqlite3Static | undefined;

const noop = (): void => {
  /* intentional no-op: swallow stdio from the emscripten-compiled binary */
};

export async function initSqliteWasm(): Promise<void> {
  if (sqlite3) return;
  // The published .d.ts declares `init()` with no parameters (see upstream PR
  // #129), but at runtime the emscripten loader accepts a Module config
  // object. We use it to silence the compiled binary's stdio noise.
  const init = sqlite3InitModule as unknown as (opts?: {
    print?: (...a: unknown[]) => void;
    printErr?: (...a: unknown[]) => void;
  }) => Promise<Sqlite3Static>;
  sqlite3 = await init({ print: noop, printErr: noop });
}

export function isSqliteWasmReady(): boolean {
  return sqlite3 !== undefined;
}

function normalizeBindings(params: unknown[]): BindingSpec | undefined {
  if (params.length === 0) return undefined;

  if (params.length === 1) {
    const only = params[0];
    if (Array.isArray(only)) return only as BindingSpec;
    if (
      only !== null &&
      typeof only === 'object' &&
      !(only instanceof Uint8Array) &&
      !(only instanceof ArrayBuffer) &&
      !(only instanceof Date)
    ) {
      return only as BindingSpec;
    }
  }

  return params as BindingSpec;
}

class SqliteWasmStatement implements SqliteStatement {
  private finalized = false;

  constructor(
    private readonly stmt: PreparedStatement,
    private readonly db: OO1Database,
  ) {}

  private resetBeforeCall(): void {
    if (this.finalized) return;
    try {
      this.stmt.reset(true);
    } catch {
      // Stmt hasn't been stepped yet or is already reset — both are fine.
    }
  }

  run(...params: unknown[]): RunResult {
    this.resetBeforeCall();

    const bindings = normalizeBindings(params);
    if (bindings !== undefined) {
      this.stmt.bind(bindings);
    }

    this.stmt.step();

    const changes = this.db.changes() as number;
    const lastRowid = this.db.selectValue('SELECT last_insert_rowid()') as
      | number
      | bigint
      | null
      | undefined;

    this.resetBeforeCall();
    return {
      changes,
      lastInsertRowid:
        typeof lastRowid === 'bigint' || typeof lastRowid === 'number' ? lastRowid : 0,
    };
  }

  get<T = unknown>(...params: unknown[]): T | undefined {
    this.resetBeforeCall();

    const bindings = normalizeBindings(params);
    if (bindings !== undefined) {
      this.stmt.bind(bindings);
    }

    const hasRow = this.stmt.step();
    if (!hasRow) {
      this.resetBeforeCall();
      return undefined;
    }

    const row = this.stmt.get({}) as T;
    this.resetBeforeCall();
    return row;
  }

  all<T = unknown>(...params: unknown[]): T[] {
    this.resetBeforeCall();

    const bindings = normalizeBindings(params);
    if (bindings !== undefined) {
      this.stmt.bind(bindings);
    }

    const rows: T[] = [];
    while (this.stmt.step()) {
      rows.push(this.stmt.get({}) as T);
    }

    this.resetBeforeCall();
    return rows;
  }

  _finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    try {
      this.stmt.finalize();
    } catch {
      // Already finalized — fine.
    }
  }
}

class SqliteWasmDriver implements SqliteDriver {
  private readonly db: OO1Database;
  private readonly statements: SqliteWasmStatement[] = [];
  private closed = false;

  constructor(db: OO1Database) {
    this.db = db;
  }

  get open(): boolean {
    return !this.closed;
  }

  prepare(sql: string): SqliteStatement {
    if (!sqlite3) {
      throw new Error('sqlite-wasm not initialized — call initSqliteWasm() first');
    }
    const stmt = this.db.prepare(sql);
    const wrapped = new SqliteWasmStatement(stmt, this.db);
    this.statements.push(wrapped);
    return wrapped;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(source: string): unknown;
  pragma(source: string, options: { simple: true }): unknown;
  pragma(source: string, options?: { simple: true }): unknown {
    const sql = `PRAGMA ${source};`;

    const isSet = /\s*=\s*/.test(source);
    if (isSet) {
      this.db.exec(sql);
      return [];
    }

    if (options?.simple) {
      return this.db.selectValue(sql);
    }

    // Return rows as column-keyed objects, matching better-sqlite3's
    // `db.pragma('table_info(x)')` output shape.
    return this.db.selectObjects(sql);
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Rollback itself failed — the original error is what we propagate.
        }
        throw err;
      }
    };
  }

  backup(destPath: string): void {
    throw new Error(
      `SqliteWasmDriver.backup(${JSON.stringify(destPath)}) is not implemented for tests`,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const stmt of this.statements) {
      stmt._finalize();
    }
    this.statements.length = 0;

    try {
      this.db.close();
    } catch {
      // Already closed — fine.
    }
  }
}

/**
 * @param filename — ignored (every database is in-memory)
 * @param options — ignored (kept for SqliteDriverFactory signature parity)
 */
export function createSqliteWasmDatabase(
  filename: string,
  options?: SqliteDriverOptions,
): SqliteDriver {
  void filename;
  void options;
  if (!sqlite3) {
    throw new Error('sqlite-wasm not initialized — call initSqliteWasm() first');
  }
  // Flags: 'c' = create if not exists. We deliberately omit 't' (tracing) —
  // 'ct' would print every statement to the console, flooding test output.
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  return new SqliteWasmDriver(db);
}
