import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from './loop-schema';
import { closeStaleProviderLimitParks, closeStoredLoopRun, STALE_PROVIDER_LIMIT_PARK_MS } from './loop-store-close';

describe('closeStoredLoopRun', () => {
  let db: SqliteDriver;
  beforeEach(() => { db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db); });
  afterEach(() => db.close());

  function seed(status = 'paused', endedAt: number | null = null) {
    db.prepare('INSERT INTO loop_runs (id, chat_id, config_json, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('loop-1', 'chat-1', '{}', status, 100, endedAt);
    db.prepare('INSERT INTO loop_checkpoints (loop_run_id, version, chat_id, status, state_json, history_tail_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('loop-1', 1, 'chat-1', 'running', JSON.stringify({ id: 'loop-1', status: 'running', endedAt: null }), '[]', 100);
  }

  it.each(['paused', 'provider-limit'])('closes a stored %s run and its stale running checkpoint', (status) => {
    seed(status);
    db.prepare('INSERT INTO loop_iterations (id, loop_run_id, seq, stage, started_at, ended_at, work_hash, output_excerpt, progress_verdict, verify_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('round-1', 'loop-1', 0, 'IMPLEMENT', 200, 300, 'hash', '', 'OK', 'not-run');
    expect(closeStoredLoopRun(db, 'loop-1')).toBe(true);
    expect(db.prepare('SELECT status, ended_at, end_reason FROM loop_runs').get()).toEqual({
      status: 'cancelled', ended_at: 300, end_reason: 'closed: stranded after app restart',
    });
    const checkpoint = db.prepare('SELECT status, state_json FROM loop_checkpoints').get<{ status: string; state_json: string }>();
    expect(checkpoint?.status).toBe('cancelled');
    expect(JSON.parse(checkpoint!.state_json)).toMatchObject({ status: 'cancelled', endedAt: 300, endReason: 'closed: stranded after app restart' });
    expect(closeStoredLoopRun(db, 'loop-1')).toBe(false);
  });

  it('uses the start time when no round exists', () => {
    seed();
    expect(closeStoredLoopRun(db, 'loop-1')).toBe(true);
    expect(db.prepare('SELECT ended_at FROM loop_runs').get()).toEqual({ ended_at: 100 });
  });

  it.each([['running', null], ['completed', 300], ['attempt-failed', 300], ['provider-limit', 300], ['paused', 300]])(
    'leaves ineligible %s/%s rows unchanged', (status, endedAt) => {
      seed(status as string, endedAt as number | null);
      expect(closeStoredLoopRun(db, 'loop-1')).toBe(false);
      expect(db.prepare('SELECT status, ended_at FROM loop_runs').get()).toEqual({ status, ended_at: endedAt });
      expect(db.prepare('SELECT status FROM loop_checkpoints').get()).toEqual({ status: 'running' });
    },
  );

  it('rolls back both records when a checkpoint cannot be parsed', () => {
    seed();
    db.prepare('UPDATE loop_checkpoints SET state_json = ?').run('invalid json');
    expect(() => closeStoredLoopRun(db, 'loop-1')).toThrow();
    expect(db.prepare('SELECT status, ended_at FROM loop_runs').get()).toEqual({ status: 'paused', ended_at: null });
  });
});

describe('closeStaleProviderLimitParks', () => {
  let db: SqliteDriver;
  beforeEach(() => { db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db); });
  afterEach(() => db.close());

  const DAY = 24 * 60 * 60_000;
  const now = 100 * DAY;
  function park(id: string, startedAt: number, lastRoundEnd?: number) {
    db.prepare('INSERT INTO loop_runs (id, chat_id, config_json, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .run(id, 'chat-1', '{}', 'provider-limit', startedAt);
    if (lastRoundEnd !== undefined) {
      db.prepare('INSERT INTO loop_iterations (id, loop_run_id, seq, stage, started_at, ended_at, work_hash, output_excerpt, progress_verdict, verify_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`${id}-round`, id, 0, 'IMPLEMENT', lastRoundEnd - 1, lastRoundEnd, 'hash', '', 'OK', 'not-run');
    }
  }
  const row = (id: string) => db.prepare('SELECT status, end_reason FROM loop_runs WHERE id = ?').get(id);

  it('closes only parks with no resume scheduled and no activity for over two weeks', () => {
    park('stale', now - 15 * DAY);
    park('recent', now - 2 * DAY);
    park('old-but-active', now - 30 * DAY, now - 3 * DAY);
    park('just-inside', now - STALE_PROVIDER_LIMIT_PARK_MS);
    // A monthly allowance: parked 20 days ago and still due to resume.
    park('monthly-wait', now - 20 * DAY);

    expect(closeStaleProviderLimitParks(db, new Set(['monthly-wait']), now)).toEqual(['stale']);
    expect(row('stale')).toEqual({ status: 'cancelled', end_reason: 'closed: parked on a usage limit for over two weeks' });
    expect(row('recent')).toEqual({ status: 'provider-limit', end_reason: null });
    expect(row('old-but-active')).toEqual({ status: 'provider-limit', end_reason: null });
    expect(row('just-inside')).toEqual({ status: 'provider-limit', end_reason: null });
    expect(row('monthly-wait')).toEqual({ status: 'provider-limit', end_reason: null });
  });

  it('leaves a usage-limit run that has already ended alone', () => {
    db.prepare('INSERT INTO loop_runs (id, chat_id, config_json, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ended', 'chat-1', '{}', 'provider-limit', 1, 2);
    expect(closeStaleProviderLimitParks(db, new Set(), now)).toEqual([]);
    expect(db.prepare('SELECT status, ended_at FROM loop_runs').get()).toEqual({ status: 'provider-limit', ended_at: 2 });
  });
});
