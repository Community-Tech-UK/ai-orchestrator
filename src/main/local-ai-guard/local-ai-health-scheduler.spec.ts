import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiHealthSample,
  LocalAiIncident,
  LocalAiProbeResult,
  LocalAiTarget,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiActivityRegistry,
} from './local-ai-activity-registry';
import {
  LocalAiHealthScheduler,
  type LocalAiHealthSchedulerDependencies,
} from './local-ai-health-scheduler';

const START = 1_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function target(
  id: string,
  patch: Partial<LocalAiTarget> = {},
): LocalAiTarget {
  return {
    id,
    label: id,
    lifecycle: 'enrolled',
    location: { type: 'coordinator' },
    provider: 'ollama',
    endpointId: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'local-model', required: true }],
    canary: { model: 'local-model', timeoutMs: 1_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 0, cooldownMs: 0 },
    createdAt: START,
    updatedAt: START,
    ...patch,
  };
}

function probe(
  value: LocalAiTarget,
  kind: 'lightweight' | 'functional',
  ok = true,
  at = Date.now(),
): LocalAiProbeResult[] {
  return [{
    targetId: value.id,
    layer: kind === 'functional' ? 'inference' : 'endpoint',
    checkType: kind,
    ok,
    required: true,
    affectedRoles: [...value.routingRoles],
    checkedAt: at,
    durationMs: 1,
    ...(ok ? {} : { failureCode: 'connection-refused' as const }),
    evidence: ok ? { endpointReachable: true } : { errorKind: 'connection-refused' },
  }];
}

interface Harness {
  scheduler: LocalAiHealthScheduler;
  activity: LocalAiActivityRegistry;
  checks: ReturnType<typeof vi.fn<LocalAiHealthSchedulerDependencies['probes']['check']>>;
  retention: ReturnType<typeof vi.fn<LocalAiHealthSchedulerDependencies['health']['runRetention']>>;
  appended: LocalAiHealthSample[];
  transitions: LocalAiTargetStatus[];
  statusEvents: LocalAiTargetStatus[];
  lifecycleChanges: ReturnType<typeof vi.fn>;
  replaceTarget(value: LocalAiTarget): void;
}

function harness(
  values: LocalAiTarget[],
  checkImplementation?: LocalAiHealthSchedulerDependencies['probes']['check'],
  options: {
    random?: () => number;
    latestSamples?: (targetId: string) => LocalAiHealthSample[];
    incidents?: LocalAiIncident[];
    retention?: LocalAiHealthSchedulerDependencies['health']['runRetention'];
  } = {},
): Harness {
  const byId = new Map(values.map((value) => [value.id, value]));
  const activity = new LocalAiActivityRegistry();
  const appended: LocalAiHealthSample[] = [];
  const transitions: LocalAiTargetStatus[] = [];
  const statusEvents: LocalAiTargetStatus[] = [];
  const checks = vi.fn(checkImplementation ?? (async (value, kind) => probe(value, kind)));
  const retention = vi.fn(options.retention ?? (() => ({
    samplesDeleted: 0,
    routingEventsDeleted: 0,
    daysAggregated: 0,
  })));
  const lifecycleChanges = vi.fn((
    targetId: string,
    lifecycle: 'enrolled' | 'paused' | 'retired',
    lifecycleOptions?: { pausedUntil?: number },
  ) => {
    const current = byId.get(targetId);
    if (!current) throw new Error('missing target');
    const updated = {
      ...current,
      lifecycle,
      updatedAt: Date.now(),
      ...(lifecycle === 'paused' && lifecycleOptions?.pausedUntil !== undefined
        ? { pausedUntil: lifecycleOptions.pausedUntil }
        : {}),
      ...(lifecycle === 'retired' ? { retiredAt: Date.now() } : {}),
    };
    if (lifecycle !== 'paused') delete updated.pausedUntil;
    if (lifecycle !== 'retired') delete updated.retiredAt;
    byId.set(targetId, updated);
    scheduler.targetChanged(targetId);
    return updated;
  });
  const scheduler = new LocalAiHealthScheduler({
    targets: {
      get: (id) => byId.get(id),
      list: () => [...byId.values()],
      setLifecycle: lifecycleChanges,
    },
    health: {
      appendSample: (sample) => appended.push(sample),
      latestSamples: options.latestSamples ?? (() => []),
      listIncidents: (query) => (options.incidents ?? []).filter((incident) =>
        (!query.targetId || incident.targetId === query.targetId)
        && (!query.state || incident.state === query.state)),
      runRetention: retention,
    },
    probes: { check: checks },
    incidents: {
      handleTransition: (transition) => {
        transitions.push(transition.current);
        return undefined;
      },
    },
    activity,
    now: () => Date.now(),
    random: options.random ?? (() => 0.5),
    timers: {
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    createId: randomUUID,
  });
  scheduler.subscribe((status) => statusEvents.push(status));
  return {
    scheduler,
    activity,
    checks,
    retention,
    appended,
    transitions,
    statusEvents,
    lifecycleChanges,
    replaceTarget: (value) => byId.set(value.id, value),
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('LocalAiActivityRegistry', () => {
  it('keeps a target busy until every independently acquired lease is released', () => {
    const registry = new LocalAiActivityRegistry();
    const releaseOne = registry.acquire('target-a');
    const releaseTwo = registry.acquire('target-a');

    releaseOne();
    releaseOne();
    expect(registry.isBusy('target-a')).toBe(true);

    releaseTwo();
    expect(registry.isBusy('target-a')).toBe(false);
  });
});

describe('LocalAiHealthScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules only enrolled targets and uses default lightweight and functional intervals', async () => {
    const enrolled = target('enrolled', {
      endpointCheckIntervalMs: undefined as unknown as number,
      canary: { model: 'local-model', timeoutMs: 1_000, intervalMs: undefined as unknown as number },
    });
    const paused = target('paused', { lifecycle: 'paused' });
    const unmanaged = target('unmanaged', { lifecycle: 'unmanaged', routingRoles: [] });
    const retired = target('retired', { lifecycle: 'retired', retiredAt: START });
    const { scheduler, checks } = harness([enrolled, paused, unmanaged, retired]);

    scheduler.start();
    await flush();
    expect(checks.mock.calls.map(([value, kind]) => [value.id, kind])).toEqual([
      ['enrolled', 'lightweight'],
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(checks.mock.calls.filter(([, kind]) => kind === 'lightweight')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(540_000);
    expect(checks.mock.calls.filter(([, kind]) => kind === 'functional')).toHaveLength(1);
    expect(checks.mock.calls.every(([value]) => value.id === 'enrolled')).toBe(true);
    scheduler.stop();
  });

  it('admits coordinator targets and only authoritatively connected worker targets', async () => {
    const coordinator = target('coordinator');
    const worker = (id: string) => target(id, {
      location: { type: 'worker', nodeId: `${id}-node` },
    });
    const connected = worker('connected');
    const blocked = [
      worker('absent'),
      worker('connecting'),
      worker('degraded'),
      worker('disconnected'),
    ];
    const { scheduler, checks } = harness([coordinator, connected, ...blocked]);

    scheduler.workerConnected('connected-node');
    expect(checks).not.toHaveBeenCalled();

    scheduler.start();
    await flush();
    expect(checks.mock.calls.map(([value]) => value.id).sort()).toEqual([
      'connected',
      'coordinator',
    ]);
    checks.mockClear();

    for (const value of blocked) {
      await expect(scheduler.recheck(value.id, 'lightweight')).rejects.toThrow();
      await expect(scheduler.ensureFresh(value.id, 'compression')).rejects.toThrow();
    }
    await expect(scheduler.recheck(coordinator.id, 'lightweight')).resolves.toMatchObject({
      targetId: coordinator.id,
    });
    await expect(scheduler.recheck(connected.id, 'lightweight')).resolves.toMatchObject({
      targetId: connected.id,
    });
    expect(checks.mock.calls.map(([value]) => value.id).sort()).toEqual([
      'connected',
      'coordinator',
    ]);
    scheduler.stop();
  });

  it('uses target interval overrides and cancels polling when a target is paused or retired', async () => {
    const value = target('target-a', {
      endpointCheckIntervalMs: 2_000,
      canary: { model: 'local-model', timeoutMs: 1_000, intervalMs: 3_000 },
    });
    const { scheduler, checks } = harness([value]);
    scheduler.start();
    await flush();
    checks.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(checks).toHaveBeenCalledWith(value, 'lightweight');

    value.lifecycle = 'paused';
    scheduler.targetChanged(value.id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checks).toHaveBeenCalledTimes(1);

    value.lifecycle = 'enrolled';
    scheduler.targetChanged(value.id);
    await flush();
    expect(checks).toHaveBeenCalledTimes(2);

    value.lifecycle = 'retired';
    scheduler.targetChanged(value.id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checks).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('keeps a timed pause excluded until its deadline, then resumes and checks without renderer involvement', async () => {
    const value = target('target-a', {
      lifecycle: 'paused',
      pausedUntil: START + 5_000,
      updatedAt: START - 1_000,
    });
    const { scheduler, checks, lifecycleChanges, statusEvents } = harness([value]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(checks).not.toHaveBeenCalled();
    expect(lifecycleChanges).not.toHaveBeenCalled();
    expect(scheduler.getStatus(value.id)).toMatchObject({
      lifecycle: 'paused',
      state: 'paused',
      routableRoles: [],
    });

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(lifecycleChanges).toHaveBeenCalledOnce();
    expect(lifecycleChanges).toHaveBeenCalledWith(value.id, 'enrolled');
    expect(checks).toHaveBeenCalledOnce();
    expect(statusEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        targetId: value.id,
        lifecycle: 'enrolled',
        state: 'checking',
        routableRoles: [],
      }),
      expect.objectContaining({
        targetId: value.id,
        lifecycle: 'enrolled',
        state: 'healthy',
        routableRoles: ['compression'],
      }),
    ]));
    scheduler.stop();
  });

  it('restores a timed pause after restart and resumes an already expired deadline once', async () => {
    const value = target('target-a', {
      lifecycle: 'paused',
      pausedUntil: START - 1,
      updatedAt: START - 10,
    });
    const { scheduler, checks, lifecycleChanges } = harness([value]);

    scheduler.start();
    scheduler.targetChanged(value.id);
    await flush();
    await vi.advanceTimersByTimeAsync(1);

    expect(lifecycleChanges).toHaveBeenCalledOnce();
    expect(checks).toHaveBeenCalledOnce();
    expect(scheduler.getStatus(value.id)).toMatchObject({
      lifecycle: 'enrolled',
      state: 'healthy',
    });
    scheduler.stop();
  });

  it('leaves an indefinite pause suspended across arbitrary time', async () => {
    const value = target('target-a', {
      lifecycle: 'paused',
      updatedAt: START,
    });
    const { scheduler, checks, lifecycleChanges } = harness([value]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(DAY_MS * 30);

    expect(lifecycleChanges).not.toHaveBeenCalled();
    expect(checks).not.toHaveBeenCalled();
    expect(scheduler.getStatus(value.id)).toMatchObject({
      lifecycle: 'paused',
      state: 'paused',
    });
    scheduler.stop();
  });

  it.each(['enrolled', 'retired'] as const)(
    'gives a manual %s transition precedence over a pending timed-pause expiry',
    async (lifecycle) => {
      const value = target('target-a', {
        lifecycle: 'paused',
        pausedUntil: START + 5_000,
        updatedAt: START,
      });
      const harnessValue = harness([value]);
      harnessValue.scheduler.start();

      harnessValue.replaceTarget(target(value.id, {
        lifecycle,
        updatedAt: START + 1_000,
        ...(lifecycle === 'retired' ? { retiredAt: START + 1_000 } : {}),
      }));
      harnessValue.scheduler.targetChanged(value.id);
      harnessValue.lifecycleChanges.mockClear();
      harnessValue.checks.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(harnessValue.lifecycleChanges).not.toHaveBeenCalled();
      if (lifecycle === 'enrolled') {
        expect(harnessValue.checks).toHaveBeenCalled();
      } else {
        expect(harnessValue.checks).not.toHaveBeenCalled();
      }
      harnessValue.scheduler.stop();
    },
  );

  it('uses both lightweight and functional target interval overrides', async () => {
    const value = target('target-a', {
      endpointCheckIntervalMs: 2_000,
      canary: { model: 'local-model', timeoutMs: 1_000, intervalMs: 3_000 },
    });
    const { scheduler, checks } = harness([value]);
    scheduler.start();
    await flush();
    checks.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(checks.mock.calls.map(([, kind]) => kind)).toEqual(['lightweight']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checks.mock.calls.map(([, kind]) => kind)).toEqual(['lightweight', 'functional']);
    scheduler.stop();
  });

  it.each([
    ['paused', { lifecycle: 'paused' as const, pausedUntil: START }],
    ['retired', { lifecycle: 'retired' as const, retiredAt: START }],
    ['unmanaged', { lifecycle: 'unmanaged' as const, routingRoles: [] }],
  ])('rejects manual checks for a %s target without probing', async (_name, patch) => {
    const value = target('target-a', patch);
    const { scheduler, checks } = harness([value]);

    await expect(scheduler.recheck(value.id, 'lightweight')).rejects.toThrow();

    expect(checks).not.toHaveBeenCalled();
  });

  it('rejects manual checks for a disconnected worker without probing', async () => {
    const value = target('target-a', {
      location: { type: 'worker', nodeId: 'node-a' },
    });
    const { scheduler, checks } = harness([value]);
    scheduler.workerDisconnected('node-a');
    checks.mockClear();

    await expect(scheduler.recheck(value.id, 'lightweight')).rejects.toThrow();

    expect(checks).not.toHaveBeenCalled();
  });

  it('discards an in-flight result when an immutable lifecycle update pauses the target', async () => {
    const value = target('target-a');
    let resolveCheck!: (samples: LocalAiProbeResult[]) => void;
    const pending = new Promise<LocalAiProbeResult[]>((resolve) => {
      resolveCheck = resolve;
    });
    const harnessValue = harness([value], async () => pending);
    harnessValue.scheduler.start();
    await flush();

    harnessValue.replaceTarget({
      ...value,
      lifecycle: 'paused',
      pausedUntil: START + 1,
      updatedAt: START + 1,
    });
    harnessValue.scheduler.targetChanged(value.id);
    resolveCheck(probe(value, 'lightweight', true, START + 2));
    await flush();

    expect(harnessValue.appended).toHaveLength(0);
    expect(harnessValue.scheduler.getStatus(value.id)).toMatchObject({
      state: 'paused',
      routableRoles: [],
    });
    harnessValue.scheduler.stop();
  });

  it('runs the required resume recheck immediately after an older in-flight probe settles', async () => {
    const value = target('target-a');
    let resolveCheck!: (samples: LocalAiProbeResult[]) => void;
    const pending = new Promise<LocalAiProbeResult[]>((resolve) => {
      resolveCheck = resolve;
    });
    const harnessValue = harness([value], async (current, kind) => {
      await pending;
      return probe(current, kind, true, Date.now());
    });
    harnessValue.scheduler.start();
    await flush();

    harnessValue.replaceTarget({
      ...value,
      lifecycle: 'paused',
      pausedUntil: START + 1,
      updatedAt: START + 1,
    });
    harnessValue.scheduler.targetChanged(value.id);
    harnessValue.replaceTarget({
      ...value,
      updatedAt: START + 2,
    });
    harnessValue.scheduler.targetChanged(value.id);
    await flush();
    resolveCheck([]);
    await flush();

    expect(harnessValue.checks).toHaveBeenCalledTimes(2);
    expect(harnessValue.scheduler.getStatus(value.id)?.routableRoles).toEqual(['compression']);
    harnessValue.scheduler.stop();
  });

  it('defers functional checks while busy and runs them after the target becomes quiet', async () => {
    const value = target('target-a', {
      canary: { model: 'local-model', timeoutMs: 1_000, intervalMs: 1_000 },
      endpointCheckIntervalMs: 60_000,
    });
    const { scheduler, activity, checks } = harness([value]);
    scheduler.start();
    await flush();
    checks.mockClear();
    const release = activity.acquire(value.id);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(checks).not.toHaveBeenCalled();

    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checks).toHaveBeenCalledOnce();
    expect(checks).toHaveBeenCalledWith(value, 'functional');
    scheduler.stop();
  });

  it('defers a manual functional check while busy and resolves it after the quiet retry', async () => {
    const value = target('target-a');
    const { scheduler, activity, checks } = harness([value]);
    scheduler.start();
    await flush();
    checks.mockClear();
    const release = activity.acquire(value.id);

    const pending = scheduler.recheck(value.id, 'functional');
    await flush();
    expect(checks).not.toHaveBeenCalled();

    release();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toMatchObject({ targetId: value.id });
    expect(checks).toHaveBeenCalledOnce();
    expect(checks).toHaveBeenCalledWith(value, 'functional');
    scheduler.stop();
  });

  it('rejects an outstanding busy manual functional wait when stopped', async () => {
    const value = target('target-a');
    const { scheduler, activity, checks } = harness([value]);
    scheduler.start();
    await flush();
    checks.mockClear();
    const release = activity.acquire(value.id);

    const pending = scheduler.recheck(value.id, 'functional');
    const rejected = expect(pending).rejects.toThrow('scheduler stopped');
    scheduler.stop();

    await rejected;
    expect(checks).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    release();
  });

  it('shares the per-target per-kind promise for concurrent manual and scheduled rechecks', async () => {
    const value = target('target-a');
    let resolveCheck!: (samples: LocalAiProbeResult[]) => void;
    const pending = new Promise<LocalAiProbeResult[]>((resolve) => {
      resolveCheck = resolve;
    });
    const { scheduler, checks } = harness([value], async () => pending);

    const first = scheduler.recheck(value.id, 'lightweight');
    const second = scheduler.recheck(value.id, 'lightweight');
    expect(first).toBe(second);
    expect(checks).toHaveBeenCalledOnce();

    resolveCheck(probe(value, 'lightweight', true, START));
    await expect(first).resolves.toMatchObject({ targetId: value.id });
  });

  it('shares an actual scheduled lightweight probe with a manual recheck at the timer boundary', async () => {
    const value = target('target-a', { endpointCheckIntervalMs: 1_000 });
    let resolveScheduled!: (samples: LocalAiProbeResult[]) => void;
    let attempts = 0;
    const { scheduler, checks } = harness([value], async (current, kind) => {
      attempts += 1;
      if (attempts === 1) return probe(current, kind, true, Date.now());
      return new Promise<LocalAiProbeResult[]>((resolve) => {
        resolveScheduled = resolve;
      });
    });
    scheduler.start();
    await flush();
    checks.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    const manual = scheduler.recheck(value.id, 'lightweight');
    expect(checks).toHaveBeenCalledOnce();

    resolveScheduled(probe(value, 'lightweight', true, Date.now()));
    await expect(manual).resolves.toMatchObject({ targetId: value.id });
    expect(checks).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it('manual rechecks bypass outage backoff while automated failures use jittered exponential backoff capped at 15 minutes', async () => {
    const value = target('target-a', { endpointCheckIntervalMs: 60_000 });
    const { scheduler, checks } = harness(
      [value],
      async (current, kind) => probe(current, kind, false, Date.now()),
    );
    scheduler.start();
    await flush();
    expect(checks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(checks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks).toHaveBeenCalledTimes(2);

    await scheduler.recheck(value.id, 'lightweight');
    expect(checks).toHaveBeenCalledTimes(3);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await scheduler.recheck(value.id, 'lightweight');
    }
    checks.mockClear();
    await vi.advanceTimersByTimeAsync(899_999);
    expect(checks.mock.calls.filter(([, kind]) => kind === 'lightweight')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks.mock.calls.filter(([, kind]) => kind === 'lightweight')).toHaveLength(1);
    scheduler.stop();
  });

  it('jitters outage backoff through the injected random port', async () => {
    const value = target('target-a', { endpointCheckIntervalMs: 60_000 });
    const { scheduler, checks } = harness(
      [value],
      async (current, kind) => probe(current, kind, false, Date.now()),
      { random: () => 0 },
    );
    scheduler.start();
    await flush();
    checks.mockClear();

    await vi.advanceTimersByTimeAsync(89_999);
    expect(checks.mock.calls.filter(([, kind]) => kind === 'lightweight')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks.mock.calls.filter(([, kind]) => kind === 'lightweight')).toHaveLength(1);
    scheduler.stop();
  });

  it('rechecks a stale role immediately after reconnect and ensureFresh returns the shared fresh verdict', async () => {
    const value = target('worker-target', {
      location: { type: 'worker', nodeId: 'node-a' },
      freshnessLimitMs: 100,
    });
    const { scheduler, checks } = harness([value]);
    scheduler.start();
    await flush();
    checks.mockClear();
    await vi.advanceTimersByTimeAsync(101);

    scheduler.workerConnected('node-a');
    const status = await scheduler.ensureFresh(value.id, 'compression');

    expect(checks).toHaveBeenCalledOnce();
    expect(status.targetId).toBe(value.id);
    expect(status.checkedAt).toBe(Date.now());
    scheduler.stop();
  });

  it('waits for one current-revision replacement when reconnect invalidates an active probe', async () => {
    const value = target('worker-target', {
      location: { type: 'worker', nodeId: 'node-a' },
    });
    const resolvers: ((samples: LocalAiProbeResult[]) => void)[] = [];
    const { scheduler, checks } = harness([value], async () =>
      new Promise<LocalAiProbeResult[]>((resolve) => resolvers.push(resolve)));
    scheduler.workerConnected('node-a');
    scheduler.start();
    await flush();
    expect(checks).toHaveBeenCalledOnce();

    scheduler.workerDisconnected('node-a');
    scheduler.workerConnected('node-a');
    const freshness = scheduler.ensureFresh(value.id, 'compression');
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    void freshness.then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      },
    );
    await flush();
    expect(outcome).toBe('pending');
    expect(checks).toHaveBeenCalledOnce();

    resolvers[0](probe(value, 'lightweight', true, START));
    await flush();
    expect(outcome).toBe('pending');
    expect(checks).toHaveBeenCalledTimes(2);

    resolvers[1](probe(value, 'lightweight', true, START + 1));
    await expect(freshness).resolves.toMatchObject({
      targetId: value.id,
      state: 'unavailable',
      checkedAt: START + 1,
    });
    expect(checks).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('rejects a queued current-revision replacement when stopped', async () => {
    const value = target('worker-target', {
      location: { type: 'worker', nodeId: 'node-a' },
    });
    const { scheduler, checks } = harness(
      [value],
      async () => new Promise<LocalAiProbeResult[]>(() => undefined),
    );
    scheduler.workerConnected('node-a');
    scheduler.start();
    await flush();
    scheduler.workerDisconnected('node-a');
    scheduler.workerConnected('node-a');

    const freshness = scheduler.ensureFresh(value.id, 'compression');
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    void freshness.then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      },
    );
    scheduler.stop();
    await flush();

    expect(outcome).toBe('rejected');
    expect(checks).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a queued current-revision replacement on a lifecycle change', async () => {
    const value = target('worker-target', {
      location: { type: 'worker', nodeId: 'node-a' },
    });
    const harnessValue = harness(
      [value],
      async () => new Promise<LocalAiProbeResult[]>(() => undefined),
    );
    harnessValue.scheduler.workerConnected('node-a');
    harnessValue.scheduler.start();
    await flush();
    harnessValue.scheduler.workerDisconnected('node-a');
    harnessValue.scheduler.workerConnected('node-a');

    const freshness = harnessValue.scheduler.ensureFresh(value.id, 'compression');
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    void freshness.then(
      () => {
        outcome = 'resolved';
      },
      () => {
        outcome = 'rejected';
      },
    );
    harnessValue.replaceTarget({
      ...value,
      lifecycle: 'paused',
      pausedUntil: START + 1,
      updatedAt: START + 1,
    });
    harnessValue.scheduler.targetChanged(value.id);
    await flush();

    expect(outcome).toBe('rejected');
    expect(harnessValue.checks).toHaveBeenCalledOnce();
    expect(harnessValue.scheduler.getStatus(value.id)).toMatchObject({
      state: 'paused',
      routableRoles: [],
    });
    harnessValue.scheduler.stop();
  });

  it('uses the 120-second production freshness default and rechecks beyond its boundary', async () => {
    const value = target('target-a', {
      freshnessLimitMs: undefined as unknown as number,
    });
    const { scheduler, checks } = harness([value]);
    await scheduler.recheck(value.id, 'lightweight');
    checks.mockClear();

    await vi.advanceTimersByTimeAsync(120_000);
    await scheduler.ensureFresh(value.id, 'compression');
    expect(checks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await scheduler.ensureFresh(value.id, 'compression');
    expect(checks).toHaveBeenCalledOnce();
  });

  it('honors a target freshness override at and beyond its exact boundary', async () => {
    const value = target('target-a', { freshnessLimitMs: 100 });
    const { scheduler, checks } = harness([value]);
    await scheduler.recheck(value.id, 'lightweight');
    checks.mockClear();

    await vi.advanceTimersByTimeAsync(100);
    await scheduler.ensureFresh(value.id, 'compression');
    expect(checks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await scheduler.ensureFresh(value.id, 'compression');
    expect(checks).toHaveBeenCalledOnce();
  });

  it('discards an in-flight worker result after disconnect and keeps the target non-routable', async () => {
    const value = target('worker-target', {
      location: { type: 'worker', nodeId: 'node-a' },
    });
    let resolveCheck!: (samples: LocalAiProbeResult[]) => void;
    const pending = new Promise<LocalAiProbeResult[]>((resolve) => {
      resolveCheck = resolve;
    });
    const { scheduler, appended } = harness([value], async () => pending);
    scheduler.workerConnected('node-a');
    scheduler.start();
    await flush();

    scheduler.workerDisconnected('node-a');
    resolveCheck(probe(value, 'lightweight', true, START + 1));
    await flush();

    expect(appended).toEqual([
      expect.objectContaining({
        failureCode: 'worker-offline',
        ok: false,
      }),
    ]);
    expect(scheduler.getStatus(value.id)).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
    });
    scheduler.stop();
  });

  it('does not emit outage evidence for initial or duplicate non-connected worker states', () => {
    const values = ['connecting', 'degraded', 'disconnected'].map((state) =>
      target(state, { location: { type: 'worker', nodeId: `${state}-node` } }));
    const { scheduler, appended, transitions } = harness(values);

    for (const state of ['connecting', 'degraded', 'disconnected']) {
      scheduler.workerDisconnected(`${state}-node`);
      scheduler.workerDisconnected(`${state}-node`);
    }
    expect(appended).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it('emits one outage transition per connected to non-connected change', () => {
    const value = target('worker-target', {
      location: { type: 'worker', nodeId: 'node-a' },
    });
    const { scheduler, appended, transitions } = harness([value]);
    scheduler.workerConnected('node-a');
    scheduler.workerDisconnected('node-a');
    scheduler.workerDisconnected('node-a');

    expect(appended).toHaveLength(1);
    expect(appended).toEqual([
      expect.objectContaining({
        targetId: value.id,
        layer: 'worker',
        checkType: 'lightweight',
        ok: false,
        required: true,
        failureCode: 'worker-offline',
        evidence: {},
        origin: 'scheduler',
      }),
    ]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      targetId: value.id,
      state: 'unavailable',
      routableRoles: [],
      incidentOpen: true,
    });

    scheduler.workerConnected('node-a');
    scheduler.workerDisconnected('node-a');
    scheduler.workerDisconnected('node-a');
    expect(appended).toHaveLength(2);
    expect(transitions).toHaveLength(2);
  });

  it('starts reconstructed targets in a non-routable state until a current probe completes', async () => {
    const value = target('target-a');
    let resolveCheck!: (samples: LocalAiProbeResult[]) => void;
    const pending = new Promise<LocalAiProbeResult[]>((resolve) => {
      resolveCheck = resolve;
    });
    const { scheduler } = harness([value], async () => pending);

    scheduler.start();
    const before = scheduler.getStatus(value.id);
    expect(before).toMatchObject({ state: 'checking', routableRoles: [] });

    resolveCheck(probe(value, 'lightweight', true, START));
    await flush();
    expect(scheduler.getStatus(value.id)?.routableRoles).toEqual(['compression']);
    scheduler.stop();
  });

  it('reconstructs persisted samples and incidents without treating stale persisted health as healthy', async () => {
    const value = target('target-a');
    const persisted = {
      ...probe(value, 'lightweight', true, START - 1)[0],
      id: 'persisted-sample',
      origin: 'scheduler' as const,
    };
    const incident: LocalAiIncident = {
      id: 'incident-a',
      targetId: value.id,
      state: 'open',
      severity: 'critical',
      failureCode: 'worker-offline',
      affectedLayers: ['worker'],
      affectedRoles: ['compression'],
      openedAt: START - 10,
      updatedAt: START - 1,
      fallbackCount: 0,
      knownCostUsd: 0,
      estimatedCostUsd: 0,
      unpricedDispatchCount: 0,
    };
    const { scheduler } = harness(
      [value],
      async () => new Promise<LocalAiProbeResult[]>(() => undefined),
      {
        latestSamples: () => [persisted],
        incidents: [incident],
      },
    );

    scheduler.start();

    expect(scheduler.getStatus(value.id)).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
      incidentOpen: true,
    });
    scheduler.stop();
  });

  it('rechecks even a recent persisted incident before returning it from ensureFresh', async () => {
    const value = target('target-a');
    const incident: LocalAiIncident = {
      id: 'incident-a',
      targetId: value.id,
      state: 'open',
      severity: 'critical',
      failureCode: 'worker-offline',
      affectedLayers: ['worker'],
      affectedRoles: ['compression'],
      openedAt: START - 10,
      updatedAt: START,
      fallbackCount: 0,
      knownCostUsd: 0,
      estimatedCostUsd: 0,
      unpricedDispatchCount: 0,
    };
    const { scheduler, checks } = harness([value], undefined, { incidents: [incident] });
    scheduler.start();

    await scheduler.ensureFresh(value.id, 'compression');

    expect(checks).toHaveBeenCalledOnce();
    scheduler.stop();
  });

  it('cancels every timer on shutdown and runs retention exactly once per day', async () => {
    const { scheduler, checks, retention } = harness([target('target-a')]);
    scheduler.start();
    await flush();
    expect(retention).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(retention).toHaveBeenCalledTimes(2);

    scheduler.stop();
    checks.mockClear();
    await vi.advanceTimersByTimeAsync(DAY_MS * 2);
    expect(retention).toHaveBeenCalledTimes(2);
    expect(checks).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reschedules daily retention after a fail-soft retention error', async () => {
    let attempts = 0;
    const { scheduler, retention } = harness([target('target-a')], undefined, {
      retention: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('retention failed');
        return { samplesDeleted: 0, routingEventsDeleted: 0, daysAggregated: 0 };
      },
    });
    scheduler.start();
    await flush();
    expect(retention).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(retention).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('discards an in-flight probe when shutdown begins', async () => {
    const value = target('target-a');
    let resolveCheck!: (samples: LocalAiProbeResult[]) => void;
    const pending = new Promise<LocalAiProbeResult[]>((resolve) => {
      resolveCheck = resolve;
    });
    const { scheduler, appended } = harness([value], async () => pending);
    scheduler.start();
    await flush();

    scheduler.stop();
    resolveCheck(probe(value, 'lightweight', true, START + 1));
    await flush();

    expect(appended).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains timer callback and probe failures without unhandled rejections and keeps scheduling', async () => {
    const value = target('target-a', { endpointCheckIntervalMs: 1_000 });
    const { scheduler, checks, transitions, appended } = harness(
      [value],
      async () => {
        throw new Error('sensitive endpoint details');
      },
    );
    scheduler.start();
    await flush();

    expect(checks).toHaveBeenCalledOnce();
    expect(transitions.at(-1)).toMatchObject({ targetId: value.id, routableRoles: [] });
    expect(appended.at(-1)).toMatchObject({
      failureCode: 'monitor-error',
      evidence: {},
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(checks).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('preserves allow-listed model drift evidence while dropping raw probe messages', async () => {
    const value = target('target-a');
    const { scheduler, appended } = harness([value], async () => [{
      targetId: value.id,
      layer: 'model',
      checkType: 'lightweight',
      ok: false,
      required: true,
      affectedRoles: ['compression'],
      checkedAt: START,
      durationMs: 4,
      failureCode: 'configuration-drift',
      message: 'private raw backend detail',
      evidence: {
        advertisedModels: ['qwen3:8b'],
        missingModels: ['qwen3:14b'],
        requiredModelCount: 2,
      },
    }]);
    await scheduler.recheck(value.id, 'lightweight');
    expect(appended[0]?.evidence).toEqual({
      advertisedModels: ['qwen3:8b'],
      missingModels: ['qwen3:14b'],
      requiredModelCount: 2,
    });
    expect(appended[0]).not.toHaveProperty('message');
  });
});
