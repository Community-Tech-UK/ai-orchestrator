import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import {
  isClaudeCostModel,
  loadStoredClaudeSessions,
  readBookingLiveAt,
  reconcileClaudeCosts,
  type StoredClaudeSession,
} from './claude-cost-reconcile';
import type { ClaudeCostStateRead } from './claude-cost-state-reader';

const LIVE_AT = 1_000;
const session = (id: string, storedUsd: number, firstAt = 2_000, extra: Partial<StoredClaudeSession> = {}): StoredClaudeSession =>
  ({ sessionId: id, models: ['opus'], rows: 3, storedUsd, firstAt, lastAt: firstAt + 10, ...extra });
const settled = (totalCostUSD: number, hasUnknownModelCost = false): ClaudeCostStateRead =>
  ({ kind: 'settled', totalCostUSD, hasUnknownModelCost });
const run = (sessions: StoredClaudeSession[], states: Record<string, ClaudeCostStateRead | 'no-transcript'>, thresholdPct?: number) =>
  reconcileClaudeCosts({ sessions, bookingLiveAt: LIVE_AT, now: 9_000, windowStart: 500, thresholdPct },
    { readState: async id => states[id] ?? 'no-transcript' });

describe('Claude model detection', () => {
  it('accepts the CLI aliases and full ids, and rejects other providers', () => {
    for (const model of ['opus', 'opus[1m]', 'sonnet', 'haiku', 'fable', 'fable[1m]', 'claude-opus-5-5']) expect(isClaudeCostModel(model), model).toBe(true);
    for (const model of ['gpt-6.1-sol', 'gemini-3', 'grok-4', '', 'opusx']) expect(isClaudeCostModel(model), model).toBe(false);
  });
});

describe('reconcileClaudeCosts', () => {
  it('reports ok when stored spend matches Claude within the threshold', async () => {
    const report = await run([session('a', 10.2), session('b', 5)], { a: settled(10), b: settled(5) });
    expect(report.status).toBe('ok');
    expect(report.total).toMatchObject({ sessions: 2, storedUsd: 15.2, cliUsd: 15, gapUsd: expect.closeTo(0.2, 6) });
    expect(report.total.driftPct).toBeCloseTo(1.3333, 3);
    expect(report.coverage).toMatchObject({ candidates: 2, compared: 2, notClaude: 0, noTranscript: 0, unsettled: 0, unknownModelCost: 0 });
  });

  it('flags drift above the threshold in either direction and not at exactly the threshold', async () => {
    expect((await run([session('a', 9.4)], { a: settled(10) })).status).toBe('drift');
    expect((await run([session('a', 10.6)], { a: settled(10) })).status).toBe('drift');
    expect((await run([session('a', 10.5)], { a: settled(10) })).status).toBe('ok');
    expect((await run([session('a', 10.6)], { a: settled(10) }, 10)).status).toBe('ok');
  });

  it('splits sessions by whether any stored row predates per-turn booking', async () => {
    const report = await run(
      [session('new', 10, 2_000), session('old', 90, 900)],
      { new: settled(10), old: settled(100) },
    );
    expect(report.byEra['per-turn']).toMatchObject({ sessions: 1, storedUsd: 10, cliUsd: 10, driftPct: 0 });
    expect(report.byEra.repaired).toMatchObject({ sessions: 1, storedUsd: 90, cliUsd: 100, gapUsd: -10, driftPct: -10 });
    expect(report.total.driftPct).toBeCloseTo(-9.0909, 3);
    expect(report.status).toBe('drift');
  });

  it('treats every session as per-turn when no booking cutoff is recorded', async () => {
    const report = await reconcileClaudeCosts({ sessions: [session('a', 1, 5)], bookingLiveAt: null, now: 9_000, windowStart: 0 },
      { readState: async () => settled(1) });
    expect(report.byEra['per-turn'].sessions).toBe(1);
    expect(report.byEra.repaired.sessions).toBe(0);
  });

  it('counts, and does not compare, sessions that are not Claude, have no transcript, are unsettled or cannot be priced', async () => {
    const report = await run(
      [session('a', 10), session('gpt', 4, 2_000, { models: ['gpt-6.1-sol'] }), session('gone', 2), session('live', 3), session('unpriced', 8), session('nofile', 1)],
      { a: settled(10), gone: 'no-transcript', live: { kind: 'unsettled' }, unpriced: settled(7, true), nofile: { kind: 'missing' } },
    );
    expect(report.coverage).toEqual({ candidates: 6, notClaude: 1, noTranscript: 1, unsettled: 2, unknownModelCost: 1, compared: 1 });
    expect(report.total).toMatchObject({ sessions: 1, storedUsd: 10, cliUsd: 10 });
  });

  it('gives no verdict only when nothing trustworthy was compared', async () => {
    expect((await run([], {})).status).toBe('insufficient-data');
    expect((await run([session('a', 3)], { a: { kind: 'unsettled' } })).status).toBe('insufficient-data');
  });

  it('flags drift above the threshold however small the compared spend is', async () => {
    const tiny = await run([session('a', 0.3)], { a: settled(0.2) });
    expect(tiny.status).toBe('drift');
    expect(tiny.total.driftPct).toBeCloseTo(50, 5);
    expect((await run([session('a', 0.0106)], { a: settled(0.01) })).status).toBe('drift');
    expect((await run([session('a', 0.0104)], { a: settled(0.01) })).status).toBe('ok');
  });

  it('treats booked spend against a zero Claude total as clear drift, and two zeros as agreement', async () => {
    const report = await run([session('a', 2)], { a: settled(0) });
    expect(report.status).toBe('drift');
    expect(report.total.driftPct).toBeNull();
    expect(report.largestGaps[0]).toMatchObject({ sessionId: 'a', gapPct: null, gapUsd: 2 });
    expect((await run([session('a', 0)], { a: settled(0) })).status).toBe('ok');
  });

  it('does not flag exactly 5% because of floating-point error in the sums', async () => {
    const tenths = Array.from({ length: 10 }, (_, index) => session(`s${index}`, 0.105));
    const states = Object.fromEntries(tenths.map(item => [item.sessionId, settled(0.1)]));
    const report = await run(tenths, states);
    expect(report.total.gapUsd / report.total.cliUsd * 100).toBeGreaterThan(5);
    expect(report.status).toBe('ok');
    expect((await run([session('a', 1.05)], { a: settled(1) })).status).toBe('ok');
    expect((await run([session('a', 1.050002)], { a: settled(1) })).status).toBe('drift');
    expect((await run([session('a', 0.95)], { a: settled(1) })).status).toBe('ok');
    expect((await run([session('a', 0.949998)], { a: settled(1) })).status).toBe('drift');
  });

  it('lists the largest absolute gaps first and caps the list', async () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(`s${index}`, 10 + index));
    const states = Object.fromEntries(sessions.map(item => [item.sessionId, settled(10)]));
    const report = await run(sessions, states);
    expect(report.largestGaps.map(item => item.sessionId)).toEqual(['s7', 's6', 's5', 's4', 's3']);
    expect(report.largestGaps[0]).toMatchObject({ gapUsd: 7, gapPct: 70, era: 'per-turn', rows: 3 });
  });

  it('records when and over what it looked', async () => {
    const report = await run([session('a', 1)], { a: settled(1) });
    expect(report).toMatchObject({ version: 1, checkedAt: 9_000, windowStart: 500, thresholdPct: 5 });
  });

  it('yields between sessions so a long run cannot starve the main process', async () => {
    let turns = 0;
    await reconcileClaudeCosts({ sessions: [session('a', 1), session('b', 1), session('c', 1)], bookingLiveAt: null, now: 1, windowStart: 0 },
      { readState: async () => settled(1), yieldTurn: async () => { turns++; } });
    expect(turns).toBe(3);
  });
});

describe('stored session loading', () => {
  let db: SqliteDriver;
  const row = (id: string, session: string, model: string, timestamp: number, cost: number) => db.prepare(
    `INSERT INTO cost_entries (id,timestamp,instance_id,session_id,model,cost) VALUES (?,?,?,?,?,?)`).run(id, timestamp, 'inst', session, model, cost);
  beforeEach(() => { db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db); });
  afterEach(() => db.close());

  it('sums the whole life of every session active in the window, not only the window', () => {
    row('1', 'long', 'opus', 100, 1.5);
    row('2', 'long', 'opus', 5_000, 2.5);
    row('3', 'old', 'opus', 100, 9);
    row('4', 'codex', 'gpt-6.1-sol', 5_000, 4);
    row('5', '', 'opus', 5_000, 7);
    const sessions = loadStoredClaudeSessions(db, 4_000);
    expect(sessions.map(item => item.sessionId).sort()).toEqual(['codex', 'long']);
    expect(sessions.find(item => item.sessionId === 'long')).toEqual({ sessionId: 'long', models: ['opus'], rows: 2, storedUsd: 4, firstAt: 100, lastAt: 5_000 });
  });

  it('reads the per-turn booking cutoff and tolerates its absence', () => {
    expect(readBookingLiveAt(db)).toEqual(expect.any(Number));
    db.prepare("DELETE FROM maintenance_markers WHERE name='a0-per-turn-booking-live'").run();
    expect(readBookingLiveAt(db)).toBeNull();
  });
});
