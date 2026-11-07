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
  claimDocumentsAndCreateItems({ store, now: () => 100, newId: () => `made-${++id}` }, run, [{ path: document, readiness: 'candidate' }], { queueDirectly });
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
    claimDocumentsAndCreateItems({ store, now: () => 200, newId: () => 'made-again' }, run, [{ path: document, readiness: 'candidate' }], {});
    expect(store.listItems('newer')[0].state).toBe('skipped');
  });

  it('starts it when it is picked by name', () => {
    expect(start(true).state).toBe('queued');
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
