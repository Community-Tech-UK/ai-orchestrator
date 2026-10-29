import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { newPlanQueueItem } from './plan-queue-state';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { PlanQueueInstancePort } from './plan-queue-host';
import { PlanQueueSpawnOutOfUsage, spawnQueueInstance, USAGE_RECHECK_MS } from './plan-queue-spawn';
import { PlanQueueSpawnRoutingChanged } from './plan-queue-checker-routing';
import { PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import { PlanQueueTriage } from './plan-queue-triage';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const initialRun: PlanQueueRun = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
  status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: 'codex',
  workerModel: null, startedAt: 1, endedAt: null };
let run: PlanQueueRun;
let items: PlanQueueItem[];
let now: number;
let triage: PlanQueueTriage;
let create: ReturnType<typeof vi.fn>;
let select: ReturnType<typeof vi.fn>;
let userClosed: boolean;
let retire: ReturnType<typeof vi.fn>;
/** What the created triage session reports; null = the provider it was asked for. */
let live: { provider?: string; currentModel?: string } | null;

beforeEach(() => {
  run = { ...initialRun, config: { ...initialRun.config } };
  items = Array.from({ length: 9 }, (_, index) => newPlanQueueItem(`item-${index}`, run.id, `/repo/${index}_plan.md`, index));
  now = 0; userClosed = false; retire = vi.fn(); live = null;
  create = vi.fn().mockResolvedValue({ id: 'triage-1' });
  select = vi.fn().mockResolvedValue({ ok: true, choice: { provider: 'claude' } });
  const host = {
    instances: { createInstance: create, getInstance: () => live ?? ({ provider: create.mock.calls.at(-1)?.[0].provider ?? 'codex' }) },
    tracker: { track: vi.fn(), isShuttingDown: () => false },
    getItem: (id: string) => items.find((item) => item.id === id)!,
    getRun: () => run,
    transition: (item: PlanQueueItem, state: PlanQueueItem['state'], patch?: Partial<PlanQueueItem>) => {
      const saved = { ...item, ...patch, state };
      items[items.findIndex((entry) => entry.id === item.id)] = saved;
      return saved;
    },
    consumeUserClose: () => userClosed, selectVerifier: select, registerRole: vi.fn(), requestPump: vi.fn(),
    liveParentId: () => 'parent', retireInstance: retire, now: () => now,
  };
  triage = new PlanQueueTriage(host as unknown as ConstructorParameters<typeof PlanQueueTriage>[0]);
});

async function waitForRetirement(): Promise<void> {
  await vi.waitFor(() => expect(triage.isStopping(run.id)).toBe(false));
}

async function start(): Promise<void> {
  await waitForRetirement();
  triage.maybeStart(run, items);
  await vi.waitFor(() => expect(create).toHaveBeenCalled());
  await new Promise((resolve) => setImmediate(resolve));
}

describe('usage waits', () => {
  it('waits for usage without spending the three start attempts that park documents', async () => {
    create.mockRejectedValue(new PlanQueueSpawnOutOfUsage(null, 'claude'));
    for (let attempt = 1; attempt <= 4; attempt++) {
      triage.maybeStart(run, items);
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(attempt));
      await vi.waitFor(() => expect(triage.isStopping(run.id)).toBe(false));
      await new Promise((resolve) => setImmediate(resolve));
      triage.maybeStart(run, items);
      await new Promise((resolve) => setImmediate(resolve));
      expect(create).toHaveBeenCalledTimes(attempt);
      now += USAGE_RECHECK_MS + 1;
    }
    expect(items.every((item) => item.state === 'discovered')).toBe(true);
  });
});

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


it('retries with the run checker choices and their saved-choice licence authority', async () => {
  const routed = { ...run, config: { ...run.config, routing: { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }], checkersChosenBy: 'saved' as const } } };
  run = routed;
  triage.maybeStart(routed, items);
  await new Promise((resolve) => setImmediate(resolve));
  triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'failed' });
  await waitForRetirement();
  triage.maybeStart(routed, items);
  await new Promise((resolve) => setImmediate(resolve));
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ choices: routed.config.routing.verifiers, choicesOverrideLicence: true }));
});

it('pause invalidates an in-flight spawn without spending an attempt', async () => {
  let resolveSpawn!: (value: {id: string}) => void;
  create.mockImplementationOnce(() => new Promise((resolve) => { resolveSpawn = resolve; }));
  triage.maybeStart(run, items);
  let paused = false;
  const pausing = triage.pause(run.id).then(() => { paused = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(paused).toBe(false);
  triage.maybeStart(run, items);
  expect(create).toHaveBeenCalledTimes(1);
  resolveSpawn({ id: 'late' });
  await pausing;
  expect(retire).toHaveBeenCalledExactlyOnceWith('late');
  triage.maybeStart(run, items);
  await new Promise((resolve) => setImmediate(resolve));
  expect(select).not.toHaveBeenCalled();
  expect(triage.isTriageFor(run.id, 'late')).toBe(false);
  expect(items[0].state).toBe('discovered');
});


it('pause stops a live triage session and ignores its eventual outcome without consuming an attempt', async () => {
  await start();
  await triage.pause(run.id);
  expect(retire).toHaveBeenCalledWith('triage-1');
  triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'stopped for pause' });
  create.mockResolvedValueOnce({ id: 'triage-2' });
  await start();
  expect(select).not.toHaveBeenCalled();
  triage.onOutcome('triage-2', run.id, { kind: 'failed', reason: 'first actual failure' });
  expect(items[0].state).toBe('discovered');
});

it('retries a rejected triage stop before Resume can start another batch', async () => {
  await start();
  run = { ...run, status: 'paused' };
  retire.mockRejectedValueOnce(new Error('stop unavailable'));
  await expect(triage.pause(run.id)).rejects.toThrow('stop unavailable');
  expect(triage.isTriageFor(run.id, 'triage-1')).toBe(false);
  triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'late outcome' });
  run = { ...run, status: 'running' };
  triage.maybeStart(run, items);
  expect(create).toHaveBeenCalledTimes(1);
  await triage.pause(run.id);
  expect(retire.mock.calls).toEqual([['triage-1'], ['triage-1']]);
  create.mockResolvedValueOnce({ id: 'triage-2' });
  await start();
  expect(create).toHaveBeenCalledTimes(2);
  expect(select).not.toHaveBeenCalled();
  expect(items[0]).toMatchObject({ state: 'discovered', parkReason: null });
});

it('retains a failed retirement of a late spawn so the next pause retries it', async () => {
  let resolveSpawn!: (value: { id: string }) => void;
  create.mockImplementationOnce(() => new Promise(resolve => { resolveSpawn = resolve; }));
  triage.maybeStart(run, items);
  run = { ...run, status: 'paused' };
  const pausing = triage.pause(run.id);
  const rejected = expect(pausing).rejects.toThrow('late stop unavailable');
  retire.mockRejectedValueOnce(new Error('late stop unavailable'));
  resolveSpawn({ id: 'late' });
  await rejected;
  expect(triage.isTriageFor(run.id, 'late')).toBe(false);
  await triage.pause(run.id);
  expect(retire.mock.calls).toEqual([['late'], ['late']]);
  run = { ...run, status: 'running' };
  await start();
  expect(select).not.toHaveBeenCalled();
  expect(items[0]).toMatchObject({ state: 'discovered', parkReason: null });
});

it('retains a paused spawn cleanup failure even after the pending batch was invalidated', async () => {
  let rejectSpawn!: (reason: Error) => void;
  create.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSpawn = reject; }));
  triage.maybeStart(run, items);
  run = { ...run, status: 'paused' };
  const pausing = triage.pause(run.id);
  const rejected = expect(pausing).rejects.toBeInstanceOf(PlanQueueSpawnRunPaused);
  rejectSpawn(new PlanQueueSpawnRunPaused('late-session'));
  await rejected;
  await triage.pause(run.id);
  expect(retire).toHaveBeenCalledExactlyOnceWith('late-session');
  expect(items[0]).toMatchObject({ state: 'discovered', parkReason: null });
});

it('a paused spawn refusal does not accrue backoff or failed starts', async () => {
  create.mockRejectedValueOnce(new PlanQueueSpawnRunPaused());
  await start();
  await start();
  expect(create).toHaveBeenCalledTimes(2);
  expect(select).not.toHaveBeenCalled();
});

it('chooses the retry checker against the first attempt\'s own provider and model, not the run\'s first worker choice', async () => {
  run = { ...run, workerProvider: 'claude', workerModel: 'claude-opus-5' };
  // The spawn's usage check started the first triage on a later worker choice.
  live = { provider: 'opencode', currentModel: 'openai/gpt-5.5' };
  await start();
  live = null;
  triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'failed' });
  await start();
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ workerProvider: 'opencode', workerModel: 'openai/gpt-5.5' }));
});

it('preserves the retry checker account fence and Copilot seat', async () => {
  await start();
  triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'failed' });
  select.mockResolvedValueOnce({ ok: true, choice: { provider: 'copilot', copilotProfileId: 'chosen-seat', accountProfileIds: ['checker-account'] } });
  await start();
  expect(create.mock.calls[1][0]).toMatchObject({ provider: 'copilot', copilotAccountProfileId: 'chosen-seat', allowedAccountProfileIds: ['checker-account'], metadata: { planQueueTriageRetry: true } });
});


it('reselects a retry checker if routing changes while selection is pending', async () => {
  run.config = { ...run.config, routing: { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }] } };
  await start();
  triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'failed' });
  await waitForRetirement();
  let resolveSelection!: (result: unknown) => void;
  select.mockImplementationOnce(() => new Promise((resolve) => { resolveSelection = resolve; }));
  triage.maybeStart(run, items);
  run = { ...run, config: { ...run.config, routing: { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'copilot' }] } } };
  select.mockResolvedValueOnce({ ok: true, choice: { provider: 'copilot', copilotProfileId: 'current-seat' } });
  resolveSelection({ ok: true, choice: { provider: 'claude', accountProfileIds: ['old-account'] } });
  await new Promise((resolve) => setImmediate(resolve));
  expect(select).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][0]).toMatchObject({ provider: 'copilot', copilotAccountProfileId: 'current-seat' });
  expect(create.mock.calls[1][0].allowedAccountProfileIds).toBeUndefined();
});


it('handles asynchronous retirement failure after a normal outcome', async () => {
  await start();
  retire.mockRejectedValueOnce(new Error('stop unavailable'));
  triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'failed' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(items[0].state).toBe('discovered');
});


describe('retry routing at the final asynchronous dispatch boundary', () => {
  it.each(['provider', 'account'] as const)('refreshes a changed %s after selection with resolved readiness', async (change) => {
    const old = { provider: 'claude', model: 'old-model', accountProfileIds: ['old-account'] };
    const current = { provider: change === 'provider' ? 'cursor' : 'claude', model: 'current-model', accountProfileIds: ['current-account'] };
    run = { ...run, config: { ...run.config, routing: { workers: [{ provider: 'codex' }], verifiers: [old] } } };
    await start();
    triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'first actual failure' });
    await waitForRetirement();
    select.mockImplementation(async (input) => ({ ok: true, choice: {
      provider: input.choices[0].provider, modelOverride: input.choices[0].model,
      accountProfileIds: [...input.choices[0].accountProfileIds],
    } }));
    const dispatch = vi.fn().mockResolvedValue({ id: 'current-retry' });
    const port = { createInstance: dispatch, terminateInstance: vi.fn() } as unknown as PlanQueueInstancePort;
    let changePending = true;
    create.mockImplementation((config: InstanceCreateConfig) => {
      if (changePending) {
        changePending = false;
        // A concurrent set-routing validation finishes before ready's already-resolved continuation.
        queueMicrotask(() => { run = { ...run, config: { ...run.config, routing: { workers: [{ provider: 'codex' }], verifiers: [current] } } }; });
      }
      return spawnQueueInstance(config, { ready: Promise.resolve(), instances: port, getRun: () => run, getItem: () => null, clearWorkerSession: vi.fn(),
        isShuttingDown: () => false, userCloseEpoch: () => 0, readAccountRules: () => ({ never: [], last: [] }), isProviderExcluded: () => false, routeUsage: async () => ({ usable: true, resumeAt: null }) });
    });
    triage.maybeStart(run, items);
    await vi.waitFor(() => expect(triage.isTriageFor(run.id, 'current-retry')).toBe(true));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: current.provider, modelOverride: 'current-model', allowedAccountProfileIds: ['current-account'],
    }));
    expect(dispatch.mock.calls[0][0].copilotAccountProfileId).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(2);
    expect(now).toBe(0); // Reselection did not enter the failed-start backoff.
    expect(items[0].state).toBe('discovered');
    triage.onOutcome('current-retry', run.id, { kind: 'failed', reason: 'second actual failure' });
    expect(items[0]).toMatchObject({ state: 'parked', parkReason: 'triage-failed' });
    expect(items[0].detail).toContain('first actual failure');
    expect(items[0].detail).toContain('second actual failure');
  });
});


it.each(['paused', 'superseded'] as const)('does not publish a reselected retry after its batch is %s', async (state) => {
  await start();
  triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'first failure' });
  await waitForRetirement();
  create.mockRejectedValueOnce(new PlanQueueSpawnRoutingChanged());
  let resolveSelection!: (result: unknown) => void;
  select.mockResolvedValueOnce({ ok: true, choice: { provider: 'claude' } });
  select.mockImplementationOnce(() => new Promise(resolve => { resolveSelection = resolve; }));
  triage.maybeStart(run, items);
  await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(2));
  run = { ...run, status: 'paused' };
  let paused = false;
  const pausing = triage.pause(run.id).then(() => { paused = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(paused).toBe(false);
  resolveSelection({ ok: true, choice: { provider: 'cursor', accountProfileIds: ['late-account'] } });
  await pausing;
  expect(create).toHaveBeenCalledTimes(2);
  if (state === 'superseded') {
    run = { ...run, status: 'running' };
    create.mockResolvedValueOnce({ id: 'new-batch' });
    triage.maybeStart(run, items);
    await vi.waitFor(() => expect(triage.isTriageFor(run.id, 'new-batch')).toBe(true));
  }
  await new Promise(resolve => setImmediate(resolve));
  expect(create).toHaveBeenCalledTimes(state === 'superseded' ? 3 : 2);
  expect(create.mock.calls.some(([config]) => config.provider === 'cursor')).toBe(false);
  expect(items[0]).toMatchObject({ state: 'discovered', parkReason: null });
  if (state === 'superseded') expect(triage.isTriageFor(run.id, 'new-batch')).toBe(true);
});

it('keeps the first-triage worker route fallback when retry checker selection is unavailable', async () => {
  run = { ...run, workerModel: 'worker-model', config: { ...run.config, routing: {
    workers: [{ provider: 'codex', model: 'worker-model', accountProfileIds: ['worker-account'] }], verifiers: [],
  } } };
  await start();
  triage.onOutcome('triage-1', run.id, { kind: 'failed', reason: 'first failure' });
  await waitForRetirement();
  select.mockResolvedValueOnce({ ok: false, reason: 'no checker installed' });
  const dispatch = vi.fn().mockResolvedValue({ id: 'fallback' });
  create.mockImplementation((config: InstanceCreateConfig) => spawnQueueInstance(config, {
    ready: Promise.resolve(), instances: { createInstance: dispatch } as unknown as PlanQueueInstancePort,
    getRun: () => run, getItem: () => null, clearWorkerSession: vi.fn(), isShuttingDown: () => false, userCloseEpoch: () => 0, readAccountRules: () => ({ never: [], last: [] }), isProviderExcluded: () => false, routeUsage: async () => ({ usable: true, resumeAt: null }),
  }));
  triage.maybeStart(run, items);
  await vi.waitFor(() => expect(triage.isTriageFor(run.id, 'fallback')).toBe(true));
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    provider: 'codex', modelOverride: 'worker-model', allowedAccountProfileIds: ['worker-account'],
  }));
  expect(dispatch.mock.calls[0][0].metadata.planQueueTriageRetry).toBeUndefined();
});


it('settles an ID-less paused spawn refusal successfully before allowing a replacement batch', async () => {
  let rejectSpawn!: (error: Error) => void;
  create.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSpawn = reject; }));
  triage.maybeStart(run, items);
  run = { ...run, status: 'paused' };
  const pausing = triage.pause(run.id);
  rejectSpawn(new PlanQueueSpawnRunPaused());
  await expect(pausing).resolves.toBeUndefined();
  expect(retire).not.toHaveBeenCalled();
  run = { ...run, status: 'running' };
  await start();
  expect(create).toHaveBeenCalledTimes(2);
  expect(select).not.toHaveBeenCalled();
});
