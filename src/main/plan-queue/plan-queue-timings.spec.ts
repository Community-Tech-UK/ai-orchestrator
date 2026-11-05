import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { LandingTimer, PlanQueueSlotWaits, recordSessionEnd, recordTiming, TIMING_REASONS } from './plan-queue-timings';
import { PlanQueueSpawnOutOfUsage, USAGE_RECHECK_MS } from './plan-queue-spawn';
import { PlanQueueUsageWaits } from './plan-queue-usage-wait';

let db: SqliteDriver;
beforeAll(() => initSqliteWasm());
afterEach(() => { db?.close(); vi.useRealTimers(); });

function storeWithClock() {
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
  const clock = { now: 1_000_000 };
  return { clock, store: new PlanQueueStore(db, () => clock.now) };
}

const rows = (store: PlanQueueStore, reason: string) => (db.prepare('SELECT item_id, detail_head FROM plan_queue_item_events WHERE reason = ? ORDER BY rowid')
  .all<{ item_id: string; detail_head: string }>(reason)).map(row => ({ itemId: row.item_id, ...JSON.parse(row.detail_head) as Record<string, unknown> }));

describe('landing timer', () => {
  it('adds up each phase and reads the machine load at the start and end of the pre-commit check only', async () => {
    let now = 0; const loads = [1.234, 5.678, 99];
    const timer = new LandingTimer(() => now, () => loads.shift() ?? 0);
    await timer.measure('sync', async () => { now += 100; });
    await timer.measure('sync', async () => { now += 50; });
    await timer.measure('commitCheck', async () => { now += 8000; });
    await timer.measure('publish', async () => { now += 20; });
    expect(timer.detail('landed')).toEqual({ outcome: 'landed', syncMs: 150, commitCheckMs: 8000, publishMs: 20, totalMs: 8170, loadStart: 1.23, loadEnd: 5.68 });
  });

  it('still reports a phase that failed, and nothing when no phase ran', async () => {
    let now = 0;
    const timer = new LandingTimer(() => now);
    expect(timer.detail('not-landed')).toBeNull();
    await expect(timer.measure('mergeCheck', async () => { now += 7; throw new Error('gate failed'); })).rejects.toThrow('gate failed');
    expect(timer.detail('failed')).toMatchObject({ outcome: 'failed', mergeCheckMs: 7 });
  });
});

describe('slot waits', () => {
  it('records a wait only for an item that was ready and blocked, with the delay after a slot freed', () => {
    const { clock, store } = storeWithClock();
    const item = newPlanQueueItem('a', 'run', '/repo/a_plan.md', 1, { state: 'queued' });
    store.waits.blocked('a');
    clock.now += 60_000; store.waits.blocked('a'); // a later pass must not restart the clock
    clock.now += 60_000; store.waits.freed('worker');
    clock.now += 15_000; store.waits.started(item, 'worker');
    expect(rows(store, TIMING_REASONS.slotWait)).toEqual([{ itemId: 'a', kind: 'worker', waitedMs: 135_000, freeToStartMs: 15_000 }]);
    store.waits.started(item, 'worker'); // started again without being blocked: nothing new
    expect(rows(store, TIMING_REASONS.slotWait)).toHaveLength(1);
  });

  it('does not call a slot that freed before the item was blocked the cause of its wait', () => {
    const { clock, store } = storeWithClock();
    const item = newPlanQueueItem('a', 'run', '/repo/a_plan.md', 1, { state: 'awaiting-slot' });
    store.waits.freed('check');
    clock.now += 1000; store.waits.blocked('a');
    clock.now += 1000; store.waits.started(item, 'check');
    expect(rows(store, TIMING_REASONS.slotWait)).toEqual([{ itemId: 'a', kind: 'check', waitedMs: 1000, freeToStartMs: null }]);
  });

  it('forgets an item that stopped waiting, and loses a wait in progress when the app restarts', () => {
    const { clock, store } = storeWithClock();
    const item = newPlanQueueItem('a', 'run', '/repo/a_plan.md', 1, { state: 'queued' });
    store.waits.blocked('a');
    store.waits.prune(new Set());
    clock.now += 1000; store.waits.started(item, 'worker');
    store.waits.blocked('a');
    const afterRestart = new PlanQueueSlotWaits(store.history, () => clock.now);
    afterRestart.started(item, 'worker');
    expect(rows(store, TIMING_REASONS.slotWait)).toEqual([]);
  });

  it('records a slot opening when an item leaves the states that hold one', () => {
    const { clock, store } = storeWithClock();
    store.upsertRun({ id: 'run', parentInstanceId: 'p', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo', status: 'running',
      config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null });
    const queued = newPlanQueueItem('b', 'run', '/repo/b_plan.md', 1, { state: 'queued' });
    const working = newPlanQueueItem('a', 'run', '/repo/a_plan.md', 1, { state: 'working' });
    store.upsertItem(queued); store.upsertItem(working);
    store.waits.blocked('b');
    clock.now += 5000; store.upsertItem({ ...working, state: 'parked' });
    clock.now += 2000; store.waits.started(queued, 'worker');
    expect(rows(store, TIMING_REASONS.slotWait)[0]).toMatchObject({ waitedMs: 7000, freeToStartMs: 2000 });
  });
});

describe('timing rows beside decision history', () => {
  const event = { itemId: 'item', runId: 'run', fromState: null, toState: 'awaiting-slot' as const, round: 0, tokens: 0 };

  it('never push an older decision event out of the window the queue reads, and are not returned by it', () => {
    const { store } = storeWithClock();
    store.history.recordEvent({ ...event, reason: 'capacity-wait', detailHead: '123' });
    for (let i = 0; i < 80; i++) recordTiming(store.history, { id: 'item', runId: 'run', state: 'awaiting-slot', round: 0 }, TIMING_REASONS.slotWait, { kind: 'worker', waitedMs: i });
    const listed = store.history.listEvents('item');
    expect(listed.map(row => row.reason)).toEqual(['capacity-wait']);
    expect(rows(store, TIMING_REASONS.slotWait)).toHaveLength(80);
  });

  it('do not look like a member leaving a check group', () => {
    const { store } = storeWithClock();
    const leader = newPlanQueueItem('leader', 'run', '/repo/l_plan.md', 1, { state: 'verifying' });
    store.history.recordChecklistRun(leader, ['leader', 'member'], 'group');
    // A session ending while the member is being set aside is a measurement, not the member leaving.
    recordTiming(store.history, { id: 'member', runId: 'run', state: 'parked', round: 0 }, TIMING_REASONS.sessionEnd, { role: 'checker', instanceId: 'x' });
    expect(store.history.checkGroupRoundIntact('group', ['leader', 'member'])).toBe(true);
  });

  it('are best effort: a failed write is logged and never reaches the caller', () => {
    const failing = { recordEvent: () => { throw new Error('disk full'); } };
    expect(() => recordTiming(failing, { id: 'item', runId: 'run', state: 'working', round: 0 }, TIMING_REASONS.landing, { totalMs: 1 })).not.toThrow();
  });

  it('record a session end for a worker or checker only, and a failing role lookup never reaches the stop', () => {
    const { store } = storeWithClock();
    const item = newPlanQueueItem('item', 'run', '/repo/a_plan.md', 1, { state: 'working' });
    const host = (role: string | null) => ({ history: store.history, getItem: () => item,
      roleOf: () => role ? { role, runId: 'run', itemId: 'item' } : undefined }) as unknown as Parameters<typeof recordSessionEnd>[0];
    recordSessionEnd(host('worker'), 'w1');
    recordSessionEnd(host('verifier'), 'c1');
    recordSessionEnd(host('triage'), 'p1');
    recordSessionEnd(host(null), 'gone');
    expect(rows(store, TIMING_REASONS.sessionEnd)).toEqual([
      { itemId: 'item', role: 'worker', instanceId: 'w1' }, { itemId: 'item', role: 'checker', instanceId: 'c1' }]);
    const broken = { history: store.history, getItem: () => item, roleOf: () => { throw new Error('lookup failed'); } } as unknown as Parameters<typeof recordSessionEnd>[0];
    expect(() => recordSessionEnd(broken, 'x')).not.toThrow();
  });
});

describe('usage waits', () => {
  const error = new PlanQueueSpawnOutOfUsage(null, 'a provider');

  it('report how long usage held the item up when the recheck time passes', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const ended: unknown[] = [];
    const waits = new PlanQueueUsageWaits((id, kind, waitedMs) => ended.push({ id, kind, waitedMs }));
    waits.start('a', error, 'worker');
    vi.setSystemTime(10_000 + USAGE_RECHECK_MS - 1);
    expect(waits.isWaiting('a')).toBe(true);
    expect(ended).toEqual([]);
    vi.setSystemTime(10_000 + USAGE_RECHECK_MS + 90_000);
    expect(waits.isWaiting('a')).toBe(false);
    expect(waits.isWaiting('a')).toBe(false);
    expect(ended).toEqual([{ id: 'a', kind: 'worker', waitedMs: USAGE_RECHECK_MS }]);
  });

  it('report the time actually waited when James clears the wait early, once', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const ended: unknown[] = [];
    const waits = new PlanQueueUsageWaits((id, kind, waitedMs) => ended.push({ id, kind, waitedMs }));
    waits.start('a', error, 'check');
    vi.setSystemTime(40_000);
    waits.clear('a'); waits.clear('a');
    expect(ended).toEqual([{ id: 'a', kind: 'check', waitedMs: 40_000 }]);
  });

  it('close the earlier stretch when a new wait starts on top of it', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const ended: unknown[] = [];
    const waits = new PlanQueueUsageWaits((id, kind, waitedMs) => ended.push({ id, kind, waitedMs }));
    waits.start('a', error, 'worker');
    vi.setSystemTime(1000);
    waits.start('a', error, 'worker');
    expect(ended).toEqual([{ id: 'a', kind: 'worker', waitedMs: 1000 }]);
  });
});
