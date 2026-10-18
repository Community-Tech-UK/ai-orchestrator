import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    parentHistoryThreadId: 'thread-1',

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
    heldAt: null,
    pendingInstruction: null,
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
  it('keeps recovery locations across stale status writes and a fresh store', () => {
    store.upsertRun(makeRun());
    const stale = makeItem({ state: 'parked' });
    store.upsertItem(stale);
    const receipt = 'Orphan checkout retained at /repo/.worktrees/queue-quarantine/owned/checkout\n';
    store.upsertItem({ ...stale, detail: receipt });
    store.upsertItem({ ...stale, state: 'queued', detail: null });
    expect(new PlanQueueStore(driver).getItem(stale.id)?.detail).toBe(receipt);
    store.upsertItem({ ...stale, state: 'verifying', detail: 'A new checker status' });
    expect(store.getItem(stale.id)?.detail).toBe(receipt + 'A new checker status');
  });

  it('retains every distinct location and never downgrades a confirmed move to planned', () => {
    store.upsertRun(makeRun());
    const item = makeItem();
    const first = '/repo/.worktrees/queue-quarantine/one/checkout';
    const second = '/repo/.worktrees/queue-quarantine/two/checkout';
    store.upsertItem({ ...item, detail: `Orphan checkout recovery location: ${first}\n` });
    store.upsertItem({ ...item, detail: `Orphan checkout retained at ${first}\n` });
    store.upsertItem({ ...item, detail: `Orphan checkout recovery location: ${first}\nOrphan checkout retained at ${second}\n` });
    expect(store.getItem(item.id)?.detail).toBe(
      `Orphan checkout retained at ${first}\nOrphan checkout retained at ${second}\n`,
    );
  });

  it('bounds replaceable status text while preserving complete recovery evidence', () => {
    store.upsertRun(makeRun());
    const item = makeItem();
    const receipt = 'Orphan checkout retained at /repo/.worktrees/queue-quarantine/owned/checkout\n';
    store.upsertItem({ ...item, detail: receipt });
    store.upsertItem({ ...item, detail: 'x'.repeat(8000) });
    const detail = store.getItem(item.id)!.detail!;
    expect(detail).toHaveLength(8000);
    expect(detail).toBe(receipt + 'x'.repeat(8000 - receipt.length));
  });

  it('rolls back state and evidence when an additional location exceeds the bounded field', () => {
    store.upsertRun(makeRun());
    const item = makeItem({ state: 'parked' });
    const first = `Orphan checkout retained at /${'a'.repeat(3970)}\n`;
    const second = `Orphan checkout retained at /${'b'.repeat(3970)}\n`;
    store.upsertItem({ ...item, detail: first + second });
    const before = store.getItem(item.id);
    expect(() => store.upsertItem({ ...item, state: 'queued', detail: 'Orphan checkout recovery location: /another/checkout\n' })).toThrow('Recovery receipts exceed');
    expect(store.getItem(item.id)).toEqual(before);
  });

  it('round-trips parent thread and updates both ownership fields on rebind/adoption', () => {
    store.upsertRun(makeRun({ parentHistoryThreadId: 'history-original' }));
    expect(store.getRun('run-1')?.parentHistoryThreadId).toBe('history-original');
    store.setRunParent('run-1', 'restored-parent', 'history-adopted');
    expect(store.getRun('run-1')).toMatchObject({ parentInstanceId: 'restored-parent', parentHistoryThreadId: 'history-adopted' });
  });
  it('adds parent thread with null for pre-migration rows, retaining data and old ownership', () => {
    const version = driver.prepare("SELECT version FROM loop_migrations WHERE name LIKE '%_plan_queue_runs_parent_thread'").get<{ version: number }>()?.version;
    expect(version).toEqual(expect.any(Number));
    const old = new Database(':memory:') as unknown as SqliteDriver;
    try {
      runLoopMigrationsUpTo(old, version! - 1);
      old.prepare(`INSERT INTO plan_queue_runs (id, parent_instance_id, kind, workspace_cwd, status, config_json, started_at, updated_at)
        VALUES ('old-run', 'old-parent', 'plans', '/repo', 'running', '{}', 1000, 1000)`).run();
      runLoopMigrations(old);
      expect(new PlanQueueStore(old).getRun('old-run')).toMatchObject({ parentInstanceId: 'old-parent', parentHistoryThreadId: null, startedAt: 1000 });
      runLoopMigrations(old);
      expect(old.prepare('SELECT COUNT(*) AS n FROM plan_queue_runs').get<{ n: number }>()?.n).toBe(1);
    } finally { old.close(); }
  });
  it.each(['preparing', 'working', 'fixing', 'verifying', 'landing'] as const)(
    'hasActiveWork counts %s only in a running run', state => {
      store.upsertRun(makeRun()); store.upsertItem(makeItem({ state }));
      expect(store.hasActiveWork()).toBe(true);
      store.upsertRun(makeRun({ status: 'paused' }));
      expect(store.hasActiveWork()).toBe(false);
    },
  );
  it.each(['needs-answer', 'parked', 'queued', 'discovered', 'landed'] as const)(
    'hasActiveWork ignores %s items', state => {
      store.upsertRun(makeRun()); store.upsertItem(makeItem({ state }));
      expect(store.hasActiveWork()).toBe(false);
    },
  );

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

  it('repoints a run at its restored parent, and a stale snapshot save cannot undo it', () => {
    const run = makeRun();
    store.upsertRun(run);
    store.setRunParent('run-1', 'parent-restored', null);
    store.upsertRun({ ...run, status: 'paused', parentHistoryThreadId: null });

    expect(store.getRun('run-1')).toMatchObject({
      parentInstanceId: 'parent-restored', parentHistoryThreadId: 'thread-1', status: 'paused',
    });
  });

  it('records the parent thread for a run that started without one', () => {
    store.upsertRun(makeRun({ parentHistoryThreadId: null }));
    store.setRunParent('run-1', 'parent-1', 'thread-found');

    expect(store.getRun('run-1')?.parentHistoryThreadId).toBe('thread-found');
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


  it('persists and clears hold time and pending instructions while retaining saved work', () => {
    store.upsertRun(makeRun({ status: 'paused' }));
    const item = makeItem({
      state: 'queued', heldAt: 8_000,
      pendingInstruction: 'Fix the checker findings in the existing branch.\nKeep its checkpoint.',
      branchName: 'queue/held-work', worktreePath: '/repo/.worktrees/held-work', checkpointCommit: 'saved-checkpoint',
    });
    store.upsertItem(item);
    expect(store.getItem(item.id)).toEqual({ ...item, updatedAt: 9_000 });
    expect(store.listItems(item.runId)[0]).toMatchObject({ heldAt: 8_000, pendingInstruction: item.pendingInstruction });

    store.upsertItem({ ...item, state: 'working', heldAt: null, pendingInstruction: null });
    expect(store.getItem(item.id)).toMatchObject({
      state: 'working', heldAt: null, pendingInstruction: null,
      branchName: item.branchName, worktreePath: item.worktreePath, checkpointCommit: item.checkpointCommit,
    });
  });

  it('upgrades v22 to v23 without altering existing rows, and repeats safely', () => {
    const old = new Database(':memory:') as unknown as SqliteDriver;
    try {
      runLoopMigrationsUpTo(old, 22);
      old.prepare(`INSERT INTO plan_queue_runs
        (id, parent_instance_id, parent_history_thread_id, kind, workspace_cwd, status, config_json, worker_provider, started_at, updated_at)
        VALUES ('legacy-run', 'legacy-parent', 'legacy-thread', 'plans', '/repo', 'paused', '{}', 'claude', 1000, 1100)`).run();
      old.prepare(`INSERT INTO plan_queue_items
        (id, run_id, document_path, state, round, errored_rounds, landing_refusals, branch_name, worktree_path, checkpoint_commit, detail, created_at, updated_at, tokens, cost_usd)
        VALUES ('legacy-item', 'legacy-run', '/repo/old_plan.md', 'fixing', 2, 1, 1, 'queue/legacy', '/repo/.worktrees/legacy', 'checkpoint', 'Keep these findings', 2000, 2100, 123, 1.25)`).run();
      const runBefore = old.prepare('SELECT * FROM plan_queue_runs').get();
      const itemBefore = old.prepare('SELECT * FROM plan_queue_items').get<Record<string, unknown>>();
      const columnsBefore = old.prepare('PRAGMA table_info(plan_queue_items)').all<{ name: string }>().map(column => column.name);
      expect(columnsBefore).not.toContain('held_at');
      expect(columnsBefore).not.toContain('pending_instruction');

      runLoopMigrations(old);
      expect(old.prepare('SELECT * FROM plan_queue_runs').get()).toEqual(runBefore);
      expect(old.prepare('SELECT * FROM plan_queue_items').get()).toEqual({ ...itemBefore, held_at: null, pending_instruction: null });
      const upgraded = new PlanQueueStore(old);
      expect(upgraded.getItem('legacy-item')).toMatchObject({ heldAt: null, pendingInstruction: null, state: 'fixing', round: 2 });

      const heldItem = { ...upgraded.getItem('legacy-item')!, state: 'queued' as const, heldAt: 3000, pendingInstruction: 'Continue saved findings' };
      upgraded.upsertItem(heldItem);
      const heldSnapshot = upgraded.getItem('legacy-item');
      expect(() => runLoopMigrations(old)).not.toThrow();
      expect(upgraded.getItem('legacy-item')).toEqual(heldSnapshot);
      expect(old.prepare('SELECT COUNT(*) AS n FROM plan_queue_runs').get<{ n: number }>()?.n).toBe(1);
      expect(old.prepare('SELECT COUNT(*) AS n FROM plan_queue_items').get<{ n: number }>()?.n).toBe(1);
      expect(old.prepare('SELECT COUNT(*) AS n FROM loop_migrations WHERE version = 23').get<{ n: number }>()?.n).toBe(1);
    } finally { old.close(); }
  });

  it('snapshots every active run with bounded recent history, sorted and without duplicates', () => {
    store.upsertRun(makeRun({ id: 'old-running', startedAt: 1 }));
    store.upsertRun(makeRun({ id: 'old-paused', status: 'paused', startedAt: 2, kind: 'livetests' }));
    store.upsertItem(makeItem({ runId: 'old-running', heldAt: null, pendingInstruction: null }));
    for (let index = 0; index < 55; index++) {
      store.upsertRun(makeRun({ id: `terminal-${index}`, status: index % 2 ? 'completed' : 'cancelled', startedAt: 100 + index }));
    }
    expect(store.listRuns(50)).toHaveLength(50);
    const snapshot = store.listRunSnapshots(50);
    expect(snapshot).toHaveLength(52);
    expect(snapshot.slice(-2).map(entry => [entry.run.id, entry.run.kind])).toEqual([['old-paused', 'livetests'], ['old-running', 'plans']]);
    expect(snapshot.at(-1)?.items).toEqual([{ ...makeItem({ runId: 'old-running' }), updatedAt: 9000 }]);
    expect(snapshot.filter(entry => ['completed', 'cancelled'].includes(entry.run.status))).toHaveLength(50);
    expect(snapshot.map(entry => entry.run.startedAt)).toEqual([...snapshot.map(entry => entry.run.startedAt)].sort((a, b) => b - a));

    store.upsertRun(makeRun({ id: 'recent-running', startedAt: 200 }));
    const overlapping = store.listRunSnapshots(50);
    expect(overlapping.filter(entry => entry.run.id === 'recent-running')).toHaveLength(1);
    expect(new Set(overlapping.map(entry => entry.run.id)).size).toBe(overlapping.length);
    expect(overlapping.filter(entry => ['completed', 'cancelled'].includes(entry.run.status))).toHaveLength(49);
    expect(overlapping[0].run.id).toBe('recent-running');
    // Deterministic ordering also covers equal start times.
    store.upsertRun(makeRun({ id: 'recent-z', startedAt: 200 }));
    expect(store.listRunSnapshots(1).slice(0, 2).map(entry => entry.run.id)).toEqual(['recent-z', 'recent-running']);
  });

  it('includes every terminal run with parked documents while bounding inert history', () => {
    store.upsertRun(makeRun({ id: 'old-completed', status: 'completed', startedAt: 1 }));
    store.upsertRun(makeRun({ id: 'old-cancelled', status: 'cancelled', kind: 'livetests', startedAt: 2 }));
    store.upsertItem(makeItem({ id: 'retained', runId: 'old-completed', state: 'parked', branchName: 'queue/retained', parkReason: 'round-limit' }));
    store.upsertItem(makeItem({ id: 'second-parked', runId: 'old-completed', documentPath: '/repo/second_plan.md', state: 'parked' }));
    store.upsertItem(makeItem({ id: 'branchless', runId: 'old-cancelled', state: 'parked', parkReason: 'triage-failed' }));
    for (let index = 0; index < 55; index++) {
      store.upsertRun(makeRun({ id: `inert-${index}`, status: index % 2 ? 'completed' : 'cancelled', startedAt: 100 + index }));
    }
    const snapshot = store.listRunSnapshots(50);
    expect(snapshot).toHaveLength(52);
    expect(snapshot.filter(entry => entry.run.id.startsWith('inert-'))).toHaveLength(50);
    expect(snapshot.slice(-2).map(entry => [entry.run.id, entry.run.kind])).toEqual([['old-cancelled', 'livetests'], ['old-completed', 'plans']]);
    expect(snapshot.find(entry => entry.run.id === 'old-cancelled')?.items[0]).toMatchObject({ branchName: null, state: 'parked', parkReason: 'triage-failed' });
    expect(snapshot.find(entry => entry.run.id === 'old-completed')?.items).toHaveLength(2);
    expect(snapshot.filter(entry => entry.run.id === 'old-completed')).toHaveLength(1);
    expect(store.listRuns(50).every(entry => entry.id.startsWith('inert-'))).toBe(true);

    store.upsertRun(makeRun({ id: 'recent-parked', status: 'completed', startedAt: 200 }));
    store.upsertItem(makeItem({ id: 'recent-document', runId: 'recent-parked', state: 'parked' }));
    const overlapping = store.listRunSnapshots(50);
    expect(overlapping.filter(entry => entry.run.id === 'recent-parked')).toHaveLength(1);
    expect(overlapping.filter(entry => entry.run.id.startsWith('inert-'))).toHaveLength(49);
    expect(overlapping.map(entry => entry.run.startedAt)).toEqual([...overlapping.map(entry => entry.run.startedAt)].sort((a, b) => b - a));
  });

  it('bulk-loads items in one read transaction for more active runs than a small IN parameter limit', () => {
    for (let index = 0; index < 1100; index++) {
      const id = `active-${index}`;
      store.upsertRun(makeRun({ id, startedAt: index }));
      store.upsertItem(makeItem({ id: `document-${index}`, runId: id }));
    }
    store.upsertRun(makeRun({ id: 'newest-history', status: 'completed', startedAt: 2000 }));
    const prepare = vi.spyOn(driver, 'prepare');
    const transaction = vi.spyOn(driver, 'transaction');
    try {
      const snapshot = store.listRunSnapshots(1);
      expect(snapshot).toHaveLength(1101);
      expect(snapshot.flatMap(entry => entry.items)).toHaveLength(1100);
      expect(snapshot.filter(entry => entry.run.status === 'completed')).toHaveLength(1);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(snapshot.find(entry => entry.run.id === 'active-0')?.items[0].runId).toBe('active-0');
    } finally { prepare.mockRestore(); transaction.mockRestore(); }
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
