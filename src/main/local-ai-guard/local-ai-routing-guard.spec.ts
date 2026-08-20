import { afterEach, describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import {
  clearModelRateOverlay,
  registerProviderModelRates,
} from '../../shared/data/model-pricing';
import type { AppSettings } from '../../shared/types/settings.types';
import type {
  LocalAiFallbackResolution,
  LocalAiIncident,
  LocalAiRoutingEvent,
  LocalAiTargetConfig,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiFallbackApprovalService,
  type LocalAiFallbackApprovalCreation,
} from './local-ai-fallback-approval-service';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import { LocalAiRoutingGuard } from './local-ai-routing-guard';
import { LocalAiTargetRepository } from './local-ai-target-repository';

const dbs: SqliteDriver[] = [];

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
  if (!migration) throw new Error('Missing migration 054_local_ai_guard');
  db.exec(migration.up);
  db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
  dbs.push(db);
  return db;
}

function config(overrides: Partial<LocalAiTargetConfig> = {}): LocalAiTargetConfig {
  return {
    lifecycle: 'enrolled',
    location: { type: 'coordinator' },
    provider: 'ollama',
    endpointId: 'local-main',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'local-model', required: true }],
    canary: { model: 'local-model', timeoutMs: 5_000, intervalMs: 120_000 },
    endpointCheckIntervalMs: 30_000,
    freshnessLimitMs: 60_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression', 'titleGeneration'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 1, cooldownMs: 60_000 },
    ...overrides,
  };
}

function status(
  targetId: string,
  overrides: Partial<LocalAiTargetStatus> = {},
): LocalAiTargetStatus {
  return {
    targetId,
    lifecycle: 'enrolled',
    state: 'healthy',
    routableRoles: ['compression', 'titleGeneration'],
    layers: {},
    consecutiveFailures: 0,
    consecutiveSuccesses: 1,
    flapping: false,
    checkedAt: 1_000,
    ...overrides,
  };
}

function settings(
  overrides: Partial<Pick<
    AppSettings,
    | 'localAiGuardDefaultFallbackPolicy'
    | 'localAiGuardDailyFallbackBudgetUsd'
    | 'localAiGuardConfirmAboveInputTokens'
  >> = {},
) {
  return {
    localAiGuardDefaultFallbackPolicy: 'notify-and-allow' as const,
    localAiGuardDailyFallbackBudgetUsd: null,
    localAiGuardConfirmAboveInputTokens: null,
    ...overrides,
  };
}

function incident(targetId: string, overrides: Partial<LocalAiIncident> = {}): LocalAiIncident {
  return {
    id: 'incident-1',
    targetId,
    state: 'open',
    severity: 'critical',
    failureCode: 'endpoint-timeout',
    affectedLayers: ['endpoint'],
    affectedRoles: ['compression'],
    openedAt: 900,
    updatedAt: 900,
    fallbackCount: 0,
    knownCostUsd: 0,
    estimatedCostUsd: 0,
    unpricedDispatchCount: 0,
    ...overrides,
  };
}

function approvalHarness(
  decisions: LocalAiFallbackResolution[] = [],
  persistResolution?: (routingEventId: string, resolution: LocalAiFallbackResolution) => void,
  persistCreation?: (creation: LocalAiFallbackApprovalCreation) => LocalAiRoutingEvent,
) {
  const incidentAllowances = new Set<string>();
  const pending: {
    id: string;
    routingEventId: string;
    incidentId?: string;
  }[] = [];
  let nextId = 0;
  return {
    request: async (
      input: { routingEventId: string; incidentId?: string },
      creation?: LocalAiFallbackApprovalCreation,
    ) => {
      if (creation) {
        const stored = persistCreation?.(creation);
        if (stored?.disposition === 'blocked') return 'block' as const;
      }
      pending.push({
        id: `approval-${nextId += 1}`,
        routingEventId: input.routingEventId,
        ...(input.incidentId ? { incidentId: input.incidentId } : {}),
      });
      const resolution = decisions.shift() ?? 'block';
      if (resolution === 'allow-incident' && input.incidentId) {
        incidentAllowances.add(input.incidentId);
      }
      persistResolution?.(input.routingEventId, resolution);
      return resolution;
    },
    listPending: () => pending as never,
    hasIncidentAllowance: (incidentId: string) => incidentAllowances.has(incidentId),
  };
}

function createGuard(options: {
  db: SqliteDriver;
  targetConfig?: LocalAiTargetConfig;
  schedulerStatus?: LocalAiTargetStatus;
  schedulerError?: Error;
  settings?: ReturnType<typeof settings>;
  decisions?: LocalAiFallbackResolution[];
  fallbackModel?: { provider: string; model: string };
  notifyFallback?: (eventId: string) => void;
  now?: number;
}) {
  const now = options.now ?? 1_000;
  const targets = new LocalAiTargetRepository(options.db, undefined, () => now);
  const target = options.targetConfig ? targets.create(options.targetConfig) : undefined;
  const health = new LocalAiHealthRepository(options.db, undefined, () => now);
  const approvals = approvalHarness(options.decisions, (routingEventId, resolution) => {
    const allowed = resolution === 'allow-once' || resolution === 'allow-incident';
    const deferred = resolution === 'defer';
    health.updateRoutingEvent(routingEventId, {
      actualRoute: allowed ? 'frontier' : deferred ? 'deferred' : 'blocked',
      disposition: allowed ? 'allowed' : deferred ? 'deferred' : 'blocked',
    });
  }, (creation) => {
    return health.reserveFallbackRoutingEvent(
      creation.routingEvent,
      creation.reservationLimits,
    );
  });
  const recorded: string[] = [];
  let id = 0;
  const guard = new LocalAiRoutingGuard({
    targets,
    scheduler: {
      getStatus: () => options.schedulerStatus,
      ensureFresh: async () => {
        if (options.schedulerError) throw options.schedulerError;
        return options.schedulerStatus ?? status(target?.id ?? 'missing');
      },
    },
    health,
    approvals,
    incidents: {
      recordFallback: (routingEvent) => {
        recorded.push(routingEvent.id);
        return undefined;
      },
    },
    settings: () => options.settings ?? settings(),
    resolveFallbackModel: () => options.fallbackModel,
    notifyFallback: (routingEvent) => options.notifyFallback?.(routingEvent.id),
    now: () => now,
    createId: () => `routing-${id += 1}`,
  });
  return { guard, health, target, recorded };
}

const fallbackInput = {
  slot: 'compression' as const,
  reason: 'bounded fallback reason',
  estimatedInputTokens: 2_000,
  estimatedOutputTokens: 200,
  slotAllowsFrontier: true,
};

describe('LocalAiRoutingGuard', () => {
  afterEach(() => {
    clearModelRateOverlay();
    for (const db of dbs.splice(0)) db.close();
  });

  it('keeps missing and unmanaged targets neutral without consulting scheduler health', async () => {
    const db = openDb();
    const missing = createGuard({
      db,
      schedulerError: new Error('scheduler must not run'),
    });
    const unmanaged = createGuard({
      db,
      targetConfig: config({ lifecycle: 'unmanaged', routingRoles: [] }),
      schedulerError: new Error('scheduler must not run'),
    });

    await expect(missing.guard.evaluateLocalTarget({
      targetId: 'not-enrolled',
      slot: 'compression',
    })).resolves.toMatchObject({ eligible: true, reason: 'unmanaged-compatibility' });
    await expect(unmanaged.guard.evaluateLocalTarget({
      targetId: unmanaged.target!.id,
      slot: 'compression',
    })).resolves.toMatchObject({
      eligible: true,
      targetId: unmanaged.target!.id,
      reason: 'unmanaged-compatibility',
    });
  });

  it('requires a current scheduler verdict and rejects unavailable, failed-role, or failed freshness evidence', async () => {
    const unavailableDb = openDb();
    const unavailable = createGuard({
      db: unavailableDb,
      targetConfig: config(),
    });
    const unavailableStatus = status(unavailable.target!.id, {
      state: 'unavailable',
      routableRoles: [],
    });
    const unavailableGuard = new LocalAiRoutingGuard({
      targets: { get: () => unavailable.target },
      scheduler: {
        getStatus: () => unavailableStatus,
        ensureFresh: async () => unavailableStatus,
      },
      health: unavailable.health,
      approvals: approvalHarness(),
      settings,
    });
    const failedRole = createGuard({
      db: openDb(),
      targetConfig: config({ endpointId: 'failed-role' }),
    });
    const failedRoleStatus = status(failedRole.target!.id, {
      state: 'healthy',
      routableRoles: ['titleGeneration'],
    });
    const failedRoleGuard = new LocalAiRoutingGuard({
      targets: { get: () => failedRole.target },
      scheduler: {
        getStatus: () => failedRoleStatus,
        ensureFresh: async () => failedRoleStatus,
      },
      health: failedRole.health,
      approvals: approvalHarness(),
      settings,
    });
    const freshnessFailure = createGuard({
      db: openDb(),
      targetConfig: config({ endpointId: 'freshness-failure' }),
      schedulerError: new Error('probe failed'),
    });

    await expect(unavailableGuard.evaluateLocalTarget({
      targetId: unavailable.target!.id,
      slot: 'compression',
    })).resolves.toMatchObject({ eligible: false, reason: 'health-unavailable' });
    await expect(failedRoleGuard.evaluateLocalTarget({
      targetId: failedRole.target!.id,
      slot: 'compression',
    })).resolves.toMatchObject({ eligible: false, reason: 'role-not-routable' });
    await expect(freshnessFailure.guard.evaluateLocalTarget({
      targetId: freshnessFailure.target!.id,
      slot: 'compression',
    })).resolves.toMatchObject({ eligible: false, reason: 'freshness-check-failed' });
  });

  it('uses slot policy, then target policy, then the global default', async () => {
    const slot = createGuard({
      db: openDb(),
      targetConfig: config({
        fallbackPolicy: 'block-paid-fallback',
        slotFallbackPolicies: { compression: 'allow-silently' },
      }),
      settings: settings({ localAiGuardDefaultFallbackPolicy: 'defer-locally' }),
    });
    const target = createGuard({
      db: openDb(),
      targetConfig: config({ fallbackPolicy: 'block-paid-fallback' }),
      settings: settings({ localAiGuardDefaultFallbackPolicy: 'defer-locally' }),
    });
    const global = createGuard({
      db: openDb(),
      settings: settings({ localAiGuardDefaultFallbackPolicy: 'defer-locally' }),
    });

    await expect(slot.guard.authorizeFallback({
      ...fallbackInput,
      intendedTargetId: slot.target!.id,
    })).resolves.toMatchObject({ allowed: true, policy: 'allow-silently' });
    await expect(target.guard.authorizeFallback({
      ...fallbackInput,
      intendedTargetId: target.target!.id,
    })).resolves.toMatchObject({
      allowed: false,
      disposition: 'blocked',
      policy: 'block-paid-fallback',
    });
    await expect(global.guard.authorizeFallback(fallbackInput)).resolves.toMatchObject({
      allowed: false,
      disposition: 'deferred',
      policy: 'defer-locally',
    });
  });

  it('retains target fallback policy while a managed target is paused', async () => {
    const paused = createGuard({
      db: openDb(),
      targetConfig: config({
        lifecycle: 'paused',
        fallbackPolicy: 'block-paid-fallback',
      }),
      settings: settings({ localAiGuardDefaultFallbackPolicy: 'allow-silently' }),
    });

    await expect(paused.guard.authorizeFallback({
      ...fallbackInput,
      intendedTargetId: paused.target!.id,
    })).resolves.toMatchObject({
      allowed: false,
      disposition: 'blocked',
      policy: 'block-paid-fallback',
    });
  });

  it('notifies without blocking for notify-and-allow and never persists the supplied reason', async () => {
    const db = openDb();
    const notified: string[] = [];
    const { guard } = createGuard({
      db,
      settings: settings({ localAiGuardDefaultFallbackPolicy: 'notify-and-allow' }),
      notifyFallback: (eventId) => notified.push(eventId),
    });

    const verdict = await guard.authorizeFallback({
      ...fallbackInput,
      reason: 'prompt=private-model-output credential=do-not-store',
    });
    const row = db.prepare('SELECT * FROM local_ai_routing_events WHERE id = ?')
      .get<Record<string, unknown>>(verdict.routingEventId);

    expect(verdict).toMatchObject({
      allowed: true,
      disposition: 'allowed',
      policy: 'notify-and-allow',
    });
    expect(notified).toEqual([verdict.routingEventId]);
    expect(JSON.stringify(row)).not.toContain('private-model-output');
    expect(JSON.stringify(row)).not.toContain('do-not-store');
  });

  it.each([
    ['allow-once', true, 'allowed'],
    ['defer', false, 'deferred'],
    ['block', false, 'blocked'],
  ] as const)('maps confirmation resolution %s to its final verdict', async (
    resolution,
    allowed,
    disposition,
  ) => {
    const { guard, health } = createGuard({
      db: openDb(),
      settings: settings({ localAiGuardDefaultFallbackPolicy: 'require-confirmation' }),
      decisions: [resolution],
    });

    const verdict = await guard.authorizeFallback(fallbackInput);

    expect(verdict).toMatchObject({
      allowed,
      disposition,
      policy: 'require-confirmation',
      fallbackRequestId: expect.any(String),
    });
    expect(health.getRoutingEvent(verdict.routingEventId)).toMatchObject({
      actualRoute: allowed ? 'frontier' : disposition === 'deferred' ? 'deferred' : 'blocked',
      disposition,
    });
  });

  it('leaves confirmation event creation to the approval service atomic boundary', async () => {
    const db = openDb();
    const health = new LocalAiHealthRepository(db, undefined, () => 1_000);
    let eventAbsentAtApprovalBoundary = false;
    const guard = new LocalAiRoutingGuard({
      targets: { get: () => undefined },
      scheduler: {
        getStatus: () => undefined,
        ensureFresh: async () => {
          throw new Error('scheduler must not run');
        },
      },
      health,
      approvals: {
        request: async (input, creation) => {
          eventAbsentAtApprovalBoundary = health.getRoutingEvent(input.routingEventId) === undefined;
          if (!creation) return 'block';
          const request = {
            id: 'request-guard-atomic-create',
            ...input,
            status: 'pending' as const,
            createdAt: 1_000,
          };
          health.createFallbackRoutingRequest(
            creation.routingEvent,
            request,
            creation.reservationLimits,
          );
          health.resolveFallbackRequest(request.id, 'block');
          return 'block';
        },
        listPending: () => [],
      },
      settings: () => settings({
        localAiGuardDefaultFallbackPolicy: 'require-confirmation',
      }),
      now: () => 1_000,
      createId: () => 'routing-guard-atomic-create',
    });

    await expect(guard.authorizeFallback(fallbackInput)).resolves.toMatchObject({
      allowed: false,
      disposition: 'blocked',
    });
    expect(eventAbsentAtApprovalBoundary).toBe(true);
  });

  it('uses the real approval service atomic creation path end to end', async () => {
    const db = openDb();
    const health = new LocalAiHealthRepository(db, undefined, () => 1_000);
    const approvals = new LocalAiFallbackApprovalService(health, {
      now: () => 1_000,
      createId: () => 'request-routing-integration',
      notifyPending: (request) => {
        approvals.resolve(request.id, 'block');
      },
    });
    const guard = new LocalAiRoutingGuard({
      targets: { get: () => undefined },
      scheduler: {
        getStatus: () => undefined,
        ensureFresh: async () => {
          throw new Error('scheduler must not run');
        },
      },
      health,
      approvals,
      settings: () => settings({
        localAiGuardDefaultFallbackPolicy: 'require-confirmation',
      }),
      now: () => 1_000,
      createId: () => 'routing-approval-integration',
    });

    await expect(guard.authorizeFallback(fallbackInput)).resolves.toEqual({
      allowed: false,
      disposition: 'blocked',
      policy: 'require-confirmation',
      routingEventId: 'routing-approval-integration',
    });
    expect(health.getFallbackRequest('request-routing-integration')).toMatchObject({
      routingEventId: 'routing-approval-integration',
      status: 'blocked',
      resolution: 'block',
    });
    expect(health.getRoutingEvent('routing-approval-integration')).toMatchObject({
      actualRoute: 'blocked',
      disposition: 'blocked',
    });
    approvals.dispose();
  });

  it('reuses allow-incident only for the same incident while retaining hard ceiling precedence', async () => {
    registerProviderModelRates([
      { provider: 'openai', id: 'priced-frontier', rate: { input: 1_000, output: 1_000 } },
    ]);
    const db = openDb();
    const setup = createGuard({
      db,
      targetConfig: config({
        fallbackPolicy: 'require-confirmation',
        incidentFallbackBudgetUsd: 10,
      }),
      decisions: ['allow-incident'],
      fallbackModel: { provider: 'openai', model: 'priced-frontier' },
    });
    setup.health.upsertIncident({
      kind: 'open-or-update',
      incident: incident(setup.target!.id),
    });

    const first = await setup.guard.authorizeFallback({
      ...fallbackInput,
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 0,
      intendedTargetId: setup.target!.id,
    });
    const second = await setup.guard.authorizeFallback({
      ...fallbackInput,
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 0,
      intendedTargetId: setup.target!.id,
    });
    const blocked = await setup.guard.authorizeFallback({
      ...fallbackInput,
      estimatedInputTokens: 10_000,
      estimatedOutputTokens: 0,
      intendedTargetId: setup.target!.id,
    });

    expect(first).toMatchObject({ allowed: true, fallbackRequestId: expect.any(String) });
    expect(second).toMatchObject({ allowed: true });
    expect(second.fallbackRequestId).toBeUndefined();
    expect(blocked).toMatchObject({
      allowed: false,
      disposition: 'blocked',
      policy: 'block-paid-fallback',
    });
  });

  it('upgrades target and global token thresholds to confirmation before permissive policies', async () => {
    const targetThreshold = createGuard({
      db: openDb(),
      targetConfig: config({
        fallbackPolicy: 'allow-silently',
        confirmAboveInputTokens: 1_000,
      }),
      settings: settings({ localAiGuardConfirmAboveInputTokens: 10_000 }),
      decisions: ['block'],
    });
    const globalThreshold = createGuard({
      db: openDb(),
      targetConfig: config({ fallbackPolicy: 'allow-silently' }),
      settings: settings({ localAiGuardConfirmAboveInputTokens: 1_000 }),
      decisions: ['defer'],
    });

    await expect(targetThreshold.guard.authorizeFallback({
      ...fallbackInput,
      intendedTargetId: targetThreshold.target!.id,
    })).resolves.toMatchObject({
      policy: 'require-confirmation',
      disposition: 'blocked',
    });
    await expect(globalThreshold.guard.authorizeFallback({
      ...fallbackInput,
      intendedTargetId: globalThreshold.target!.id,
    })).resolves.toMatchObject({
      policy: 'require-confirmation',
      disposition: 'deferred',
    });
  });

  it('hard-blocks unknown estimates under configured daily or incident ceilings', async () => {
    const daily = createGuard({
      db: openDb(),
      settings: settings({ localAiGuardDailyFallbackBudgetUsd: 100 }),
      fallbackModel: { provider: 'unknown', model: 'unpriced-model' },
    });
    const incidentSetup = createGuard({
      db: openDb(),
      targetConfig: config({ incidentFallbackBudgetUsd: 100 }),
      fallbackModel: { provider: 'unknown', model: 'unpriced-model' },
    });
    incidentSetup.health.upsertIncident({
      kind: 'open-or-update',
      incident: incident(incidentSetup.target!.id),
    });

    await expect(daily.guard.authorizeFallback(fallbackInput)).resolves.toMatchObject({
      allowed: false,
      disposition: 'blocked',
      policy: 'block-paid-fallback',
    });
    await expect(incidentSetup.guard.authorizeFallback({
      ...fallbackInput,
      intendedTargetId: incidentSetup.target!.id,
    })).resolves.toMatchObject({
      allowed: false,
      disposition: 'blocked',
      policy: 'block-paid-fallback',
    });
  });

  it('treats a known model under the wrong provider as unpriced beneath a hard ceiling', async () => {
    const setup = createGuard({
      db: openDb(),
      settings: settings({ localAiGuardDailyFallbackBudgetUsd: 100 }),
      fallbackModel: { provider: 'openai', model: 'opus' },
    });

    await expect(setup.guard.authorizeFallback(fallbackInput)).resolves.toMatchObject({
      allowed: false,
      disposition: 'blocked',
      policy: 'block-paid-fallback',
      routingEventId: expect.any(String),
    });
    const stored = setup.health.getRoutingEvent('routing-1');
    expect(stored).toMatchObject({
      provider: 'openai',
      model: 'opus',
      decisionReason: 'daily-budget',
    });
    expect(stored).not.toHaveProperty('estimatedCostUsd');
  });

  it('counts post-midnight completions and unresolved prior-day reservations against the new UTC day', async () => {
    const db = openDb();
    const midnight = Date.UTC(2026, 6, 27);
    const now = midnight + 1_000;
    registerProviderModelRates([
      { provider: 'openai', id: 'midnight-model', rate: { input: 1_000, output: 1_000 } },
    ]);
    const setup = createGuard({
      db,
      now,
      settings: settings({
        localAiGuardDefaultFallbackPolicy: 'allow-silently',
        localAiGuardDailyFallbackBudgetUsd: 1.25,
      }),
      fallbackModel: { provider: 'openai', model: 'midnight-model' },
    });
    setup.health.appendRoutingEvent({
      ...eventForSpend('prior-day-completed', midnight - 1_000, 0.75),
      completedAt: midnight + 500,
    });
    setup.health.appendRoutingEvent(
      eventForSpend('prior-day-unresolved', midnight - 2_000, 0.5),
    );

    await expect(setup.guard.authorizeFallback({
      ...fallbackInput,
      estimatedInputTokens: 1,
      estimatedOutputTokens: 0,
    })).resolves.toMatchObject({
      allowed: false,
      disposition: 'blocked',
      policy: 'block-paid-fallback',
    });
  });

  it('uses catalogue pricing and durable reservations to prevent concurrent daily overspend', async () => {
    registerProviderModelRates([
      { provider: 'openai', id: 'reservation-model', rate: { input: 1_000, output: 1_000 } },
    ]);
    const setup = createGuard({
      db: openDb(),
      settings: settings({
        localAiGuardDefaultFallbackPolicy: 'allow-silently',
        localAiGuardDailyFallbackBudgetUsd: 1.5,
      }),
      fallbackModel: { provider: 'openai', model: 'reservation-model' },
    });
    const input = {
      ...fallbackInput,
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 0,
    };

    const [first, second] = await Promise.all([
      setup.guard.authorizeFallback(input),
      setup.guard.authorizeFallback(input),
    ]);

    expect([first.allowed, second.allowed]).toEqual([true, false]);
    const firstEvent = setup.health.getRoutingEvent(first.routingEventId);
    expect(firstEvent?.knownCostUsd).toBeUndefined();
    expect(firstEvent?.estimatedCostUsd).toBe(1);
    expect(setup.health.getRoutingEvent(second.routingEventId)).toMatchObject({
      decisionReason: 'daily-budget',
      estimatedCostUsd: 1,
    });
  });

  it('blocks frontier-disabled slots and marks an allowed dispatch exactly once', async () => {
    const setup = createGuard({
      db: openDb(),
      settings: settings({ localAiGuardDefaultFallbackPolicy: 'allow-silently' }),
    });
    const privacyBlock = await setup.guard.authorizeFallback({
      ...fallbackInput,
      slotAllowsFrontier: false,
    });
    const allowed = await setup.guard.authorizeFallback(fallbackInput);

    setup.guard.markFallbackDispatched(allowed.routingEventId);
    setup.guard.markFallbackDispatched(allowed.routingEventId);
    setup.guard.markFallbackDispatched(privacyBlock.routingEventId);

    expect(privacyBlock).toMatchObject({
      allowed: false,
      disposition: 'blocked',
      policy: 'block-paid-fallback',
    });
    expect(setup.recorded).toEqual([allowed.routingEventId]);
    expect(setup.health.getRoutingEvent(allowed.routingEventId)?.completedAt).toBe(1_000);
  });

  it('replays durable completed dispatch accounting once after a process restart', async () => {
    const setup = createGuard({
      db: openDb(),
      settings: settings({ localAiGuardDefaultFallbackPolicy: 'allow-silently' }),
    });
    const allowed = await setup.guard.authorizeFallback(fallbackInput);
    setup.health.updateRoutingEvent(allowed.routingEventId, { completedAt: 1_000 });

    setup.guard.markFallbackDispatched(allowed.routingEventId);
    setup.guard.markFallbackDispatched(allowed.routingEventId);

    expect(setup.recorded).toEqual([allowed.routingEventId]);
  });
});

function eventForSpend(
  id: string,
  createdAt: number,
  estimatedCostUsd: number,
): import('../../shared/types/local-ai-guard.types').LocalAiRoutingEvent {
  return {
    id,
    slot: 'compression',
    intendedRoute: 'local',
    actualRoute: 'frontier',
    policy: 'allow-silently',
    disposition: 'allowed',
    decisionReason: 'policy',
    provider: 'openai',
    model: 'midnight-model',
    inputTokens: 1,
    outputTokens: 0,
    estimatedCostUsd,
    createdAt,
  };
}
