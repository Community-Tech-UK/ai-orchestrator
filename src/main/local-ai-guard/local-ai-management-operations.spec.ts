import { describe, expect, it, vi } from 'vitest';
import type {
  LocalAiIncident,
  LocalAiTarget,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import { LocalAiHealthEngine } from './local-ai-health-engine';
import { createLocalAiManagementOperations } from './local-ai-management-operations';

const NOW = 1_700_000_000_000;

function target(id: string, patch: Partial<LocalAiTarget> = {}): LocalAiTarget {
  return {
    id,
    label: `${id} label`,
    lifecycle: 'enrolled',
    location: { type: 'worker', nodeId: 'node-1' },
    provider: 'openai-compatible',
    endpointId: `${id}-endpoint`,
    baseUrl: 'http://127.0.0.1:1234',
    expectedModels: [{ modelId: 'qwen/qwen3.5-9b', required: true }],
    canary: { model: 'qwen/qwen3.5-9b', timeoutMs: 30_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 2, cooldownMs: 300_000 },
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...patch,
  };
}

function healthyStatus(targetId: string): LocalAiTargetStatus {
  return {
    targetId,
    lifecycle: 'enrolled',
    state: 'healthy',
    routableRoles: ['compression'],
    layers: {
      endpoint: {
        targetId,
        layer: 'endpoint',
        checkType: 'lightweight',
        ok: true,
        required: true,
        affectedRoles: [],
        checkedAt: NOW - 5_000,
        durationMs: 2,
        evidence: { endpointReachable: true },
      },
      inference: {
        targetId,
        layer: 'inference',
        checkType: 'functional',
        ok: false,
        required: true,
        affectedRoles: ['compression'],
        checkedAt: NOW - 60_000,
        durationMs: 400,
        failureCode: 'malformed-inference-output',
        message: 'provider text that must not reach the CLI',
        evidence: { canaryOutputValid: false },
      },
    },
    consecutiveFailures: 1,
    consecutiveSuccesses: 0,
    flapping: false,
    checkedAt: NOW - 5_000,
  };
}

const incident: LocalAiIncident = {
  id: 'incident-1',
  targetId: 'retired-target',
  state: 'open',
  severity: 'warning',
  failureCode: 'connection-refused',
  affectedLayers: ['endpoint'],
  affectedRoles: ['compression'],
  openedAt: NOW - 120_000,
  updatedAt: NOW - 60_000,
  fallbackCount: 0,
  knownCostUsd: 0,
  estimatedCostUsd: 0,
  unpricedDispatchCount: 0,
};

function harness() {
  const active = target('lm-studio');
  const paused = target('paused-one', { lifecycle: 'paused' });
  const retired = target('retired-target', { lifecycle: 'retired', label: 'old ollama' });
  const runtime = {
    targets: {
      list: vi.fn((options?: { includeRetired?: boolean }) =>
        options?.includeRetired ? [active, paused, retired] : [active, paused]),
      get: vi.fn((id: string) => [active, paused, retired].find((item) => item.id === id)),
      rename: vi.fn((id: string, label: string) => ({ ...active, id, label })),
      update: vi.fn((id: string, patch: Partial<LocalAiTarget>) => ({ ...active, id, ...patch })),
    },
    scheduler: {
      getStatus: vi.fn((id: string) => (id === active.id ? healthyStatus(id) : undefined)),
      recheck: vi.fn(async (id: string) => healthyStatus(id)),
    },
    engine: new LocalAiHealthEngine(),
    health: {
      listIncidents: vi.fn((query: { state?: string }) => (query.state === 'open' ? [incident] : [])),
      summarize: vi.fn((window: '24h' | '7d' | '30d') => ({
        window,
        localTasks: 95,
        localTokens: 1_000,
        proposedFallbacks: 5,
        allowedFallbacks: 5,
        deferredFallbacks: 0,
        blockedFallbacks: 0,
        knownCostUsd: 0.01,
        estimatedCostUsd: 0,
        unpricedDispatchCount: 0,
        avoidedEstimatedTokens: 1_000,
        avoidedEstimatedCostUsd: 0.2,
        byTarget: { [active.id]: 100 },
        byModel: {},
        bySlot: {},
        byIncident: {},
      })),
    },
    incidents: {
      acknowledge: vi.fn((id: string) => (id === incident.id
        ? { ...incident, state: 'acknowledged' as const, acknowledgedAt: NOW }
        : undefined)),
    },
    notifyChanged: vi.fn(),
  };
  const operations = createLocalAiManagementOperations({
    getRuntime: () => runtime as never,
    now: () => NOW,
  });
  return { operations, runtime, active, paused };
}

describe('createLocalAiManagementOperations', () => {
  it('reports enrolled and paused targets with bounded layer results and labelled incidents', async () => {
    const h = harness();

    const status = await h.operations.status();

    expect(status.aggregate).toMatchObject({ enrolled: 2, healthy: 1, paused: 1 });
    expect(status.targets.map((item) => [item.id, item.label, item.state])).toEqual([
      ['lm-studio', 'lm-studio label', 'healthy'],
      ['paused-one', 'paused-one label', 'paused'],
    ]);
    expect(status.targets[0]?.layers).toEqual({
      endpoint: { ok: true, required: true, checkedAt: NOW - 5_000, durationMs: 2 },
      inference: {
        ok: false,
        required: true,
        checkedAt: NOW - 60_000,
        durationMs: 400,
        failureCode: 'malformed-inference-output',
      },
    });
    // Probe messages and evidence can carry provider text; the CLI never sees them.
    expect(JSON.stringify(status)).not.toContain('provider text');
    expect(JSON.stringify(status)).not.toContain('evidence');
    expect(status.incidents).toEqual([expect.objectContaining({
      id: 'incident-1',
      targetLabel: 'old ollama',
    })]);
  });

  it('runs a check through the scheduler and publishes the change', async () => {
    const h = harness();

    const result = await h.operations.recheck('lm-studio', 'functional');

    expect(h.runtime.scheduler.recheck).toHaveBeenCalledWith('lm-studio', 'functional');
    expect(result).toMatchObject({ id: 'lm-studio', label: 'lm-studio label', state: 'healthy' });
    expect(h.runtime.notifyChanged).toHaveBeenCalledOnce();
  });

  it('refuses to check an unknown target before touching the scheduler', async () => {
    const h = harness();

    await expect(h.operations.recheck('missing', 'lightweight')).rejects.toThrow(/not found/);
    expect(h.runtime.scheduler.recheck).not.toHaveBeenCalled();
  });

  it('renames and updates through the repository and publishes each change', async () => {
    const h = harness();

    await expect(h.operations.rename('lm-studio', 'windows-pc · LM Studio'))
      .resolves.toMatchObject({ label: 'windows-pc · LM Studio' });
    await expect(h.operations.update('lm-studio', { warningLatencyMs: 15_000 }))
      .resolves.toMatchObject({ warningLatencyMs: 15_000 });

    expect(h.runtime.targets.rename).toHaveBeenCalledWith('lm-studio', 'windows-pc · LM Studio');
    expect(h.runtime.targets.update).toHaveBeenCalledWith('lm-studio', { warningLatencyMs: 15_000 });
    expect(h.runtime.notifyChanged).toHaveBeenCalledTimes(2);
  });

  it('rejects a patch that changes endpoint identity before writing', async () => {
    const h = harness();

    await expect(h.operations.update('lm-studio', { endpointId: 'other' } as never)).rejects.toThrow();
    expect(h.runtime.targets.update).not.toHaveBeenCalled();
  });

  it('returns the effectiveness summary for the requested window', async () => {
    const h = harness();

    await expect(h.operations.summary('7d')).resolves.toMatchObject({ window: '7d', localTasks: 95 });
    expect(h.runtime.health.summarize).toHaveBeenCalledWith('7d');
  });

  it('acknowledges a known incident and rejects an unknown one', async () => {
    const h = harness();

    await expect(h.operations.acknowledgeIncident('incident-1'))
      .resolves.toMatchObject({ id: 'incident-1', state: 'acknowledged' });
    await expect(h.operations.acknowledgeIncident('missing')).rejects.toThrow(/not found/);
    expect(h.runtime.notifyChanged).toHaveBeenCalledOnce();
  });
});
