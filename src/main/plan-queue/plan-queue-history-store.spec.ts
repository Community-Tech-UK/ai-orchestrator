import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';

let db: SqliteDriver;
beforeAll(() => initSqliteWasm());
afterEach(() => db?.close());

describe('queue round history', () => {
  it('lists one run\'s events newest first with timing rows, without workers\' closing messages or other runs', () => {
    db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    for (const id of ['run', 'other-run']) store.upsertRun({
      id, parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
      status: 'completed', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null,
      workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: 2,
    });
    const job = newPlanQueueItem('job', 'run', '/repo/job_plan.md', 1);
    const other = newPlanQueueItem('other', 'other-run', '/repo/other_plan.md', 1);
    store.upsertItem(job); store.upsertItem(other);
    // After the event each job writes when it is created, so the order below is exact.
    const later = Date.now() + 60_000;
    const record = (itemId: string, runId: string, offset: number, reason: string | null) => store.history.recordEvent({
      itemId, runId, at: later + offset, fromState: 'verifying', toState: 'verifying', reason, detailHead: null, round: 0, tokens: 0 });
    record('job', 'run', 10, 'worker-claim');
    record('job', 'run', 20, null);
    record('job', 'run', 30, 'slot-wait');
    record('job', 'run', 40, 'checklist-run');
    record('other', 'other-run', 50, 'checklist-run');
    expect(store.history.listRunEvents('run', 3).map(event => event.at)).toEqual([later + 40, later + 30, later + 20]);
    expect(store.history.listRunEvents('run', 10).filter(event => event.at >= later).map(event => event.reason)).toEqual(['checklist-run', 'slot-wait', null]);
  });

  it('counts actual checklist runs and unique jobs in each participating run across retries', () => {
    db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    for (const id of ['first-run', 'second-run', 'untested-run']) store.upsertRun({
      id, parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
      status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null,
      workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null,
    });
    const first = newPlanQueueItem('first', 'first-run', '/repo/first_plan.md', 1);
    const second = newPlanQueueItem('second', 'first-run', '/repo/second_plan.md', 2);
    const third = newPlanQueueItem('third', 'second-run', '/repo/third_plan.md', 3);
    for (const item of [first, second, third]) store.upsertItem(item);
    store.history.recordChecklistRun(first, [first.id, second.id, third.id], 'group');
    store.history.recordChecklistRun(first, [first.id]);
    store.history.recordChecklistRun(second, [second.id]);
    expect(store.history.checksSummary('first-run')).toEqual({ runs: 3, jobs: 2 });
    expect(store.history.checksSummary('second-run')).toEqual({ runs: 1, jobs: 1 });
    expect(store.history.checksSummary('untested-run')).toBeUndefined();
    const snapshots = new Map(new PlanQueueStore(db).listRunSnapshots().map(entry => [entry.run.id, entry.checks]));
    expect(snapshots.get('first-run')).toEqual({ runs: 3, jobs: 2 });
    expect(snapshots.get('second-run')).toEqual({ runs: 1, jobs: 1 });
    expect(snapshots.get('untested-run')).toBeUndefined();
  });

  it('remembers a failed group for the exact commit beyond the recent history window', () => {
    db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    const event = { itemId: 'item', runId: 'run', fromState: null, toState: 'awaiting-slot' as const, round: 0, tokens: 0 };
    store.history.recordEvent({ ...event, reason: 'check-group-failed', detailHead: JSON.stringify({ head: 'failed-head' }) });
    for (let i = 0; i < 60; i++) store.history.recordEvent({ ...event, reason: 'note', detailHead: 'Later history' });
    expect(store.history.hasFailedCheckGroup('item', 'failed-head')).toBe(true);
    expect(store.history.hasFailedCheckGroup('item', 'new-head')).toBe(false);
    expect(store.history.hasFailedCheckGroup('other', 'failed-head')).toBe(false);
  });

  it('invalidates a group after any member leaves its round, even when it returns', () => {
    db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    const history = new PlanQueueStore(db).history;
    const item = newPlanQueueItem('leader', 'run', '/repo/plan.md', 1, { state: 'verifying' });
    history.recordChecklistRun(item, ['leader', 'member'], 'group');
    expect(history.checkGroupRoundIntact('group', ['leader', 'member'])).toBe(true);
    history.recordEvent({ itemId: 'member', runId: 'run', fromState: 'verifying', toState: 'fixing', reason: null, detailHead: null, round: 1, tokens: 0 });
    history.recordEvent({ itemId: 'member', runId: 'run', fromState: 'fixing', toState: 'verifying', reason: null, detailHead: null, round: 1, tokens: 0 });
    expect(history.checkGroupRoundIntact('group', ['leader', 'member'])).toBe(false);
    expect(history.checkGroupRoundIntact('unknown', ['leader', 'member'])).toBe(false);
  });

  it('keeps all verdicts across Resume and records path-free state events atomically', () => {
    db = createSqliteWasmDatabase(':memory:');
    runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    store.upsertRun({ id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans',
      workspaceCwd: '/repo', status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null,
      workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
    const item = newPlanQueueItem('item', 'run', '/repo/plan.md', 1);
    store.upsertItem(item);
    for (const [index, verdict] of (['FAIL', 'FAIL', 'PASS'] as const).entries()) {
      store.history.recordVerdict({ itemId: item.id, runId: item.runId, round: index + 1, verdict,
        findings: [{ severity: 'high', confidence: 95, summary: 'Retry fails', file: 'src/retry.ts' }],
        gatesRun: [], notChecked: ['Windows runtime needs its worker.'], worktreeHead: 'head', documentSha256: 'document' });
    }
    store.upsertItem({ ...item, state: 'parked', detail: 'Stopped in /Users/example/private/project/file.ts' });
    store.upsertItem({ ...item, state: 'queued', round: 0, verdict: null });
    const restored = new PlanQueueStore(db);
    expect(restored.history.listVerdicts(item.id).map(row => row.verdict)).toEqual(['FAIL', 'FAIL', 'PASS']);
    expect(new Set(restored.history.listVerdicts(item.id).map(row => row.findings[0].id)).size).toBe(1);
    const events = restored.history.listEvents(item.id);
    expect(events.map(row => row.toState)).toEqual(['queued', 'parked', 'discovered']);
    expect(events[1].detailHead).not.toContain('/Users/');
  });
});
