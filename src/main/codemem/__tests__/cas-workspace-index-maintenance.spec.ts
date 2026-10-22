import { describe, expect, it } from 'vitest';
import { CODEMEM_JOURNAL_SIZE_LIMIT_BYTES, migrate } from '../cas-schema';
import {
  checkpointAndTruncateWal,
  vacuumFreelistPages,
} from '../cas-workspace-index-maintenance';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';

interface FakeVacuumDb {
  db: SqliteDriver;
  calls: string[];
}

/**
 * A database whose free pages drop by each step's request. `busyFrom` makes
 * every checkpoint from that (0-based) call onwards report an open reader.
 */
function fakeVacuumDb(options: {
  freePages: number;
  checkpointBusy?: boolean;
  busyFrom?: number;
  autoVacuum?: number;
}): FakeVacuumDb {
  const calls: string[] = [];
  let freePages = options.freePages;
  let checkpoints = 0;
  const db = {
    pragma: (source: string) => {
      calls.push(source);
      if (source === 'auto_vacuum') return options.autoVacuum ?? 2;
      if (source === 'freelist_count') return freePages;
      const step = /^incremental_vacuum\((\d+)\)$/.exec(source);
      if (step) {
        freePages = Math.max(0, freePages - Number(step[1]));
        return [];
      }
      if (source === 'wal_checkpoint(TRUNCATE)') {
        const busy = options.checkpointBusy || (options.busyFrom !== undefined && checkpoints >= options.busyFrom);
        checkpoints += 1;
        return [{ busy: busy ? 1 : 0, log: 10, checkpointed: busy ? 0 : 10 }];
      }
      return [];
    },
    exec: (sql: string) => {
      calls.push(`exec:${sql}`);
    },
  } as unknown as SqliteDriver;
  return { db, calls };
}

describe('vacuumFreelistPages', () => {
  it('releases free pages in bounded steps with a checkpoint after each step', () => {
    const { db, calls } = fakeVacuumDb({ freePages: 25 });

    const result = vacuumFreelistPages(db, { stepPages: 10 });

    expect(result).toEqual({ freedPages: 25, remainingFreePages: 0, stoppedReason: 'done' });
    expect(calls.filter((call) => call.startsWith('incremental_vacuum'))).toEqual([
      'incremental_vacuum(10)',
      'incremental_vacuum(10)',
      'incremental_vacuum(5)',
    ]);
    // One checkpoint before the first step, then one after each step.
    expect(calls.filter((call) => call === 'wal_checkpoint(TRUNCATE)')).toHaveLength(4);
  });

  it('moves no pages while an open read keeps the WAL from checkpointing', () => {
    const { db, calls } = fakeVacuumDb({ freePages: 100, checkpointBusy: true });

    const result = vacuumFreelistPages(db, { stepPages: 10 });

    expect(result).toEqual({ freedPages: 0, remainingFreePages: 100, stoppedReason: 'checkpoint-busy' });
    expect(calls.some((call) => call.startsWith('incremental_vacuum'))).toBe(false);
  });

  it('stops after one step when a read opens mid-run', () => {
    const { db, calls } = fakeVacuumDb({ freePages: 100, busyFrom: 1 });

    const result = vacuumFreelistPages(db, { stepPages: 10 });

    expect(result).toEqual({ freedPages: 10, remainingFreePages: 90, stoppedReason: 'checkpoint-busy' });
    expect(calls.filter((call) => call.startsWith('incremental_vacuum'))).toEqual(['incremental_vacuum(10)']);
  });

  it('leaves the one-off full VACUUM to callers that allow it', () => {
    const { db, calls } = fakeVacuumDb({ freePages: 40, autoVacuum: 0 });

    const result = vacuumFreelistPages(db, { allowFullVacuum: false });

    expect(result).toEqual({ freedPages: 0, remainingFreePages: 40, stoppedReason: 'full-vacuum-needed' });
    expect(calls).not.toContain('exec:VACUUM');
  });

  it('stops starting steps once the time budget is spent', () => {
    const { db } = fakeVacuumDb({ freePages: 100 });
    let clock = 0;

    const result = vacuumFreelistPages(db, {
      stepPages: 10,
      timeBudgetMs: 25,
      now: () => {
        const current = clock;
        clock += 10;
        return current;
      },
    });

    expect(result.stoppedReason).toBe('time-budget');
    expect(result.remainingFreePages).toBeGreaterThan(0);
    expect(result.freedPages + result.remainingFreePages).toBe(100);
  });

  // The test SQLite driver keeps each connection in its own memory, so a WAL
  // shared with a second, reading connection cannot be built here; the
  // busy-reader path is covered with the fake above and was reproduced against
  // a real file with the sqlite3 CLI (see the plan).
  it('frees every page of a real database', () => {
    const db = defaultDriverFactory(':memory:');
    migrate(db);
    db.exec('CREATE TABLE filler (body TEXT)');
    const insert = db.prepare('INSERT INTO filler (body) VALUES (?)');
    for (let i = 0; i < 200; i++) insert.run('x'.repeat(8_192));
    db.exec('DELETE FROM filler');
    const freeBefore = Number(db.pragma('freelist_count', { simple: true }));
    expect(freeBefore).toBeGreaterThan(0);

    const result = vacuumFreelistPages(db, { stepPages: 64 });

    expect(result.stoppedReason).toBe('done');
    expect(result.freedPages).toBe(freeBefore);
    expect(Number(db.pragma('freelist_count', { simple: true }))).toBe(0);
    db.close();
  });
});

describe('checkpointAndTruncateWal', () => {
  it('does not wait for an open read, and restores the busy timeout afterwards', () => {
    const calls: string[] = [];
    const db = {
      pragma: (source: string) => {
        calls.push(source);
        if (source === 'busy_timeout') return 5000;
        if (source === 'wal_checkpoint(TRUNCATE)') return [{ busy: 1, log: 1, checkpointed: 0 }];
        return [];
      },
    } as unknown as SqliteDriver;

    expect(checkpointAndTruncateWal(db)).toBe(false);
    expect(calls).toEqual(['busy_timeout', 'busy_timeout = 0', 'wal_checkpoint(TRUNCATE)', 'busy_timeout = 5000']);
  });

  it('reports a busy checkpoint as not truncated', () => {
    expect(checkpointAndTruncateWal(fakeVacuumDb({ freePages: 0, checkpointBusy: true }).db)).toBe(false);
    expect(checkpointAndTruncateWal(fakeVacuumDb({ freePages: 0 }).db)).toBe(true);
  });
});

describe('codemem journal size limit', () => {
  it('caps the WAL size on every migrated connection', () => {
    const db = defaultDriverFactory(':memory:');
    migrate(db);

    expect(Number(db.pragma('journal_size_limit', { simple: true }))).toBe(CODEMEM_JOURNAL_SIZE_LIMIT_BYTES);
    db.close();
  });
});
