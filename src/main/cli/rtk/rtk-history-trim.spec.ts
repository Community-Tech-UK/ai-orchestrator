import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteWasmDatabase } from '../../db/sqlite-wasm-driver';
import type { RunResult, SqliteDriver, SqliteDriverFactory, SqliteStatement } from '../../db/sqlite-driver';
import { previewRtkHistoryTrim, trimRtkHistory } from './rtk-history-trim';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

interface SchemaOptions {
  withProjectColumn?: boolean;
  withFailures?: boolean;
  withCommands?: boolean;
}

function buildSharedFactory(dbPath: string, options: SchemaOptions = {}): (filename?: string) => SqliteDriver {
  const { withProjectColumn = true, withFailures = true, withCommands = true } = options;
  writeFileSync(dbPath, 'marker', 'utf-8');
  const db = createSqliteWasmDatabase(dbPath) as unknown as SqliteDriver;
  if (withCommands) {
    db.exec(`
      CREATE TABLE commands (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        original_cmd TEXT NOT NULL,
        rtk_cmd TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        saved_tokens INTEGER NOT NULL,
        savings_pct REAL NOT NULL,
        exec_time_ms INTEGER DEFAULT 0
        ${withProjectColumn ? `, project_path TEXT DEFAULT ''` : ''}
      );
      CREATE INDEX idx_timestamp ON commands(timestamp);
    `);
  }
  if (withFailures) {
    db.exec(`
      CREATE TABLE parse_failures (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        original TEXT NOT NULL,
        error TEXT NOT NULL,
        fallback_succeeded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_failures_timestamp ON parse_failures(timestamp);
    `);
  }
  const shared: SqliteDriver = new Proxy(db, {
    get(target, prop) {
      if (prop === 'close') return () => undefined;
      const val = (target as unknown as Record<string, unknown>)[prop as string];
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as SqliteDriver;
  return () => shared;
}

function insertCommands(db: SqliteDriver, rows: { timestamp: string }[]): void {
  const stmt = db.prepare(
    'INSERT INTO commands (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) stmt.run(row.timestamp, 'a', 'b', 10, 5, 5, 50);
}

function insertFailures(db: SqliteDriver, rows: { timestamp: string }[]): void {
  const stmt = db.prepare('INSERT INTO parse_failures (timestamp, original, error) VALUES (?, ?, ?)');
  for (const row of rows) stmt.run(row.timestamp, 'a', 'boom');
}

const iso = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;

describe('previewRtkHistoryTrim', () => {
  let tempRoot = '';
  let dbPath = '';

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'rtk-history-trim-'));
    dbPath = path.join(tempRoot, 'history.db');
  });
  afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

  it('counts only rows older than the cutoff, matching a hand count', () => {
    const factory = buildSharedFactory(dbPath);
    const db = factory();
    insertCommands(db, [{ timestamp: iso(1) }, { timestamp: iso(2) }, { timestamp: iso(7) }, { timestamp: iso(8) }]);
    insertFailures(db, [{ timestamp: iso(1) }, { timestamp: iso(7) }]);

    const preview = previewRtkHistoryTrim(30, {
      dbPath,
      now: () => Date.parse('2026-02-05T00:00:00.000Z'),
      driverFactory: factory,
    });

    expect(preview.available).toBe(true);
    expect(preview.commandsToRemove).toBe(2);
    expect(preview.failuresToRemove).toBe(1);
    expect(preview.fileBytes).toBeGreaterThan(0);
    expect(preview.oldestAt).toBe(Date.parse(iso(1)));
    expect(preview.newestAt).toBe(Date.parse(iso(8)));
    expect(preview.estimatedBytes).toBeGreaterThan(0);
  });

  it('reports unavailable and writes nothing when the file, a table or the timestamp column is missing', () => {
    const missingFile = buildSharedFactory(dbPath);
    rmSync(dbPath, { force: true });
    expect(previewRtkHistoryTrim(30, { dbPath, driverFactory: missingFile }).available).toBe(false);
    expect(previewRtkHistoryTrim(30, { dbPath, driverFactory: buildSharedFactory(dbPath, { withFailures: false }) }).available).toBe(false);
    rmSync(dbPath, { force: true });
    expect(previewRtkHistoryTrim(30, { dbPath, driverFactory: buildSharedFactory(dbPath, { withCommands: false }) }).available).toBe(false);
  });

  it('works on a database without project_path', () => {
    const factory = buildSharedFactory(dbPath, { withProjectColumn: false });
    insertCommands(factory(), [{ timestamp: iso(1) }, { timestamp: iso(6) }]);
    const preview = previewRtkHistoryTrim(30, {
      dbPath,
      now: () => Date.parse('2026-02-05T00:00:00.000Z'),
      driverFactory: factory,
    });
    expect(preview.available).toBe(true);
    expect(preview.commandsToRemove).toBe(1);
  });

  it('closes an acquired read-only handle when schema inspection fails', () => {
    writeFileSync(dbPath, 'marker', 'utf-8');
    let closed = false;
    let openedReadOnly = false;
    const driverFactory: SqliteDriverFactory = (_filename, options) => {
      openedReadOnly = options?.readonly === true;
      return {
        pragma: () => { throw new Error('SQLITE_CORRUPT'); },
        close: () => { closed = true; },
      } as unknown as SqliteDriver;
    };

    const preview = previewRtkHistoryTrim(30, { dbPath, driverFactory });

    expect(openedReadOnly).toBe(true);
    expect(preview.available).toBe(false);
    expect(closed).toBe(true);
  });
});

describe('trimRtkHistory', () => {
  let tempRoot = '';
  let dbPath = '';

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'rtk-history-trim-'));
    dbPath = path.join(tempRoot, 'history.db');
  });
  afterEach(() => rmSync(tempRoot, { recursive: true, force: true }));

  it('removes only older rows in batches of 2000 and never vacuums', async () => {
    const factory = buildSharedFactory(dbPath);
    const db = factory();
    insertCommands(db, Array.from({ length: 5000 }, () => ({ timestamp: iso(1) })));
    insertCommands(db, Array.from({ length: 5 }, () => ({ timestamp: iso(7) })));
    insertFailures(db, Array.from({ length: 2 }, () => ({ timestamp: iso(1) })));
    insertFailures(db, [{ timestamp: iso(7) }]);
    const pagesBefore = db.pragma('page_count', { simple: true });

    const progress: number[] = [];
    const result = await trimRtkHistory(30, {
      dbPath,
      now: () => Date.parse('2026-02-05T00:00:00.000Z'),
      driverFactory: factory,
      onProgress: (removed) => progress.push(removed),
    });

    expect(result).toEqual({ removedCommands: 5000, removedFailures: 2, stoppedEarly: false });
    expect(progress).toEqual([2000, 2000, 1000, 2]);
    expect(db.prepare('SELECT COUNT(*) AS total FROM commands').get<{ total: number }>()).toEqual({ total: 5 });
    expect(db.prepare('SELECT COUNT(*) AS total FROM parse_failures').get<{ total: number }>()).toEqual({ total: 1 });
    expect(db.pragma('page_count', { simple: true })).toBe(pagesBefore);
  });

  it('stops after three busy results in a row, reports the partial count and never throws', async () => {
    const factory = buildSharedFactory(dbPath);
    const db = factory();
    insertCommands(db, Array.from({ length: 5000 }, () => ({ timestamp: iso(1) })));

    let deletes = 0;
    const busyStatement: SqliteStatement = {
      run: () => {
        deletes += 1;
        if (deletes === 1) {
          db.prepare('DELETE FROM commands WHERE id IN (SELECT id FROM commands WHERE timestamp < ? LIMIT 2000)').run(iso(1));
          return { changes: 2000, lastInsertRowid: 0 } satisfies RunResult;
        }
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      },
      get: () => undefined,
      all: () => [],
    };
    const busyFactory: SqliteDriverFactory = () => {
      const inner = factory();
      return new Proxy(inner, {
        get(target, prop) {
          if (prop === 'prepare') return (sql: string) => (/^DELETE FROM commands/.test(sql) ? busyStatement : target.prepare(sql));
          const val = (target as unknown as Record<string, unknown>)[prop as string];
          return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
        },
      }) as SqliteDriver;
    };

    const progress: number[] = [];
    const result = await trimRtkHistory(30, {
      dbPath,
      now: () => Date.parse('2026-02-05T00:00:00.000Z'),
      driverFactory: busyFactory,
      onProgress: (removed) => progress.push(removed),
    });

    expect(result.removedCommands).toBe(2000);
    expect(result.stoppedEarly).toBe(true);
    expect(progress).toEqual([2000]);
  });

  it('returns zero without writing when the schema is missing', async () => {
    const factory = buildSharedFactory(dbPath, { withCommands: false });
    const result = await trimRtkHistory(30, { dbPath, driverFactory: factory });
    expect(result).toEqual({ removedCommands: 0, removedFailures: 0, stoppedEarly: false });
  });
});
