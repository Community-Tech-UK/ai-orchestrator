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
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, routing: { worker: { provider: 'claude' }, verifiers: [{ provider: 'codex' }] } },
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
    run = { ...run, config: { ...run.config, routing: { worker: { provider: 'claude' }, verifiers: [{ provider: 'cursor' }] } } };
    const rejected = expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnRoutingChanged);
    ready.resolve();
    await rejected;
    expect(instances.createInstance).not.toHaveBeenCalled();
  });
});


it('refuses a triage retry whose legacy worker model changed after selection', async () => {
  run = { ...run, config: { ...run.config, routing: undefined } };
  const ready = deferred<void>();
  config = { ...config, provider: 'codex', metadata: { ...config.metadata, planQueueRole: 'triage',
    planQueueTriageRetry: true, planQueueRouting: JSON.stringify(run.config.routing), planQueueTriageWorkerModel: run.workerModel } };
  const pending = spawnQueueInstance(config, host(ready.promise));
  run = { ...run, workerModel: 'changed-model' };
  const rejected = expect(pending).rejects.toBeInstanceOf(PlanQueueSpawnRoutingChanged);
  ready.resolve();
  await rejected;
  expect(instances.createInstance).not.toHaveBeenCalled();
});


it.each(['triage', 'verifier'] as const)('refuses a legacy %s selection when explicit routing is installed during readiness', async (role) => {
  run = { ...run, config: { ...run.config, routing: undefined } };
  const ready = deferred<void>();
  config = { ...config, provider: 'codex', allowedAccountProfileIds: ['old-account'], metadata: {
    ...config.metadata, planQueueRole: role, planQueueRouting: JSON.stringify(run.config.routing),
    ...(role === 'triage' ? { planQueueTriageRetry: true, planQueueTriageWorkerModel: run.workerModel } : {}),
  } };
  const pending = spawnQueueInstance(config, host(ready.promise));
  run = { ...run, config: { ...run.config, routing: { worker: { provider: 'claude' }, verifiers: [{ provider: 'cursor' }] } } };
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
