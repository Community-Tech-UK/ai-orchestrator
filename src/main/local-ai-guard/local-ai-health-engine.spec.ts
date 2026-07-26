import { describe, expect, it } from 'vitest';
import type {
  LocalAiHealthTransition,
  LocalAiProbeResult,
  LocalAiTarget,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import { LocalAiHealthTransitionSchema } from '../../shared/validation/local-ai-guard.schemas';
import { LocalAiHealthEngine } from './local-ai-health-engine';

const BASE_TIME = 1_700_000_000_000;

function target(overrides: Partial<LocalAiTarget> = {}): LocalAiTarget {
  return {
    id: 'target-1',
    label: 'Primary local AI',
    lifecycle: 'enrolled',
    location: { type: 'coordinator' },
    provider: 'ollama',
    endpointId: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:8b', required: true }],
    canary: { model: 'qwen3:8b', timeoutMs: 1_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['titleGeneration', 'compression', 'titleGeneration'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 1, cooldownMs: 60_000 },
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

function sample(overrides: Partial<LocalAiProbeResult> = {}): LocalAiProbeResult {
  return {
    targetId: 'target-1',
    layer: 'endpoint',
    checkType: 'lightweight',
    ok: true,
    required: true,
    affectedRoles: ['compression', 'titleGeneration'],
    checkedAt: BASE_TIME,
    durationMs: 5,
    evidence: { endpointReachable: true },
    ...overrides,
  };
}

function status(overrides: Partial<LocalAiTargetStatus> = {}): LocalAiTargetStatus {
  return {
    targetId: 'target-1',
    state: 'healthy',
    routableRoles: ['compression', 'titleGeneration'],
    layers: { endpoint: sample() },
    consecutiveFailures: 0,
    consecutiveSuccesses: 1,
    flapping: false,
    checkedAt: BASE_TIME,
    lifecycle: 'enrolled',
    stateTransitions: [],
    ...overrides,
  };
}

function expectValid(transition: LocalAiHealthTransition): LocalAiHealthTransition {
  expect(() => LocalAiHealthTransitionSchema.parse(transition)).not.toThrow();
  return transition;
}

describe('LocalAiHealthEngine', () => {
  const engine = new LocalAiHealthEngine();

  it('reports Not configured when there are no enrolled target statuses', () => {
    expect(engine.aggregate([])).toEqual({
      state: 'not-configured',
      enrolled: 0,
      healthy: 0,
      degraded: 0,
      unavailable: 0,
      paused: 0,
    });
  });

  it('creates deterministic checking status without treating missing evidence as healthy', () => {
    expect(engine.checking(target(), BASE_TIME + 1)).toEqual({
      targetId: 'target-1',
      state: 'checking',
      routableRoles: [],
      layers: {},
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      flapping: false,
      checkedAt: BASE_TIME + 1,
      lifecycle: 'enrolled',
      stateTransitions: [],
    });
  });

  it('removes only affected roles on the first required failure', () => {
    const transition = expectValid(engine.apply(
      target(),
      status(),
      [sample({
        ok: false,
        failureCode: 'protocol-error',
        affectedRoles: ['titleGeneration', 'titleGeneration'],
        checkedAt: BASE_TIME + 1,
      })],
      BASE_TIME + 1,
    ));

    expect(transition.current).toMatchObject({
      state: 'healthy',
      routableRoles: ['compression'],
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
      flapping: false,
    });
    expect(transition.incidentAction).toBe('none');
  });

  it.each([
    { count: 2, state: 'degraded', incidentAction: 'none' },
    { count: 3, state: 'unavailable', incidentAction: 'open' },
  ] as const)('makes $count consecutive required failures $state', ({ count, state: expectedState, incidentAction }) => {
    let previous = status();
    let transition: LocalAiHealthTransition | undefined;
    for (let failure = 1; failure <= count; failure += 1) {
      transition = engine.apply(
        target(),
        previous,
        [sample({ ok: false, failureCode: 'protocol-error', checkedAt: BASE_TIME + failure })],
        BASE_TIME + failure,
      );
      previous = transition.current;
    }

    expect(transition?.current.state).toBe(expectedState);
    expect(transition?.current.consecutiveFailures).toBe(count);
    expect(transition?.incidentAction).toBe(incidentAction);
    expectValid(transition!);
  });

  it.each([
    'worker-offline',
    'authentication-error',
    'missing-required-model',
  ] as const)('makes an unambiguous required %s failure immediately unavailable', (failureCode) => {
    const transition = expectValid(engine.apply(
      target(),
      status(),
      [sample({ ok: false, failureCode, checkedAt: BASE_TIME + 1 })],
      BASE_TIME + 1,
    ));

    expect(transition.current).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
      consecutiveFailures: 1,
    });
    expect(transition.incidentAction).toBe('open');
  });

  it('makes a failed required pre-route probe immediately unavailable', () => {
    const preRouteFailure = {
      ...sample({ ok: false, failureCode: 'connection-refused', checkedAt: BASE_TIME + 1 }),
      id: 'sample-1',
      origin: 'pre-route' as const,
    };

    const transition = expectValid(engine.apply(
      target(),
      status(),
      [preRouteFailure],
      BASE_TIME + 1,
    ));

    expect(transition.current.state).toBe('unavailable');
    expect(transition.incidentAction).toBe('open');
    expect(transition.current.layers.endpoint).not.toHaveProperty('id');
    expect(transition.current.layers.endpoint).not.toHaveProperty('origin');
  });

  it('does not let an older pre-route failure override a newer successful layer result', () => {
    const olderPreRouteFailure = {
      ...sample({ ok: false, failureCode: 'connection-refused' }),
      id: 'sample-older',
      origin: 'pre-route' as const,
    };
    const newerSuccess = sample({ checkedAt: BASE_TIME + 1 });

    const transition = expectValid(engine.apply(
      target(),
      status(),
      [olderPreRouteFailure, newerSuccess],
      BASE_TIME + 1,
    ));

    expect(transition.current).toMatchObject({
      state: 'healthy',
      consecutiveFailures: 0,
      routableRoles: ['compression', 'titleGeneration'],
    });
    expect(transition.incidentAction).toBe('none');
  });

  it('degrades an optional-model failure and removes only its assigned roles', () => {
    const transition = expectValid(engine.apply(
      target(),
      status(),
      [
        sample({ checkedAt: BASE_TIME + 1 }),
        sample({
          layer: 'model',
          ok: false,
          required: false,
          failureCode: 'missing-required-model',
          affectedRoles: ['titleGeneration'],
          evidence: { missingModels: ['nomic-embed-text'] },
          checkedAt: BASE_TIME + 1,
        }),
      ],
      BASE_TIME + 1,
    ));

    expect(transition.current).toMatchObject({
      state: 'degraded',
      routableRoles: ['compression'],
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    });
    expect(transition.incidentAction).toBe('none');
  });

  it('requires two consecutive successful required checks to recover and resolve', () => {
    const unavailable = status({
      state: 'unavailable',
      routableRoles: [],
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    });

    const first = expectValid(engine.apply(
      target(), unavailable, [sample({ checkedAt: BASE_TIME + 1 })], BASE_TIME + 1,
    ));
    const second = expectValid(engine.apply(
      target(), first.current, [sample({ checkedAt: BASE_TIME + 2 })], BASE_TIME + 2,
    ));

    expect(first.current).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
    });
    expect(first.incidentAction).toBe('none');
    expect(second.current).toMatchObject({
      state: 'healthy',
      routableRoles: ['compression', 'titleGeneration'],
      consecutiveFailures: 0,
      consecutiveSuccesses: 2,
    });
    expect(second.incidentAction).toBe('resolve');
  });

  it('treats pause as neutral and ignores probe outcomes while suspended', () => {
    const previous = status({
      state: 'degraded',
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
      stateTransitions: [{ state: 'degraded', at: BASE_TIME - 1 }],
    });
    const transition = expectValid(engine.apply(
      target({ lifecycle: 'paused', pausedUntil: BASE_TIME + 60_000 }),
      previous,
      [sample({ ok: false, failureCode: 'worker-offline' })],
      BASE_TIME,
    ));

    expect(transition.current).toMatchObject({
      state: 'paused',
      routableRoles: [],
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
      flapping: false,
      stateTransitions: [{ state: 'degraded', at: BASE_TIME - 1 }],
    });
    expect(transition.incidentAction).toBe('none');
  });

  it('quarantines four active-state changes within ten minutes and clears after two new successes', () => {
    let current = engine.apply(target(), undefined, [sample()], BASE_TIME).current;

    current = engine.apply(target(), current, [sample({ ok: false, failureCode: 'worker-offline', checkedAt: BASE_TIME + 1 })], BASE_TIME + 1).current;
    current = engine.apply(target(), current, [sample({ checkedAt: BASE_TIME + 2 })], BASE_TIME + 2).current;
    current = engine.apply(target(), current, [sample({ checkedAt: BASE_TIME + 3 })], BASE_TIME + 3).current;
    current = engine.apply(target(), current, [sample({ ok: false, failureCode: 'worker-offline', checkedAt: BASE_TIME + 4 })], BASE_TIME + 4).current;
    current = engine.apply(target(), current, [sample({ checkedAt: BASE_TIME + 5 })], BASE_TIME + 5).current;
    const quarantined = expectValid(engine.apply(target(), current, [sample({ checkedAt: BASE_TIME + 6 })], BASE_TIME + 6));

    expect(quarantined.current).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
      consecutiveSuccesses: 0,
      flapping: true,
    });
    expect(quarantined.current.stateTransitions).toHaveLength(4);

    const oneSuccess = engine.apply(target(), quarantined.current, [sample({ checkedAt: BASE_TIME + 7 })], BASE_TIME + 7);
    const recovered = expectValid(engine.apply(target(), oneSuccess.current, [sample({ checkedAt: BASE_TIME + 8 })], BASE_TIME + 8));
    expect(oneSuccess.current.flapping).toBe(true);
    expect(oneSuccess.current.routableRoles).toEqual([]);
    expect(recovered.current).toMatchObject({
      state: 'healthy',
      routableRoles: ['compression', 'titleGeneration'],
      consecutiveSuccesses: 2,
      flapping: false,
    });
    expect(recovered.current.stateTransitions).toEqual([{ state: 'healthy', at: BASE_TIME + 8 }]);
  });

  it('does not interpret stale evidence as healthy or resolve an unavailable incident', () => {
    const previous = status({
      state: 'unavailable',
      routableRoles: [],
      consecutiveFailures: 3,
      checkedAt: BASE_TIME,
    });
    const stale = expectValid(engine.apply(
      target({ freshnessLimitMs: 100 }),
      previous,
      [sample({ checkedAt: BASE_TIME })],
      BASE_TIME + 101,
    ));

    expect(stale.current).toMatchObject({
      state: 'checking',
      routableRoles: [],
      consecutiveFailures: 3,
      checkedAt: BASE_TIME,
    });
    expect(stale.incidentAction).toBe('none');
  });

  it('deduplicates layer results and roles deterministically without mutating inputs', () => {
    const healthy = sample({
      ok: true,
      affectedRoles: ['titleGeneration', 'compression'],
      evidence: { endpointReachable: true },
    });
    const failed = sample({
      ok: false,
      failureCode: 'protocol-error',
      affectedRoles: ['compression', 'titleGeneration', 'compression'],
      evidence: { endpointReachable: false },
    });
    const inputTarget = target();
    const previous = status();
    const targetBefore = structuredClone(inputTarget);
    const previousBefore = structuredClone(previous);
    const samplesBefore = structuredClone([healthy, failed]);

    const forward = expectValid(engine.apply(inputTarget, previous, [healthy, failed], BASE_TIME));
    const reverse = expectValid(engine.apply(inputTarget, previous, [failed, healthy], BASE_TIME));

    expect(forward.current).toEqual(reverse.current);
    expect(forward.current.layers.endpoint).toMatchObject({ ok: false, affectedRoles: ['compression', 'titleGeneration'] });
    expect(inputTarget).toEqual(targetBefore);
    expect(previous).toEqual(previousBefore);
    expect([healthy, failed]).toEqual(samplesBefore);
  });

  it('aggregates the worst unpaused state and deterministic counts', () => {
    expect(engine.aggregate([
      status({ targetId: 'healthy', state: 'healthy' }),
      status({ targetId: 'degraded', state: 'degraded' }),
      status({ targetId: 'paused', state: 'paused' }),
      status({ targetId: 'checking', state: 'checking' }),
    ])).toEqual({
      state: 'degraded',
      enrolled: 4,
      healthy: 1,
      degraded: 1,
      unavailable: 0,
      paused: 1,
    });
  });

  it('does not advance failure or recovery hysteresis when the same evaluation cycle is replayed', () => {
    const failure = sample({
      ok: false,
      failureCode: 'protocol-error',
      checkedAt: BASE_TIME + 1,
    });
    const firstFailure = engine.apply(target(), status(), [failure], BASE_TIME + 1);
    const replayedFailure = expectValid(engine.apply(
      target(), firstFailure.current, [failure], BASE_TIME + 2,
    ));
    expect(replayedFailure.current).toMatchObject({
      state: 'healthy',
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
      checkedAt: BASE_TIME + 1,
    });
    expect(replayedFailure.incidentAction).toBe('none');

    const unavailable = status({
      state: 'unavailable',
      routableRoles: [],
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    });
    const success = sample({ checkedAt: BASE_TIME + 1 });
    const firstSuccess = engine.apply(target(), unavailable, [success], BASE_TIME + 1);
    const replayedSuccess = expectValid(engine.apply(
      target(), firstSuccess.current, [success], BASE_TIME + 2,
    ));
    expect(replayedSuccess.current).toMatchObject({
      state: 'unavailable',
      consecutiveSuccesses: 1,
    });
    expect(replayedSuccess.incidentAction).toBe('none');
  });

  it('uses merged fresh required layers so endpoint-only success cannot clear a model failure', () => {
    const modelFailure = sample({
      layer: 'model',
      ok: false,
      failureCode: 'protocol-error',
      checkedAt: BASE_TIME,
    });
    const previous = status({
      state: 'unavailable',
      routableRoles: [],
      layers: { model: modelFailure },
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    });
    const first = engine.apply(
      target(), previous, [sample({ checkedAt: BASE_TIME + 1 })], BASE_TIME + 1,
    );
    const second = expectValid(engine.apply(
      target(), first.current, [sample({ checkedAt: BASE_TIME + 2 })], BASE_TIME + 2,
    ));

    expect(first.current.consecutiveSuccesses).toBe(0);
    expect(second.current).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
      consecutiveSuccesses: 0,
    });
    expect(second.current.layers.model).toMatchObject({ ok: false, required: true });
    expect(second.incidentAction).not.toBe('resolve');
  });

  it('makes stale retained required layers checking instead of fabricating health', () => {
    const previous = status({
      layers: { model: sample({ layer: 'model', checkedAt: BASE_TIME }) },
    });
    const transition = expectValid(engine.apply(
      target({ freshnessLimitMs: 100 }),
      previous,
      [sample({ checkedAt: BASE_TIME + 101 })],
      BASE_TIME + 101,
    ));

    expect(transition.current).toMatchObject({
      state: 'checking',
      routableRoles: [],
      consecutiveSuccesses: 1,
      checkedAt: BASE_TIME + 101,
    });
    expect(transition.incidentAction).toBe('none');
  });

  it('normalizes history to distinct active transitions and keeps the exact window edge', () => {
    const edge = BASE_TIME - 10 * 60 * 1_000;
    const previous = status({
      state: 'unavailable',
      routableRoles: [],
      stateTransitions: [
        { state: 'unavailable', at: edge - 1 },
        { state: 'healthy', at: edge },
        { state: 'healthy', at: edge + 1 },
        { state: 'checking', at: edge + 2 },
        { state: 'unavailable', at: edge + 3 },
        { state: 'unavailable', at: edge + 4 },
        { state: 'degraded', at: BASE_TIME + 1 },
        { state: 'healthy', at: Number.NaN },
      ],
    });

    const transition = expectValid(engine.apply(target(), previous, [], BASE_TIME));

    expect(transition.current.checkedAt).toBe(BASE_TIME);
    expect(transition.current.stateTransitions).toEqual([
      { state: 'healthy', at: edge },
      { state: 'unavailable', at: edge + 3 },
    ]);
    expect(transition.current.flapping).toBe(false);
  });

  it('clamps regressed now to prior checkedAt without erasing transition evidence', () => {
    const previous = status({
      checkedAt: BASE_TIME + 100,
      stateTransitions: [{ state: 'degraded', at: BASE_TIME + 50 }],
    });

    const transition = expectValid(engine.apply(target(), previous, [], BASE_TIME));

    expect(transition.current.checkedAt).toBe(BASE_TIME + 100);
    expect(transition.current.stateTransitions).toEqual([
      { state: 'degraded', at: BASE_TIME + 50 },
    ]);
  });

  it('falls back safely from schema-invalid prior status without mutating it', () => {
    const invalidPrior = {
      ...status(),
      checkedAt: -1,
      consecutiveFailures: -2,
      consecutiveSuccesses: Number.POSITIVE_INFINITY,
      layers: {
        endpoint: sample({ checkedAt: -1, durationMs: -1 }),
      },
      stateTransitions: [{ state: 'healthy', at: -1 }],
    } as LocalAiTargetStatus;
    const before = structuredClone(invalidPrior);

    const transition = expectValid(engine.apply(
      target(), invalidPrior, [sample({ checkedAt: BASE_TIME + 1 })], BASE_TIME + 1,
    ));

    expect(transition.previous).toBeUndefined();
    expect(transition.current).toMatchObject({
      state: 'healthy',
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
    });
    expect(invalidPrior).toEqual(before);
  });

  it('excludes unmanaged and retired apply results from aggregate enrolment', () => {
    const unmanaged = engine.apply(
      target({ lifecycle: 'unmanaged', routingRoles: [] }), undefined, [], BASE_TIME,
    ).current;
    const retired = engine.apply(
      target({ lifecycle: 'retired', routingRoles: [], retiredAt: BASE_TIME }), undefined, [], BASE_TIME,
    ).current;

    expect(unmanaged.lifecycle).toBe('unmanaged');
    expect(retired.lifecycle).toBe('retired');
    expect(engine.aggregate([unmanaged, retired])).toEqual({
      state: 'not-configured',
      enrolled: 0,
      healthy: 0,
      degraded: 0,
      unavailable: 0,
      paused: 0,
    });
  });

  it('counts paused targets as configured while excluding them from active severity', () => {
    const paused = engine.apply(
      target({ lifecycle: 'paused', pausedUntil: BASE_TIME + 1 }), undefined, [], BASE_TIME,
    ).current;

    expect(paused.lifecycle).toBe('paused');
    expect(engine.aggregate([paused])).toEqual({
      state: 'paused',
      enrolled: 1,
      healthy: 0,
      degraded: 0,
      unavailable: 0,
      paused: 1,
    });
  });

  it('never makes a zero-capability enrolled target healthy when config validation is bypassed', () => {
    const transition = expectValid(engine.apply(
      target({ routingRoles: [] }), undefined, [sample()], BASE_TIME,
    ));

    expect(transition.current).toMatchObject({
      lifecycle: 'enrolled',
      state: 'checking',
      routableRoles: [],
      consecutiveSuccesses: 0,
    });
  });

  it('does not infer a new flapping transition from replayed history alone', () => {
    const previous = status({
      checkedAt: BASE_TIME,
      stateTransitions: [
        { state: 'unavailable', at: BASE_TIME - 4 },
        { state: 'healthy', at: BASE_TIME - 3 },
        { state: 'unavailable', at: BASE_TIME - 2 },
        { state: 'healthy', at: BASE_TIME - 1 },
      ],
    });

    const replay = expectValid(engine.apply(target(), previous, [sample()], BASE_TIME + 1));

    expect(replay.current.flapping).toBe(false);
    expect(replay.current.routableRoles).toEqual(['compression', 'titleGeneration']);
    expect(replay.incidentAction).toBe('none');
  });

  it('uses the newest sample time when explicit now regresses behind the evaluation cycle', () => {
    const transition = expectValid(engine.apply(
      target(),
      status(),
      [sample({ checkedAt: BASE_TIME + 10 })],
      BASE_TIME - 10,
    ));

    expect(transition.current).toMatchObject({
      state: 'healthy',
      checkedAt: BASE_TIME + 10,
      consecutiveSuccesses: 2,
    });
  });

  it('bounds valid but excessive prior counters before replaying evidence', () => {
    const previous = status({
      consecutiveFailures: Number.MAX_SAFE_INTEGER,
      consecutiveSuccesses: Number.MAX_SAFE_INTEGER,
    });

    const replay = expectValid(engine.apply(target(), previous, [sample()], BASE_TIME));

    expect(replay.previous).toMatchObject({
      consecutiveFailures: 3,
      consecutiveSuccesses: 2,
    });
    expect(replay.current.consecutiveFailures).toBe(3);
    expect(replay.current.consecutiveSuccesses).toBe(2);
  });

  it('does not double-count a paused lifecycle carrying a stale active state', () => {
    expect(engine.aggregate([status({ lifecycle: 'paused', state: 'healthy' })])).toEqual({
      state: 'paused',
      enrolled: 1,
      healthy: 0,
      degraded: 0,
      unavailable: 0,
      paused: 1,
    });
  });

  it('advances a newer per-layer model winner even when another retained layer has a later timestamp', () => {
    const previous = status({
      state: 'healthy',
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
      layers: {
        endpoint: sample({ checkedAt: BASE_TIME + 10 }),
        model: sample({
          layer: 'model',
          ok: false,
          failureCode: 'protocol-error',
          checkedAt: BASE_TIME + 5,
        }),
      },
      checkedAt: BASE_TIME + 10,
    });
    const newerModelFailure = sample({
      layer: 'model',
      ok: false,
      failureCode: 'protocol-error',
      checkedAt: BASE_TIME + 6,
    });

    const advanced = expectValid(engine.apply(
      target(), previous, [newerModelFailure], BASE_TIME + 10,
    ));
    const replay = expectValid(engine.apply(
      target(), advanced.current, [newerModelFailure], BASE_TIME + 11,
    ));

    expect(advanced.current).toMatchObject({
      state: 'degraded',
      consecutiveFailures: 2,
      checkedAt: BASE_TIME + 10,
    });
    expect(replay.current.consecutiveFailures).toBe(2);
    expect(replay.incidentAction).toBe('none');
  });

  it('advances one same-time materially changed critical winner and makes its exact replay neutral', () => {
    const changedCritical = sample({
      ok: false,
      failureCode: 'worker-offline',
      checkedAt: BASE_TIME,
      evidence: { endpointReachable: false },
    });

    const changed = expectValid(engine.apply(target(), status(), [changedCritical], BASE_TIME));
    const replay = expectValid(engine.apply(
      target(), changed.current, [changedCritical], BASE_TIME + 1,
    ));

    expect(changed.current).toMatchObject({
      state: 'unavailable',
      consecutiveFailures: 1,
      incidentOpen: true,
      recoveryState: 'unavailable',
    });
    expect(changed.incidentAction).toBe('open');
    expect(replay.current.consecutiveFailures).toBe(1);
    expect(replay.incidentAction).toBe('none');
  });

  it('preserves unavailable incident recovery through stale checking and pause, then resolves exactly once', () => {
    const critical = engine.apply(target(), status(), [sample({
      ok: false,
      failureCode: 'worker-offline',
      checkedAt: BASE_TIME + 1,
    })], BASE_TIME + 1);
    const stale = engine.apply(
      target({ freshnessLimitMs: 100 }), critical.current, [], BASE_TIME + 102,
    );
    const paused = engine.apply(
      target({ lifecycle: 'paused', pausedUntil: BASE_TIME + 103 }),
      stale.current,
      [],
      BASE_TIME + 102,
    );
    const firstSuccess = engine.apply(
      target({ freshnessLimitMs: 100 }),
      paused.current,
      [sample({ checkedAt: BASE_TIME + 103 })],
      BASE_TIME + 103,
    );
    const secondSuccess = expectValid(engine.apply(
      target({ freshnessLimitMs: 100 }),
      firstSuccess.current,
      [sample({ checkedAt: BASE_TIME + 104 })],
      BASE_TIME + 104,
    ));
    const replay = engine.apply(
      target({ freshnessLimitMs: 100 }),
      secondSuccess.current,
      [sample({ checkedAt: BASE_TIME + 104 })],
      BASE_TIME + 105,
    );

    expect(stale.current).toMatchObject({
      state: 'checking',
      incidentOpen: true,
      recoveryState: 'unavailable',
      consecutiveFailures: 1,
    });
    expect(paused.current).toMatchObject({
      state: 'paused',
      incidentOpen: true,
      recoveryState: 'unavailable',
    });
    expect(firstSuccess.current).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
      consecutiveSuccesses: 1,
      incidentOpen: true,
      recoveryState: 'unavailable',
    });
    expect(secondSuccess.current).toMatchObject({
      state: 'healthy',
      routableRoles: ['compression', 'titleGeneration'],
      consecutiveSuccesses: 2,
      incidentOpen: false,
    });
    expect(secondSuccess.current.recoveryState).toBeUndefined();
    expect(secondSuccess.incidentAction).toBe('resolve');
    expect(replay.incidentAction).toBe('none');
  });

  it('preserves degraded recovery through stale checking until two new successes', () => {
    const firstFailure = engine.apply(target(), status(), [sample({
      ok: false,
      failureCode: 'protocol-error',
      checkedAt: BASE_TIME + 1,
    })], BASE_TIME + 1);
    const degraded = engine.apply(target(), firstFailure.current, [sample({
      ok: false,
      failureCode: 'protocol-error',
      checkedAt: BASE_TIME + 2,
    })], BASE_TIME + 2);
    const stale = engine.apply(
      target({ freshnessLimitMs: 100 }), degraded.current, [], BASE_TIME + 103,
    );
    const firstSuccess = engine.apply(
      target({ freshnessLimitMs: 100 }),
      stale.current,
      [sample({ checkedAt: BASE_TIME + 104 })],
      BASE_TIME + 104,
    );
    const recovered = expectValid(engine.apply(
      target({ freshnessLimitMs: 100 }),
      firstSuccess.current,
      [sample({ checkedAt: BASE_TIME + 105 })],
      BASE_TIME + 105,
    ));

    expect(degraded.current).toMatchObject({ state: 'degraded', recoveryState: 'degraded' });
    expect(stale.current).toMatchObject({ state: 'checking', recoveryState: 'degraded' });
    expect(firstSuccess.current).toMatchObject({
      state: 'degraded',
      consecutiveSuccesses: 1,
      recoveryState: 'degraded',
    });
    expect(recovered.current).toMatchObject({ state: 'healthy', incidentOpen: false });
    expect(recovered.current.recoveryState).toBeUndefined();
    expect(recovered.incidentAction).toBe('none');
  });

  it('discards malformed persisted layers and invalid or foreign incoming probes independently', () => {
    const malformedPrevious = status({
      checkedAt: BASE_TIME + 10,
      layers: {
        endpoint: sample({ layer: 'model', checkedAt: BASE_TIME + 5 }),
        model: sample({ targetId: 'foreign-target', layer: 'model', checkedAt: BASE_TIME + 5 }),
        inference: sample({ layer: 'inference', checkedAt: BASE_TIME + 11 }),
        worker: sample({ layer: 'worker', checkedAt: BASE_TIME + 5, durationMs: -1 }),
        effectiveness: sample({
          layer: 'effectiveness',
          required: false,
          checkedAt: BASE_TIME + 5,
        }),
      },
    });
    const invalidIncoming = sample({
      layer: 'model',
      checkedAt: BASE_TIME + 10,
      durationMs: -1,
    });
    const foreignIncoming = sample({
      targetId: 'foreign-target',
      layer: 'worker',
      checkedAt: BASE_TIME + 10,
    });

    const transition = expectValid(engine.apply(
      target(),
      malformedPrevious,
      [invalidIncoming, foreignIncoming, sample({ checkedAt: BASE_TIME + 10 })],
      BASE_TIME + 10,
    ));

    expect(Object.keys(transition.previous?.layers ?? {})).toEqual(['effectiveness']);
    expect(Object.keys(transition.current.layers)).toEqual(['endpoint', 'effectiveness']);
    expect(Object.values(transition.current.layers).every((item) =>
      item !== undefined
      && item.targetId === 'target-1'
      && item.checkedAt <= transition.current.checkedAt)).toBe(true);
  });

  it('detects a ninth in-window transition even though retained history stays capped at eight', () => {
    const previous = status({
      state: 'healthy',
      checkedAt: BASE_TIME,
      stateTransitions: Array.from({ length: 8 }, (_, index) => ({
        state: index % 2 === 0 ? 'unavailable' as const : 'healthy' as const,
        at: BASE_TIME - 8 + index,
      })),
    });

    const transition = expectValid(engine.apply(target(), previous, [sample({
      ok: false,
      failureCode: 'worker-offline',
      checkedAt: BASE_TIME + 1,
    })], BASE_TIME + 1));

    expect(transition.current.flapping).toBe(true);
    expect(transition.current.stateTransitions).toHaveLength(8);
    expect(transition.current.stateTransitions?.at(-1)).toEqual({
      state: 'unavailable',
      at: BASE_TIME + 1,
    });
  });

  it('deduplicates target IDs before aggregation with deterministic conservative tie breaks', () => {
    const duplicates = [
      status({ targetId: 'newer-neutral', lifecycle: 'enrolled', state: 'unavailable', checkedAt: 10 }),
      status({ targetId: 'newer-neutral', lifecycle: 'retired', state: 'unavailable', checkedAt: 20 }),
      status({ targetId: 'active-tie', lifecycle: 'retired', state: 'unavailable', checkedAt: 30 }),
      status({ targetId: 'active-tie', lifecycle: 'enrolled', state: 'healthy', checkedAt: 30 }),
      status({ targetId: 'severity-tie', lifecycle: 'enrolled', state: 'healthy', checkedAt: 40 }),
      status({ targetId: 'severity-tie', lifecycle: 'enrolled', state: 'unavailable', checkedAt: 40 }),
    ];
    const expected = {
      state: 'unavailable' as const,
      enrolled: 2,
      healthy: 1,
      degraded: 0,
      unavailable: 1,
      paused: 0,
    };

    expect(engine.aggregate(duplicates)).toEqual(expected);
    expect(engine.aggregate([...duplicates].reverse())).toEqual(expected);
  });

  it('requires a genuinely new required winner for each unavailable recovery success', () => {
    const outage = expectValid(engine.apply(target(), status(), [sample({
      ok: false,
      failureCode: 'worker-offline',
      checkedAt: BASE_TIME + 1,
    })], BASE_TIME + 1));
    const firstRequiredSuccess = expectValid(engine.apply(
      target(),
      outage.current,
      [sample({ checkedAt: BASE_TIME + 2 })],
      BASE_TIME + 2,
    ));
    const firstOptionalSuccess = expectValid(engine.apply(
      target(),
      firstRequiredSuccess.current,
      [sample({
        layer: 'effectiveness',
        required: false,
        checkedAt: BASE_TIME + 3,
      })],
      BASE_TIME + 3,
    ));
    const secondOptionalSuccess = expectValid(engine.apply(
      target(),
      firstOptionalSuccess.current,
      [sample({
        layer: 'effectiveness',
        required: false,
        checkedAt: BASE_TIME + 4,
      })],
      BASE_TIME + 4,
    ));
    const secondRequiredSuccess = expectValid(engine.apply(
      target(),
      secondOptionalSuccess.current,
      [sample({ checkedAt: BASE_TIME + 5 })],
      BASE_TIME + 5,
    ));
    const replay = expectValid(engine.apply(
      target(),
      secondRequiredSuccess.current,
      [sample({ checkedAt: BASE_TIME + 5 })],
      BASE_TIME + 6,
    ));

    expect(firstRequiredSuccess.current).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
      consecutiveSuccesses: 1,
      recoveryState: 'unavailable',
      incidentOpen: true,
    });
    for (const optional of [firstOptionalSuccess, secondOptionalSuccess]) {
      expect(optional.current).toMatchObject({
        state: 'unavailable',
        routableRoles: [],
        consecutiveSuccesses: 1,
        recoveryState: 'unavailable',
        incidentOpen: true,
      });
      expect(optional.incidentAction).toBe('none');
    }
    expect(secondRequiredSuccess.current).toMatchObject({
      state: 'healthy',
      routableRoles: ['compression', 'titleGeneration'],
      consecutiveSuccesses: 2,
      incidentOpen: false,
    });
    expect(secondRequiredSuccess.current.recoveryState).toBeUndefined();
    expect(secondRequiredSuccess.incidentAction).toBe('resolve');
    expect(replay.incidentAction).toBe('none');
  });

  it('does not fabricate required recovery credit from optional-only success novelty', () => {
    const transition = expectValid(engine.apply(
      target(),
      status({ consecutiveSuccesses: 0 }),
      [sample({
        layer: 'effectiveness',
        required: false,
        checkedAt: BASE_TIME + 1,
      })],
      BASE_TIME + 1,
    ));

    expect(transition.current.consecutiveFailures).toBe(0);
    expect(transition.current.consecutiveSuccesses).toBe(0);
    expect(transition.incidentAction).toBe('none');
  });

  it('preserves required-failure hysteresis through an optional failure and exact replays', () => {
    const firstRequiredFailure = expectValid(engine.apply(
      target(),
      status(),
      [sample({
        ok: false,
        failureCode: 'protocol-error',
        affectedRoles: ['titleGeneration'],
        checkedAt: BASE_TIME + 1,
      })],
      BASE_TIME + 1,
    ));
    const optionalFailureSample = sample({
      layer: 'effectiveness',
      checkType: 'functional',
      ok: false,
      required: false,
      failureCode: 'latency-exceeded',
      affectedRoles: ['compression'],
      checkedAt: BASE_TIME + 2,
      evidence: { canaryLatencyMs: 3_000 },
    });
    const optionalFailure = expectValid(engine.apply(
      target(),
      firstRequiredFailure.current,
      [optionalFailureSample],
      BASE_TIME + 2,
    ));
    const optionalReplay = expectValid(engine.apply(
      target(),
      optionalFailure.current,
      [optionalFailureSample],
      BASE_TIME + 3,
    ));
    const secondRequiredFailure = expectValid(engine.apply(
      target(),
      optionalReplay.current,
      [sample({
        ok: false,
        failureCode: 'protocol-error',
        affectedRoles: ['titleGeneration'],
        checkedAt: BASE_TIME + 3,
      })],
      BASE_TIME + 3,
    ));
    const thirdRequiredFailureSample = sample({
      ok: false,
      failureCode: 'protocol-error',
      affectedRoles: ['titleGeneration'],
      checkedAt: BASE_TIME + 4,
    });
    const thirdRequiredFailure = expectValid(engine.apply(
      target(),
      secondRequiredFailure.current,
      [thirdRequiredFailureSample],
      BASE_TIME + 4,
    ));
    const unavailableReplay = expectValid(engine.apply(
      target(),
      thirdRequiredFailure.current,
      [thirdRequiredFailureSample],
      BASE_TIME + 5,
    ));

    expect(firstRequiredFailure.current).toMatchObject({
      state: 'healthy',
      routableRoles: ['compression'],
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
    });
    expect(optionalFailure.current).toMatchObject({
      state: 'degraded',
      routableRoles: [],
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
      recoveryState: 'degraded',
    });
    expect(optionalFailure.incidentAction).toBe('none');
    expect(optionalReplay.current).toMatchObject({
      state: 'degraded',
      routableRoles: [],
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
    });
    expect(optionalReplay.incidentAction).toBe('none');
    expect(secondRequiredFailure.current).toMatchObject({
      state: 'degraded',
      routableRoles: [],
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
    });
    expect(secondRequiredFailure.incidentAction).toBe('none');
    expect(thirdRequiredFailure.current).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
      incidentOpen: true,
    });
    expect(thirdRequiredFailure.incidentAction).toBe('open');
    expect(unavailableReplay.current).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
      incidentOpen: true,
    });
    expect(unavailableReplay.incidentAction).toBe('none');
  });
});
