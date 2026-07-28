import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type {
  LocalAiEndpointIdentity,
  LocalAiTarget,
} from '../../../shared/types/local-ai-guard.types';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { LocalAiTargetRepository } from '../../local-ai-guard/local-ai-target-repository';
import { RLM_MIGRATIONS_051_055 } from '../../persistence/rlm/rlm-migrations-051-055';
import type { IpcResponse } from '../validated-handler';

type Handler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  removeHandler: vi.fn(),
  registeredCleanup: null as (() => void) | null,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => mocks.handlers.set(channel, handler)),
    removeHandler: mocks.removeHandler,
  },
}));

vi.mock('../../util/cleanup-registry', () => ({
  registerCleanup: vi.fn((cleanup: () => void) => {
    mocks.registeredCleanup = cleanup;
    return vi.fn();
  }),
}));

import { registerLocalAiGuardHandlers } from './local-ai-guard-handlers';

describe('registerLocalAiGuardHandlers', () => {
  beforeEach(() => {
    mocks.registeredCleanup?.();
    mocks.registeredCleanup = null;
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers every request channel exactly once and re-registration tears down the old bridge', async () => {
    const first = harness();
    first.register();
    expect([...mocks.handlers.keys()].sort()).toEqual(requestChannels().sort());

    const second = harness();
    second.register();
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect([...mocks.handlers.keys()].sort()).toEqual(requestChannels().sort());
  });

  it('serves a bounded snapshot projection and never exposes repository rows', async () => {
    const h = harness();
    h.register();
    const response = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT);

    expect(response).toEqual({
      success: true,
      data: {
        revision: '0',
        aggregate: {
          state: 'healthy', enrolled: 1, healthy: 1, degraded: 0,
          unavailable: 0, paused: 0,
        },
        targets: [h.status],
        targetConfigs: [h.target],
        incidents: [h.incident],
        recoveryAttempts: [{
          id: 'attempt-1',
          targetId: 'target-1',
          action: 'restart-ollama',
          attemptNumber: 1,
          claimedAt: 1,
          outcome: 'not-recovered',
          supported: true,
          attempted: true,
          recovered: false,
        }],
        pendingFallbacks: [h.pending],
      },
    });
    expect(h.runtime.health.listIncidents).toHaveBeenCalledWith({ limit: 100 });
    expect(h.runtime.health.listRecoveryAttempts).toHaveBeenCalledWith('target-1');
    expect(JSON.stringify(response)).not.toContain('config_json');
    expect(JSON.stringify(response)).not.toContain('routing_events');
  });

  it('requires a trusted sender for every active operation before touching runtime state', async () => {
    const trustError = {
      success: false,
      error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
    };
    const h = harness({ trustError });
    h.register();

    for (const [channel, payload] of trustedOperationRequests()) {
      await expect(invoke(channel, payload)).resolves.toEqual(trustError);
    }
    expect(h.ensureTrustedSender).toHaveBeenCalledTimes(trustedOperationRequests().length);
    expect(h.runtime.targets.create).not.toHaveBeenCalled();
    expect(h.runtime.scheduler.recheck).not.toHaveBeenCalled();
    expect(h.runtime.approvals.resolve).not.toHaveBeenCalled();
  });

  it('rejects untrusted discovery before parsing or invoking credential and probe work', async () => {
    const trustError = {
      success: false,
      error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
    };
    const credentialResolver = vi.fn();
    const probe = vi.fn();
    const h = harness({
      trustError,
      discoverOperation: async () => {
        credentialResolver();
        probe();
        return [];
      },
    });
    h.register();

    const untrustedResponse = await invoke(
      IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER,
      { unexpected: 'payload-must-not-be-parsed-first' },
    );
    expect(credentialResolver).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(h.discoverCandidates).not.toHaveBeenCalled();
    expect(h.runtime.targets.list).not.toHaveBeenCalled();
    expect(h.runtime.notifyChanged).not.toHaveBeenCalled();
    expect(h.sendToRenderer).not.toHaveBeenCalled();
    expect(untrustedResponse).toEqual(trustError);
    expect(h.ensureTrustedSender).toHaveBeenCalledWith(
      expect.anything(),
      IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER,
    );

    h.ensureTrustedSender.mockReturnValue(null);
    await expect(invoke(IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER)).resolves.toEqual({
      success: true,
      data: [],
    });
    expect(h.discoverCandidates).toHaveBeenCalledOnce();
    expect(credentialResolver).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
  });

  it('strictly validates mutations and bounded query discriminants', async () => {
    const h = harness();
    h.register();

    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE, {
      targetId: '', patch: { baseUrl: 'https://public.example.com' },
    })).error?.code).toBe('VALIDATION_FAILED');
    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK, {
      targetId: 'target-1', kind: 'unbounded',
    })).error?.code).toBe('VALIDATION_FAILED');
    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY, {
      window: '365d',
    })).error?.code).toBe('VALIDATION_FAILED');
    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE, {
      requestId: 'request-1', resolution: 'approve-everything',
    })).error?.code).toBe('VALIDATION_FAILED');
    expect(h.runtime.targets.update).not.toHaveBeenCalled();
  });

  it('rejects out-of-policy numeric create, update, and validate requests before trusted services', async () => {
    const h = harness();
    h.register();

    const createConfig = targetConfig();
    createConfig.endpointCheckIntervalMs = 1;
    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE, {
      config: createConfig,
    })).error?.code).toBe('VALIDATION_FAILED');
    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE, {
      targetId: 'target-1',
      patch: { recovery: { automatic: true, maxAttempts: 1.5, cooldownMs: 60_000 } },
    })).error?.code).toBe('VALIDATION_FAILED');
    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE, {
      config: { ...targetConfig(), warningLatencyMs: 1_000_000_000 },
    })).error?.code).toBe('VALIDATION_FAILED');

    expect(h.runtime.targets.create).not.toHaveBeenCalled();
    expect(h.runtime.targets.update).not.toHaveBeenCalled();
    expect(h.runtime.probes.check).not.toHaveBeenCalled();
  });

  it('rejects invalid target model relationships before trusted create, update, or validation services', async () => {
    const h = harness();
    h.register();
    const duplicateModels = [
      targetConfig().expectedModels[0],
      { ...targetConfig().expectedModels[0], required: false },
    ];

    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE, {
      config: { ...targetConfig(), expectedModels: duplicateModels },
    })).error?.code).toBe('VALIDATION_FAILED');
    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE, {
      config: {
        ...targetConfig(),
        canary: { ...targetConfig().canary, model: 'not-expected' },
      },
    })).error?.code).toBe('VALIDATION_FAILED');
    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE, {
      targetId: 'target-1',
      patch: {
        expectedModels: targetConfig().expectedModels,
        canary: { ...targetConfig().canary, model: 'not-expected' },
      },
    })).error?.code).toBe('VALIDATION_FAILED');
    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE, {
      config: { ...targetConfig(), expectedModels: duplicateModels },
    })).error?.code).toBe('VALIDATION_FAILED');

    expect(h.runtime.targets.create).not.toHaveBeenCalled();
    expect(h.runtime.targets.update).not.toHaveBeenCalled();
    expect(h.runtime.probes.check).not.toHaveBeenCalled();
  });

  it('routes validated lifecycle, recovery, summary, and fallback operations to live services', async () => {
    const h = harness();
    h.register();

    await expect(invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE, {
      config: targetConfig(),
    })).resolves.toMatchObject({ success: true, data: h.target });
    await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE, {
      targetId: 'target-1', patch: { warningLatencyMs: 2_000 },
    });
    await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE, {
      targetId: 'target-1', lifecycle: 'paused', pausedUntil: 5_000,
    });
    await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK, {
      targetId: 'target-1', kind: 'functional',
    });
    await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE, {
      incidentId: 'incident-1',
    });
    await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_DIAGNOSE, { targetId: 'target-1' });
    const repairResponse = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR, {
      targetId: 'target-1', action: 'restart-ollama', mode: 'automatic',
    });
    await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY, { window: '30d' });
    await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_LIST);
    await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE, {
      requestId: 'request-1', resolution: 'defer',
    });

    expect(h.runtime.targets.update).toHaveBeenCalledWith(
      'target-1', { warningLatencyMs: 2_000 },
    );
    expect(h.runtime.targets.setLifecycle).toHaveBeenCalledWith(
      'target-1',
      'paused',
      { pausedUntil: 5_000 },
    );
    expect(h.runtime.scheduler.recheck).toHaveBeenCalledWith('target-1', 'functional');
    expect(h.runtime.incidents.acknowledge).toHaveBeenCalledWith('incident-1');
    expect(h.runtime.recovery.diagnose).toHaveBeenCalledWith('target-1');
    expect(h.runtime.recovery.repair).toHaveBeenCalledWith(
      'target-1', 'restart-ollama', 'automatic',
    );
    expect(repairResponse).toMatchObject({
      success: true,
      data: { outcome: 'guided' },
    });
    expect(h.runtime.health.summarize).toHaveBeenCalledWith('30d');
    expect(h.runtime.approvals.resolve).toHaveBeenCalledWith('request-1', 'defer');
  });

  it('discovers safe endpoint metadata and validates through the real probe without persisting', async () => {
    const h = harness();
    h.register();

    const discovered = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER);
    expect(discovered).toEqual({
      success: true,
      data: [{
        identity: {
          location: { type: 'worker', nodeId: 'worker-1' },
          provider: 'ollama',
          endpointId: 'worker-ollama',
          baseUrl: 'http://127.0.0.1:11434',
        },
        label: 'Worker Ollama',
        models: ['qwen3:14b'],
        healthy: true,
      }],
    });
    expect(JSON.stringify(discovered)).not.toContain('SECRET_RESOLVER');

    const validated = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE, {
      config: targetConfig(),
    });
    expect(validated).toMatchObject({
      success: true,
      data: [{ targetId: expect.any(String), layer: 'endpoint' }],
    });
    expect(h.runtime.probes.check).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: 'enrolled', id: expect.any(String) }),
      'functional',
    );
    expect(h.runtime.targets.create).not.toHaveBeenCalled();
  });

  it('omits unsafe or oversized discovery candidates and preserves a valid sanitized candidate', async () => {
    const h = harness({
      discoverCandidates: [
        candidate({
          id: 'valid-endpoint',
          label: 'Valid Local Endpoint',
          baseUrl: 'http://127.0.0.1:11434/',
          modelId: 'qwen3:14b',
        }),
        candidate({
          id: 'userinfo-endpoint',
          baseUrl: 'http://user:CREDENTIAL_SECRET@127.0.0.1:11434',
        }),
        candidate({
          id: 'query-endpoint',
          baseUrl: 'http://127.0.0.1:11434?api_key=QUERY_SECRET',
        }),
        candidate({ id: 'malformed-endpoint', baseUrl: 'not-a-url' }),
        candidate({ id: 'oversized-url', baseUrl: `http://127.0.0.1/${'u'.repeat(2_100)}` }),
        candidate({ id: 'oversized-label', label: `LABEL_SECRET${'l'.repeat(300)}` }),
        candidate({ id: 'oversized-model', modelId: `MODEL_SECRET${'m'.repeat(300)}` }),
      ],
    });
    h.register();

    const response = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER);

    expect(response).toEqual({
      success: true,
      data: [{
        identity: {
          location: { type: 'worker', nodeId: 'worker-1' },
          provider: 'ollama',
          endpointId: 'valid-endpoint',
          baseUrl: 'http://127.0.0.1:11434',
        },
        label: 'Valid Local Endpoint',
        models: ['qwen3:14b'],
        healthy: true,
      }],
    });
    expect(JSON.stringify(response)).not.toMatch(
      /CREDENTIAL_SECRET|QUERY_SECRET|LABEL_SECRET|MODEL_SECRET/,
    );
  });

  it('uses exact identity lookups and stops candidate projection at the public cap', async () => {
    let candidateReads = 0;
    let targetReads = 0;
    const targets = Array.from({ length: 1_000 }, (_, index) => {
      const endpointId = `endpoint-${index}`;
      return {
        ...targetConfig(),
        id: `target-${index}`,
        label: `Target ${index}`,
        location: { type: 'worker' as const, nodeId: 'worker-1' },
        baseUrl: `http://127.0.0.1:${20_000 + index}`,
        createdAt: 1,
        updatedAt: 1,
        get endpointId() {
          targetReads += 1;
          return endpointId;
        },
      };
    });
    const discoverCandidates = Array.from({ length: 1_001 }, (_, index) => {
      const value = candidate({
        id: `endpoint-${index}`,
        baseUrl: `http://127.0.0.1:${20_000 + index}`,
      }) as { endpoint: unknown; models: unknown; healthy: unknown; reason: unknown };
      return {
        models: value.models,
        healthy: value.healthy,
        reason: value.reason,
        get endpoint() {
          candidateReads += 1;
          return value.endpoint;
        },
      };
    });
    const h = harness({ discoverCandidates, targets });
    h.register();

    const response = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER);

    expect(response.success).toBe(true);
    expect((response.data as unknown[])).toHaveLength(1_000);
    expect(candidateReads).toBe(1_000);
    expect(targetReads).toBe(1_000);
    expect(h.runtime.targets.findByEndpoint).toHaveBeenCalledTimes(1_000);
    expect(h.runtime.targets.list).not.toHaveBeenCalled();
  });

  it('links a candidate through real persistence when its active target is beyond the snapshot page', async () => {
    const db = defaultDriverFactory(':memory:');
    const migration = RLM_MIGRATIONS_051_055.find(
      (item) => item.name === '054_local_ai_guard',
    );
    if (!migration) throw new Error('Missing migration 054_local_ai_guard');
    db.exec(migration.up);
    let now = 0;
    let discoveredBaseUrl = 'http://127.0.0.1:11434';
    const repository = new LocalAiTargetRepository(db, undefined, () => ++now);
    try {
      for (let index = 0; index < 1_000; index += 1) {
        repository.create({
          ...targetConfig(),
          location: { type: 'worker', nodeId: 'worker-1' },
          endpointId: `other-endpoint-${index}`,
          baseUrl: `http://127.0.0.1:${20_000 + index}`,
        });
      }
      const matching = repository.create({
        ...targetConfig(),
        location: { type: 'worker', nodeId: 'worker-1' },
        endpointId: 'worker-ollama',
        baseUrl: 'http://127.0.0.1:11434',
      });
      expect(repository.list()).toHaveLength(1_000);

      const h = harness({
        discoverOperation: async () => [candidate({
          id: 'worker-ollama',
          baseUrl: discoveredBaseUrl,
        })],
      });
      h.runtime.targets = repository as never;
      h.register();

      const expectedEndpoint = {
        identity: {
          location: { type: 'worker' as const, nodeId: 'worker-1' },
          provider: 'ollama' as const,
          endpointId: 'worker-ollama',
          baseUrl: discoveredBaseUrl,
        },
        label: 'Worker Ollama',
        models: ['qwen3:14b'],
        healthy: true,
      };
      await expect(invoke(IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER)).resolves.toEqual({
        success: true,
        data: [{ ...expectedEndpoint, enrolledTargetId: matching.id }],
      });

      discoveredBaseUrl = 'http://127.0.0.1:22434';
      repository.update(matching.id, { baseUrl: discoveredBaseUrl });
      await expect(invoke(IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER)).resolves.toEqual({
        success: true,
        data: [{
          ...expectedEndpoint,
          identity: { ...expectedEndpoint.identity, baseUrl: discoveredBaseUrl },
          enrolledTargetId: matching.id,
        }],
      });

      repository.setLifecycle(matching.id, 'retired');
      await expect(invoke(IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER)).resolves.toEqual({
        success: true,
        data: [{
          ...expectedEndpoint,
          identity: { ...expectedEndpoint.identity, baseUrl: discoveredBaseUrl },
        }],
      });
    } finally {
      db.close();
    }
  });

  it('returns a bounded deterministic failure when summary maps exceed the entry limit', async () => {
    const first = summary({
      byTarget: Object.fromEntries(
        Array.from({ length: 5_000 }, (_, index) => [`target-${index.toString().padStart(4, '0')}`, 1]),
      ),
    });
    const second = summary({
      byTarget: Object.fromEntries(Object.entries(first.byTarget).reverse()),
    });
    const h = harness({ summary: first });
    h.runtime.health.summarize
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    h.register();

    const responses = [
      await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY, { window: '30d' }),
      await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY, { window: '30d' }),
    ];

    for (const response of responses) {
      expect(response).toMatchObject({
        success: false,
        error: {
          code: 'LOCAL_AI_GUARD_SUMMARY_FAILED',
          message: 'The Local AI Guard operation could not be completed.',
        },
      });
      expect(JSON.stringify(response).length).toBeLessThan(512);
      expect(JSON.stringify(response)).not.toContain('target-4999');
    }
  });

  it('rejects overlong summary keys while preserving valid bounded totals and breakdowns', async () => {
    const valid = summary({
      localTasks: 7,
      knownCostUsd: 1.25,
      estimatedCostUsd: 2.5,
      byTarget: { 'target-1': 7 },
      byModel: { 'qwen3:14b': 7 },
      byIncident: { 'incident-1': 2 },
    });
    const h = harness({ summary: valid });
    h.runtime.health.summarize
      .mockReturnValueOnce(summary({ byModel: { [`MODEL_SECRET${'m'.repeat(300)}`]: 1 } }))
      .mockReturnValueOnce(valid);
    h.register();

    const rejected = await invoke(
      IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY,
      { window: '30d' },
    );
    expect(rejected).toMatchObject({
      success: false,
      error: { code: 'LOCAL_AI_GUARD_SUMMARY_FAILED' },
    });
    expect(JSON.stringify(rejected)).not.toContain('MODEL_SECRET');

    await expect(invoke(
      IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY,
      { window: '30d' },
    )).resolves.toEqual({ success: true, data: valid });
  });

  it('validates every service-owned result before it crosses the renderer boundary', async () => {
    const h = harness();
    const oversized = `BOUNDARY_SECRET${'x'.repeat(4_100)}`;
    const malformedTarget = { ...h.target, label: oversized };
    const malformedStatus = { ...h.status, targetId: oversized };
    const malformedIncident = { ...h.incident, id: oversized };
    const malformedPending = { ...h.pending, id: oversized };
    h.runtime.targets.create.mockReturnValue(malformedTarget);
    h.runtime.targets.update.mockReturnValue(malformedTarget);
    h.runtime.targets.setLifecycle.mockReturnValue(malformedTarget);
    h.runtime.probes.check.mockResolvedValue([{
      targetId: 'target-1',
      layer: 'endpoint',
      checkType: 'functional',
      ok: false,
      required: true,
      affectedRoles: ['compression'],
      checkedAt: 1,
      durationMs: 1,
      evidence: { errorKind: oversized },
    }] as never);
    h.runtime.scheduler.recheck.mockResolvedValue(malformedStatus);
    h.runtime.incidents.acknowledge.mockReturnValue(malformedIncident);
    h.runtime.recovery.diagnose.mockResolvedValue({
      targetId: 'target-1',
      checkedAt: 1,
      samples: Array.from({ length: 5_000 }, () => ({
        targetId: 'target-1',
        layer: 'endpoint',
        checkType: 'functional',
        ok: true,
        required: true,
        affectedRoles: [],
        checkedAt: 1,
        durationMs: 1,
        evidence: {},
      })),
      recommendedActions: [],
    } as never);
    h.runtime.recovery.repair.mockResolvedValue({
      targetId: 'target-1',
      action: 'restart-ollama',
      outcome: 'guided',
      supported: true,
      attempted: false,
      recovered: false,
      message: oversized,
      completedAt: 1,
    });
    h.runtime.approvals.listPending.mockReturnValue([malformedPending]);
    h.runtime.approvals.resolve.mockReturnValue(malformedPending as never);
    h.register();

    const responses = await Promise.all([
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE, { config: targetConfig() }),
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE, {
        targetId: 'target-1',
        patch: { warningLatencyMs: 2_000 },
      }),
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE, {
        targetId: 'target-1',
        lifecycle: 'paused',
      }),
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE, { config: targetConfig() }),
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK, {
        targetId: 'target-1',
        kind: 'functional',
      }),
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE, {
        incidentId: 'incident-1',
      }),
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_DIAGNOSE, { targetId: 'target-1' }),
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR, {
        targetId: 'target-1',
        action: 'restart-ollama',
        mode: 'automatic',
      }),
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_LIST),
      invoke(IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE, {
        requestId: 'request-1',
        resolution: 'defer',
      }),
    ]);

    expect(responses).toHaveLength(10);
    for (const response of responses) {
      expect(response.success).toBe(false);
      expect(JSON.stringify(response)).not.toContain('BOUNDARY_SECRET');
      expect(JSON.stringify(response).length).toBeLessThan(512);
    }
  });

  it('enforces every canonical repair outcome tuple at the public IPC exit', async () => {
    const h = harness();
    const base = {
      targetId: 'target-1',
      action: 'restart-ollama',
      message: 'Safe repair result.',
      completedAt: 1,
    };
    const canonicalOutcomes = [
      { outcome: 'guided', supported: true, attempted: false, recovered: false },
      { outcome: 'unsupported', supported: false, attempted: false, recovered: false },
      { outcome: 'not-attempted', supported: true, attempted: false, recovered: false },
      { outcome: 'execution-failed', supported: true, attempted: true, recovered: false },
      { outcome: 'completed-not-recovered', supported: true, attempted: true, recovered: false },
      { outcome: 'recovered', supported: true, attempted: true, recovered: true },
    ] as const;
    h.register();

    for (const result of canonicalOutcomes) {
      h.runtime.recovery.repair.mockResolvedValueOnce({ ...base, ...result } as never);
      await expect(invoke(IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR, {
        targetId: 'target-1',
        action: 'restart-ollama',
        mode: 'automatic',
      })).resolves.toEqual({
        success: true,
        data: { ...base, ...result },
      });
    }

    for (const result of canonicalOutcomes.flatMap((canonical) => [
      { ...canonical, supported: !canonical.supported },
      { ...canonical, attempted: !canonical.attempted },
      { ...canonical, recovered: !canonical.recovered },
    ])) {
      h.runtime.recovery.repair.mockResolvedValueOnce({ ...base, ...result } as never);
      const response = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR, {
        targetId: 'target-1',
        action: 'restart-ollama',
        mode: 'automatic',
      });
      expect(response).toMatchObject({
        success: false,
        error: { code: 'LOCAL_AI_GUARD_MUTATION_FAILED' },
      });
      expect(response).not.toHaveProperty('data');
    }
  });

  it('pushes only a bounded snapshot delta and stops every listener and handler on cleanup', async () => {
    const h = harness();
    h.register();
    h.emit();
    await vi.waitFor(() => expect(h.sendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.LOCAL_AI_GUARD_STATUS_DELTA,
      expect.objectContaining({ revision: '1', targets: [h.status] }),
    ));

    const cleanup = mocks.registeredCleanup;
    cleanup?.();
    h.emit();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.removeHandler).toHaveBeenCalledTimes(requestChannels().length);
    expect(h.sendToRenderer).toHaveBeenCalledTimes(1);
  });

  it('retries snapshot construction when the source revision changes mid-build', async () => {
    const h = harness({ changeDuringSnapshot: true });
    h.register();

    const response = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT);

    expect(response).toMatchObject({
      success: true,
      data: { revision: '1', targets: [h.status] },
    });
    // Two builds serve the stable response; the queued revision-1 delta builds once more.
    expect(h.runtime.targets.list).toHaveBeenCalledTimes(3);
  });

  it('coalesces source changes into one delta carrying the latest server revision', async () => {
    const h = harness();
    h.register();

    h.emit();
    h.emit();
    h.emit();

    await vi.waitFor(() => expect(h.sendToRenderer).toHaveBeenCalledOnce());
    expect(h.sendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.LOCAL_AI_GUARD_STATUS_DELTA,
      expect.objectContaining({ revision: '3' }),
    );
  });

  it('redacts repository failures from snapshot error envelopes', async () => {
    const h = harness();
    h.runtime.health.listIncidents.mockImplementation(() => {
      throw new Error('database /private/path SECRET');
    });
    h.register();

    const response = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT);
    expect(response).toMatchObject({
      success: false,
      error: {
        code: 'LOCAL_AI_GUARD_SNAPSHOT_FAILED',
        message: 'The Local AI Guard operation could not be completed.',
      },
    });
    expect(JSON.stringify(response)).not.toContain('SECRET');
    expect(JSON.stringify(response)).not.toContain('/private/path');
  });

  it('fails after three unstable snapshot builds without leaking partial data, then recovers', async () => {
    const h = harness({ snapshotDriftCount: 3 });
    h.register();

    const failed = await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT);
    expect(failed).toMatchObject({
      success: false,
      error: {
        code: 'LOCAL_AI_GUARD_SNAPSHOT_FAILED',
        message: 'The Local AI Guard operation could not be completed.',
      },
    });
    expect(failed).not.toHaveProperty('data');
    expect(JSON.stringify(failed)).not.toContain('snapshot-changed-during-build');

    await expect(invoke(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT)).resolves.toMatchObject({
      success: true,
      data: { revision: '3', targets: [h.status] },
    });
  });

  it('returns the typed unavailable envelope after its runtime is disposed', async () => {
    const h = harness();
    h.register();
    h.runtime.isDisposed = true;

    for (const [channel, payload] of [
      [IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT, undefined],
      [IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER, undefined],
      [IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE, { config: targetConfig() }],
      [IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK, {
        targetId: 'target-1', kind: 'lightweight',
      }],
      [IPC_CHANNELS.LOCAL_AI_GUARD_DIAGNOSE, { targetId: 'target-1' }],
      [IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY, { window: '24h' }],
      [IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_LIST, undefined],
    ] as const) {
      await expect(invoke(channel, payload)).resolves.toMatchObject({
        success: false,
        error: { code: 'LOCAL_AI_GUARD_RUNTIME_UNAVAILABLE' },
      });
    }
    expect(h.runtime.scheduler.recheck).not.toHaveBeenCalled();
    expect(h.runtime.probes.check).not.toHaveBeenCalled();
    expect(h.runtime.recovery.diagnose).not.toHaveBeenCalled();
    expect(h.runtime.health.summarize).not.toHaveBeenCalled();
  });

  it('keeps validated unavailable handlers without leaking initialization errors', async () => {
    const sendToRenderer = vi.fn();
    registerLocalAiGuardHandlers({
      windowManager: { sendToRenderer },
      ensureTrustedSender: vi.fn(() => null),
      getRuntime: () => {
        throw new Error('database /private/path SECRET');
      },
      discoverCandidates: async () => [],
    });

    expect((await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK, {})).error?.code)
      .toBe('VALIDATION_FAILED');
    expect(await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT)).toMatchObject({
      success: false,
      error: {
        code: 'LOCAL_AI_GUARD_RUNTIME_UNAVAILABLE',
        message: 'Local AI Guard is unavailable for this session.',
      },
    });
    expect(JSON.stringify(await invoke(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT)))
      .not.toContain('SECRET');
  });
});

function harness(options: {
  trustError?: IpcResponse | null;
  discoverCandidates?: unknown[];
  discoverOperation?: () => Promise<unknown[]>;
  summary?: unknown;
  targets?: unknown[];
  changeDuringSnapshot?: boolean;
  snapshotDriftCount?: number;
} = {}) {
  let emitListener: (() => void) | null = null;
  const unsubscribe = vi.fn(() => {
    emitListener = null;
  });
  const target = { ...targetConfig(), id: 'target-1', label: 'Local Ollama', createdAt: 1, updatedAt: 1 };
  const status = {
    targetId: 'target-1', lifecycle: 'enrolled' as const, state: 'healthy' as const,
    routableRoles: ['compression' as const], layers: {}, consecutiveFailures: 0,
    consecutiveSuccesses: 2, flapping: false, checkedAt: 1, stateTransitions: [],
  };
  const incident = {
    id: 'incident-1', targetId: 'target-1', state: 'open' as const,
    severity: 'warning' as const, failureCode: 'endpoint-timeout' as const,
    affectedLayers: ['endpoint' as const], affectedRoles: ['compression' as const],
    openedAt: 1, updatedAt: 1, fallbackCount: 0, knownCostUsd: 0, estimatedCostUsd: 0,
  };
  const pending = {
    id: 'request-1', routingEventId: 'event-1', slot: 'compression' as const,
    status: 'pending' as const, estimatedInputTokens: 100, createdAt: 1, expiresAt: 10_000,
  };
  let revision = 0n;
  let changedDuringSnapshot = false;
  let remainingSnapshotDrifts = options.snapshotDriftCount ?? 0;
  let targetIndex: Map<string, LocalAiTarget> | undefined;
  const runtime = {
    get revision() {
      return revision.toString();
    },
    isDisposed: false,
    targets: {
      list: vi.fn(() => {
        if (options.changeDuringSnapshot && !changedDuringSnapshot) {
          changedDuringSnapshot = true;
          runtime.notifyChanged();
        }
        if (remainingSnapshotDrifts > 0) {
          remainingSnapshotDrifts -= 1;
          revision += 1n;
        }
        return (options.targets ?? [target]) as never;
      }),
      findByEndpoint: vi.fn((identity: LocalAiEndpointIdentity) => {
        if (!targetIndex) {
          targetIndex = new Map(
            ((options.targets ?? [target]) as LocalAiTarget[])
              .filter((candidateTarget) => candidateTarget.lifecycle !== 'retired')
              .map((candidateTarget) => [
                targetIdentityKey(candidateTarget),
                candidateTarget,
              ]),
          );
        }
        return targetIndex.get(targetIdentityKey(identity));
      }),
      create: vi.fn(() => target),
      update: vi.fn(() => target),
      setLifecycle: vi.fn(() => target),
    },
    health: {
      listIncidents: vi.fn(() => [incident]),
      listRecoveryAttempts: vi.fn(() => [{
        id: 'attempt-1',
        targetId: 'target-1',
        action: 'restart-ollama',
        attemptNumber: 1,
        claimedAt: 1,
        outcome: 'not-recovered',
        supported: true,
        attempted: true,
        recovered: false,
      }]),
      summarize: vi.fn(() => options.summary ?? summary()),
    },
    probes: {
      check: vi.fn(async (value: { id: string }) => [{
        targetId: value.id, layer: 'endpoint', checkType: 'functional', ok: true,
        required: true, affectedRoles: ['compression'], checkedAt: 1, durationMs: 1,
        evidence: { endpointReachable: true },
      }]),
    },
    engine: {
      checking: vi.fn(() => status),
      aggregate: vi.fn(() => ({
        state: 'healthy', enrolled: 1, healthy: 1, degraded: 0,
        unavailable: 0, paused: 0,
      })),
    },
    scheduler: {
      getStatus: vi.fn(() => status),
      recheck: vi.fn(async () => status),
    },
    incidents: {
      acknowledge: vi.fn(() => ({ ...incident, state: 'acknowledged' })),
    },
    recovery: {
      diagnose: vi.fn(async () => ({ targetId: 'target-1', checkedAt: 1, samples: [] })),
      repair: vi.fn(async () => ({
        targetId: 'target-1', action: 'restart-ollama', outcome: 'guided', supported: true,
        attempted: false, recovered: false, message: 'Guided action.', completedAt: 1,
      })),
    },
    approvals: {
      listPending: vi.fn(() => [pending]),
      resolve: vi.fn(() => ({ ...pending, status: 'deferred', resolution: 'defer' })),
    },
    notifyChanged: vi.fn(() => {
      revision += 1n;
      emitListener?.();
    }),
    subscribe: vi.fn((listener: () => void) => {
      emitListener = listener;
      return unsubscribe;
    }),
  };
  const ensureTrustedSender = vi.fn(() => options.trustError ?? null);
  const sendToRenderer = vi.fn();
  const discoverCandidates = vi.fn(options.discoverOperation ?? (async () =>
    (options.discoverCandidates ?? [{
      endpoint: {
        id: 'worker-ollama', label: 'Worker Ollama', provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434', apiKeyCommand: 'SECRET_RESOLVER',
        source: 'worker-node', workerNodeId: 'worker-1', enabled: true,
      },
      models: [{
        id: 'qwen3:14b', name: 'qwen3:14b', provider: 'ollama',
        endpointId: 'worker-ollama',
      }],
      healthy: true,
    }]) as never));
  return {
    runtime, target, status, incident, pending, ensureTrustedSender, sendToRenderer,
    discoverCandidates, unsubscribe,
    emit: () => runtime.notifyChanged(),
    register: () => {
      return registerLocalAiGuardHandlers({
        windowManager: { sendToRenderer },
        ensureTrustedSender,
        getRuntime: () => runtime as never,
        discoverCandidates: discoverCandidates as never,
      });
    },
  };
}

function candidate(input: {
  id: string;
  label?: string;
  baseUrl?: string;
  modelId?: string;
}): unknown {
  const modelId = input.modelId ?? 'qwen3:14b';
  return {
    endpoint: {
      id: input.id,
      label: input.label ?? 'Worker Ollama',
      provider: 'ollama',
      baseUrl: input.baseUrl ?? 'http://127.0.0.1:11434',
      apiKeyEnv: 'CREDENTIAL_ENV',
      apiKeyCommand: 'CREDENTIAL_COMMAND',
      source: 'worker-node',
      workerNodeId: 'worker-1',
      enabled: true,
    },
    models: [{
      id: modelId,
      name: modelId,
      provider: 'ollama',
      endpointId: input.id,
    }],
    healthy: true,
    reason: 'PRIVATE_DISCOVERY_REASON',
  };
}

function summary(
  overrides: Partial<{
    window: '24h' | '7d' | '30d';
    localTasks: number;
    localTokens: number;
    proposedFallbacks: number;
    allowedFallbacks: number;
    deferredFallbacks: number;
    blockedFallbacks: number;
    knownCostUsd: number;
    estimatedCostUsd: number;
    avoidedEstimatedTokens: number;
    avoidedEstimatedCostUsd: number;
    byTarget: Record<string, number>;
    byModel: Record<string, number>;
    bySlot: Record<string, number>;
    byIncident: Record<string, number>;
  }> = {},
) {
  return {
    window: '30d' as const,
    localTasks: 0,
    localTokens: 0,
    proposedFallbacks: 0,
    allowedFallbacks: 0,
    deferredFallbacks: 0,
    blockedFallbacks: 0,
    knownCostUsd: 0,
    estimatedCostUsd: 0,
    avoidedEstimatedTokens: 0,
    avoidedEstimatedCostUsd: 0,
    byTarget: {},
    byModel: {},
    bySlot: {},
    byIncident: {},
    ...overrides,
  };
}

function targetConfig() {
  return {
    lifecycle: 'enrolled' as const,
    location: { type: 'coordinator' as const },
    provider: 'ollama' as const,
    endpointId: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:14b', required: true }],
    canary: { model: 'qwen3:14b', timeoutMs: 30_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 5_000,
    routingRoles: ['compression' as const],
    fallbackPolicy: 'notify-and-allow' as const,
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 2, cooldownMs: 300_000 },
  };
}

function requestChannels(): string[] {
  return [
    IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT,
    IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE,
    IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE,
    IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE,
    IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER,
    IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE,
    IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK,
    IPC_CHANNELS.LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE,
    IPC_CHANNELS.LOCAL_AI_GUARD_DIAGNOSE,
    IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR,
    IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY,
    IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_LIST,
    IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE,
  ];
}

function trustedOperationRequests(): [string, unknown][] {
  return [
    [IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE, { config: targetConfig() }],
    [IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE, {
      targetId: 'target-1', patch: { warningLatencyMs: 2_000 },
    }],
    [IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE, {
      targetId: 'target-1', lifecycle: 'paused',
    }],
    [IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER, undefined],
    [IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE, { config: targetConfig() }],
    [IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK, { targetId: 'target-1', kind: 'lightweight' }],
    [IPC_CHANNELS.LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE, { incidentId: 'incident-1' }],
    [IPC_CHANNELS.LOCAL_AI_GUARD_DIAGNOSE, { targetId: 'target-1' }],
    [IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR, {
      targetId: 'target-1', action: 'restart-ollama', mode: 'guided',
    }],
    [IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE, {
      requestId: 'request-1', resolution: 'allow-once',
    }],
  ];
}

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  return handler({ sender: { id: 1 } }, payload);
}

function targetIdentityKey(identity: LocalAiEndpointIdentity): string {
  return JSON.stringify([
    identity.location.type,
    identity.location.type === 'worker' ? identity.location.nodeId : '',
    identity.provider,
    identity.endpointId,
    identity.baseUrl,
  ]);
}
