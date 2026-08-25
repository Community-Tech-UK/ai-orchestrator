import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalAiRoutingEvent, LocalAiTarget } from '../../shared/types/local-ai-guard.types';
import {
  compareLocalAiRevisionCursors,
  incrementLocalAiRevisionCursor,
  parseLocalAiRevisionCursor,
} from '../../shared/types/local-ai-guard.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { LocalAiActivityRegistry } from './local-ai-activity-registry';
import { LocalAiHealthScheduler } from './local-ai-health-scheduler';
import {
  _resetLocalAiGuardRuntimeForTesting,
  getLocalAiGuardRuntime,
  initializeLocalAiGuardRuntime,
  LocalAiGuardRuntime,
  notifyFallbackInto,
} from './local-ai-runtime';

function services(
  scheduler: Record<string, unknown>,
  incidents: Record<string, unknown>,
  targets: Record<string, unknown>,
) {
  return {
    scheduler,
    incidents,
    targets,
    health: {},
    probes: {},
    engine: {},
    recovery: {},
    activity: {},
  } as never;
}

function routingEvent(id: string, overrides: Partial<LocalAiRoutingEvent> = {}): LocalAiRoutingEvent {
  return {
    id,
    slot: 'compression',
    intendedRoute: 'local',
    actualRoute: 'frontier',
    policy: 'notify-and-allow',
    disposition: 'allowed',
    decisionReason: 'policy',
    inputTokens: 100,
    outputTokens: 50,
    createdAt: 1,
    ...overrides,
  };
}

function target(lifecycle: LocalAiTarget['lifecycle'] = 'enrolled'): LocalAiTarget {
  return {
    id: 'target-a',
    label: 'Target A',
    lifecycle,
    location: { type: 'worker', nodeId: 'node-a' },
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
    createdAt: 1,
    updatedAt: 1,
  };
}

function schedulerDouble(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    targetChanged: vi.fn(),
    workerConnected: vi.fn(),
    workerDisconnected: vi.fn(),
    ...overrides,
  };
}

function workerNode(id: string, status: WorkerNodeInfo['status']): WorkerNodeInfo {
  return {
    id,
    name: id,
    status,
    activeInstances: 0,
    capabilities: {
      platform: 'linux',
      arch: 'x64',
      cpuCores: 4,
      totalMemoryMB: 8_192,
      availableMemoryMB: 4_096,
      supportedClis: [],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 2,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
  };
}

function registrationWorkers(
  throwOnRegistration?: number,
  nodes: WorkerNodeInfo[] = [],
) {
  const listeners = new Map<string, Set<(node: WorkerNodeInfo) => void>>();
  let registrations = 0;
  return {
    on(event: string, listener: (node: WorkerNodeInfo) => void) {
      registrations += 1;
      const eventListeners = listeners.get(event) ?? new Set<(node: WorkerNodeInfo) => void>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      if (registrations === throwOnRegistration) {
        throw new Error(`registration ${registrations} failed`);
      }
    },
    removeListener(event: string, listener: (node: WorkerNodeInfo) => void) {
      listeners.get(event)?.delete(listener);
    },
    getAllNodes: () => nodes,
    listenerCount: () => [...listeners.values()].reduce((count, values) => count + values.size, 0),
  };
}

describe('Local AI Guard runtime', () => {
  beforeEach(() => {
    _resetLocalAiGuardRuntimeForTesting();
  });

  afterEach(() => {
    _resetLocalAiGuardRuntimeForTesting();
  });

  it('advances a server-authored revision before notifying status subscribers', () => {
    const runtime = new LocalAiGuardRuntime(services(
      schedulerDouble(),
      { dispose: vi.fn() },
      { subscribe: () => () => undefined },
    ));
    const observed = vi.fn(() => runtime.revision);
    runtime.subscribe(observed);

    expect(runtime.revision).toBe('0');
    runtime.notifyChanged();
    runtime.notifyChanged();

    expect(observed.mock.results.map(({ value }) => value)).toEqual(['1', '2']);
    expect(runtime.revision).toBe('2');

    runtime.dispose();
    runtime.notifyChanged();
    expect(runtime.revision).toBe('2');
    expect(observed).toHaveBeenCalledTimes(2);
  });

  it('continues advancing after the old numeric safe-integer boundary', () => {
    let committedSourceNotification: (() => void) | undefined;
    const scheduler = schedulerDouble({
      subscribe: vi.fn((listener: () => void) => {
        committedSourceNotification = listener;
        return () => undefined;
      }),
    });
    const runtime = new LocalAiGuardRuntime(services(
      scheduler,
      { dispose: vi.fn() },
      { subscribe: () => () => undefined },
    ));
    const listener = vi.fn();
    runtime.subscribe(listener);
    (runtime as unknown as { statusRevision: bigint }).statusRevision =
      BigInt(Number.MAX_SAFE_INTEGER);

    expect(() => committedSourceNotification?.()).not.toThrow();
    expect(runtime.revision).toBe('9007199254740992');
    expect(listener).toHaveBeenCalledOnce();

    runtime.dispose();
  });

  it('compares, parses, and increments canonical cursors without Number conversion', () => {
    expect(parseLocalAiRevisionCursor('9007199254740992')).toBe(9_007_199_254_740_992n);
    expect(incrementLocalAiRevisionCursor('9007199254740991')).toBe('9007199254740992');
    expect(compareLocalAiRevisionCursors('99', '100')).toBeLessThan(0);
    expect(compareLocalAiRevisionCursors('100', '99')).toBeGreaterThan(0);
    expect(compareLocalAiRevisionCursors('9007199254740992', '9007199254740992')).toBe(0);
  });

  it('starts once, exposes Task 1-7 services, and disposes scheduler and incident resources', () => {
    const scheduler = {
      start: vi.fn(),
      stop: vi.fn(),
      targetChanged: vi.fn(),
      workerConnected: vi.fn(),
      workerDisconnected: vi.fn(),
    };
    const incidents = { dispose: vi.fn() };
    const runtime = initializeLocalAiGuardRuntime({
      services: services(scheduler, incidents, { subscribe: () => () => undefined }),
      workers: new EventEmitter() as never,
      registerCleanup: () => () => undefined,
    });

    expect(runtime).toBe(getLocalAiGuardRuntime());
    expect(scheduler.start).toHaveBeenCalledOnce();
    expect(runtime).toMatchObject({
      scheduler,
      incidents,
    });

    runtime.dispose();
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(incidents.dispose).toHaveBeenCalledOnce();
  });

  it('subscribes to target lifecycle and worker roster/capability events and removes subscriptions on dispose', () => {
    const workers = new EventEmitter();
    const listeners = new Set<(value: LocalAiTarget) => void>();
    const scheduler = {
      start: vi.fn(),
      stop: vi.fn(),
      targetChanged: vi.fn(),
      workerConnected: vi.fn(),
      workerDisconnected: vi.fn(),
    };
    const runtime = initializeLocalAiGuardRuntime({
      services: services(scheduler, { dispose: vi.fn() }, {
        subscribe: (listener: (value: LocalAiTarget) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
      workers: workers as never,
      registerCleanup: () => () => undefined,
    });

    listeners.forEach((listener) => listener(target('paused')));
    workers.emit('node:connected', workerNode('node-a', 'connected'));
    workers.emit('node:local-models-changed', workerNode('node-a', 'connected'));
    workers.emit('node:updated', workerNode('node-a', 'connected'));
    workers.emit('node:updated', workerNode('node-a', 'degraded'));
    workers.emit('node:disconnected', workerNode('node-a', 'disconnected'));
    workers.emit('node:disconnected', workerNode('node-a', 'disconnected'));

    expect(scheduler.targetChanged).toHaveBeenCalledWith('target-a');
    expect(scheduler.workerConnected).toHaveBeenCalledTimes(2);
    expect(scheduler.workerDisconnected).toHaveBeenCalledOnce();
    expect(scheduler.workerDisconnected).toHaveBeenLastCalledWith('node-a');

    runtime.dispose();
    expect(listeners).toHaveLength(0);
    expect(workers.listenerCount('node:connected')).toBe(0);
    expect(workers.listenerCount('node:updated')).toBe(0);
    expect(workers.listenerCount('node:local-models-changed')).toBe(0);
    expect(workers.listenerCount('node:disconnected')).toBe(0);
  });

  it('treats registry terminal disconnects as authoritative and emits one outage per connection', () => {
    WorkerNodeRegistry._resetForTesting();
    const workers = WorkerNodeRegistry.getInstance();
    const value = target();
    const appended: { failureCode?: string }[] = [];
    const targets = {
      get: (id: string) => id === value.id ? value : undefined,
      list: () => [value],
      setLifecycle: vi.fn(),
      subscribe: () => () => undefined,
    };
    const scheduler = new LocalAiHealthScheduler({
      targets,
      health: {
        appendSample: (sample) => appended.push(sample),
        latestSamples: () => [],
        listIncidents: () => [],
        runRetention: () => ({
          samplesDeleted: 0,
          routingEventsDeleted: 0,
          daysAggregated: 0,
        }),
      },
      probes: {
        check: async () => new Promise<never>(() => undefined),
      },
      incidents: {
        handleTransition: () => undefined,
      },
      activity: new LocalAiActivityRegistry(),
    });
    initializeLocalAiGuardRuntime({
      services: services(scheduler as never, { dispose: vi.fn() }, targets),
      workers,
      registerCleanup: () => () => undefined,
    });
    const outageSamples = () => appended.filter(
      (sample) => sample.failureCode === 'worker-offline',
    );

    workers.registerNode(workerNode('node-a', 'connected'));
    workers.deregisterNode('node-a');
    expect(outageSamples()).toHaveLength(1);
    expect(scheduler.getStatus(value.id)).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
    });

    workers.registerNode(workerNode('node-a', 'connected'));
    workers.updateNodeMetrics('node-a', { status: 'degraded' });
    expect(outageSamples()).toHaveLength(2);
    workers.deregisterNode('node-a');
    expect(outageSamples()).toHaveLength(2);

    workers.registerNode(workerNode('node-a', 'connected'));
    workers.deregisterNode('node-a');
    expect(outageSamples()).toHaveLength(3);
  });

  it('establishes status-aware worker admission before scheduler startup', () => {
    const calls: string[] = [];
    const scheduler = schedulerDouble({
      start: vi.fn(() => calls.push('start')),
      workerConnected: vi.fn((nodeId: string) => calls.push(`connected:${nodeId}`)),
      workerDisconnected: vi.fn((nodeId: string) => calls.push(`disconnected:${nodeId}`)),
    });
    const workers = registrationWorkers(undefined, [
      workerNode('connecting-node', 'connecting'),
      workerNode('connected-node', 'connected'),
      workerNode('degraded-node', 'degraded'),
      workerNode('disconnected-node', 'disconnected'),
    ]);

    initializeLocalAiGuardRuntime({
      services: services(
        scheduler,
        { dispose: vi.fn() },
        { subscribe: () => () => undefined },
      ),
      workers: workers as never,
      registerCleanup: () => () => undefined,
    });

    expect(calls).toEqual([
      'disconnected:connecting-node',
      'connected:connected-node',
      'disconnected:degraded-node',
      'disconnected:disconnected-node',
      'start',
    ]);
  });

  it('registers cleanup once and cleanup stops runtime subscriptions', () => {
    let cleanup: (() => void) | undefined;
    const unregister = vi.fn();
    const scheduler = {
      start: vi.fn(),
      stop: vi.fn(),
      targetChanged: vi.fn(),
      workerConnected: vi.fn(),
      workerDisconnected: vi.fn(),
    };
    const runtime = initializeLocalAiGuardRuntime({
      services: services(scheduler, { dispose: vi.fn() }, { subscribe: () => () => undefined }),
      workers: new EventEmitter() as never,
      registerCleanup: (fn) => {
        cleanup = fn;
        return unregister;
      },
    });

    cleanup?.();
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(() => runtime.dispose()).not.toThrow();
  });

  it('releases the owned singleton on dispose and initializes a fresh live runtime', () => {
    const firstScheduler = schedulerDouble();
    const firstIncidents = { dispose: vi.fn() };
    const first = initializeLocalAiGuardRuntime({
      services: services(
        firstScheduler,
        firstIncidents,
        { subscribe: () => () => undefined },
      ),
      workers: registrationWorkers() as never,
      registerCleanup: () => vi.fn(),
    });

    first.dispose();
    first.dispose();

    const secondScheduler = schedulerDouble();
    const second = initializeLocalAiGuardRuntime({
      services: services(
        secondScheduler,
        { dispose: vi.fn() },
        { subscribe: () => () => undefined },
      ),
      workers: registrationWorkers() as never,
      registerCleanup: () => vi.fn(),
    });

    expect(second).not.toBe(first);
    expect(getLocalAiGuardRuntime()).toBe(second);
    expect(firstScheduler.stop).toHaveBeenCalledOnce();
    expect(firstIncidents.dispose).toHaveBeenCalledOnce();
    expect(secondScheduler.start).toHaveBeenCalledOnce();
  });

  it('disposes partial runtime state when scheduler startup fails', () => {
    const scheduler = {
      start: vi.fn(() => {
        throw new Error('startup failed');
      }),
      stop: vi.fn(),
      targetChanged: vi.fn(),
      workerConnected: vi.fn(),
      workerDisconnected: vi.fn(),
    };
    const incidents = { dispose: vi.fn() };
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);

    expect(() => initializeLocalAiGuardRuntime({
      services: services(scheduler, incidents, { subscribe: () => () => undefined }),
      workers: new EventEmitter() as never,
      registerCleanup: register,
    })).toThrow('startup failed');

    expect(register).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(incidents.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ['target subscription', 0],
    ['worker connected registration', 1],
    ['worker status registration', 2],
    ['worker capability registration', 3],
    ['worker disconnected registration', 4],
    ['cleanup registration', 5],
  ])('rolls back every acquired resource when %s fails', (_name, boundary) => {
    const scheduler = schedulerDouble();
    const incidents = { dispose: vi.fn() };
    const unsubscribe = vi.fn();
    const targets = {
      subscribe: () => {
        if (boundary === 0) throw new Error('target subscription failed');
        return unsubscribe;
      },
    };
    const workers = registrationWorkers(boundary >= 1 && boundary <= 4 ? boundary : undefined);
    const register = vi.fn(() => {
      if (boundary === 5) throw new Error('cleanup registration failed');
      return vi.fn();
    });

    expect(() => initializeLocalAiGuardRuntime({
      services: services(scheduler, incidents, targets),
      workers: workers as never,
      registerCleanup: register,
    })).toThrow();

    expect(workers.listenerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledTimes(boundary === 0 ? 0 : 1);
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(incidents.dispose).toHaveBeenCalledOnce();
  });

  it('isolates every teardown failure so later cleanup still runs', () => {
    const scheduler = schedulerDouble({
      stop: vi.fn(() => {
        throw new Error('scheduler stop failed');
      }),
    });
    const incidents = {
      dispose: vi.fn(() => {
        throw new Error('incident dispose failed');
      }),
    };
    const runtime = new LocalAiGuardRuntime(
      services(scheduler, incidents, { subscribe: () => () => undefined }),
    );
    const firstDisposer = vi.fn(() => {
      throw new Error('subscription cleanup failed');
    });
    const secondDisposer = vi.fn();
    runtime.addDisposer(firstDisposer);
    runtime.addDisposer(secondDisposer);
    const unregister = vi.fn(() => {
      throw new Error('cleanup unregister failed');
    });
    runtime.setCleanupRegistration(unregister);

    expect(() => runtime.dispose()).not.toThrow();

    expect(unregister).toHaveBeenCalledOnce();
    expect(firstDisposer).toHaveBeenCalledOnce();
    expect(secondDisposer).toHaveBeenCalledOnce();
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(incidents.dispose).toHaveBeenCalledOnce();
  });
});

describe('LT-189: notify-and-allow fallback notifications', () => {
  function bareRuntime(): LocalAiGuardRuntime {
    return new LocalAiGuardRuntime(
      services(schedulerDouble(), { dispose: vi.fn() }, { subscribe: () => () => undefined }),
    );
  }

  it('records a notify-and-allow event, most-recent first, and pulses a revision change', () => {
    const runtime = bareRuntime();
    const before = runtime.revision;

    runtime.recordFallbackNotification(routingEvent('event-1'));
    expect(runtime.fallbackNotifications).toEqual([routingEvent('event-1')]);
    expect(runtime.revision).not.toBe(before);

    runtime.recordFallbackNotification(routingEvent('event-2'));
    // Newest first, so the renderer banner shows the latest fallback.
    expect(runtime.fallbackNotifications.map((event) => event.id)).toEqual(['event-2', 'event-1']);
  });

  it('bounds the notification list instead of growing it unboundedly', () => {
    const runtime = bareRuntime();
    for (let i = 0; i < 60; i += 1) {
      runtime.recordFallbackNotification(routingEvent(`event-${i}`));
    }
    expect(runtime.fallbackNotifications).toHaveLength(50);
    // Most recent 50 survive; the oldest ten are dropped.
    expect(runtime.fallbackNotifications[0]?.id).toBe('event-59');
    expect(runtime.fallbackNotifications.at(-1)?.id).toBe('event-10');
  });

  it('does not record after disposal', () => {
    const runtime = bareRuntime();
    runtime.dispose();
    runtime.recordFallbackNotification(routingEvent('event-1'));
    expect(runtime.fallbackNotifications).toEqual([]);
  });

  it('refreshes a live notification from the durable event after cost attribution', () => {
    const original = routingEvent('event-1');
    const untouched = routingEvent('event-2');
    const enriched = routingEvent('event-1', {
      inputTokens: 640,
      outputTokens: 24,
      estimatedCostUsd: 0.0015,
    });
    const runtime = new LocalAiGuardRuntime({
      scheduler: schedulerDouble(),
      incidents: { dispose: vi.fn() },
      targets: { subscribe: () => () => undefined },
      health: { getRoutingEvent: vi.fn(() => enriched) },
      probes: {},
      engine: {},
      recovery: {},
      activity: {},
    } as never);
    runtime.recordFallbackNotification(untouched);
    runtime.recordFallbackNotification(original);

    runtime.refreshFallbackNotification('event-1');

    expect(runtime.fallbackNotifications).toEqual([enriched, untouched]);
  });

  it('leaves live notifications unchanged when the event or durable row is missing', () => {
    const original = routingEvent('event-1');
    const getRoutingEvent = vi.fn(() => undefined);
    const runtime = new LocalAiGuardRuntime({
      scheduler: schedulerDouble(),
      incidents: { dispose: vi.fn() },
      targets: { subscribe: () => () => undefined },
      health: { getRoutingEvent },
      probes: {},
      engine: {},
      recovery: {},
      activity: {},
    } as never);
    runtime.recordFallbackNotification(original);

    runtime.refreshFallbackNotification('missing-event');
    runtime.refreshFallbackNotification('event-1');

    expect(getRoutingEvent).toHaveBeenCalledExactlyOnceWith('event-1');
    expect(runtime.fallbackNotifications).toEqual([original]);
  });

  describe('notifyFallbackInto', () => {
    it('forwards a fired event to whichever runtime the getter currently returns', () => {
      const runtime = bareRuntime();
      const notify = notifyFallbackInto(() => runtime);

      notify(routingEvent('event-1'));

      expect(runtime.fallbackNotifications).toEqual([routingEvent('event-1')]);
    });

    it('tolerates a getter that has not yet resolved a runtime (deferred-closure construction order)', () => {
      let current: LocalAiGuardRuntime | undefined;
      const notify = notifyFallbackInto(() => current);

      expect(() => notify(routingEvent('event-1'))).not.toThrow();

      current = bareRuntime();
      notify(routingEvent('event-2'));
      expect(current.fallbackNotifications).toEqual([routingEvent('event-2')]);
    });
  });
});
