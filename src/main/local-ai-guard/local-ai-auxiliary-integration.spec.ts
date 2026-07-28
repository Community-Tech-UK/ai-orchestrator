import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import type { AppSettings } from '../../shared/types/settings.types';
import type {
  LocalAiFallbackPolicy,
  LocalAiTargetConfig,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import {
  AuxiliaryLlmService,
  __resetAuxiliaryRemoteHooksForTesting,
  __setAuxiliaryRemoteHooksForTesting,
} from '../rlm/auxiliary-llm-service';
import {
  __resetLocalAiAuxiliaryHooksForTesting,
  __setLocalAiAuxiliaryHooksForTesting,
} from './local-ai-auxiliary-bridge';
import {
  _resetCostAttributionForTesting,
  subscribeCostAttribution,
} from '../core/system/cost-attribution';
import { LocalAiActivityRegistry } from './local-ai-activity-registry';
import { LocalAiFallbackApprovalService } from './local-ai-fallback-approval-service';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import { LocalAiRoutingGuard } from './local-ai-routing-guard';
import { applyLocalAiRoutingCostAttribution } from './local-ai-runtime';
import { LocalAiTargetRepository } from './local-ai-target-repository';
import {
  runAuthorizedFrontierFallback,
  runCorrelatedPaidFrontierCall,
} from './local-ai-cost-correlation';

const modelClient = vi.hoisted(() => ({
  probe: vi.fn(),
  list: vi.fn(),
  generate: vi.fn(),
}));

vi.mock('../rlm/auxiliary-model-client', () => ({
  probeOllamaEndpoint: vi.fn(),
  listOllamaModels: vi.fn(),
  generateWithOllama: vi.fn(),
  probeOpenAiCompatibleEndpoint: modelClient.probe,
  listOpenAiCompatibleModels: modelClient.list,
  generateWithOpenAiCompatible: modelClient.generate,
}));

const dbs: SqliteDriver[] = [];
const disposers: (() => void)[] = [];

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
  if (!migration) throw new Error('Missing migration 054_local_ai_guard');
  db.exec(migration.up);
  dbs.push(db);
  return db;
}

function targetConfig(overrides: Partial<LocalAiTargetConfig> = {}): LocalAiTargetConfig {
  return {
    lifecycle: 'enrolled',
    location: { type: 'coordinator' },
    provider: 'openai-compatible',
    endpointId: 'ep-local',
    baseUrl: 'http://127.0.0.1:1234',
    expectedModels: [{ modelId: 'local-model', required: true }],
    canary: { model: 'local-model', timeoutMs: 5_000, intervalMs: 120_000 },
    endpointCheckIntervalMs: 30_000,
    freshnessLimitMs: 60_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 1, cooldownMs: 60_000 },
    ...overrides,
  };
}

function healthyStatus(targetId: string): LocalAiTargetStatus {
  return {
    targetId,
    lifecycle: 'enrolled',
    state: 'healthy',
    routableRoles: ['compression'],
    layers: {},
    consecutiveFailures: 0,
    consecutiveSuccesses: 1,
    flapping: false,
    checkedAt: 1_000,
  };
}

function serviceSettings(slotAllowsFrontier = true) {
  return {
    auxiliaryLlmEnabled: true,
    auxiliaryLlmRoutingMode: 'manual-only' as const,
    auxiliaryLlmAllowRemoteWorkerModels: false,
    auxiliaryLlmUseLocalhostOllama: false,
    auxiliaryLlmDailySpendCapUsd: null,
    auxiliaryLlmEndpointsJson: JSON.stringify([{
      id: 'ep-local',
      label: 'Local model',
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234',
      source: 'manual',
      enabled: true,
    }]),
    auxiliaryLlmSlotsJson: JSON.stringify({
      compression: {
        enabled: true,
        provider: 'auto',
        endpointId: 'ep-local',
        model: 'local-model',
        maxInputTokens: 8_000,
        maxOutputTokens: 500,
        temperature: 0,
        timeoutMs: 5_000,
        requireJson: false,
        allowFrontierFallback: slotAllowsFrontier,
      },
    }),
    auxiliaryLlmQuickModel: '',
    auxiliaryLlmQualityModel: '',
  };
}

function guardSettings(policy: LocalAiFallbackPolicy) {
  return {
    localAiGuardDefaultFallbackPolicy: policy,
    localAiGuardDailyFallbackBudgetUsd: null,
    localAiGuardConfirmAboveInputTokens: null,
  } satisfies Pick<
    AppSettings,
    | 'localAiGuardDefaultFallbackPolicy'
    | 'localAiGuardDailyFallbackBudgetUsd'
    | 'localAiGuardConfirmAboveInputTokens'
  >;
}

function harness(
  policy: LocalAiFallbackPolicy,
  createTarget = true,
  targetOverrides: Partial<LocalAiTargetConfig> = {},
) {
  const db = openDb();
  const targets = new LocalAiTargetRepository(db, undefined, () => 1_000);
  const target = createTarget
    ? targets.create(targetConfig({ fallbackPolicy: policy, ...targetOverrides }))
    : undefined;
  const health = new LocalAiHealthRepository(db, undefined, () => 1_000);
  const approvals = new LocalAiFallbackApprovalService(health, {
    now: () => 1_000,
    createId: () => 'approval-1',
    schedule: () => 1,
    cancelScheduled: () => undefined,
  });
  const activity = new LocalAiActivityRegistry();
  let status = target ? healthyStatus(target.id) : undefined;
  const ensureFresh = vi.fn(async (targetId: string) => {
    if (!status) throw new Error('target invalidated');
    return status.targetId === targetId ? status : healthyStatus(targetId);
  });
  const invalidateTarget = vi.fn((targetId: string) => {
    status = {
      ...healthyStatus(targetId),
      state: 'unavailable',
      routableRoles: [],
      consecutiveFailures: 3,
      consecutiveSuccesses: 0,
    };
  });
  const guard = new LocalAiRoutingGuard({
    targets,
    scheduler: {
      getStatus: () => status,
      ensureFresh,
    },
    health,
    approvals,
    settings: () => guardSettings(policy),
    now: () => 1_000,
    createId: (() => {
      let id = 0;
      return () => `routing-${id += 1}`;
    })(),
  });
  __setLocalAiAuxiliaryHooksForTesting({
    findTarget: (identity) => targets.findByEndpoint(identity),
    evaluateLocalTarget: (input) => guard.evaluateLocalTarget(input),
    acquireTarget: (targetId) => activity.acquire(targetId),
    invalidateTarget,
    authorizeFallback: (input) => guard.authorizeFallback(input),
    markFallbackDispatched: (eventId) => guard.markFallbackDispatched(eventId),
  });
  disposers.push(subscribeCostAttribution((record) => {
    applyLocalAiRoutingCostAttribution({ health } as never, record);
  }));
  return {
    targets, target, health, approvals, activity, ensureFresh, invalidateTarget, guard,
  };
}

async function configuredService(slotAllowsFrontier = true): Promise<AuxiliaryLlmService> {
  AuxiliaryLlmService._resetForTesting();
  const service = AuxiliaryLlmService.getInstance();
  service.configure(serviceSettings(slotAllowsFrontier));
  return service;
}

describe('Local AI Guard auxiliary integration', () => {
  const previousAttributionFlag = process.env['AIO_COST_ATTRIBUTION'];

  beforeEach(() => {
    vi.clearAllMocks();
    modelClient.probe.mockResolvedValue(true);
    modelClient.list.mockResolvedValue([{
      id: 'local-model',
      name: 'local-model',
      provider: 'openai-compatible',
      endpointId: 'ep-local',
    }]);
    process.env['AIO_COST_ATTRIBUTION'] = '0';
    _resetCostAttributionForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuxiliaryRemoteHooksForTesting();
    __resetLocalAiAuxiliaryHooksForTesting();
    AuxiliaryLlmService._resetForTesting();
    if (previousAttributionFlag === undefined) delete process.env['AIO_COST_ATTRIBUTION'];
    else process.env['AIO_COST_ATTRIBUTION'] = previousAttributionFlag;
    _resetCostAttributionForTesting();
    for (const dispose of disposers.splice(0)) dispose();
    for (const db of dbs.splice(0)) db.close();
  });

  it('checks an enrolled target and holds its activity lease for the local generation', async () => {
    const setup = harness('notify-and-allow');
    modelClient.generate.mockImplementation(async () => {
      expect(setup.activity.isBusy(setup.target!.id)).toBe(true);
      return 'local result';
    });
    const service = await configuredService();

    const result = await service.generate('compression', 'system', 'user prompt');

    expect(result.text).toBe('local result');
    expect(result.decision).toMatchObject({
      source: 'local',
      intendedTargetId: setup.target!.id,
    });
    expect(setup.ensureFresh).toHaveBeenCalledWith(setup.target!.id, 'compression');
    expect(setup.activity.isBusy(setup.target!.id)).toBe(false);
  });

  it('invalidates an enrolled target after local generation fails before authorizing fallback', async () => {
    const setup = harness('notify-and-allow');
    modelClient.generate.mockRejectedValue(new Error('authentication failed'));
    const service = await configuredService();

    const result = await service.generate('compression', 'system', 'user prompt');

    expect(setup.invalidateTarget).toHaveBeenCalledWith(setup.target!.id);
    expect(result.decision).toMatchObject({
      source: 'fallback',
      intendedTargetId: setup.target!.id,
      fallbackDisposition: 'allowed',
      allowFrontierFallback: true,
    });
    expect(setup.health.getRoutingEvent(result.decision.localAiRoutingEventId!)).toMatchObject({
      targetId: setup.target!.id,
      disposition: 'allowed',
    });
  });

  it('invalidates a managed worker target when RPC returns schema-valid empty text', async () => {
    const workerEndpoint = {
      id: 'worker-ep',
      label: 'Managed worker',
      provider: 'ollama' as const,
      baseUrl: 'http://127.0.0.1:11434',
      source: 'worker-node' as const,
      workerNodeId: 'node-1',
      enabled: true,
    };
    const setup = harness('notify-and-allow', true, {
      location: { type: 'worker', nodeId: 'node-1' },
      provider: 'ollama',
      endpointId: workerEndpoint.id,
      baseUrl: workerEndpoint.baseUrl,
      expectedModels: [{ modelId: 'local-model', required: true }],
    });
    const rpc = vi.fn().mockResolvedValue({ text: '' });
    __setAuxiliaryRemoteHooksForTesting({
      isNodeConnected: () => true,
      sendServiceRpc: <T>() => rpc() as Promise<T>,
      connectedWorkerNodes: () => [{
        id: 'node-1',
        name: 'Worker',
        status: 'connected',
        capabilities: {
          localModelEndpoints: [{
            provider: 'ollama',
            baseUrl: workerEndpoint.baseUrl,
            models: ['local-model'],
            healthy: true,
          }],
        },
      }] as never,
    });
    const service = await configuredService();
    service.configure({
      ...serviceSettings(true),
      auxiliaryLlmAllowRemoteWorkerModels: true,
      auxiliaryLlmEndpointsJson: JSON.stringify([workerEndpoint]),
      auxiliaryLlmSlotsJson: JSON.stringify({
        compression: {
          enabled: true,
          provider: 'ollama',
          endpointId: workerEndpoint.id,
          model: 'local-model',
          maxInputTokens: 8_000,
          maxOutputTokens: 500,
          temperature: 0,
          timeoutMs: 5_000,
          requireJson: false,
          allowFrontierFallback: true,
        },
      }),
    });

    const result = await service.generate('compression', 'system', 'user prompt');

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result.decision).toMatchObject({
      source: 'fallback',
      intendedTargetId: setup.target!.id,
      localAiRoutingEventId: 'routing-1',
    });
    expect(setup.invalidateTarget).toHaveBeenCalledWith(setup.target!.id);
    await expect(setup.guard.evaluateLocalTarget({
      targetId: setup.target!.id,
      slot: 'compression',
    })).resolves.toMatchObject({ eligible: false, reason: 'health-unavailable' });
  });

  it('invalidates a guard-approved managed target when its endpoint probe fails', async () => {
    const setup = harness('notify-and-allow');
    modelClient.probe.mockResolvedValue(false);
    const service = await configuredService();

    const result = await service.generate('compression', 'system', 'user prompt');

    expect(setup.ensureFresh).toHaveBeenCalledWith(setup.target!.id, 'compression');
    expect(setup.invalidateTarget).toHaveBeenCalledWith(setup.target!.id);
    expect(result.decision).toMatchObject({
      source: 'fallback',
      intendedTargetId: setup.target!.id,
    });
  });

  it('invalidates a guard-approved managed target when model listing throws', async () => {
    const setup = harness('notify-and-allow');
    modelClient.list.mockRejectedValue(new Error('model endpoint failed'));
    const service = await configuredService();

    const result = await service.generate('compression', 'system', 'user prompt');

    expect(setup.invalidateTarget).toHaveBeenCalledWith(setup.target!.id);
    expect(result.decision).toMatchObject({
      source: 'fallback',
      intendedTargetId: setup.target!.id,
    });
  });

  it('invalidates a guard-approved managed target when its required model disappears', async () => {
    const setup = harness('notify-and-allow');
    modelClient.list.mockResolvedValue([{
      id: 'different-model',
      name: 'different-model',
      provider: 'openai-compatible',
      endpointId: 'ep-local',
    }]);
    const service = await configuredService();

    const result = await service.generate('compression', 'system', 'user prompt');

    expect(setup.invalidateTarget).toHaveBeenCalledWith(setup.target!.id);
    expect(result.decision).toMatchObject({
      source: 'fallback',
      intendedTargetId: setup.target!.id,
    });
  });

  it('keeps an unmanaged endpoint compatible without inventing a target identity', async () => {
    const setup = harness('notify-and-allow', false);
    modelClient.generate.mockResolvedValue('unmanaged result');
    const service = await configuredService();

    const result = await service.generate('compression', 'system', 'user prompt');

    expect(result.text).toBe('unmanaged result');
    expect(result.decision.source).toBe('cheap-cloud');
    expect(result.decision.intendedTargetId).toBeUndefined();
    expect(setup.ensureFresh).not.toHaveBeenCalled();
  });

  it.each([
    ['defer-locally', 'deferred'],
    ['block-paid-fallback', 'blocked'],
  ] as const)('maps %s authorization to a non-frontier %s decision', async (policy, disposition) => {
    harness(policy, false);
    modelClient.probe.mockResolvedValue(false);
    const service = await configuredService(true);

    const { decision } = await service.generate('compression', 'system', 'user prompt');

    expect(decision).toMatchObject({
      source: 'fallback',
      allowFrontierFallback: false,
      fallbackDisposition: disposition,
    });
  });

  it('waits for durable confirmation resolution before returning the fallback decision', async () => {
    const setup = harness('require-confirmation', false);
    modelClient.probe.mockResolvedValue(false);
    const service = await configuredService(true);

    let settled = false;
    const generation = service.generate('compression', 'system', 'user prompt')
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(setup.approvals.listPending()).toHaveLength(1));
    expect(settled).toBe(false);

    setup.approvals.resolve('approval-1', 'allow-once');
    const { decision } = await generation;

    expect(decision).toMatchObject({
      allowFrontierFallback: true,
      fallbackDisposition: 'allowed',
      localAiRoutingEventId: 'routing-1',
    });
  });

  it('patches the routing event from a real LLMService paid provider winner', async () => {
    const setup = harness('notify-and-allow', false);
    modelClient.probe.mockResolvedValue(false);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/tags')) return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'frontier summary' }],
          usage: { input_tokens: 21, output_tokens: 7 },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { LLMService, getLLMService } = await import('../rlm/llm-service');
    LLMService._resetForTesting();
    const llm = getLLMService({
      provider: 'anthropic',
      anthropicApiKey: 'test-placeholder',
      model: 'haiku',
    });
    const attributed: unknown[] = [];
    const unsubscribe = subscribeCostAttribution((record) => attributed.push(record));

    await llm.summarize({
      requestId: 'real-provider',
      content: 'content requiring a frontier summary',
      targetTokens: 50,
      preserveKeyPoints: false,
    });
    unsubscribe();

    const event = setup.health.getRoutingEvent('routing-1');
    expect(event?.provider).toBe('anthropic');
    expect(event?.model).toBe('haiku');
    expect(event?.inputTokens).toBe(21);
    expect(event?.outputTokens).toBe(7);
    expect(event?.estimatedCostUsd).toEqual(expect.any(Number));
    expect(event?.completedAt).toBe(1_000);
    expect(attributed.filter((record) => (
      (record as { correlationId?: string }).correlationId === 'routing-1'
    ))).toHaveLength(1);
  });

  it('durably marks dispatch before invoking the paid provider exactly once', async () => {
    const order: string[] = [];
    const mark = vi.fn(async () => {
      order.push('mark');
    });
    __setLocalAiAuxiliaryHooksForTesting({
      findTarget: () => undefined,
      evaluateLocalTarget: async () => ({ eligible: true, reason: 'test' }),
      acquireTarget: () => () => undefined,
      invalidateTarget: () => undefined,
      authorizeFallback: async () => ({
        allowed: true,
        disposition: 'allowed',
        policy: 'allow-silently',
        routingEventId: 'routing-order',
      }),
      markFallbackDispatched: mark,
    });
    const run = vi.fn(async () => {
      order.push('run');
      return 'ok';
    });

    await expect(runAuthorizedFrontierFallback({
      slot: 'compression',
      provider: 'local-fallback',
      source: 'fallback',
      reason: 'test',
      allowFrontierFallback: true,
      fallbackDisposition: 'allowed',
      localAiRoutingEventId: 'routing-order',
    }, () => runCorrelatedPaidFrontierCall(run))).resolves.toBe('ok');

    expect(order).toEqual(['mark', 'run']);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('prevents provider invocation when durable dispatch marking fails', async () => {
    const run = vi.fn(async () => 'must not run');
    __setLocalAiAuxiliaryHooksForTesting({
      findTarget: () => undefined,
      evaluateLocalTarget: async () => ({ eligible: true, reason: 'test' }),
      acquireTarget: () => () => undefined,
      invalidateTarget: () => undefined,
      authorizeFallback: async () => ({
        allowed: true,
        disposition: 'allowed',
        policy: 'allow-silently',
        routingEventId: 'routing-fail',
      }),
      markFallbackDispatched: async () => {
        throw new Error('durable mark failed');
      },
    });

    await expect(runAuthorizedFrontierFallback({
      slot: 'compression',
      provider: 'local-fallback',
      source: 'fallback',
      reason: 'test',
      allowFrontierFallback: true,
      fallbackDisposition: 'allowed',
      localAiRoutingEventId: 'routing-fail',
    }, () => runCorrelatedPaidFrontierCall(run))).rejects.toThrow('durable mark failed');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps a rejected provider durably marked exactly once', async () => {
    const mark = vi.fn(async () => undefined);
    __setLocalAiAuxiliaryHooksForTesting({
      findTarget: () => undefined,
      evaluateLocalTarget: async () => ({ eligible: true, reason: 'test' }),
      acquireTarget: () => () => undefined,
      invalidateTarget: () => undefined,
      authorizeFallback: async () => ({
        allowed: true,
        disposition: 'allowed',
        policy: 'allow-silently',
        routingEventId: 'routing-reject',
      }),
      markFallbackDispatched: mark,
    });

    await expect(runAuthorizedFrontierFallback({
      slot: 'compression',
      provider: 'local-fallback',
      source: 'fallback',
      reason: 'test',
      allowFrontierFallback: true,
      fallbackDisposition: 'allowed',
      localAiRoutingEventId: 'routing-reject',
    }, () => runCorrelatedPaidFrontierCall(async () => {
      throw new Error('provider rejected');
    }))).rejects.toThrow('provider rejected');
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it('does not mark dispatch when an authorized scope resolves locally', async () => {
    const mark = vi.fn();
    __setLocalAiAuxiliaryHooksForTesting({
      findTarget: () => undefined,
      evaluateLocalTarget: async () => ({ eligible: true, reason: 'test' }),
      acquireTarget: () => () => undefined,
      invalidateTarget: () => undefined,
      authorizeFallback: async () => ({
        allowed: true,
        disposition: 'allowed',
        policy: 'allow-silently',
        routingEventId: 'routing-local',
      }),
      markFallbackDispatched: mark,
    });

    await expect(runAuthorizedFrontierFallback({
      slot: 'compression',
      provider: 'local-fallback',
      source: 'fallback',
      reason: 'test',
      allowFrontierFallback: true,
      fallbackDisposition: 'allowed',
      localAiRoutingEventId: 'routing-local',
    }, async () => 'local result')).resolves.toBe('local result');

    expect(mark).not.toHaveBeenCalled();
  });

  it('publishes estimated local tokens without a dollar cost even when JSONL is disabled', async () => {
    harness('notify-and-allow');
    modelClient.generate.mockResolvedValue('local result');
    const records: Parameters<Parameters<typeof subscribeCostAttribution>[0]>[0][] = [];
    const unsubscribe = subscribeCostAttribution((record) => records.push(record));
    const service = await configuredService();

    await service.generate('compression', 'system', 'user prompt');
    unsubscribe();

    expect(records).toContainEqual(expect.objectContaining({
      source: 'auxiliary',
      auxRoutedTo: 'local',
      costKnown: false,
      usage: expect.objectContaining({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      }),
    }));
    expect(records.find((record) => record.auxRoutedTo === 'local')?.usage?.cost).toBeUndefined();
  });
});
