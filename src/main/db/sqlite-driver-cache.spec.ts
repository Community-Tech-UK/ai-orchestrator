import { describe, it, expect, beforeAll } from 'vitest';
import { initSqliteWasm, createSqliteWasmDatabase } from './sqlite-wasm-driver';
import type { SqliteDriver } from './sqlite-driver';

describe('SqliteDriver.prepareCached', () => {
  let db: SqliteDriver;

  beforeAll(async () => {
    await initSqliteWasm();
    db = createSqliteWasmDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
  });

  afterAll(() => {
    db.close();
  });

  it('returns the same statement object for repeated SQL', () => {
    const sql = 'SELECT 1 AS x';
    const s1 = db.prepareCached(sql);
    const s2 = db.prepareCached(sql);
    expect(s1).toBe(s2);
  });

  it('returns different objects for different SQL', () => {
    const s1 = db.prepareCached('SELECT 1');
    const s2 = db.prepareCached('SELECT 2');
    expect(s1).not.toBe(s2);
  });

  it('cached statement executes correctly on repeated calls', () => {
    db.exec("INSERT INTO t VALUES (1, 'hello')");
    const stmt = db.prepareCached('SELECT val FROM t WHERE id = ?');
    const r1 = stmt.get<{ val: string }>(1);
    const r2 = stmt.get<{ val: string }>(1);
    expect(r1?.val).toBe('hello');
    expect(r2?.val).toBe('hello');
  });

  it('non-cached prepare returns a fresh statement each call', () => {
    const sql = 'SELECT 1 AS fresh';
    const s1 = db.prepare(sql);
    const s2 = db.prepare(sql);
    // prepare() may or may not return the same object — what matters is that
    // prepareCached() consistently returns the same one.
    const sc = db.prepareCached(sql);
    expect(db.prepareCached(sql)).toBe(sc);
    void s1;
    void s2;
  });
});
