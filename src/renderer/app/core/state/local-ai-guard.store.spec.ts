import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiDiscoveredEndpoint,
  LocalAiEffectivenessSummary,
  LocalAiFallbackRequest,
  LocalAiGuardSnapshot,
  LocalAiIncident,
  LocalAiProbeResult,
  LocalAiTarget,
  LocalAiTargetConfig,
  LocalAiTargetStatus,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardIpcService } from '../services/ipc/local-ai-guard-ipc.service';
import { LocalAiGuardStore } from './local-ai-guard.store';

function fallback(
  id: string,
  createdAt: number,
  overrides: Partial<LocalAiFallbackRequest> = {},
): LocalAiFallbackRequest {
  return {
    id,
    routingEventId: `event-${id}`,
    slot: 'compression',
    status: 'pending',
    estimatedInputTokens: 1_200,
    estimatedCostUsd: 0.018,
    createdAt,
    expiresAt: createdAt + 60_000,
    ...overrides,
  };
}

function incident(
  id: string,
  state: LocalAiIncident['state'],
): LocalAiIncident {
  return {
    id,
    targetId: 'target-1',
    state,
    severity: 'warning',
    failureCode: 'endpoint-timeout',
    affectedLayers: ['endpoint'],
    affectedRoles: ['compression'],
    openedAt: 1_000,
    updatedAt: 2_000,
    fallbackCount: 0,
    knownCostUsd: 0,
    estimatedCostUsd: 0,
  };
}

function snapshot(
  overrides: Partial<LocalAiGuardSnapshot> = {},
): LocalAiGuardSnapshot {
  return {
    revision: '0',
    aggregate: {
      state: 'not-configured',
      enrolled: 0,
      healthy: 0,
      degraded: 0,
      unavailable: 0,
      paused: 0,
    },
    targets: [],
    incidents: [],
    pendingFallbacks: [],
    ...overrides,
    targetConfigs: overrides.targetConfigs ?? [],
    recoveryAttempts: overrides.recoveryAttempts ?? [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

describe('LocalAiGuardStore', () => {
  let delta: ((value: LocalAiGuardSnapshot) => void) | undefined;
  const unsubscribe = vi.fn();
  const ipc = {
    getSnapshot: vi.fn(),
    onStatusDelta: vi.fn((listener: (value: LocalAiGuardSnapshot) => void) => {
      delta = listener;
      return unsubscribe;
    }),
    resolveFallback: vi.fn(),
    discover: vi.fn(),
    validate: vi.fn(),
    createTarget: vi.fn(),
    updateTarget: vi.fn(),
    setTargetLifecycle: vi.fn(),
    recheck: vi.fn(),
    acknowledgeIncident: vi.fn(),
    diagnose: vi.fn(),
    repair: vi.fn(),
    getSummary: vi.fn(),
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    delta = undefined;
    ipc.getSnapshot.mockResolvedValue({ success: true, data: snapshot() });
    ipc.resolveFallback.mockResolvedValue({
      success: true,
      data: fallback('request-1', 1_000, {
        status: 'allowed',
        resolution: 'allow-once',
        resolvedAt: 2_000,
      }),
    });
    ipc.discover.mockResolvedValue({ success: true, data: [discoveredEndpoint()] });
    ipc.validate.mockResolvedValue({ success: true, data: validationResults() });
    ipc.createTarget.mockResolvedValue({ success: true, data: target() });
    ipc.updateTarget.mockResolvedValue({ success: true, data: target() });
    ipc.setTargetLifecycle.mockResolvedValue({ success: true, data: target() });
    ipc.recheck.mockResolvedValue({
      success: true,
      data: {
        targetId: 'target-1', state: 'healthy', routableRoles: ['compression'],
        layers: {}, consecutiveFailures: 0, consecutiveSuccesses: 2,
        flapping: false, checkedAt: 2_000,
      },
    });
    ipc.acknowledgeIncident.mockResolvedValue({
      success: true,
      data: incident('incident-1', 'acknowledged'),
    });
    ipc.diagnose.mockResolvedValue({
      success: true,
      data: {
        targetId: 'target-1',
        checkedAt: 2_000,
        samples: validationResults(),
        recommendedActions: ['deep-check'],
      },
    });
    ipc.repair.mockResolvedValue({
      success: true,
      data: {
        targetId: 'target-1',
        action: 'deep-check',
        outcome: 'guided',
        supported: true,
        attempted: false,
        recovered: false,
        message: 'Run the complete health check.',
        completedAt: 3_000,
      },
    });
    ipc.getSummary.mockResolvedValue({
      success: true,
      data: effectivenessSummary(),
    });
    TestBed.configureTestingModule({
      providers: [
        LocalAiGuardStore,
        { provide: LocalAiGuardIpcService, useValue: ipc },
      ],
    });
  });

  it('loads a snapshot before subscribing, initializes once, and reconciles the gap', async () => {
    const order: string[] = [];
    ipc.getSnapshot.mockImplementation(async () => {
      order.push('snapshot');
      return { success: true, data: snapshot() };
    });
    ipc.onStatusDelta.mockImplementation((listener) => {
      order.push('subscribe');
      delta = listener;
      return unsubscribe;
    });
    const store = TestBed.inject(LocalAiGuardStore);

    await Promise.all([store.initialize(), store.initialize()]);

    expect(order).toEqual(['snapshot', 'subscribe', 'snapshot']);
    expect(store.isInitialized()).toBe(true);
    expect(ipc.onStatusDelta).toHaveBeenCalledOnce();
  });

  it('replaces the editable target cache from every authoritative snapshot', async () => {
    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({ revision: '1', targetConfigs: [target()] }),
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    expect(store.knownTarget('target-1')).toEqual(target());

    delta?.(snapshot({ revision: '2', targetConfigs: [] }));
    expect(store.knownTarget('target-1')).toBeNull();
  });

  it('keeps a newer delta delivered during post-subscription reconciliation', async () => {
    const reconciliation = deferred<{
      success: true;
      data: LocalAiGuardSnapshot;
    }>();
    ipc.getSnapshot
      .mockResolvedValueOnce({ success: true, data: snapshot() })
      .mockReturnValueOnce(reconciliation.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    const initializing = store.initialize();
    await vi.waitFor(() => expect(delta).toBeTypeOf('function'));

    const newest = snapshot({
      revision: '3',
      aggregate: {
        state: 'unavailable',
        enrolled: 1,
        healthy: 0,
        degraded: 0,
        unavailable: 1,
        paused: 0,
      },
      pendingFallbacks: [fallback('newest', 3_000)],
    });
    delta?.(newest);
    reconciliation.resolve({ success: true, data: snapshot({ revision: '2' }) });
    await initializing;

    expect(store.snapshot()).toEqual(newest);
  });

  it('keeps a newer reconciliation snapshot over an older buffered delta', async () => {
    const reconciliation = deferred<{
      success: true;
      data: LocalAiGuardSnapshot;
    }>();
    ipc.getSnapshot
      .mockResolvedValueOnce({
        success: true,
        data: snapshot({
          revision: '1',
          aggregate: {
            state: 'checking',
            enrolled: 1,
            healthy: 0,
            degraded: 0,
            unavailable: 0,
            paused: 0,
          },
        }),
      })
      .mockReturnValueOnce(reconciliation.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    const initializing = store.initialize();
    await vi.waitFor(() => expect(delta).toBeTypeOf('function'));

    delta?.(snapshot({
      revision: '2',
      aggregate: {
        state: 'unavailable',
        enrolled: 1,
        healthy: 0,
        degraded: 0,
        unavailable: 1,
        paused: 0,
      },
    }));
    const healthy = snapshot({
      revision: '3',
      aggregate: {
        state: 'healthy',
        enrolled: 1,
        healthy: 1,
        degraded: 0,
        unavailable: 0,
        paused: 0,
      },
    });
    reconciliation.resolve({ success: true, data: healthy });
    await initializing;

    expect(store.snapshot()).toEqual(healthy);
  });

  it('ignores lower and equal revision deltas as idempotent', async () => {
    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({
        revision: '5',
        aggregate: {
          state: 'healthy',
          enrolled: 1,
          healthy: 1,
          degraded: 0,
          unavailable: 0,
          paused: 0,
        },
      }),
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    for (const revision of ['4', '5']) {
      delta?.(snapshot({
        revision,
        aggregate: {
          state: 'unavailable',
          enrolled: 1,
          healthy: 0,
          degraded: 0,
          unavailable: 1,
          paused: 0,
        },
      }));
    }

    expect(store.aggregate().state).toBe('healthy');
    expect(store.snapshot()?.revision).toBe('5');
  });

  it('accepts a newer decimal cursor after the old numeric safe-integer boundary', async () => {
    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({ revision: '9007199254740991' }),
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    delta?.(snapshot({
      revision: '9007199254740992',
      aggregate: {
        state: 'healthy',
        enrolled: 1,
        healthy: 1,
        degraded: 0,
        unavailable: 0,
        paused: 0,
      },
    }));

    expect(store.snapshot()?.revision).toBe('9007199254740992');
    expect(store.aggregate().state).toBe('healthy');
  });

  it('suppresses a late fetch failure after a newer healthy delta is accepted', async () => {
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    const refresh = deferred<{
      success: false;
      error: { message: string };
    }>();
    ipc.getSnapshot.mockReturnValueOnce(refresh.promise);

    const refreshing = store.refresh();
    delta?.(snapshot({
      revision: '1',
      aggregate: {
        state: 'healthy',
        enrolled: 1,
        healthy: 1,
        degraded: 0,
        unavailable: 0,
        paused: 0,
      },
    }));
    refresh.resolve({
      success: false,
      error: { message: 'stale private failure detail' },
    });
    await refreshing;

    expect(store.snapshot()?.revision).toBe('1');
    expect(store.error()).toBeNull();
  });

  it('surfaces a fetch failure when no newer cursor was accepted', async () => {
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    const refresh = deferred<{
      success: false;
      error: { message: string };
    }>();
    ipc.getSnapshot.mockReturnValueOnce(refresh.promise);

    const refreshing = store.refresh();
    delta?.(snapshot({ revision: '0' }));
    refresh.resolve({
      success: false,
      error: { message: 'fixed at the renderer boundary' },
    });
    await refreshing;

    expect(store.error()).toBe('Local AI Guard status could not be refreshed.');
  });

  it('marks status unavailable after both initialization fetches fail without inventing state', async () => {
    ipc.getSnapshot.mockResolvedValue({
      success: false,
      error: { message: 'runtime unavailable' },
    });
    const store = TestBed.inject(LocalAiGuardStore);

    await store.initialize();

    expect(store.isInitialized()).toBe(true);
    expect(store.hasAuthoritativeSnapshot()).toBe(false);
    expect(store.snapshot()).toBeNull();
    expect(store.error()).toBe('Local AI Guard status could not be refreshed.');

    const recovered = snapshot({
      revision: '1',
      aggregate: {
        state: 'degraded',
        enrolled: 1,
        healthy: 0,
        degraded: 1,
        unavailable: 0,
        paused: 0,
      },
    });
    delta?.(recovered);

    expect(store.hasAuthoritativeSnapshot()).toBe(true);
    expect(store.snapshot()).toEqual(recovered);
    expect(store.error()).toBeNull();
  });

  it('derives aggregate, targets, active incidents, and pending fallbacks', async () => {
    const current = snapshot({
      aggregate: {
        state: 'degraded',
        enrolled: 2,
        healthy: 1,
        degraded: 1,
        unavailable: 0,
        paused: 0,
      },
      targets: [{
        targetId: 'target-1',
        state: 'degraded',
        routableRoles: [],
        layers: {},
        consecutiveFailures: 2,
        consecutiveSuccesses: 0,
        flapping: false,
        checkedAt: 2_000,
      }],
      incidents: [
        incident('open', 'open'),
        incident('acknowledged', 'acknowledged'),
        incident('resolved', 'resolved'),
      ],
      pendingFallbacks: [
        fallback('pending', 1_000),
        fallback('resolved', 2_000, { status: 'blocked' }),
      ],
    });
    ipc.getSnapshot.mockResolvedValue({ success: true, data: current });
    const store = TestBed.inject(LocalAiGuardStore);

    await store.initialize();

    expect(store.aggregate()).toEqual(current.aggregate);
    expect(store.targets()).toEqual(current.targets);
    expect(store.activeIncidents().map(({ id }) => id)).toEqual(['open', 'acknowledged']);
    expect(store.pendingFallbacks().map(({ id }) => id)).toEqual(['pending']);
  });

  it('loads effectiveness windows without replacing current targets or incidents', async () => {
    const current = snapshot({
      revision: '7',
      targets: [targetStatus()],
      targetConfigs: [target()],
      incidents: [incident('incident-1', 'open')],
    });
    ipc.getSnapshot.mockResolvedValue({ success: true, data: current });
    ipc.getSummary.mockResolvedValue({
      success: true,
      data: effectivenessSummary({ window: '7d' }),
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    const snapshotBefore = store.snapshot();

    await store.loadEffectiveness('7d');

    expect(ipc.getSummary).toHaveBeenCalledWith('7d');
    expect(store.effectiveness()).toEqual(effectivenessSummary({ window: '7d' }));
    expect(store.effectivenessWindow()).toBe('7d');
    expect(store.snapshot()).toBe(snapshotBefore);
    expect(store.targets()).toEqual(current.targets);
    expect(store.activeIncidents()).toEqual(current.incidents);
  });

  it('keeps the newest effectiveness query and exposes only a fixed failure message', async () => {
    const stale = deferred<{
      success: true;
      data: LocalAiEffectivenessSummary;
    }>();
    ipc.getSummary
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({
        success: false,
        error: { message: 'sqlite:///private/path?token=secret' },
      });
    const store = TestBed.inject(LocalAiGuardStore);

    const first = store.loadEffectiveness('7d');
    const second = store.loadEffectiveness('30d');
    await second;
    stale.resolve({
      success: true,
      data: effectivenessSummary({ window: '7d', localTasks: 99 }),
    });
    await first;

    expect(store.effectivenessWindow()).toBe('30d');
    expect(store.effectiveness()).toBeNull();
    expect(store.effectivenessError()).toBe('Effectiveness data could not be loaded.');
    expect(store.effectivenessError()).not.toContain('private');
  });

  it('does not label a previous summary as the newly requested period while loading', async () => {
    const pending = deferred<{
      success: true;
      data: LocalAiEffectivenessSummary;
    }>();
    const store = TestBed.inject(LocalAiGuardStore);
    await store.loadEffectiveness('24h');
    expect(store.effectiveness()?.window).toBe('24h');
    ipc.getSummary.mockReturnValueOnce(pending.promise);

    const loading = store.loadEffectiveness('7d');

    expect(store.effectivenessWindow()).toBe('7d');
    expect(store.effectivenessLoading()).toBe(true);
    expect(store.effectiveness()).toBeNull();
    pending.resolve({
      success: true,
      data: effectivenessSummary({ window: '7d' }),
    });
    await loading;
    expect(store.effectiveness()?.window).toBe('7d');
  });

  it('rejects a summary whose response window does not match the requested period', async () => {
    ipc.getSummary.mockResolvedValueOnce({
      success: true,
      data: effectivenessSummary({ window: '24h' }),
    });
    const store = TestBed.inject(LocalAiGuardStore);

    await store.loadEffectiveness('30d');

    expect(store.effectiveness()).toBeNull();
    expect(store.effectivenessError()).toBe('Effectiveness data could not be loaded.');
  });

  it('ignores a late effectiveness response after the store is destroyed', async () => {
    const pending = deferred<{
      success: true;
      data: LocalAiEffectivenessSummary;
    }>();
    ipc.getSummary.mockReturnValueOnce(pending.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    const loading = store.loadEffectiveness('30d');

    store.destroy();
    pending.resolve({
      success: true,
      data: effectivenessSummary({ window: '30d' }),
    });
    await loading;

    expect(store.effectiveness()).toBeNull();
    expect(store.effectivenessWindow()).toBe('24h');
    expect(store.effectivenessLoading()).toBe(false);
  });

  it('retains the last good snapshot on refresh failure and clears the error on recovery', async () => {
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    const original = store.snapshot();
    ipc.getSnapshot.mockResolvedValueOnce({
      success: false,
      error: { message: 'file:///private/path?token=secret' },
    });

    await store.refresh();

    expect(store.snapshot()).toBe(original);
    expect(store.error()).toBe('Local AI Guard status could not be refreshed.');

    const recovered = snapshot({
      revision: '1',
      aggregate: {
        state: 'healthy',
        enrolled: 1,
        healthy: 1,
        degraded: 0,
        unavailable: 0,
        paused: 0,
      },
    });
    ipc.getSnapshot.mockResolvedValueOnce({ success: true, data: recovered });
    await store.refresh();

    expect(store.snapshot()).toEqual(recovered);
    expect(store.error()).toBeNull();
  });

  it('serializes fallback decisions, removes a resolved request, and converges by refresh', async () => {
    const pending = fallback('request-1', 1_000);
    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({ pendingFallbacks: [pending] }),
    });
    const resolution = deferred<{
      success: true;
      data: LocalAiFallbackRequest;
    }>();
    ipc.resolveFallback.mockReturnValueOnce(resolution.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({ pendingFallbacks: [] }),
    });

    const first = store.resolveFallback('request-1', 'allow-once');
    const duplicate = store.resolveFallback('request-1', 'block');

    expect(store.resolvingFallbackId()).toBe('request-1');
    expect(ipc.resolveFallback).toHaveBeenCalledOnce();
    resolution.resolve({
      success: true,
      data: { ...pending, status: 'allowed', resolution: 'allow-once', resolvedAt: 2_000 },
    });
    await Promise.all([first, duplicate]);

    expect(store.resolvingFallbackId()).toBeNull();
    expect(store.pendingFallbacks()).toEqual([]);
    expect(ipc.getSnapshot).toHaveBeenCalledTimes(3);
  });

  it('surfaces a fixed resolution error and remains usable for a retry', async () => {
    const pending = fallback('request-1', 1_000);
    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({ pendingFallbacks: [pending] }),
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    ipc.resolveFallback.mockResolvedValueOnce({
      success: false,
      error: { message: 'sqlite /Users/name/private.db failed' },
    });

    await store.resolveFallback('request-1', 'defer');

    expect(store.error()).toBe('Fallback decision could not be saved. Try again.');
    expect(store.pendingFallbacks()).toEqual([pending]);

    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({ pendingFallbacks: [] }),
    });
    await store.resolveFallback('request-1', 'block');
    expect(ipc.resolveFallback).toHaveBeenCalledTimes(2);
    expect(store.error()).toBeNull();
  });

  it('unsubscribes exactly once and ignores late async responses and deltas after destroy', async () => {
    const reconciliation = deferred<{
      success: true;
      data: LocalAiGuardSnapshot;
    }>();
    ipc.getSnapshot
      .mockResolvedValueOnce({ success: true, data: snapshot() })
      .mockReturnValueOnce(reconciliation.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    const initializing = store.initialize();
    await vi.waitFor(() => expect(delta).toBeTypeOf('function'));

    store.destroy();
    store.destroy();
    const late = snapshot({
      aggregate: {
        state: 'healthy',
        enrolled: 1,
        healthy: 1,
        degraded: 0,
        unavailable: 0,
        paused: 0,
      },
    });
    delta?.(late);
    reconciliation.resolve({ success: true, data: late });
    await initializing;

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(store.isInitialized()).toBe(false);
    expect(store.snapshot()).toBeNull();
  });

  it('orchestrates typed discovery, validation, target lifecycle, and recovery operations', async () => {
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    await store.loadInventory();
    await expect(store.validateTarget(targetConfig())).resolves.toEqual(validationResults());
    await store.createTarget(targetConfig());
    await store.updateTarget('target-1', { warningLatencyMs: 3_000 });
    await store.setTargetLifecycle('target-1', 'paused', { pausedUntil: 4_000 });
    await store.recheckTarget('target-1', 'lightweight');
    await store.acknowledgeIncident('incident-1');
    await store.diagnoseTarget('target-1');
    await store.repairTarget('target-1', 'deep-check', 'guided');

    expect(store.discoveries()).toEqual([{
      ...discoveredEndpoint(),
      enrolledTargetId: 'target-1',
    }]);
    expect(ipc.setTargetLifecycle).toHaveBeenCalledWith(
      'target-1',
      'paused',
      { pausedUntil: 4_000 },
    );
    expect(store.diagnosticFor('target-1')?.recommendedActions).toEqual(['deep-check']);
    expect(store.repairFor('target-1')?.message).toBe('Run the complete health check.');
    expect(store.repairFor('target-1')?.outcome).toBe('guided');
    expect(store.operationError()).toBeNull();
  });

  it('links a just-discovered candidate immediately after enrolment succeeds', async () => {
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    await store.loadInventory();

    expect(store.discoveries()[0]?.enrolledTargetId).toBeUndefined();

    await store.createTarget(targetConfig());

    expect(store.discoveries()).toEqual([{
      ...discoveredEndpoint(),
      enrolledTargetId: 'target-1',
    }]);
  });

  it('keeps an exact server enrolment beyond the bounded snapshot until a known update or retirement', async () => {
    const linkedId = 'target-1001';
    const secondEndpoint = discoveredEndpoint({
      baseUrl: 'http://127.0.0.1:22434',
      label: 'This Mac · Second',
    });
    ipc.discover.mockResolvedValueOnce({
      success: true,
      data: [{
        ...discoveredEndpoint(),
        enrolledTargetId: linkedId,
      }, secondEndpoint],
    });
    ipc.updateTarget.mockResolvedValueOnce({
      success: true,
      data: target({
        id: linkedId,
        baseUrl: 'http://127.0.0.1:22434',
        label: 'This Mac · Second',
      }),
    });
    ipc.setTargetLifecycle.mockResolvedValueOnce({
      success: true,
      data: target({
        id: linkedId,
        lifecycle: 'retired',
        baseUrl: 'http://127.0.0.1:22434',
        label: 'This Mac · Second',
        retiredAt: 3_000,
      }),
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    await store.loadInventory();
    expect(store.discoveries().map(({ enrolledTargetId }) => enrolledTargetId))
      .toEqual([linkedId, undefined]);

    await store.updateTarget(linkedId, { baseUrl: 'http://127.0.0.1:22434' });
    expect(store.discoveries().map(({ enrolledTargetId }) => enrolledTargetId))
      .toEqual([undefined, linkedId]);

    await store.setTargetLifecycle(linkedId, 'retired');
    expect(store.discoveries().map(({ enrolledTargetId }) => enrolledTargetId))
      .toEqual([undefined, undefined]);
  });

  it('reconciles every cached candidate when an authoritative snapshot changes targets', async () => {
    const secondEndpoint = discoveredEndpoint({
      endpointId: 'second',
      baseUrl: 'http://127.0.0.1:22434',
      label: 'This Mac · Second',
    });
    ipc.discover.mockResolvedValueOnce({
      success: true,
      data: [discoveredEndpoint(), secondEndpoint],
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    await store.loadInventory();

    delta?.(snapshot({
      revision: '1',
      targetConfigs: [
        target(),
        target({
          id: 'target-2',
          endpointId: 'second',
          baseUrl: 'http://127.0.0.1:22434',
          label: 'This Mac · Second',
        }),
      ],
    }));

    expect(store.discoveries().map(({ enrolledTargetId }) => enrolledTargetId))
      .toEqual(['target-1', 'target-2']);
  });

  it('moves enrolment linkage across every cached identity after a target update', async () => {
    const secondEndpoint = discoveredEndpoint({
      baseUrl: 'http://127.0.0.1:22434',
      label: 'This Mac · Second',
    });
    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({ revision: '1', targetConfigs: [target()] }),
    });
    ipc.discover.mockResolvedValueOnce({
      success: true,
      data: [discoveredEndpoint(), secondEndpoint],
    });
    ipc.updateTarget.mockResolvedValueOnce({
      success: true,
      data: target({
        baseUrl: 'http://127.0.0.1:22434',
        label: 'This Mac · Second',
      }),
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    await store.loadInventory();
    expect(store.discoveries().map(({ enrolledTargetId }) => enrolledTargetId))
      .toEqual(['target-1', undefined]);

    await store.updateTarget('target-1', { baseUrl: 'http://127.0.0.1:22434' });

    expect(store.discoveries().map(({ enrolledTargetId }) => enrolledTargetId))
      .toEqual([undefined, 'target-1']);
  });

  it('clears retired enrolment linkage while preserving actual discovery presence', async () => {
    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({ revision: '1', targetConfigs: [target()] }),
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    await store.loadInventory();
    expect(store.discoveries()[0]?.enrolledTargetId).toBe('target-1');
    ipc.setTargetLifecycle.mockResolvedValueOnce({
      success: true,
      data: target({ lifecycle: 'retired' }),
    });

    await store.setTargetLifecycle('target-1', 'retired');

    expect(store.knownTarget('target-1')).toBeNull();
    expect(store.discoveries()).toEqual([discoveredEndpoint()]);
  });

  it('uses discovery refreshes alone to track disappearance and reappearance', async () => {
    ipc.getSnapshot.mockResolvedValue({
      success: true,
      data: snapshot({ revision: '1', targetConfigs: [target()] }),
    });
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();
    await store.loadInventory();
    expect(store.discoveries()[0]?.enrolledTargetId).toBe('target-1');
    ipc.discover
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [discoveredEndpoint()] });

    await store.loadInventory();
    expect(store.discoveries()).toEqual([]);

    await store.loadInventory();
    expect(store.discoveries()).toEqual([{
      ...discoveredEndpoint(),
      enrolledTargetId: 'target-1',
    }]);
  });

  it('queues a different operation without returning the in-flight operation result', async () => {
    const discovery = deferred<{
      success: true;
      data: LocalAiDiscoveredEndpoint[];
    }>();
    ipc.discover.mockReturnValueOnce(discovery.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    const discovering = store.loadInventory();
    const validating = store.validateTarget(targetConfig());

    expect(ipc.discover).toHaveBeenCalledOnce();
    expect(ipc.validate).not.toHaveBeenCalled();

    discovery.resolve({ success: true, data: [discoveredEndpoint()] });

    await expect(discovering).resolves.toEqual([discoveredEndpoint()]);
    await expect(validating).resolves.toEqual(validationResults());
    expect(ipc.validate).toHaveBeenCalledOnce();
  });

  it('coalesces only an identical operation and clears it after success', async () => {
    const firstCheck = deferred<{
      success: true;
      data: LocalAiTargetStatus;
    }>();
    ipc.recheck.mockReturnValueOnce(firstCheck.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    const first = store.recheckTarget('target-1', 'lightweight');
    const duplicate = store.recheckTarget('target-1', 'lightweight');
    firstCheck.resolve({
      success: true,
      data: targetStatus(),
    });

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      targetStatus(),
      targetStatus(),
    ]);
    expect(ipc.recheck).toHaveBeenCalledOnce();

    await expect(store.recheckTarget('target-1', 'lightweight')).resolves.toEqual(
      targetStatus(),
    );
    expect(ipc.recheck).toHaveBeenCalledTimes(2);
  });

  it('clears a failed operation so the same identity can retry', async () => {
    const failedCheck = deferred<{
      success: true;
      data: LocalAiTargetStatus;
    }>();
    ipc.recheck.mockReturnValueOnce(failedCheck.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    const first = store.recheckTarget('target-1', 'functional');
    failedCheck.reject(new Error('private endpoint failed'));

    await expect(first).resolves.toBeUndefined();
    await expect(store.recheckTarget('target-1', 'functional')).resolves.toEqual(
      targetStatus(),
    );
    expect(ipc.recheck).toHaveBeenCalledTimes(2);
    expect(store.operationKey()).toBeNull();
  });

  it('cancels active and queued operations on destroy and starts new-generation work', async () => {
    const staleDiscovery = deferred<{
      success: true;
      data: LocalAiDiscoveredEndpoint[];
    }>();
    ipc.discover.mockReturnValueOnce(staleDiscovery.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    const discovering = store.loadInventory();
    const staleValidation = store.validateTarget(targetConfig());
    let staleResults: unknown = 'pending';
    void Promise.all([discovering, staleValidation]).then((results) => {
      staleResults = results;
    });

    store.destroy();
    store.destroy();
    await Promise.resolve();
    await Promise.resolve();

    expect(staleResults).toEqual([undefined, undefined]);
    expect(ipc.validate).not.toHaveBeenCalled();

    await expect(store.validateTarget(targetConfig())).resolves.toEqual(validationResults());
    expect(ipc.validate).toHaveBeenCalledOnce();
    expect(store.operationKey()).toBeNull();
  });

  it('ignores a late old-generation completion while new work is active', async () => {
    const staleDiscovery = deferred<{
      success: true;
      data: LocalAiDiscoveredEndpoint[];
    }>();
    const currentValidation = deferred<{
      success: true;
      data: LocalAiProbeResult[];
    }>();
    ipc.discover.mockReturnValueOnce(staleDiscovery.promise);
    ipc.validate.mockReturnValueOnce(currentValidation.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    const staleResult = store.loadInventory();
    store.destroy();
    await expect(staleResult).resolves.toBeUndefined();

    const validating = store.validateTarget(targetConfig());
    expect(store.operationKey()).toBe('validate');
    expect(ipc.validate).toHaveBeenCalledOnce();

    staleDiscovery.resolve({ success: true, data: [discoveredEndpoint()] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.operationKey()).toBe('validate');
    expect(store.discoveries()).toEqual([]);

    currentValidation.resolve({ success: true, data: validationResults() });
    await expect(validating).resolves.toEqual(validationResults());
    expect(store.operationKey()).toBeNull();
    expect(store.operationError()).toBeNull();

    await expect(store.loadInventory()).resolves.toEqual([discoveredEndpoint()]);
    expect(ipc.discover).toHaveBeenCalledTimes(2);
    expect(store.discoveries()).toEqual([discoveredEndpoint()]);
  });

  it('prevents duplicate mutations and exposes only a fixed privacy-safe operation error', async () => {
    const pending = deferred<{
      success: false;
      error: { message: string };
    }>();
    ipc.recheck.mockReturnValueOnce(pending.promise);
    const store = TestBed.inject(LocalAiGuardStore);
    await store.initialize();

    const first = store.recheckTarget('target-1', 'lightweight');
    const duplicate = store.recheckTarget('target-1', 'lightweight');
    expect(store.operationKey()).toBe('recheck:target-1');
    expect(ipc.recheck).toHaveBeenCalledOnce();

    pending.resolve({
      success: false,
      error: { message: 'http://user:secret@host/private' },
    });
    await Promise.all([first, duplicate]);

    expect(store.operationError()).toBe(
      'The Local AI Guard operation could not be completed. Try again.',
    );
    expect(store.operationError()).not.toContain('user:secret');
    expect(store.operationKey()).toBeNull();
  });
});

function discoveredEndpoint(
  overrides: Partial<LocalAiDiscoveredEndpoint['identity']> & { label?: string } = {},
): LocalAiDiscoveredEndpoint {
  return {
    identity: {
      location: { type: 'coordinator' },
      provider: 'ollama',
      endpointId: overrides.endpointId ?? 'ollama',
      baseUrl: overrides.baseUrl ?? 'http://127.0.0.1:11434',
    },
    label: overrides.label ?? 'This Mac · Ollama',
    models: ['qwen3:8b'],
    healthy: true,
  };
}

function targetConfig(): LocalAiTargetConfig {
  return {
    lifecycle: 'enrolled',
    location: { type: 'coordinator' },
    provider: 'ollama',
    endpointId: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:8b', required: true }],
    canary: { model: 'qwen3:8b', timeoutMs: 30_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60_000 },
  };
}

function target(overrides: Partial<LocalAiTarget> = {}): LocalAiTarget {
  return {
    ...targetConfig(),
    id: 'target-1',
    label: 'This Mac · Ollama',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function validationResults(): LocalAiProbeResult[] {
  return [{
    targetId: 'validation',
    layer: 'endpoint',
    checkType: 'lightweight',
    ok: true,
    required: true,
    affectedRoles: ['compression'],
    checkedAt: 1_000,
    durationMs: 20,
    evidence: { endpointReachable: true },
  }];
}

function targetStatus(): LocalAiTargetStatus {
  return {
    targetId: 'target-1',
    state: 'healthy',
    routableRoles: ['compression'],
    layers: {},
    consecutiveFailures: 0,
    consecutiveSuccesses: 2,
    flapping: false,
    checkedAt: 2_000,
  };
}

function effectivenessSummary(
  overrides: Partial<LocalAiEffectivenessSummary> = {},
): LocalAiEffectivenessSummary {
  return {
    window: '24h',
    localTasks: 3,
    localTokens: 1_000,
    proposedFallbacks: 1,
    allowedFallbacks: 1,
    deferredFallbacks: 0,
    blockedFallbacks: 0,
    knownCostUsd: 1.25,
    estimatedCostUsd: 0.5,
    avoidedEstimatedTokens: 900,
    avoidedEstimatedCostUsd: 2,
    byTarget: { 'target-1': 4 },
    byModel: { 'qwen3:14b': 3 },
    bySlot: { compression: 4 },
    byIncident: { 'incident-1': 1 },
    ...overrides,
  };
}
