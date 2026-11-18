/**
 * Before a turn is sent to a live worker of a Linear run, the ticket check is the last wait. A ticket edited in Linear
 * while the worker's Copilot context is refreshed is still seen: nothing is sent and the job is held, not failed.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueTicketHeld, ticketAskSentence } from './plan-queue-ticket-ask';
import type { PlanQueueRun } from './plan-queue.types';

/** Linear as the check sees it: `changed` is flipped by whatever the test says happened during a wait. */
const ticket = vi.hoisted(() => ({ changed: false, events: [] as string[] }));
vi.mock('./plan-queue-work-sources', async (original) => {
  const actual = await original<typeof import('./plan-queue-work-sources')>();
  const assertReadyForSession = async () => {
    ticket.events.push('check');
    if (ticket.changed) throw new PlanQueueTicketHeld(ticketAskSentence('ORC-12', 'changed'), 'ORC-12', 'changed');
  };
  return { ...actual, workSourceFor: (kind: Parameters<typeof actual.workSourceFor>[0]) => ({ ...actual.workSourceFor(kind), assertReadyForSession }) };
});

beforeAll(() => initSqliteWasm());
beforeEach(() => { ticket.changed = false; ticket.events = []; });
afterEach(() => PlanQueueCoordinator._resetForTesting());

async function turnAfterCopilotRefresh(changeDuringRefresh: boolean) {
  const db = createSqliteWasmDatabase(':memory:');
  runLoopMigrations(db);
  const store = new PlanQueueStore(db);
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null,
    kind: 'tickets', workspaceCwd: '/synthetic/project', status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.tickets,
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
  const manager = Object.assign(new EventEmitter(), {
    getInstance: (id: string) => id === worker.id ? worker : undefined,
    getAllInstances: () => [worker], adoptOrphanInstance: () => false,
    createInstance: async () => { throw new Error('No session is created in this test'); },
    terminateInstance: vi.fn(async () => undefined),
    restartFreshInstance: async (id: string) => {
      ticket.events.push('refresh');
      if (changeDuringRefresh) ticket.changed = true;
      manager.emit('provider:normalized-event', { instanceId: id, event: { kind: 'exit', code: 0, signal: null } });
      worker.providerSessionId = 'fresh-provider'; worker.historyThreadId = 'fresh-thread';
      worker.contextUsage = { copilotUsage: { compactions: 0 } };
      return undefined; // Real child instances keep their transcript without a separate restart archive.
    },
    sendInput: async () => { ticket.events.push('send'); },
  });
  const coordinator = PlanQueueCoordinator.getInstance();
  coordinator.initialize({ store, instances: manager, pumpIntervalMs: null,
    worktreeCreator: { createWorktree: vi.fn(), cleanupWorktree: vi.fn(), getAllSessions: () => [] } });
  coordinator.registerRole(worker.id, { role: 'worker', runId: run.id, itemId: item.id });
  coordinator.tracker.beginTurn(worker.id);
  try {
    await coordinator.answer(item.id, 'continue');
    return { events: [...ticket.events], saved: new PlanQueueStore(db).getItem(item.id), parked: store.history.listEvents(item.id).filter(event => event.toState === 'parked') };
  } finally { coordinator.shutdown(); await coordinator._whenSettledForTesting(); db.close(); }
}

it('sends nothing and holds the job when the ticket changed while Copilot\'s context was refreshed', async () => {
  const { events, saved, parked } = await turnAfterCopilotRefresh(true);
  expect(events).toEqual(['refresh', 'check']);
  expect(saved).toMatchObject({ detail: ticketAskSentence('ORC-12', 'changed'), parkReason: null, erroredRounds: 0, question: { jamesOnly: true } });
  expect(saved?.heldAt).not.toBeNull();
  expect(saved?.pendingInstruction).toContain('James says: carry on using your best judgement.');
  expect(parked).toEqual([]);
});

it('checks the ticket after the refresh and then sends the turn when it is unchanged', async () => {
  const { events, saved } = await turnAfterCopilotRefresh(false);
  expect(events).toEqual(['refresh', 'check', 'send']);
  expect(saved).toMatchObject({ pendingInstruction: null, heldAt: null });
});
