import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueRun } from './plan-queue.types';

beforeAll(() => initSqliteWasm());
afterEach(() => PlanQueueCoordinator._resetForTesting());

it('forwards the real queue continuation restart to its manager and retains durable job ownership', async () => {
  const db = createSqliteWasmDatabase(':memory:');
  runLoopMigrations(db);
  const store = new PlanQueueStore(db);
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null,
    kind: 'plans', workspaceCwd: '/synthetic/project', status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
    workerProvider: 'copilot', workerModel: null, relaxation: null, startedAt: 1, endedAt: null };
  const worker: PlanQueueInstanceRecord = { id: 'owner', parentId: 'parent', status: 'idle', provider: 'copilot',
    workingDirectory: '/synthetic/project/item', historyThreadId: 'old-thread', providerSessionId: 'old-provider',
    metadata: { planQueueRole: 'worker', planQueueRunId: 'run', planQueueItemId: 'job' },
    outputBuffer: [{ type: 'assistant', content: 'Earlier work' }],
    contextUsage: { copilotUsage: { compactions: 1, postCompactionTokens: 901, tokenLimit: 1000 } } };
  const item = newPlanQueueItem('job', 'run', '/synthetic/project/example_plan.md', 1, {
    state: 'working', branchName: 'queue/example', worktreePath: worker.workingDirectory!, workerInstanceId: worker.id,
    question: { question: 'Continue?', options: [{ id: 'continue', label: 'Continue' }] },
  });
  store.upsertRun(run); store.upsertItem(item);
  const operations: string[] = [];
  const manager = Object.assign(new EventEmitter(), {
    getInstance: (id: string) => id === worker.id ? worker : undefined,
    getAllInstances: () => [worker], adoptOrphanInstance: () => false,
    createInstance: async () => { throw new Error('Must keep the owning instance'); },
    terminateInstance: vi.fn(async () => undefined),
    restartFreshInstance: async (id: string) => {
      operations.push(`restart:${id}`);
      manager.emit('provider:normalized-event', { instanceId: id, event: { kind: 'exit', code: 0, signal: null } });
      worker.providerSessionId = 'fresh-provider'; worker.historyThreadId = 'fresh-thread';
      worker.contextUsage = { copilotUsage: { compactions: 0 } };
      return undefined; // Real child instances keep their transcript without a separate restart archive.
    },
    sendInput: async (id: string, message: string) => {
      operations.push(`send:${id}`);
      expect(message).toContain('example_plan.md');
      expect(message).toContain('James says: carry on using your best judgement.');
      expect(worker.providerSessionId).toBe('fresh-provider');
      expect(worker.metadata?.['planQueueRound']).toBe(item.round);
    },
  });
  const coordinator = PlanQueueCoordinator.getInstance();
  coordinator.initialize({ store, instances: manager, pumpIntervalMs: null,
    worktreeCreator: { createWorktree: vi.fn(), cleanupWorktree: vi.fn(), getAllSessions: () => [] } });
  coordinator.registerRole(worker.id, { role: 'worker', runId: run.id, itemId: item.id });
  coordinator.tracker.beginTurn(worker.id);
  try {
    await coordinator.answer(item.id, 'continue');
    expect(operations).toEqual(['restart:owner', 'send:owner']);
    expect(new PlanQueueStore(db).getItem(item.id)).toMatchObject({ id: 'job', runId: 'run', state: 'working',
      branchName: 'queue/example', worktreePath: '/synthetic/project/item', workerInstanceId: 'owner',
      pendingInstruction: null, workerSession: { providerSessionId: 'fresh-provider' } });
    expect(worker).toMatchObject({ id: 'owner', parentId: 'parent', workingDirectory: '/synthetic/project/item',
      outputBuffer: [{ type: 'assistant', content: 'Earlier work' }], metadata: { planQueueItemId: 'job' } });
    expect(coordinator.tracker.isTracked(worker.id)).toBe(true);
    expect(store.history.listEvents(item.id).filter(event => event.toState === 'parked')).toEqual([]);
  } finally { coordinator.shutdown(); await coordinator._whenSettledForTesting(); db.close(); }
});
