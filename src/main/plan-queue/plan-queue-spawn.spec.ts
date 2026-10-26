import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import { PlanQueueSpawnRoutingChanged } from './plan-queue-checker-routing';
import type { PlanQueueInstancePort } from './plan-queue-host';
import { PlanQueueSpawnRunPaused } from './plan-queue-run-hold';
import { spawnQueueInstance } from './plan-queue-spawn';
import type { PlanQueueRun } from './plan-queue.types';
import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let run: PlanQueueRun;
let epoch: number;
let instances: PlanQueueInstancePort;
let config: InstanceCreateConfig;

beforeEach(() => {
  epoch = 0;
  run = {
    id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/queue-test',
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, routing: { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'codex' }] } },
    workerProvider: 'claude', workerModel: null, relaxation: null, startedAt: 1, endedAt: null,
  };
  instances = {
    createInstance: vi.fn(async () => ({ id: 'created' })), terminateInstance: vi.fn(async () => undefined),
    sendInput: vi.fn(async () => undefined), getInstance: vi.fn(), getAllInstances: () => [],
  };
  config = { workingDirectory: '/queue-test', provider: 'claude', metadata: { planQueueRunId: run.id, planQueueRole: 'worker' } };
});

function host(ready: Promise<void>) {
  return { ready, instances, getRun: () => run, isShuttingDown: () => false, userCloseEpoch: () => epoch, isProviderExcluded: () => false };
}

describe('Plan Queue asynchronous spawn fences', () => {
  it('refuses a run paused while waiting for readiness with the distinct pause error', async () => {
    const ready = deferred<void>();
    const pending = spawnQueueInstance(config, host(ready.promise));
    run = { ...run, status: 'paused' };
    const rejected = expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnRunPaused);
    ready.resolve();
    await rejected;
    expect(instances.createInstance).not.toHaveBeenCalled();
    expect(instances.terminateInstance).not.toHaveBeenCalled();
  });

  it('terminates a session created while Pause was in flight and refuses to publish it', async () => {
    const created = deferred<{ id: string; readyPromise: Promise<void> }>();
    vi.mocked(instances.createInstance).mockReturnValue(created.promise);
    const pending = spawnQueueInstance(config, host(Promise.resolve()));
    await vi.waitFor(() => expect(instances.createInstance).toHaveBeenCalledTimes(1));
    run = { ...run, status: 'paused' };
    const rejected = expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnRunPaused);
    created.resolve({ id: 'late-session', readyPromise: Promise.reject(new Error('adapter stopped')) });
    await rejected;
    expect(instances.terminateInstance).toHaveBeenCalledExactlyOnceWith('late-session', true);
  });

  it('retains the distinct Close all error when its epoch changes before readiness', async () => {
    const ready = deferred<void>();
    const pending = spawnQueueInstance(config, host(ready.promise));
    epoch += 1;
    const rejected = expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnStoppedByUser);
    ready.resolve();
    await rejected;
    expect(instances.createInstance).not.toHaveBeenCalled();
  });

  it('retains the late session ID on a failed pause cleanup so the hold can retry stopping it', async () => {
    const created = deferred<{ id: string }>();
    vi.mocked(instances.createInstance).mockReturnValue(created.promise);
    vi.mocked(instances.terminateInstance).mockRejectedValueOnce(new Error('stop unavailable'));
    const pending = spawnQueueInstance(config, host(Promise.resolve()));
    await vi.waitFor(() => expect(instances.createInstance).toHaveBeenCalledTimes(1));
    run = { ...run, status: 'paused' };
    const rejected = expect(pending).rejects.toMatchObject({ instanceId: 'late-session' });
    created.resolve({ id: 'late-session' });
    await rejected;
    await expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnRunPaused);
    expect(instances.terminateInstance).toHaveBeenCalledExactlyOnceWith('late-session', true);
  });

  it('refuses a checker whose routing signature changed while waiting for readiness', async () => {
    const ready = deferred<void>();
    config = { ...config, provider: 'codex', metadata: { ...config.metadata, planQueueRole: 'verifier', planQueueRouting: JSON.stringify(run.config.routing) } };
    const pending = spawnQueueInstance(config, host(ready.promise));
    run = { ...run, config: { ...run.config, routing: { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'cursor' }] } } };
    const rejected = expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnRoutingChanged);
    ready.resolve();
    await rejected;
    expect(instances.createInstance).not.toHaveBeenCalled();
  });
});


it.each(['triage', 'verifier'] as const)('refuses a legacy %s selection when explicit routing is installed during readiness', async (role) => {
  run = { ...run, config: { ...run.config, routing: undefined } };
  const ready = deferred<void>();
  config = { ...config, provider: 'codex', allowedAccountProfileIds: ['old-account'], metadata: {
    ...config.metadata, planQueueRole: role, planQueueRouting: JSON.stringify(run.config.routing),
    ...(role === 'triage' ? { planQueueTriageRetry: true } : {}),
  } };
  const pending = spawnQueueInstance(config, host(ready.promise));
  run = { ...run, config: { ...run.config, routing: { workers: [{ provider: 'claude' }], verifiers: [{ provider: 'cursor' }] } } };
  const rejected = expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnRoutingChanged);
  ready.resolve();
  await rejected;
  expect(instances.createInstance).not.toHaveBeenCalled();
});


it('retains Close all identity and cleanup ownership when it overtakes Pause during creation', async () => {
  const created = deferred<{ id: string }>();
  vi.mocked(instances.createInstance).mockReturnValue(created.promise);
  const stopError = new Error('Close all cleanup failed');
  vi.mocked(instances.terminateInstance).mockRejectedValueOnce(stopError);
  const pending = spawnQueueInstance(config, host(Promise.resolve()));
  await vi.waitFor(() => expect(instances.createInstance).toHaveBeenCalledTimes(1));
  run = { ...run, status: 'paused' };
  epoch += 1;
  const rejected = expect(pending).rejects.toMatchObject({ instanceId: 'late-close-session', cause: stopError });
  created.resolve({ id: 'late-close-session' });
  await rejected;
  await expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnStoppedByUser);
  expect(instances.terminateInstance).toHaveBeenCalledExactlyOnceWith('late-close-session', true);
});

describe('ranked worker choices at spawn', () => {
  const twoChoices = { workers: [{ provider: 'claude', model: 'claude-opus-5' }, { provider: 'codex', model: 'gpt-6.1-sol', accountProfileIds: ['pro-2'] }], verifiers: [] };

  it('starts the worker on the first choice with usage left', async () => {
    run = { ...run, config: { ...run.config, routing: twoChoices } };
    const routeUsage = vi.fn(async (choice: { provider: string }) => ({ usable: choice.provider !== 'claude', resumeAt: null }));
    await spawnQueueInstance(config, { ...host(Promise.resolve()), routeUsage });
    expect(routeUsage).toHaveBeenCalledTimes(2);
    expect(instances.createInstance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: 'codex', modelOverride: 'gpt-6.1-sol', allowedAccountProfileIds: ['pro-2'], accountRouteOrigin: 'automation',
    }));
  });

  it('never checks usage for a run with one worker choice', async () => {
    const routeUsage = vi.fn();
    await spawnQueueInstance(config, { ...host(Promise.resolve()), routeUsage });
    expect(routeUsage).not.toHaveBeenCalled();
    expect(instances.createInstance).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude' }));
  });

  it('chooses again from the new list when James changes routing during the usage check', async () => {
    run = { ...run, config: { ...run.config, routing: twoChoices } };
    const first = deferred<{ usable: boolean; resumeAt: number | null }>();
    const routeUsage = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ usable: true, resumeAt: null });
    const pending = spawnQueueInstance(config, { ...host(Promise.resolve()), routeUsage });
    await vi.waitFor(() => expect(routeUsage).toHaveBeenCalledTimes(1));
    run = { ...run, config: { ...run.config, routing: { workers: [{ provider: 'cursor' }, { provider: 'claude' }], verifiers: [] } } };
    first.resolve({ usable: true, resumeAt: null });
    await pending;
    expect(instances.createInstance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'cursor' }));
  });

  it('refuses the spawn when the run is paused during the usage check', async () => {
    run = { ...run, config: { ...run.config, routing: twoChoices } };
    const check = deferred<{ usable: boolean; resumeAt: number | null }>();
    const pending = spawnQueueInstance(config, { ...host(Promise.resolve()), routeUsage: () => check.promise });
    run = { ...run, status: 'paused' };
    const rejected = expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnRunPaused);
    check.resolve({ usable: true, resumeAt: null });
    await rejected;
    expect(instances.createInstance).not.toHaveBeenCalled();
  });

  it('skips a worker choice since added to the never-auto-pick list without checking its usage', async () => {
    run = { ...run, config: { ...run.config, routing: { workers: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'cursor' }], verifiers: [] } } };
    const routeUsage = vi.fn(async () => ({ usable: true, resumeAt: null }));
    await spawnQueueInstance(config, { ...host(Promise.resolve()), isProviderExcluded: (provider: string) => provider === 'claude', routeUsage });
    expect(routeUsage).toHaveBeenCalledExactlyOnceWith({ provider: 'codex' }, 'automation');
    expect(instances.createInstance).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex' }));
  });
});
