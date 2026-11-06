import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { createSqliteWasmDatabase } from '../../db/sqlite-wasm-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { RLMDatabase } from '../rlm-database';
import { enableRlmWal } from './rlm-schema';

vi.mock('../../db/better-sqlite3-driver', () => ({ defaultDriverFactory: vi.fn() }));

describe('RLM WAL startup contention', () => {
  let db: SqliteDriver;
  let scratch: string;

  beforeEach(() => {
    RLMDatabase._resetForTesting();
    db = createSqliteWasmDatabase(':memory:');
    vi.mocked(defaultDriverFactory).mockReturnValue(db);
    scratch = mkdtempSync(join(tmpdir(), 'rlm-wal-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    RLMDatabase._resetForTesting();
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('retries a busy journal-mode change and permits initialization to finish', () => {
    const pragma = db.pragma.bind(db);
    let contended = false;
    vi.spyOn(db, 'pragma').mockImplementation((source: string, options?: { simple: true }) => {
      if (source === 'journal_mode = WAL' && !contended) {
        contended = true;
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
      return options ? pragma(source, options) : pragma(source);
    });
    const database = RLMDatabase.getInstance({
      dbPath: join(scratch, 'rlm.db'), contentDir: join(scratch, 'content'),
    });
    expect(database.isInitialized()).toBe(true);
    expect(database.getSchemaInfo().pendingMigrations).toEqual([]);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it.each(['SQLITE_IOERR', 'SQLITE_LOCKED', 'SQLITE_READONLY', undefined])(
    'surfaces %s immediately and restores the connection timeout', (code) => {
      const failure = Object.assign(new Error('startup failed'), { code });
      db.pragma('busy_timeout = 321');
      const pragma = db.pragma.bind(db);
      const wait = vi.spyOn(Atomics, 'wait');
      vi.spyOn(db, 'pragma').mockImplementation((source: string, options?: { simple: true }) => {
        if (source === 'journal_mode = WAL') throw failure;
        return options ? pragma(source, options) : pragma(source);
      });
      expect(() => enableRlmWal(db)).toThrow(failure);
      expect(wait).not.toHaveBeenCalled();
      expect(pragma('busy_timeout', { simple: true })).toBe(321);
    });

  it('stops retrying a persistently busy journal change after five seconds', () => {
    const failure = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const pragma = db.pragma.bind(db);
    vi.spyOn(db, 'pragma').mockImplementation((source: string, options?: { simple: true }) => {
      if (source === 'journal_mode = WAL') throw failure;
      return options ? pragma(source, options) : pragma(source);
    });
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Atomics, 'wait').mockImplementation((_buffer, _index, _value, timeout) => {
      elapsed += timeout!;
      return 'timed-out';
    });
    expect(() => enableRlmWal(db)).toThrow(failure);
    expect(elapsed).toBe(5_000);
  });

  it('does not attempt WAL again if scheduling consumes the remaining budget', () => {
    const failure = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const pragma = db.pragma.bind(db);
    let attempts = 0;
    vi.spyOn(db, 'pragma').mockImplementation((source: string, options?: { simple: true }) => {
      if (source === 'journal_mode = WAL' && ++attempts === 1) throw failure;
      return options ? pragma(source, options) : pragma(source);
    });
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      elapsed = 5_001;
      return 'timed-out';
    });
    expect(() => enableRlmWal(db)).toThrow(failure);
    expect(attempts).toBe(1);
  });

  it('closes a failed initialization connection and allows a fresh startup', () => {
    const failure = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
    const pragma = db.pragma.bind(db);
    vi.spyOn(db, 'pragma').mockImplementation((source: string, options?: { simple: true }) => {
      if (source === 'journal_mode = WAL') throw failure;
      return options ? pragma(source, options) : pragma(source);
    });
    const config = { dbPath: join(scratch, 'rlm.db'), contentDir: join(scratch, 'content') };
    expect(() => RLMDatabase.getInstance(config)).toThrow(failure);
    expect(() => db.prepare('SELECT 1')).toThrow();
    db = createSqliteWasmDatabase(':memory:');
    vi.mocked(defaultDriverFactory).mockReturnValue(db);
    expect(RLMDatabase.getInstance(config).isInitialized()).toBe(true);
  });
});
