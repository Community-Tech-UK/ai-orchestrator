import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteWasmDatabase } from '../../../db/sqlite-wasm-driver';
import type {
  SqliteDriver,
  SqliteDriverFactory,
} from '../../../db/sqlite-driver';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  _resetForTesting,
  getRtkTrackingDbPath,
  RtkTrackingReader,
} from '../rtk-tracking-reader';

interface FixtureRow {
  timestamp: string;
  original: string;
  rewritten: string;
  inputTokens: number;
  outputTokens: number;
  projectPath?: string;
}

/**
 * Build an in-memory SQLite DB matching RTK's schema and pre-populate with
 * the given rows. Returns a driverFactory that hands out the same DB instance
 * to any caller, so write-then-read patterns work under the test WASM mock.
 */
function buildSharedDriver(
  rows: FixtureRow[],
  opts: { withProjectColumn?: boolean } = {},
): SqliteDriverFactory {
  const withProject = opts.withProjectColumn !== false;
  const db = createSqliteWasmDatabase(':memory:') as unknown as SqliteDriver;
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
      ${withProject ? `, project_path TEXT DEFAULT ''` : ''}
    );
    CREATE INDEX idx_timestamp ON commands(timestamp);
  `);

  const insertCols = withProject
    ? 'timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, project_path'
    : 'timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct';
  const placeholders = withProject ? '?, ?, ?, ?, ?, ?, ?, ?' : '?, ?, ?, ?, ?, ?, ?';
  const stmt = db.prepare(
    `INSERT INTO commands (${insertCols}) VALUES (${placeholders})`,
  );
  for (const r of rows) {
    const saved = r.inputTokens - r.outputTokens;
    const pct = r.inputTokens > 0 ? (saved / r.inputTokens) * 100 : 0;
    if (withProject) {
      stmt.run(
        r.timestamp,
        r.original,
        r.rewritten,
        r.inputTokens,
        r.outputTokens,
        saved,
        pct,
        r.projectPath ?? '',
      );
    } else {
      stmt.run(r.timestamp, r.original, r.rewritten, r.inputTokens, r.outputTokens, saved, pct);
    }
  }

  // Suppress close() so the reader's getDriver() can also call close without
  // breaking other queries that share this DB.
  const sharedDriver: SqliteDriver = new Proxy(db, {
    get(target, prop) {
      if (prop === 'close') return () => undefined;
      const val = (target as Record<string, unknown>)[prop as string];
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  }) as SqliteDriver;

  const factory: SqliteDriverFactory = (): SqliteDriver => sharedDriver;
  return factory;
}

/** Driver factory that throws on open, simulating a corrupt or unreadable DB. */
const throwingFactory: SqliteDriverFactory = () => {
  throw new Error('simulated corrupt DB');
};

describe('rtk-tracking-reader', () => {
  let tempRoot = '';
  let dbPath = '';

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'rtk-tracking-reader-'));
    dbPath = path.join(tempRoot, 'tracking.db');
    _resetForTesting();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    _resetForTesting();
  });

  describe('getRtkTrackingDbPath', () => {
    it('returns a platform-appropriate path', () => {
      const result = getRtkTrackingDbPath();
      expect(result).toContain('rtk');
      expect(result).toContain('tracking.db');
      if (process.platform === 'darwin') {
        expect(result).toContain('Library/Application Support');
      }
    });
  });

  describe('isAvailable', () => {
    it('reports false when the DB does not exist', () => {
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath });
      expect(reader.isAvailable()).toBe(false);
    });
  });

  describe('getSummary', () => {
    it('returns null when the DB is missing', () => {
      const reader = new RtkTrackingReader({
        dbPathOverride: dbPath,
        // Use the throwing factory just to be safe — should never be invoked
        // because isAvailable() returns false first.
        driverFactory: throwingFactory,
      });
      expect(reader.getSummary()).toBeNull();
    });

    it('returns zeroed summary for an empty DB', () => {
      const factory = buildSharedDriver([]);
      // Touch the file so isAvailable() returns true under jsdom fs
      writeFileSync(dbPath, '');
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      const summary = reader.getSummary();
      expect(summary).not.toBeNull();
      expect(summary?.commands).toBe(0);
      expect(summary?.totalSaved).toBe(0);
      expect(summary?.byCommand).toEqual([]);
      expect(summary?.lastCommandAt).toBeNull();
    });

    it('aggregates totals across rows', () => {
      const factory = buildSharedDriver([
        {
          timestamp: '2026-05-01T10:00:00.000Z',
          original: 'git status',
          rewritten: 'rtk git status',
          inputTokens: 1000,
          outputTokens: 200,
          projectPath: '/proj/a',
        },
        {
          timestamp: '2026-05-01T11:00:00.000Z',
          original: 'git status',
          rewritten: 'rtk git status',
          inputTokens: 800,
          outputTokens: 160,
          projectPath: '/proj/a',
        },
        {
          timestamp: '2026-05-02T09:00:00.000Z',
          original: 'cargo test',
          rewritten: 'rtk cargo test',
          inputTokens: 5000,
          outputTokens: 500,
          projectPath: '/proj/b',
        },
      ]);
      writeFileSync(dbPath, '');
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      const summary = reader.getSummary();
      expect(summary?.commands).toBe(3);
      expect(summary?.totalInput).toBe(6800);
      expect(summary?.totalOutput).toBe(860);
      expect(summary?.totalSaved).toBe(5940);
      expect(summary?.lastCommandAt).toBe('2026-05-02T09:00:00.000Z');
      expect(summary?.byCommand[0]?.rtkCmd).toBe('rtk cargo test');
      expect(summary?.byCommand[0]?.saved).toBe(4500);
      expect(summary?.byCommand[1]?.rtkCmd).toBe('rtk git status');
      expect(summary?.byCommand[1]?.saved).toBe(1440);
    });

    it('filters by project_path', () => {
      const factory = buildSharedDriver([
        {
          timestamp: '2026-05-01T10:00:00.000Z',
          original: 'git status',
          rewritten: 'rtk git status',
          inputTokens: 1000,
          outputTokens: 200,
          projectPath: '/proj/a',
        },
        {
          timestamp: '2026-05-01T11:00:00.000Z',
          original: 'cargo test',
          rewritten: 'rtk cargo test',
          inputTokens: 5000,
          outputTokens: 500,
          projectPath: '/proj/b',
        },
      ]);
      writeFileSync(dbPath, '');
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      const summary = reader.getSummary({ projectPath: '/proj/a' });
      expect(summary?.commands).toBe(1);
      expect(summary?.totalSaved).toBe(800);
    });

    it('filters by sinceMs', () => {
      const factory = buildSharedDriver([
        {
          timestamp: '2026-05-01T10:00:00.000Z',
          original: 'git status',
          rewritten: 'rtk git status',
          inputTokens: 1000,
          outputTokens: 200,
        },
        {
          timestamp: '2026-05-05T10:00:00.000Z',
          original: 'cargo test',
          rewritten: 'rtk cargo test',
          inputTokens: 5000,
          outputTokens: 500,
        },
      ]);
      writeFileSync(dbPath, '');
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      const since = new Date('2026-05-03T00:00:00.000Z').getTime();
      const summary = reader.getSummary({ sinceMs: since });
      expect(summary?.commands).toBe(1);
      expect(summary?.byCommand[0]?.rtkCmd).toBe('rtk cargo test');
    });

    it('handles older rtk schema without project_path column', () => {
      const factory = buildSharedDriver(
        [
          {
            timestamp: '2026-05-01T10:00:00.000Z',
            original: 'git status',
            rewritten: 'rtk git status',
            inputTokens: 1000,
            outputTokens: 200,
          },
        ],
        { withProjectColumn: false },
      );
      writeFileSync(dbPath, '');
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      const summary = reader.getSummary({ projectPath: '/proj/a' });
      expect(summary?.commands).toBe(1);
    });
  });

  describe('getRecentHistory', () => {
    it('returns empty array when DB missing', () => {
      const reader = new RtkTrackingReader({
        dbPathOverride: dbPath,
        driverFactory: throwingFactory,
      });
      expect(reader.getRecentHistory()).toEqual([]);
    });

    it('returns rows newest-first up to limit', () => {
      const factory = buildSharedDriver([
        {
          timestamp: '2026-05-01T10:00:00.000Z',
          original: 'a',
          rewritten: 'rtk a',
          inputTokens: 100,
          outputTokens: 10,
        },
        {
          timestamp: '2026-05-02T10:00:00.000Z',
          original: 'b',
          rewritten: 'rtk b',
          inputTokens: 200,
          outputTokens: 20,
        },
        {
          timestamp: '2026-05-03T10:00:00.000Z',
          original: 'c',
          rewritten: 'rtk c',
          inputTokens: 300,
          outputTokens: 30,
        },
      ]);
      writeFileSync(dbPath, '');
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      const history = reader.getRecentHistory({ limit: 2 });
      expect(history).toHaveLength(2);
      expect(history[0]?.originalCmd).toBe('c');
      expect(history[1]?.originalCmd).toBe('b');
    });

    it('caps absurd limits to a sane maximum', () => {
      const factory = buildSharedDriver([]);
      writeFileSync(dbPath, '');
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      expect(reader.getRecentHistory({ limit: 999_999 })).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('returns null when the factory throws on open', () => {
      writeFileSync(dbPath, '');
      const reader = new RtkTrackingReader({
        dbPathOverride: dbPath,
        driverFactory: throwingFactory,
      });
      expect(reader.getSummary()).toBeNull();
      expect(reader.getRecentHistory()).toEqual([]);
    });
  });

  describe('connection lifecycle', () => {
    it('reuses a single connection across queries', () => {
      const factory = buildSharedDriver([
        {
          timestamp: '2026-05-01T10:00:00.000Z',
          original: 'a',
          rewritten: 'rtk a',
          inputTokens: 100,
          outputTokens: 10,
        },
      ]);
      writeFileSync(dbPath, '');
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      const a = reader.getSummary();
      const b = reader.getSummary();
      expect(a?.commands).toBe(1);
      expect(b?.commands).toBe(1);
      reader.close();
    });

    it('does not retry opening the DB after a failed first attempt', () => {
      // No file present — first call returns null and remembers the failure
      const reader = new RtkTrackingReader({
        dbPathOverride: dbPath,
        driverFactory: buildSharedDriver([]),
      });
      expect(reader.getSummary()).toBeNull();
      // Even if the file appears later, the cached failure prevents reopen
      writeFileSync(dbPath, '');
      expect(reader.getSummary()).toBeNull();
    });
  });
});
