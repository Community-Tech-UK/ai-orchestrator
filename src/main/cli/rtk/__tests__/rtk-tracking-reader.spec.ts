import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
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

import { RtkDailyRollup } from '../rtk-daily-rollup';

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
      const val = (target as unknown as Record<string, unknown>)[prop as string];
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
    it('returns a platform-appropriate path (current or legacy db name)', () => {
      const result = getRtkTrackingDbPath();
      expect(result).toContain('rtk');
      // RTK renamed tracking.db -> history.db (~v0.40+); accept either.
      expect(result).toMatch(/(history|tracking)\.db$/);
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

    it('reopens an atomically replaced source rather than caching the old connection under its new identity', () => {
      const first = buildSharedDriver([{ timestamp: '2026-10-20T10:00:00.000Z', original: 'x', rewritten: 'rtk x', inputTokens: 10, outputTokens: 1 }]);
      const second = buildSharedDriver([{ timestamp: '2026-10-20T11:00:00.000Z', original: 'y', rewritten: 'rtk y', inputTokens: 50, outputTokens: 5 }]);
      const factory = vi.fn().mockImplementationOnce(first).mockImplementationOnce(second);
      writeFileSync(dbPath, 'old source');
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: factory });
      expect(reader.getSummary()?.totalSaved).toBe(9);
      const replacement = path.join(tempRoot, 'replacement.db');
      writeFileSync(replacement, 'new source');
      renameSync(replacement, dbPath);
      expect(reader.getSummary()?.totalSaved).toBe(45);
      expect(factory).toHaveBeenCalledTimes(2);
      reader.close();
    });

    it('opens a database that appears after the first query', () => {
      // No file is present until RTK runs its first command.
      const reader = new RtkTrackingReader({
        dbPathOverride: dbPath,
        driverFactory: buildSharedDriver([]),
      });
      expect(reader.getSummary()).toBeNull();
      // Refresh picks up the new file without an app restart.
      writeFileSync(dbPath, '');
      expect(reader.getSummary()?.commands).toBe(0);
    });
  });
});

/**
 * T5 compliance. These assert the two things the plan actually needs and the
 * one thing it asked for that cannot be delivered honestly.
 *
 * Measured against the real database on this machine while building this:
 * 251,656 filtered vs 87,125 proxied (25.7% bypass, well over the plan's 10%
 * warning threshold), and 13,707 parse failures against 26,819 commands in a
 * 7-day window — i.e. about half of attempted rtk invocations produced no
 * filtering at all, while `rtk gain` still reported savings from the rest.
 */
describe('RtkTrackingReader.getCompliance (T5)', () => {
  let complianceRoot: string;
  let existingDbPath: string;

  beforeEach(() => {
    complianceRoot = mkdtempSync(path.join(tmpdir(), 'rtk-compliance-'));
    existingDbPath = path.join(complianceRoot, 'history.db');
    // `getDriver()` refuses to open a path that does not exist, so the fake
    // driver would never be reached without a real file here.
    writeFileSync(existingDbPath, '');
  });

  afterEach(() => {
    rmSync(complianceRoot, { recursive: true, force: true });
    _resetForTesting();
  });

  function readerWith(rows: {
    commands: { rtk_cmd: string }[];
    failures?: { fallback_succeeded: number }[];
    withFailuresTable?: boolean;
  }) {
    const driver = {
      prepare: (sql: string) => ({
        get: (..._params: unknown[]) => {
          if (sql.includes('FROM commands')) {
            const proxied = rows.commands.filter((c) => c.rtk_cmd.startsWith('rtk proxy')).length;
            return { proxied, filtered: rows.commands.length - proxied };
          }
          const failures = rows.failures ?? [];
          return {
            total: failures.length,
            recovered: failures.filter((f) => f.fallback_succeeded === 1).length,
          };
        },
        all: (..._params: unknown[]) =>
          (rows.withFailuresTable === false ? [] : [{ name: 'parse_failures' }]),
      }),
      pragma: () => [{ name: 'project_path' }],
      close: () => { /* in-memory compliance fixture has no resources */ },
    } as unknown as SqliteDriver;

    return new RtkTrackingReader({
      dbPathOverride: existingDbPath,
      driverFactory: () => driver,
    });
  }

  it('counts rtk proxy invocations as bypass, not as filtering', () => {
    const result = readerWith({
      commands: [
        { rtk_cmd: 'rtk git status' },
        { rtk_cmd: 'rtk proxy npm test' },
        { rtk_cmd: 'rtk proxy cargo build' },
        { rtk_cmd: 'rtk npm run build' },
      ],
    }).getCompliance();

    expect(result?.filtered).toBe(2);
    expect(result?.proxied).toBe(2);
    expect(result?.proxyRatePct).toBe(50);
  });

  it('reports the parse-failure rate, which the savings summary hides entirely', () => {
    const result = readerWith({
      commands: [{ rtk_cmd: 'rtk git status' }],
      failures: [{ fallback_succeeded: 1 }, { fallback_succeeded: 1 }, { fallback_succeeded: 0 }],
    }).getCompliance();

    expect(result?.parseFailures).toBe(3);
    expect(result?.parseFailuresRecovered).toBe(2);
    // 3 failures out of 4 attempted invocations.
    expect(result?.parseFailureRatePct).toBe(75);
  });

  it('names what it cannot measure instead of implying full coverage', () => {
    const result = readerWith({ commands: [{ rtk_cmd: 'rtk git status' }] }).getCompliance();
    expect(result?.unmeasurable.join(' ')).toContain('RTK_DISABLED');
    expect(result?.unmeasurable.join(' ')).toContain('no rtk prefix');
  });

  it('omits parse failures from a project-scoped query rather than attributing global ones', () => {
    const result = readerWith({
      commands: [{ rtk_cmd: 'rtk git status' }],
      failures: [{ fallback_succeeded: 1 }],
    }).getCompliance({ projectPath: '/repo' });

    expect(result?.parseFailures).toBe(0);
    expect(result?.unmeasurable.join(' ')).toContain('not recorded per project');
  });

  it('returns null rates rather than a flattering zero when there is no data', () => {
    const result = readerWith({ commands: [] }).getCompliance();
    expect(result?.proxyRatePct).toBeNull();
    expect(result?.parseFailureRatePct).toBeNull();
  });
});


describe('incremental daily rollup', () => {
  it('matches exact raw summaries across the partial-day boundary, projects and restarts', () => {
    const rows: FixtureRow[] = [
      { timestamp: '2026-10-13T09:59:00.000Z', original: 'git status', rewritten: 'rtk git status', inputTokens: 100, outputTokens: 10, projectPath: '/a' },
      { timestamp: '2026-10-13T10:01:00.000Z', original: 'git status', rewritten: 'rtk git status', inputTokens: 100, outputTokens: 30, projectPath: '/a' },
      { timestamp: '2026-10-14T12:00:00.000Z', original: 'git status', rewritten: 'rtk git status', inputTokens: 300, outputTokens: 60, projectPath: '/a' },
      { timestamp: '2026-10-14T13:00:00.000Z', original: 'cargo test', rewritten: 'rtk cargo test', inputTokens: 1000, outputTokens: 10, projectPath: '/b' },
    ];
    const source = buildSharedDriver(rows)(':memory:');
    const cache = createSqliteWasmDatabase(':memory:') as unknown as SqliteDriver;
    const now = Date.parse('2026-10-20T10:00:00.000Z');
    const opts = { sinceMs: now - 7 * 86_400_000 };
    const rollup = new RtkDailyRollup(cache);
    expect(rollup.getSummary(source, 'source-1', true, opts, now)).toMatchObject({ commands: 3, totalSaved: 1300 });
    expect(rollup.getSummary(source, 'source-1', true, { ...opts, projectPath: '/a' }, now))
      .toMatchObject({ commands: 2, totalSaved: 310, avgSavingsPct: 75 });
    source.prepare(`INSERT INTO commands (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, project_path)
      VALUES (?, 'git status', 'rtk git status', 100, 50, 50, 50, '/a')`).run('2026-10-20T09:00:00.000Z');
    const restarted = new RtkDailyRollup(cache);
    expect(restarted.getSummary(source, 'source-1', true, opts, now)).toMatchObject({ commands: 4, totalSaved: 1350 });
    expect(restarted.getSummary(source, 'source-1', true, opts, now)).toMatchObject({ commands: 4, totalSaved: 1350 });
    // A replacement file with the same IDs must discard its predecessor's aggregates.
    const replacement = buildSharedDriver([rows[2]])(':memory:');
    expect(restarted.getSummary(replacement, 'source-2', true, opts, now)).toMatchObject({ commands: 1, totalSaved: 240 });
    expect(restarted.getSummary(source, 'source-1', true, {}, now)).toBeUndefined();
    expect(restarted.getSummary(source, 'source-1', true, { sinceMs: now - 30 * 86_400_000 }, now)).toBeUndefined();
    cache.close();
  });

  it('supports legacy schemas and bounds retention to eight days', () => {
    const source = buildSharedDriver([
      { timestamp: '2026-09-01T10:00:00.000Z', original: 'x', rewritten: 'rtk x', inputTokens: 1, outputTokens: 0 },
      { timestamp: '2026-10-20T10:00:00.000Z', original: 'x', rewritten: 'rtk x', inputTokens: 2, outputTokens: 0 },
    ], { withProjectColumn: false })(':memory:');
    const cache = createSqliteWasmDatabase(':memory:') as unknown as SqliteDriver;
    const now = Date.parse('2026-10-20T12:00:00.000Z');
    const rollup = new RtkDailyRollup(cache);
    expect(rollup.getSummary(source, 'legacy', false, { sinceMs: now - 7 * 86_400_000, projectPath: '/ignored' }, now))
      .toMatchObject({ commands: 1, totalSaved: 2 });
    expect(cache.prepare('SELECT COUNT(*) AS n FROM daily').get()).toEqual({ n: 1 });
    cache.close();
  });
});

describe('hourly project burst notices', () => {
  it('warns strictly above 2,000 per project and ignores older invocations', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rtk-bursts-'));
    const dbPath = path.join(root, 'history.db');
    writeFileSync(dbPath, '');
    try {
      const row = { timestamp: '2026-10-20T11:30:00.000Z', original: 'git cat-file', rewritten: 'rtk git cat-file', inputTokens: 1, outputTokens: 0 };
      const rows = [
        ...Array.from({ length: 2001 }, () => ({ ...row, projectPath: '/burst' })),
        ...Array.from({ length: 2000 }, () => ({ ...row, projectPath: '/threshold' })),
        ...Array.from({ length: 2001 }, () => ({ ...row, projectPath: '/old', timestamp: '2026-10-20T10:59:00.000Z' })),
      ];
      const reader = new RtkTrackingReader({ dbPathOverride: dbPath, driverFactory: buildSharedDriver(rows) });
      expect(reader.getProjectBursts(Date.parse('2026-10-20T12:00:00.000Z')))
        .toEqual([{ projectPath: '/burst', commands: 2001 }]);
      reader.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
