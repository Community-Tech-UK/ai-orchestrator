/**
 * The ticket check before a session of a Linear run is created is the last wait before the creation. A ticket edited in
 * Linear while the queue chooses a route, checks its usage or tries to reopen a conversation is still seen, and no
 * session starts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { PlanQueueInstancePort } from './plan-queue-host';
import { _setLinearProviderPolicyForTesting, LinearProviderPolicy } from './plan-queue-linear-providers';
import { spawnQueueInstance } from './plan-queue-spawn';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueTicketHeld, ticketAskSentence } from './plan-queue-ticket-ask';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

/** Linear as the check sees it: `changed` is flipped by whatever the test says happened during a wait. */
const ticket = vi.hoisted(() => ({ changed: false, events: [] as string[] }));
vi.mock('./plan-queue-work-sources', () => ({
  workSourceFor: () => ({
    assertReadyForSession: async () => {
      ticket.events.push('check');
      if (ticket.changed) throw new PlanQueueTicketHeld(ticketAskSentence('ORC-12', 'changed'), 'ORC-12', 'changed');
    },
  }),
}));

let run: PlanQueueRun;
let item: PlanQueueItem;
let instances: PlanQueueInstancePort;
const session = { provider: 'claude', model: null, accountProfileId: null, providerSessionId: 'conversation', workingDirectory: '/queue-test', recordedAt: 1 };

beforeEach(() => {
  ticket.changed = false;
  ticket.events = [];
  _setLinearProviderPolicyForTesting(new LinearProviderPolicy({
    readTeams: () => [{ teamId: 'team-orc', providers: ['claude', 'codex'] }],
    teamsOfRun: () => [{ teamId: 'team-orc', teamKey: 'ORC' }],
  }));
  run = {
    id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'tickets', workspaceCwd: '/queue-test',
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.tickets, routing: { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'codex' }] } },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null,
  };
  item = newPlanQueueItem('item', 'run', 'linear:lin-12', 1, { sourceKind: 'linear' });
  instances = {
    createInstance: vi.fn(async () => { ticket.events.push('create'); return { id: 'created' }; }),
    terminateInstance: vi.fn(async () => undefined), restartFreshInstance: vi.fn(async () => undefined),
    sendInput: vi.fn(async () => undefined), getInstance: vi.fn(), getAllInstances: () => [],
  };
});

function config(role: 'worker' | 'verifier'): InstanceCreateConfig {
  return { workingDirectory: '/queue-test', provider: role === 'worker' ? 'claude' : 'codex', initialPrompt: 'brief',
    metadata: { planQueueRunId: run.id, planQueueRole: role, planQueueItemId: item.id } };
}

function host(routeUsage = async () => ({ usable: true, resumeAt: null })) {
  return { ready: Promise.resolve(), instances, getRun: () => run, getItem: () => item, clearWorkerSession: vi.fn(),
    isShuttingDown: () => false, userCloseEpoch: () => 0, readAccountRules: () => ({ never: [], last: [] }),
    isProviderExcluded: () => false, routeUsage };
}

describe('the ticket check before a session of a Linear run', () => {
  it.each(['worker', 'verifier'] as const)('runs after the route and its usage are settled, right before a %s is created', async (role) => {
    const routeUsage = async () => { ticket.events.push('usage'); return { usable: true, resumeAt: null }; };
    await spawnQueueInstance(config(role), host(routeUsage));
    expect(ticket.events.at(-2)).toBe('check');
    expect(ticket.events.at(-1)).toBe('create');
    expect(ticket.events.filter((event) => event === 'check')).toHaveLength(1);
  });

  it.each(['worker', 'verifier'] as const)('sees a change made while the usage is checked, and no %s is created', async (role) => {
    const routeUsage = async () => { ticket.changed = true; return { usable: true, resumeAt: null }; };
    await expect(spawnQueueInstance(config(role), host(routeUsage))).rejects.toBeInstanceOf(PlanQueueTicketHeld);
    expect(instances.createInstance).not.toHaveBeenCalled();
  });

  it('checks again before a second session when the conversation could not be reopened, and sees a change made meanwhile', async () => {
    item = { ...item, workerSession: session };
    vi.mocked(instances.createInstance).mockImplementationOnce(async () => {
      ticket.events.push('create');
      ticket.changed = true;
      throw new Error('conversation missing');
    });
    await expect(spawnQueueInstance(config('worker'), host())).rejects.toBeInstanceOf(PlanQueueTicketHeld);
    expect(instances.createInstance).toHaveBeenCalledTimes(1);
    expect(ticket.events).toEqual(['check', 'create', 'check']);
  });

  it('starts the second session when the ticket is still as approved', async () => {
    item = { ...item, workerSession: session };
    vi.mocked(instances.createInstance).mockRejectedValueOnce(new Error('conversation missing'));
    await expect(spawnQueueInstance(config('worker'), host())).resolves.toMatchObject({ id: 'created' });
    expect(instances.createInstance).toHaveBeenCalledTimes(2);
    expect(ticket.events).toEqual(['check', 'check', 'create']);
  });

  it('asks nothing for a plan run', async () => {
    run = { ...run, kind: 'plans', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, routing: run.config.routing } };
    await spawnQueueInstance(config('worker'), host());
    expect(ticket.events).toEqual(['create']);
  });
});
