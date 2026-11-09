import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { runToDto } from './plan-queue-messages';
import { claimDocumentsAndCreateItems } from './plan-queue-run-start';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueRun } from './plan-queue.types';

const DAY = 24 * 60 * 60_000;
let db: SqliteDriver;
let store: PlanQueueStore;
let folder: string;
let document: string;
let run: PlanQueueRun;
beforeAll(() => initSqliteWasm());
beforeEach(() => {
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
  store = new PlanQueueStore(db);
  folder = mkdtempSync(join(tmpdir(), 'queue-run-start-'));
  document = join(folder, 'work_plan.md');
  writeFileSync(document, '# Work\n');
  utimesSync(document, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
  const makeRun = (id: string): PlanQueueRun => ({ id, parentInstanceId: `parent-${id}`, parentHistoryThreadId: null, kind: 'plans', workspaceCwd: folder,
    status: 'completed', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: 2 });
  store.upsertRun(makeRun('old')); store.upsertRun(makeRun('older'));
  run = { ...makeRun('new'), status: 'running', endedAt: null };
  store.upsertRun(run);
  for (const [id, runId, at] of [['first', 'older', 1], ['second', 'old', 2]] as const) {
    const attempt = newPlanQueueItem(id, runId, document, at, { state: 'queued' });
    store.upsertItem(attempt);
    store.upsertItem({ ...attempt, state: 'parked', parkReason: 'worktree-error', detail: 'The checks could not start.' });
  }
});
afterEach(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });

const start = (queueDirectly: boolean) => {
  let id = 0;
  claimDocumentsAndCreateItems({ store, now: () => 100, newId: () => `made-${++id}` }, run, [{ ref: document, readiness: 'candidate' }], { queueDirectly });
  return store.listItems('new')[0];
};

describe('starting a document that keeps stopping the same way', () => {
  it('leaves it out of a bulk start and says why', () => {
    expect(start(false)).toMatchObject({ state: 'skipped', detail: expect.stringContaining('Pick it by name') });
  });

  it('keeps leaving it out on later starts, because a left-out row is not an attempt', () => {
    expect(start(false).state).toBe('skipped');
    store.upsertRun({ ...run, id: 'newer', parentInstanceId: 'parent-newer' });
    run = { ...store.getRun('newer')! };
    claimDocumentsAndCreateItems({ store, now: () => 200, newId: () => 'made-again' }, run, [{ ref: document, readiness: 'candidate' }], {});
    expect(store.listItems('newer')[0].state).toBe('skipped');
  });

  it('starts it when it is picked by name', () => {
    expect(start(true).state).toBe('queued');
  });
});

describe('the order and source of a new run\'s items (step 6)', () => {
  // The folder is made fresh for each test, so the candidates are too.
  const candidates = () => ['c_plan.md', 'a_plan.md', 'b_plan.md'].map(name => ({ ref: join(folder, name), readiness: 'candidate' as const }));
  const startThree = (target: PlanQueueRun, documents = candidates()) => {
    let id = 0;
    for (const candidate of documents) writeFileSync(candidate.ref, '# Plan\n');
    claimDocumentsAndCreateItems({ store, now: () => 500, newId: () => `three-${++id}` }, target, documents);
    return store.listItems(target.id);
  };

  it('records the source and a sort key for each item in discovery order, however the clock ticks', () => {
    const documents = candidates();
    const items = startThree(run, documents);
    expect(items.map(item => item.sourceRef)).toEqual(documents.map(candidate => candidate.ref));
    expect(items.every(item => item.sourceKind === 'markdown')).toBe(true);
    expect(items.map(item => item.sortKey)).toEqual(['9.000000.000000', '9.000000.000001', '9.000000.000002']);
  });

  it('keeps that order when the sort key, not the creation time, is what differs', () => {
    const documents = candidates();
    const items = startThree(run, documents);
    // Put the creation times in the opposite order: the run still follows its sort keys.
    items.forEach((item, index) => db.prepare('UPDATE plan_queue_items SET created_at = ? WHERE id = ?').run(1_000 - index, item.id));
    expect(store.listItems(run.id).map(item => item.sourceRef)).toEqual(documents.map(candidate => candidate.ref));
  });

  it('gives a second run started over the same documents nothing, because the first owns them', () => {
    const documents = candidates();
    startThree(run, documents);
    store.upsertRun({ ...run, id: 'second', parentInstanceId: 'parent-second' });
    const second = store.getRun('second')!;
    expect(claimDocumentsAndCreateItems({ store, now: () => 600, newId: () => 'again' }, second, documents)).toEqual(documents.map(candidate => candidate.ref));
    expect(store.listItems('second')).toEqual([]);
  });
});

describe('a plan too big for one job', () => {
  const bigPlan = (lines: string[]) => { const path = join(folder, 'big_plan.md'); writeFileSync(path, ['# Big', ...lines].join('\n')); return path; };
  const startWith = (path: string, queueDirectly = false, kind: PlanQueueRun['kind'] = 'plans') => {
    const target = { ...run, kind };
    claimDocumentsAndCreateItems({ store, now: () => 100, newId: () => `big-${kind}-${queueDirectly}` }, target, [{ ref: path, readiness: 'candidate' }], { queueDirectly });
    return store.listItems(run.id).find(item => item.sourceRef === path)!;
  };

  it('is left out of a bulk start, saying why, when it has many unticked items', () => {
    const item = startWith(bigPlan(Array.from({ length: 21 }, (_, n) => `- [ ] step ${n}`)));
    expect(item).toMatchObject({ state: 'skipped', detail: expect.stringContaining('21 unticked items') });
  });

  it('is left out when it is very large, even with few items left', () => {
    expect(startWith(bigPlan(['x'.repeat(60_000), '- [ ] last step'])).state).toBe('skipped');
  });

  it('starts when picked by name, and a normal plan starts as usual', () => {
    expect(startWith(bigPlan(Array.from({ length: 21 }, (_, n) => `- [ ] step ${n}`)), true).state).toBe('queued');
  });

  it('leaves live-test documents alone, whose checklists are long by nature', () => {
    expect(startWith(bigPlan(Array.from({ length: 30 }, (_, n) => `- [ ] check ${n}`)), false, 'livetests').state).not.toBe('skipped');
  });
});

describe('rounds across attempts', () => {
  it('reaches the job row, and counts verdicts from every attempt', () => {
    for (const [itemId, runId, round] of [['first', 'older', 1], ['first', 'older', 2], ['second', 'old', 1]] as const) {
      store.history.recordVerdict({ itemId, runId, round, verdict: 'FAIL', findings: [], gatesRun: [], notChecked: [], worktreeHead: null, documentSha256: null });
    }
    const item = { ...store.getItem('second')!, round: 1 };
    const dto = runToDto(store.getRun('old')!, [item], undefined, new Map(), store.history.totalRoundsByDocument());
    expect(dto.items[0].totalRounds).toBe(3);
    expect(runToDto(store.getRun('old')!, [{ ...item, round: 3 }], undefined, new Map(), store.history.totalRoundsByDocument()).items[0]).not.toHaveProperty('totalRounds');
  });
});
