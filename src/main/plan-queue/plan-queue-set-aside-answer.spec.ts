import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { setAsideQuestion } from './plan-queue-run-start';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import type { PlanQueueRun } from './plan-queue.types';

beforeAll(() => initSqliteWasm());
afterEach(() => PlanQueueCoordinator._resetForTesting());

function setup() {
  const db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
  const store = new PlanQueueStore(db);
  const originalRun: PlanQueueRun = { id: 'original', parentInstanceId: 'parent', parentHistoryThreadId: null,
    kind: 'plans', workspaceCwd: '/fixture', status: 'completed', config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: 2 };
  store.upsertRun(originalRun); store.upsertRun({ ...originalRun, id: 'new', status: 'paused', endedAt: null });
  const previous = newPlanQueueItem('previous', 'original', '/fixture/work_plan.md', 1,
    { state: 'parked', branchName: 'queue/saved', workerInstanceId: 'old-worker', parkReason: 'worker-error' });
  store.upsertItem(previous);
  store.upsertItem(newPlanQueueItem('question', 'new', previous.documentPath, 3,
    { state: 'needs-answer', question: setAsideQuestion(previous) }));
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const stopping = new Promise<void>(resolve => { entered = resolve; });
  const worker: PlanQueueInstanceRecord = { id: 'old-worker', status: 'idle', workingDirectory: '/fixture', outputBuffer: [] };
  const manager = Object.assign(new EventEmitter(), {
    getInstance: (id: string) => id === worker.id ? worker : undefined,
    getAllInstances: () => [worker], adoptOrphanInstance: () => false,
    createInstance: vi.fn(async () => { throw new Error('Load gate must prevent dispatch'); }),
    terminateInstance: vi.fn(async () => { entered(); await held; }),
    restartFreshInstance: async () => undefined, sendInput: async () => undefined,
  });
  const coordinator = PlanQueueCoordinator.getInstance();
  coordinator.initialize({ store, instances: manager, pumpIntervalMs: null, loadAverage: () => [Infinity, Infinity, Infinity],
    worktreeCreator: { createWorktree: vi.fn(), cleanupWorktree: vi.fn(), getAllSessions: () => [] } });
  return { coordinator, store, release, stopping, db };
}

describe('resuming the earlier set-aside attempt', () => {
  it('accepts only one answer while the older session is stopping', async () => {
    const f = setup();
    try {
      const resume = f.coordinator.answer('question', 'resume-set-aside');
      await f.stopping;
      const other = f.coordinator.answer('question', 'fresh').then(() => null, error => error);
      await new Promise(resolve => setImmediate(resolve));
      f.release(); await resume;
      expect(await other).toBeInstanceOf(Error);
      expect(f.store.getItem('question')).toMatchObject({ state: 'skipped', question: null });
      expect(f.store.getItem('previous')).toMatchObject({ state: 'queued', branchName: 'queue/saved' });
    } finally { f.release(); f.coordinator.shutdown(); await f.coordinator._whenSettledForTesting(); f.db.close(); }
  });

  it('refuses to resume an attempt that a newer merged attempt has replaced, and leaves the question open', async () => {
    const f = setup();
    try {
      const previous = f.store.getItem('previous')!;
      f.store.upsertRun({ ...f.store.getRun('original')!, id: 'merged-run' });
      f.store.upsertItem({ ...previous, id: 'merged-attempt', runId: 'merged-run', state: 'landed', createdAt: previous.createdAt + 1 });
      await expect(f.coordinator.answer('question', 'resume-set-aside')).rejects.toThrow('already merged');
      expect(f.store.getItem('previous')).toMatchObject({ state: 'parked', branchName: 'queue/saved' });
      expect(f.store.getItem('question')).toMatchObject({ state: 'needs-answer' });
    } finally { f.release(); f.coordinator.shutdown(); await f.coordinator._whenSettledForTesting(); f.db.close(); }
  });

  it('does not reopen the old run after the requesting run was cancelled', async () => {
    const f = setup();
    try {
      const resume = f.coordinator.answer('question', 'resume-set-aside');
      await f.stopping;
      await f.coordinator.control({ action: 'cancel', runId: 'new' });
      f.release(); await resume;
      expect(f.store.getRun('new')?.status).toBe('cancelled');
      expect(f.store.getRun('original')?.status).toBe('completed');
      expect(f.store.getItem('previous')).toMatchObject({ state: 'parked', branchName: 'queue/saved' });
    } finally { f.release(); f.coordinator.shutdown(); await f.coordinator._whenSettledForTesting(); f.db.close(); }
  });
});
