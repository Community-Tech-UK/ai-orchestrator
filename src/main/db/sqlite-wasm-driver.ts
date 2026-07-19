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

import { readFileSync } from 'node:fs';
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
  private readonly stmtCache = new Map<string, SqliteWasmStatement>();
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

  prepareCached(sql: string): SqliteStatement {
    const cached = this.stmtCache.get(sql);
    if (cached) return cached;
    const stmt = this.prepare(sql) as SqliteWasmStatement;
    this.stmtCache.set(sql, stmt);
    return stmt;
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

  async backup(destPath: string): Promise<void> {
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

/**
 * Open an on-disk SQLite file (e.g. a real production `codemem.sqlite` or
 * `rlm.db`) as a genuinely READ-ONLY database, without requiring the native
 * `better-sqlite3` addon — the addon is compiled against Electron's Node ABI
 * and cannot load under plain Node (`tsx`, `vitest`); see
 * `better-sqlite3-driver.ts`'s header comment.
 *
 * Implementation: read the file's bytes and load them into a private WASM
 * heap via `sqlite3_deserialize` with `SQLITE_DESERIALIZE_READONLY`. This is
 * SQLite's own read-only enforcement (any write throws `SQLITE_READONLY` at
 * the engine level) — not merely "callers never call `.run()`" — and it is
 * structurally incapable of mutating the source file: the loaded database
 * lives entirely in a detached in-memory image that is never serialized back
 * to `filePath`.
 *
 * Throws if the file is missing, unreadable, or not a valid SQLite database.
 *
 * Known limitation: `sqlite3_deserialize` requires the whole file resident in
 * the WASM heap, which is capped at 2 GiB (32-bit linear memory). A store at
 * or above that size throws here (message contains "greater than 2 GiB");
 * callers should surface that as a real, distinct failure — not silently
 * treat it as "missing" or "corrupt".
 */
export function openSqliteWasmFileReadOnly(filePath: string): SqliteDriver {
  if (!sqlite3) {
    throw new Error('sqlite-wasm not initialized — call initSqliteWasm() first');
  }
  const bytes = readFileSync(filePath);
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  const ptr = sqlite3.wasm.allocFromTypedArray(new Uint8Array(bytes));
  const rc = sqlite3.capi.sqlite3_deserialize(
    db,
    'main',
    ptr,
    bytes.length,
    bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_READONLY | sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
  );
  if (rc !== sqlite3.capi.SQLITE_OK) {
    db.close();
    throw new Error(
      `Failed to load "${filePath}" as a read-only SQLite database (sqlite3_deserialize rc=${rc})`,
    );
  }
  return new SqliteWasmDriver(db);
}

/**
 * Test-fixture helper: an in-memory driver plus a way to export its exact
 * SQLite bytes. Lets specs build a fixture using REAL production schema/seed
 * code (e.g. `migrate()` + `CasStore`, same as `synthetic-suite.ts`'s
 * `seedFixtureCasStore`) and then write it to disk for
 * `openSqliteWasmFileReadOnly` to read back — without depending on the native
 * `better-sqlite3` addon (ABI-mismatched under plain Node/vitest). Not used
 * by any production code path — tests only.
 */
export function createSqliteWasmDatabaseWithExport(): {
  driver: SqliteDriver;
  exportBytes: () => Uint8Array;
} {
  if (!sqlite3) {
    throw new Error('sqlite-wasm not initialized — call initSqliteWasm() first');
  }
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  return {
    driver: new SqliteWasmDriver(db),
    exportBytes: () => {
      if (!sqlite3) throw new Error('sqlite-wasm not initialized');
      return sqlite3.capi.sqlite3_js_db_export(db);
    },
  };
}
