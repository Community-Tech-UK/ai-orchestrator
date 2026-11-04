import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueuePreparationErrors } from './plan-queue-error-class';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { recordQueueRestart } from './plan-queue-restart-progress';
import { preflightPlanQueueRun } from './plan-queue-run-preflight';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueTurnRetries } from './plan-queue-turn-retry';
import type { PlanQueueItem } from './plan-queue.types';

let root: string;
let db: SqliteDriver;
let store: PlanQueueStore;
let host: PlanQueueFlowHost;
beforeAll(() => initSqliteWasm());
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T00:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'queue-policy-'));
  const doc = join(root, 'work_plan.md'); writeFileSync(doc, '# Work\n');
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db); store = new PlanQueueStore(db);
  store.upsertRun({ id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root,
    status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
  for (const id of ['one', 'two']) {
    const target = id === 'one' ? doc : join(root, 'second_plan.md'); writeFileSync(target, '# Work\n');
    store.upsertItem(newPlanQueueItem(id, 'run', target, id === 'one' ? 1 : 2, {
      state: 'preparing', checkpointCommit: 'head', workerInstanceId: `worker-${id}`,
    }));
  }
  host = { history: store.history, getRun: (id: string) => store.getRun(id)!, getItem: (id: string) => store.getItem(id)!,
    transition: (item: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem>) => {
      const next = { ...item, ...patch, state }; store.upsertItem(next); return next;
    }, pauseForSharedError: vi.fn(), worktrees: { worktreeUsage: () => ({ inUse: 5, maxConcurrent: 5 }) },
    tracker: { isShuttingDown: () => false, beginTurn: vi.fn() }, instances: { sendInput: vi.fn(async () => undefined) },
  } as unknown as PlanQueueFlowHost;
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

describe('queue failure safeguards', () => {
  it('waits with bounded backoff and recovers its wait after a new controller', () => {
    const errors = new PlanQueuePreparationErrors(host);
    expect(errors.defer(host.getItem('one'), new Error('Maximum concurrent worktrees (5) reached'))).toBe(true);
    expect(host.getItem('one')).toMatchObject({ state: 'queued', parkReason: null, detail: 'Waiting for a free work folder (5 in use)' });
    expect(new PlanQueuePreparationErrors(host).waiting(host.getItem('one'))).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(errors.waiting(host.getItem('one'))).toBe(false);
    errors.defer(host.getItem('one'), new Error('Maximum concurrent worktrees (5) reached'));
    vi.advanceTimersByTime(119_999);
    expect(errors.waiting(host.getItem('one'))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(errors.waiting(host.getItem('one'))).toBe(false);
  });

  it('pauses only after identical job errors on two different jobs', () => {
    const errors = new PlanQueuePreparationErrors(host);
    errors.failed(host.getItem('one'), new Error('disk unavailable'));
    errors.failed(host.getItem('one'), new Error('disk unavailable'));
    expect(host.pauseForSharedError).not.toHaveBeenCalled();
    errors.failed(host.getItem('two'), new Error('disk unavailable'));
    expect(host.pauseForSharedError).toHaveBeenCalledTimes(1);
  });

  it('counts consecutive restarts but resets on changed work or a completed round', async () => {
    expect(await recordQueueRestart(host, host.getItem('one'))).toBe(1);
    expect(await recordQueueRestart(host, host.getItem('one'))).toBe(2);
    expect(await recordQueueRestart(host, host.getItem('one'))).toBe(3);
    store.upsertItem({ ...host.getItem('one'), checkpointCommit: 'new-head' });
    expect(await recordQueueRestart(host, host.getItem('one'))).toBe(1);
    store.upsertItem({ ...host.getItem('one'), round: 1 });
    expect(await recordQueueRestart(host, host.getItem('one'))).toBe(1);
  });

  it('retries a transient turn twice in the same session and cancels a pending retry', async () => {
    store.upsertItem({ ...host.getItem('one'), state: 'working' });
    const retries = new PlanQueueTurnRetries(host);
    for (const delay of [15_000, 45_000]) {
      const retry = retries.retry(host.getItem('one'), 'worker-one', 'provider returned 503');
      await vi.advanceTimersByTimeAsync(delay);
      expect(await retry).toBe(true);
    }
    expect(await retries.retry(host.getItem('one'), 'worker-one', 'provider returned 503')).toBe(false);
    expect(host.instances.sendInput).toHaveBeenCalledTimes(2);
    expect(await retries.retry(host.getItem('one'), 'worker-one', 'permission denied')).toBe(false);
    retries.completed('worker-one');
    const cancelled = retries.retry(host.getItem('one'), 'worker-one', 'transport closed'); retries.cancel('one');
    expect(await cancelled).toBe(true);
    expect(host.instances.sendInput).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preflights routes independently of folder capacity but refuses an impossible checker', async () => {
    const input = { routing: { workers: [{ provider: 'claude' }], verifiers: [] }, workspaceCwd: root,
      workerProvider: 'claude', workerModel: null,
      selectVerifier: vi.fn(async () => ({ ok: true as const, choice: { provider: 'codex' } })) };
    await expect(preflightPlanQueueRun(input)).resolves.toBeUndefined();
    await expect(preflightPlanQueueRun({ ...input, selectVerifier: async () => ({ ok: false, reason: 'No allowed checker' }) }))
      .rejects.toThrow('No allowed checker');
  });
});
