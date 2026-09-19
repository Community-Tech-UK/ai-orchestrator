import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations, runLoopMigrationsUpTo } from '../orchestration/loop-schema';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

let driver: SqliteDriver;
let store: PlanQueueStore;

function makeRun(overrides: Partial<PlanQueueRun> = {}): PlanQueueRun {
  return {
    id: 'run-1',
    parentInstanceId: 'parent-1',
    kind: 'plans',
    workspaceCwd: '/repo',
    status: 'running',
    config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
    relaxation: null,
    workerProvider: 'claude',
    workerModel: null,
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<PlanQueueItem> = {}): PlanQueueItem {
  return {
    id: 'item-1',
    runId: 'run-1',
    documentPath: '/repo/docs/plans/a_plan.md',
    state: 'discovered',
    round: 0,
    erroredRounds: 0,
    landingRefusals: 0,
    branchName: null,
    worktreePath: null,
    baseCommit: null,
    checkpointCommit: null,
    verifiedMainCommit: null,
    landedCommit: null,
    workerInstanceId: null,
    verifierInstanceId: null,
    question: null,
    answer: null,
    parkReason: null,
    detail: null,
    verdict: null,
    createdAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

beforeEach(() => {
  driver = new Database(':memory:') as unknown as SqliteDriver;
  driver.exec('PRAGMA foreign_keys = ON');
  runLoopMigrations(driver);
  store = new PlanQueueStore(driver, () => 9_000);
});

afterEach(() => {
  driver.close();
});

describe('PlanQueueStore', () => {
  it('applies migration 17 on top of a version-16 database without touching existing rows', () => {
    const old = new Database(':memory:') as unknown as SqliteDriver;
    runLoopMigrationsUpTo(old, 16);
    old
      .prepare(
        `INSERT INTO loop_runs (id, chat_id, config_json, status, started_at, total_iterations)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('legacy', 'chat', '{}', 'completed', 1, 1);

    runLoopMigrations(old);

    const tables = old
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plan_queue_%'")
      .all<{ name: string }>()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(['plan_queue_items', 'plan_queue_runs']);
    expect(old.prepare('SELECT COUNT(*) AS n FROM loop_runs').get<{ n: number }>()?.n).toBe(1);
    old.close();
  });

  it('round-trips a run including its relaxation snapshot', () => {
    const run = makeRun({
      relaxation: { entries: [{ key: 'computerUseAutonomyLevel', original: 'ask', applied: 'trusted' }] },
    });
    store.upsertRun(run);

    expect(store.getRun('run-1')).toEqual(run);
    expect(store.listRunsWithRelaxation().map((r) => r.id)).toEqual(['run-1']);

    store.upsertRun({ ...run, relaxation: null, status: 'completed', endedAt: 5_000 });
    expect(store.listRunsWithRelaxation()).toEqual([]);
    expect(store.listActiveRuns()).toEqual([]);
    expect(store.getRun('run-1')?.endedAt).toBe(5_000);
  });

  it('round-trips an item with question, verdict and git ownership', () => {
    store.upsertRun(makeRun());
    const item = makeItem({
      state: 'verifying',
      round: 2,
      erroredRounds: 1,
      landingRefusals: 1,
      branchName: 'queue/a',
      worktreePath: '/repo/.worktrees/queue-a',
      baseCommit: 'aaa',
      checkpointCommit: 'bbb',
      verifiedMainCommit: 'ccc',
      workerInstanceId: 'w1',
      verifierInstanceId: 'v1',
      question: { question: 'Approved?', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] },
      answer: 'y',
      verdict: {
        verdict: 'FAIL',
        findings: [{ severity: 'high', confidence: 80, summary: 'missing test' }],
        gatesRun: [{ command: 'npx tsc --noEmit', exitCode: 0 }],
        documentComplete: true,
        needJames: [],
      },
    });
    store.upsertItem(item);

    expect(store.getItem('item-1')).toEqual({ ...item, updatedAt: 9_000 });
    expect(store.findItemByInstance('v1')?.id).toBe('item-1');
    expect(store.findItemByInstance('w1')?.id).toBe('item-1');
    expect(store.findItemByInstance('nobody')).toBeNull();
  });

  it('lists only items that own a branch or worktree', () => {
    store.upsertRun(makeRun());
    store.upsertItem(makeItem({ id: 'plain' }));
    store.upsertItem(
      makeItem({ id: 'owner', documentPath: '/repo/docs/plans/b_plan.md', branchName: 'queue/b' }),
    );

    expect(store.listItemsWithGitOwnership().map((i) => i.id)).toEqual(['owner']);
    expect(store.listItems('run-1').map((i) => i.id).sort()).toEqual(['owner', 'plain']);
  });

  it('refuses two items for the same document in one run', () => {
    store.upsertRun(makeRun());
    store.upsertItem(makeItem({ id: 'first' }));

    expect(() => store.upsertItem(makeItem({ id: 'second' }))).toThrow();
  });

  it('throws rather than swallowing a failed write', () => {
    expect(() => store.upsertItem(makeItem({ runId: 'no-such-run' }))).toThrow();
  });

  it('deletes items with their run', () => {
    store.upsertRun(makeRun());
    store.upsertItem(makeItem());

    driver.prepare('DELETE FROM plan_queue_runs WHERE id = ?').run('run-1');

    expect(store.getItem('item-1')).toBeNull();
  });
});
