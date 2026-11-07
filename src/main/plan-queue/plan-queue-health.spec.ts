import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueItemState } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { computeQueueHealth } from './plan-queue-health';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { TIMING_REASONS } from './plan-queue-timings';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = 100 * DAY;

let db: SqliteDriver;
beforeAll(() => initSqliteWasm());
afterEach(() => db?.close());

/** A store on a clock the test moves by hand, with one run to hang items on. */
function fixture() {
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
  let clock = NOW - 10 * DAY;
  const store = new PlanQueueStore(db, () => clock);
  for (const id of ['run', 'run2']) store.upsertRun({ id, parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
    status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
  const items = new Map<string, ReturnType<typeof newPlanQueueItem>>();
  const move = (id: string, state: PlanQueueItemState, at: number, path = `/repo/${id}_plan.md`, runId = 'run') => {
    clock = at;
    const item = { ...(items.get(id) ?? newPlanQueueItem(id, runId, path, at, { state: 'queued' })), state };
    items.set(id, item);
    store.upsertItem(item);
  };
  const verdict = (itemId: string, result: 'PASS' | 'FAIL', at: number) => store.history.recordVerdict({
    itemId, runId: 'run', round: 0, verdict: result, findings: [], gatesRun: [], notChecked: [], worktreeHead: null, documentSha256: null, at });
  const timing = (itemId: string, reason: string, at: number, detail: object) => store.history.recordEvent({
    itemId, runId: 'run', fromState: 'working', toState: 'working', reason, detailHead: JSON.stringify(detail), round: 0, tokens: 0, at });
  /** queued, then a path to `end` with each step lasting `step` minutes. */
  const run = (id: string, start: number, end: PlanQueueItemState, path = `/repo/${id}_plan.md`, runId = 'run') => {
    move(id, 'queued', start - MIN, path, runId);
    let at = start;
    for (const state of ['preparing', 'working', 'awaiting-slot', 'verifying'] as const) { move(id, state, at, path, runId); at += 10 * MIN; }
    if (end === 'landed') { move(id, 'landing', at, path, runId); move(id, 'landed', at + 5 * MIN, path, runId); }
    else move(id, end, at, path, runId);
  };
  return { store, move, verdict, timing, run };
}

describe('Queue health', () => {
  it('computes every measure from stored events, verdicts and timing rows', () => {
    const { store, verdict, timing, run } = fixture();
    const base = NOW - 5 * DAY;
    run('a', base, 'landed');
    verdict('a', 'PASS', base + 30 * MIN);
    run('b', base + DAY, 'landed');
    verdict('b', 'FAIL', base + DAY + 30 * MIN); verdict('b', 'PASS', base + DAY + 40 * MIN);
    run('c', base + 2 * DAY, 'parked');
    verdict('c', 'PASS', base + 2 * DAY + 30 * MIN);
    run('d', base + 3 * DAY, 'parked', '/repo/shared_plan.md');
    for (const at of [1, 2, 3]) verdict('d', 'FAIL', base + 3 * DAY + at * MIN);
    run('g', base + 4 * DAY, 'landed', '/repo/shared_plan.md', 'run2');
    verdict('g', 'PASS', base + 4 * DAY + 30 * MIN);
    run('e', base + 4 * DAY, 'verifying'); // still in flight: not a finished attempt
    verdict('e', 'PASS', base + 4 * DAY + 20 * MIN);

    timing('a', TIMING_REASONS.sessionStart, base + 20 * MIN, { role: 'checker', instanceId: 'check-1', provider: 'codex', model: 'gpt' });
    timing('a', TIMING_REASONS.sessionEnd, base + 28 * MIN, { role: 'checker', instanceId: 'check-1' });
    timing('b', TIMING_REASONS.sessionStart, base + DAY, { role: 'checker', instanceId: 'check-2', provider: 'codex', model: 'gpt' });
    timing('b', TIMING_REASONS.sessionEnd, base + DAY + 20 * MIN, { role: 'checker', instanceId: 'check-2' });
    timing('b', TIMING_REASONS.sessionStart, base + DAY, { role: 'worker', instanceId: 'worker-1', provider: 'claude', model: 'opus' });
    timing('b', TIMING_REASONS.sessionEnd, base + DAY + 99 * MIN, { role: 'worker', instanceId: 'worker-1' });
    timing('a', TIMING_REASONS.slotWait, base, { kind: 'worker', waitedMs: 4 * MIN, freeToStartMs: 20_000 });
    timing('b', TIMING_REASONS.slotWait, base, { kind: 'check', waitedMs: 2 * MIN, freeToStartMs: 40_000 });
    timing('c', TIMING_REASONS.slotWait, base, { kind: 'check', waitedMs: 6 * MIN, freeToStartMs: null });
    timing('a', TIMING_REASONS.usageWait, base, { kind: 'worker', waitedMs: 3 * MIN });
    timing('a', TIMING_REASONS.landing, base, { outcome: 'landed', syncMs: 10_000, mergeCheckMs: 60_000, commitCheckMs: 8 * MIN, publishMs: 2_000, totalMs: 9 * MIN, loadStart: 3, loadEnd: 7 });
    timing('b', TIMING_REASONS.landing, base, { outcome: 'landed', syncMs: 30_000, commitCheckMs: 4 * MIN, publishMs: 4_000, totalMs: 5 * MIN });
    timing('c', TIMING_REASONS.landing, base, { outcome: 'not-landed', commitCheckMs: 15 * MIN, totalMs: 15 * MIN });

    const health = store.queueHealth();

    // a, b, g landed; c and d ended set aside; e is still running and is not a finished attempt.
    expect(health.attemptsLanded).toEqual({ count: 3, of: 5, share: 0.6 });
    // Five finished attempts cover four documents; g landed the one d was set aside on.
    expect(health.documentsLanded).toEqual({ count: 3, of: 4, share: 0.75 });
    // a, b, c and g passed a check; only c ended without landing.
    expect(health.passesNotLanded).toEqual({ count: 1, of: 4, share: 0.25 });
    // First check, for every finished attempt that has one (e is still running, so it is left out): a, c and g
    // passed it; b and d did not.
    expect(health.firstCheckPassed).toEqual({ count: 3, of: 5, share: 3 / 5 });
    expect(health.freeSlotToStart).toEqual({ count: 2, medianMs: 30_000 });
    // Only the checker sessions are check time: 8 and 20 minutes.
    expect(health.checkTime).toEqual({ count: 2, medianMs: 14 * MIN });
    // Only landings that landed: the 15-minute attempt that did not is left out.
    expect(health.landingTime).toEqual({ count: 2, medianMs: 7 * MIN, syncMs: 20_000, mergeCheckMs: 60_000, commitCheckMs: 6 * MIN, publishMs: 3_000 });
    // d spent three rounds and c one, on items set aside.
    expect(health.setAsideRounds).toEqual({ items: 2, rounds: 4 });
    // Waiting is the recorded slot and usage waits: 4 + 2 + 6 + 3 = 15 minutes.
    expect(health.waiting.waitingMs).toBe(15 * MIN);
    expect(health.waiting.workingMs).toBeGreaterThan(0);
    expect(health.waiting.share).toBeCloseTo(15 * MIN / (15 * MIN + health.waiting.workingMs), 10);
  });

  it('counts only finished steps as working time, and ignores timing rows when finding where a step starts', () => {
    const { store, run, timing } = fixture();
    run('a', NOW - 2 * DAY, 'landed');
    // A timing row written while the item was preparing must not move the moment it first reached preparing.
    timing('a', TIMING_REASONS.sessionStart, NOW - 9 * DAY, { role: 'worker', instanceId: 'w', provider: 'claude', model: 'x' });
    // preparing 10 + working 10 + (awaiting-slot is not work) + verifying 10 + landing 5 minutes.
    expect(store.queueHealth().waiting.workingMs).toBe(35 * MIN);
  });

  it('leaves out attempts that began before the window', () => {
    const { store, run } = fixture();
    run('old', NOW - 20 * DAY, 'landed');
    run('recent', NOW - DAY, 'parked');
    expect(store.queueHealth().attemptsLanded).toEqual({ count: 0, of: 1, share: 0 });
  });

  it('reports nothing measured, not zero, when nothing has finished', () => {
    const { store } = fixture();
    const health = store.queueHealth();
    expect(health.attemptsLanded.share).toBeNull();
    expect(health.documentsLanded.share).toBeNull();
    expect(health.passesNotLanded.share).toBeNull();
    expect(health.firstCheckPassed.share).toBeNull();
    expect(health.freeSlotToStart.medianMs).toBeNull();
    expect(health.checkTime.medianMs).toBeNull();
    expect(health.landingTime.medianMs).toBeNull();
    expect(health.waiting.share).toBeNull();
    expect(health.setAsideRounds).toEqual({ items: 0, rounds: 0 });
  });

  it('skips unreadable timing rows instead of failing the summary', () => {
    const health = computeQueueHealth({ now: NOW, windowDays: 14, items: [], verdicts: [], states: [],
      timings: [{ itemId: 'x', at: 1, reason: TIMING_REASONS.slotWait, detail: '{"kind":"worker","waitedMs":' },
        { itemId: 'x', at: 2, reason: TIMING_REASONS.slotWait, detail: null },
        { itemId: 'x', at: 3, reason: TIMING_REASONS.slotWait, detail: '{"kind":"check","waitedMs":60000,"freeToStartMs":5000}' }] });
    expect(health.freeSlotToStart).toEqual({ count: 1, medianMs: 5000 });
    expect(health.waiting.waitingMs).toBe(60_000);
  });

  it('does not pair a checker end with a worker start, or an end with no start', () => {
    const rows = [
      { itemId: 'x', at: 10, reason: TIMING_REASONS.sessionStart, detail: JSON.stringify({ role: 'worker', instanceId: 'a', provider: 'claude', model: null }) },
      { itemId: 'x', at: 20, reason: TIMING_REASONS.sessionEnd, detail: JSON.stringify({ role: 'checker', instanceId: 'a' }) },
      { itemId: 'x', at: 30, reason: TIMING_REASONS.sessionEnd, detail: JSON.stringify({ role: 'checker', instanceId: 'lost' }) },
    ];
    expect(computeQueueHealth({ now: NOW, windowDays: 14, items: [], verdicts: [], states: [], timings: rows }).checkTime).toEqual({ count: 0, medianMs: null });
  });

  it('lists tests that failed for more than one document, counting each document once', () => {
    const items = [['a', '/repo/one_plan.md'], ['b', '/repo/one_plan.md'], ['c', '/repo/two_plan.md'], ['d', '/repo/three_plan.md']]
      .map(([id, documentPath]) => ({ id, documentPath, state: 'parked' }));
    const row = (itemId: string, ...gates: object[]) => ({ itemId, verdict: 'FAIL', gates: JSON.stringify(gates), round: 1, findings: '[]' });
    const health = computeQueueHealth({ now: NOW, windowDays: 14, items, states: [], timings: [], verdicts: [
      row('a', { failingTests: ['shared test', 'same document only'] }),
      row('a', { failingTests: ['shared test'] }),
      row('b', { failingTests: ['same document only'] }),
      row('c', { failingTests: ['shared test', 'pair test'] }),
      row('d', { failingTests: ['shared test', 'pair test'] }, { timedOut: true, failingTests: ['timed out test'] }),
      row('c', { timedOut: true, failingTests: ['timed out test'] }),
      row('d', { command: 'older verdict with no names' }),
    ] });
    expect(health.repeatFailingTests).toEqual([{ test: 'shared test', jobs: 3 }, { test: 'pair test', jobs: 2 }]);
  });

  it('counts a finding once, in the round it first appeared, and only from round 3 on', () => {
    const finding = (id: string, severity: string) => ({ id, severity, summary: id });
    const row = (itemId: string, round: number, ...findings: object[]) => ({ itemId, verdict: 'FAIL', gates: '[]', round, findings: JSON.stringify(findings) });
    const health = computeQueueHealth({ now: NOW, windowDays: 14, states: [], timings: [], items: [{ id: 'a', documentPath: '/repo/a_plan.md', state: 'parked' }, { id: 'b', documentPath: '/repo/b_plan.md', state: 'parked' }], verdicts: [
      row('a', 1, finding('early', 'high')),
      row('a', 3, finding('early', 'high'), finding('late', 'medium')),
      row('a', 4, finding('late', 'medium'), finding('later', 'low')),
      row('b', 3, finding('early', 'critical')),
    ] });
    expect(health.lateFindings).toEqual({ critical: 1, high: 0, medium: 1, low: 1 });
  });
});
