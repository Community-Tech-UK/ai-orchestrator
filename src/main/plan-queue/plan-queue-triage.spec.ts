import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueTriage } from './plan-queue-triage';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const run: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
  status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: 'codex',
  workerModel: null, startedAt: 1, endedAt: null };
let items: PlanQueueItem[];
let now: number;
let triage: PlanQueueTriage;
let create: ReturnType<typeof vi.fn>;
let select: ReturnType<typeof vi.fn>;
let userClosed: boolean;

beforeEach(() => {
  items = Array.from({ length: 9 }, (_, index) => newPlanQueueItem(`item-${index}`, run.id, `/repo/${index}_plan.md`, index));
  now = 0; userClosed = false;
  create = vi.fn().mockResolvedValue({ id: 'triage-1' });
  select = vi.fn().mockResolvedValue({ ok: true, choice: { provider: 'claude' } });
  const host = {
    instances: { createInstance: create, getInstance: () => ({ provider: 'codex' }) },
    tracker: { track: vi.fn(), isShuttingDown: () => false },
    getItem: (id: string) => items.find((item) => item.id === id)!,
    getRun: () => run,
    transition: (item: PlanQueueItem, state: PlanQueueItem['state'], patch?: Partial<PlanQueueItem>) => {
      const saved = { ...item, ...patch, state };
      items[items.findIndex((entry) => entry.id === item.id)] = saved;
      return saved;
    },
    consumeUserClose: () => userClosed, selectVerifier: select, registerRole: vi.fn(), requestPump: vi.fn(),
    liveParentId: () => 'parent', retireInstance: vi.fn(), now: () => now,
  };
  triage = new PlanQueueTriage(host as unknown as ConstructorParameters<typeof PlanQueueTriage>[0]);
});

async function start(): Promise<void> {
  triage.maybeStart(run, items);
  await vi.waitFor(() => expect(create).toHaveBeenCalled());
  await new Promise((resolve) => setImmediate(resolve));
}

describe('readiness batches and retries', () => {
  it('does not spend a readiness attempt when James closes its session', async () => {
    await start(); userClosed = true;
    triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'removed' });
    userClosed = false;
    create.mockResolvedValueOnce({ id: 'triage-2' }); await start();
    triage.onOutcome('triage-2', run.id, { kind: 'failed', reason: 'first genuine failure' });
    expect(items[0].state).toBe('discovered');
  });
  it('limits a readiness session to the oldest eight documents', async () => {
    await start();
    const prompt = create.mock.calls[0][0].initialPrompt;
    expect(prompt).toContain('/repo/7_plan.md');
    expect(prompt).not.toContain('/repo/8_plan.md');
  });

  it('does not spend an attempt on a rejected spawn, and waits one minute', async () => {
    create.mockRejectedValueOnce(new Error('spawn unavailable'));
    await start();
    triage.maybeStart(run, items);
    expect(create).toHaveBeenCalledTimes(1);
    now = 60_000;
    await start();
    expect(create).toHaveBeenCalledTimes(2);
    expect(select).not.toHaveBeenCalled();
  });

  it('retries only unreported documents with another provider', async () => {
    await start();
    items[0] = { ...items[0], state: 'queued' };
    triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'checker failed' });
    create.mockResolvedValueOnce({ id: 'triage-2' });
    await start();
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ workerProvider: 'codex' }));
    expect(create.mock.calls[1][0].provider).toBe('claude');
    expect(create.mock.calls[1][0].initialPrompt).not.toContain('/repo/0_plan.md');
  });

  it('parks unreported documents after two outcomes, with both provider causes', async () => {
    await start();
    triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'checker failed' });
    create.mockResolvedValueOnce({ id: 'triage-2' });
    await start();
    triage.onOutcome('triage-2', run.id, { kind: 'provider-limit', notice: 'weekly limit' });
    expect(items[0]).toMatchObject({ state: 'parked', parkReason: 'triage-failed' });
    expect(items[0].detail).toContain('checker failed');
    expect(items[0].detail).toContain('Codex');
    expect(items[0].detail).toContain('Claude');
    expect(items[8].state).toBe('discovered');
  });

  it('parks the batch after three consecutive failed starts', async () => {
    create.mockRejectedValue(new Error('spawn unavailable'));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      now = attempt * 60_000;
      await start();
    }
    expect(items.slice(0, 8).every((item) => item.state === 'parked')).toBe(true);
    expect(items[0].detail).toContain('spawn unavailable');
    expect(items[8].state).toBe('discovered');
  });
});
