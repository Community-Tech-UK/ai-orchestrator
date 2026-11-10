import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { InputTurnRegistry } from '../instance/input-turn-registry';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { WorkAdmission } from '../work-admission/work-admission';
import { PlanQueueCoordinator, type PlanQueueInstanceManagerPort } from './plan-queue-coordinator';
import { SET_ASIDE_FOLDER_METADATA } from './plan-queue-set-aside';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueRun } from './plan-queue.types';

// A Set aside agent skips a fresh attempt that blocks an older one only in its reply to James's typed message.
let db: SqliteDriver;
let store: PlanQueueStore;
let coordinator: PlanQueueCoordinator;
let personTurns: InputTurnRegistry;
const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
  status: 'paused', config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
  relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
const sessions: Record<string, { id: string; status: string; metadata?: Record<string, unknown> }> = {
  parent: { id: 'parent', status: 'idle' },
  agent: { id: 'agent', status: 'idle', metadata: { [SET_ASIDE_FOLDER_METADATA]: '/repo' } },
};

beforeAll(() => initSqliteWasm());
beforeEach(() => {
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db); store = new PlanQueueStore(db);
  store.upsertRun(run);
  personTurns = new InputTurnRegistry();
  coordinator = new PlanQueueCoordinator();
  const instances: PlanQueueInstanceManagerPort = Object.assign(new EventEmitter(), {
    createInstance: async () => { throw new Error('No session expected'); },
    sendInput: async () => undefined, terminateInstance: async () => undefined,
    restartFreshInstance: async () => undefined,
    getInstance: (id: string) => sessions[id] as never,
    getAllInstances: () => Object.values(sessions) as never[], adoptOrphanInstance: () => false,
  });
  coordinator.initialize({ store, instances, personTurns,
    worktreeCreator: { getAllSessions: () => [], createWorktree: async () => { throw new Error('No checkout expected'); }, cleanupWorktree: async () => undefined },
    loadAverage: () => [0, 0, 0], pumpIntervalMs: null });
});
afterEach(async () => {
  coordinator.shutdown(); await coordinator._whenSettledForTesting();
  db.close(); vi.restoreAllMocks(); WorkAdmission._resetForTesting();
});

function queued(id: string) {
  store.upsertItem(newPlanQueueItem(id, run.id, `/repo/docs/plans/${id}_plan.md`, 1, { state: 'queued' }));
  return id;
}

function jamesTyped(at: Date): void {
  personTurns.setReportsTurnStarts('agent', true);
  personTurns.noteInput('agent', { messageId: 'm1', personTypedAt: at.getTime() });
  personTurns.noteTurnStarted('agent', 'harness-send');
}

it("skips a job that has not started in its reply to James's typed message, and names that message", async () => {
  const itemId = queued('fresh');
  jamesTyped(new Date(2026, 10, 10, 17, 5));
  await coordinator.control({ action: 'skip-item', itemId }, 'agent');
  expect(store.getItem(itemId)).toMatchObject({ state: 'skipped', detail: "Skipped by the Set aside agent (session agent), after James's message at 17:05." });
});

it('refuses without a message from James, and when the latest input is a Harness notice', async () => {
  const itemId = queued('fresh');
  personTurns.setReportsTurnStarts('agent', true);
  await expect(coordinator.control({ action: 'skip-item', itemId }, 'agent')).rejects.toThrow('in its reply to a message James typed');
  jamesTyped(new Date());
  personTurns.noteInput('agent', { messageId: 'notice', personTypedAt: null });
  await expect(coordinator.control({ action: 'skip-item', itemId }, 'agent')).rejects.toThrow('in its reply to a message James typed');
  expect(store.getItem(itemId)!.state).toBe('queued');
});

it('still cannot skip a job that has started or been set aside', async () => {
  const itemId = 'parked';
  store.upsertItem(newPlanQueueItem(itemId, run.id, '/repo/docs/plans/parked_plan.md', 1, { state: 'parked', parkReason: 'round-limit', branchName: 'queue/parked' }));
  jamesTyped(new Date());
  await expect(coordinator.control({ action: 'skip-item', itemId }, 'agent')).rejects.toThrow('only an item that has not started can be skipped');
});

it('still names James when he skips a job from the page', async () => {
  const itemId = queued('fresh');
  await coordinator.control({ action: 'skip-item', itemId });
  expect(store.getItem(itemId)!.detail).toBe('Skipped by James.');
});
