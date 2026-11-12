import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { pumpPlanQueue } from './plan-queue-pump';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueSlotWaits } from './plan-queue-timings';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, loadavg: () => [0, 0, 0] }, loadavg: () => [0, 0, 0] };
});
afterEach(() => WorkAdmission._resetForTesting());

function fixture(overrides: { load?: number; usage?: boolean; claimed?: boolean; breaker?: boolean; turns?: readonly string[]; status?: PlanQueueRun['status'] } = {}) {
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'chat', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
    status: overrides.status ?? 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, verifierGates: ['npm test'] },
    relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
  const waiting = newPlanQueueItem('waiting', 'run', '/repo/waiting_plan.md', 1, { state: 'awaiting-slot', branchName: 'queue/waiting', worktreePath: '/repo/.worktrees/waiting' });
  const items: PlanQueueItem[] = [waiting];
  const waits = new PlanQueueSlotWaits({ recordEvent: vi.fn() } as never);
  const started: string[] = [];
  const finishLandingCleanup = vi.fn(async () => undefined);
  const announceRun = vi.fn();
  const host: Parameters<typeof pumpPlanQueue>[0] = {
    store: { listActiveRuns: () => [run], listAutomaticLandingsInEndedRuns: () => [], listItems: () => items, listItemsWithKeptFolders: () => [], waits } as never,
    flow: {
      startItem: async () => undefined, startVerification: async (item: PlanQueueItem) => { started.push(item.id); },
      isWaitingForUsage: () => overrides.usage ?? false, isClaimed: () => overrides.claimed ?? false,
      checklistTurns: new Set(overrides.turns ?? []), finishLandingCleanup,
      breaker: { canStart: () => overrides.breaker ?? true, started: () => undefined },
      keptFolders: { retryDue: () => undefined }, discardedRefs: { sweepDue: () => undefined }, recoveryCopies: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined },
    } as never,
    triage: null, getRun: () => run, getItem: id => items.find(item => item.id === id)!,
    transition: (item, state, patch) => Object.assign(item, patch, { state }),
    notifyParent: () => undefined, resolveRunParent: () => 'chat',
    loadAverage: () => [overrides.load ?? 0, 0, 0], queueFolderLimit: () => 0, followParent: value => value,
    isShuttingDown: () => false, isControlling: () => false, finishRun: () => undefined,
    logItemError: (_item, error) => { throw error; }, announceRun,
  };
  return { host, items, waits, started, finishLandingCleanup, announceRun };
}

describe('why a job is waiting for its checks', () => {
  it.each([
    ['other-checks', { turns: ['another-job'] }],
    ['computer-busy', { load: 10_000 }],
    ['trying-later', { usage: true }],
    ['checked-together', { claimed: true }],
    ['run-on-hold', { breaker: false }],
  ] as const)('records %s and tells the screen once', async (why, overrides) => {
    const { host, waits, started, announceRun } = fixture(overrides);
    await pumpPlanQueue(host);
    expect(waits.whyWaiting('waiting')).toBe(why);
    expect(started).toEqual([]);
    await pumpPlanQueue(host);
    expect(announceRun.mock.calls).toEqual([['run']]);
  });

  it('records a hold across Harness', async () => {
    const { host, waits } = fixture();
    getWorkAdmission().setGlobalPhase('holding');
    await pumpPlanQueue(host);
    expect(waits.whyWaiting('waiting')).toBe('harness-held');
  });

  it('starts the job when nothing is in the way', async () => {
    const { host, waits, started, announceRun } = fixture();
    await pumpPlanQueue(host);
    expect(started).toEqual(['waiting']);
    expect(waits.whyWaiting('waiting')).toBeUndefined();
    expect(announceRun).not.toHaveBeenCalled();
  });

  it('retries a finished job\'s leftover cleanup instead of skipping the run for ever', async () => {
    const { host, items, waits, started, finishLandingCleanup } = fixture();
    items.push(newPlanQueueItem('old', 'run', '/repo/old_plan.md', 0, { state: 'landed', workerInstanceId: 'gone' }));
    await pumpPlanQueue(host);
    expect(finishLandingCleanup).toHaveBeenCalledWith('old');
    expect(waits.whyWaiting('waiting')).toBe('tidying-up');
    expect(started).toEqual([]);
    items[1] = { ...items[1], workerInstanceId: null };
    await pumpPlanQueue(host);
    expect(started).toEqual(['waiting']);
  });

  it('leaves a paused run\'s cleanup for Resume', async () => {
    const { host, items, waits, finishLandingCleanup } = fixture({ status: 'paused' });
    items.push(newPlanQueueItem('old', 'run', '/repo/old_plan.md', 0, { state: 'landed', workerInstanceId: 'gone' }));
    await pumpPlanQueue(host);
    expect(finishLandingCleanup).not.toHaveBeenCalled();
    expect(waits.whyWaiting('waiting')).toBe('run-on-hold');
  });

  it('replaces an earlier reason once the run is paused', async () => {
    const { host, waits } = fixture({ status: 'paused' });
    waits.explain('waiting', 'other-checks');
    await pumpPlanQueue(host);
    expect(waits.whyWaiting('waiting')).toBe('run-on-hold');
  });
});

describe('the scheduler\'s cleanup retry', () => {
  function landedJob() {
    let item = newPlanQueueItem('old', 'run', '/repo/old_plan.md', 0, { state: 'landed', workerInstanceId: 'worker' });
    const terminateInstance = vi.fn(async () => undefined);
    const host = {
      instances: { getInstance: () => ({ id: 'worker' }), terminateInstance },
      tracker: { untrack: vi.fn(), isTracked: () => false, isShuttingDown: () => false },
      getRun: () => ({ id: 'run', status: 'running', workspaceCwd: '/repo', config: {} }), getItem: () => item,
      save: (updated: PlanQueueItem) => (item = updated), roleOf: () => undefined, unregisterRole: vi.fn(), requestPump: vi.fn(),
    } as unknown as PlanQueueFlowHost;
    return { flow: new PlanQueueItemFlow(host), terminateInstance, current: () => item };
  }

  it('leaves a cleanup already under way alone', async () => {
    const { flow, terminateInstance, current } = landedJob();
    let release = (): void => undefined;
    terminateInstance.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
    const first = flow.finishLandingCleanup('old');
    await vi.waitFor(() => expect(terminateInstance).toHaveBeenCalled());
    await flow.finishLandingCleanup('old'); // Returns at once. Queueing behind the lock would never settle here.
    expect(current().workerInstanceId).toBe('worker');
    release();
    await first;
    expect(current().workerInstanceId).toBeNull();
    expect(terminateInstance).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed cleanup for the next pass without rejecting', async () => {
    const { flow, terminateInstance, current } = landedJob();
    terminateInstance.mockRejectedValueOnce(new Error('stop refused'));
    await expect(flow.finishLandingCleanup('old')).resolves.toBeUndefined();
    expect(current().workerInstanceId).toBe('worker');
    await flow.finishLandingCleanup('old');
    expect(current().workerInstanceId).toBeNull();
    await flow.finishLandingCleanup('old');
    expect(terminateInstance).toHaveBeenCalledTimes(2);
  });
});
