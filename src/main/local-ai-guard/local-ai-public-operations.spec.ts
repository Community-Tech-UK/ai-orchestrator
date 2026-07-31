import { describe, expect, it, vi } from 'vitest';
import { createLocalAiPublicOperations } from './local-ai-public-operations';

const config = {
  lifecycle: 'enrolled' as const,
  location: { type: 'worker' as const, nodeId: 'node-1' },
  provider: 'openai-compatible' as const,
  endpointId: 'openai-compatible',
  baseUrl: 'http://100.64.0.2:1234/v1',
  expectedModels: [{ modelId: 'qwen/qwen3.5-9b', required: true }],
  canary: {
    model: 'qwen/qwen3.5-9b',
    timeoutMs: 30_000,
    intervalMs: 600_000,
  },
  endpointCheckIntervalMs: 60_000,
  freshnessLimitMs: 120_000,
  warningLatencyMs: 2_000,
  routingRoles: ['compression' as const],
  fallbackPolicy: 'notify-and-allow' as const,
  slotFallbackPolicies: {},
  recovery: {
    automatic: false,
    maxAttempts: 2,
    cooldownMs: 300_000,
  },
};

const target = {
  ...config,
  id: 'target-1',
  label: 'node-1: openai-compatible',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

function harness() {
  const targets = {
    list: vi.fn(() => [target]),
    findByEndpoint: vi.fn(() => undefined),
    create: vi.fn(() => target),
  };
  const probes = {
    check: vi.fn(async (validationTarget: typeof target) => [{
      targetId: validationTarget.id,
      layer: 'worker',
      checkType: 'functional',
      ok: true,
      required: true,
      affectedRoles: ['compression'],
      checkedAt: 1_700_000_000_000,
      durationMs: 25,
      message: 'raw provider detail must not cross the public boundary',
      evidence: { workerConnected: true },
    }]),
  };
  const runtime = { targets, probes };
  const discoverCandidates = vi.fn(async () => [{
    endpoint: {
      id: 'openai-compatible',
      label: 'windows-pc • openai-compatible',
      provider: 'openai-compatible',
      baseUrl: 'http://100.64.0.2:1234/v1',
      apiKeyCommand: 'SECRET_RESOLVER',
      source: 'worker-node',
      workerNodeId: 'node-1',
      enabled: true,
    },
    models: [{
      id: 'qwen/qwen3.5-9b',
      name: 'Qwen',
      provider: 'openai-compatible',
      endpointId: 'openai-compatible',
    }],
    healthy: true,
  }]);
  const operations = createLocalAiPublicOperations({
    getRuntime: () => runtime as never,
    discoverCandidates: discoverCandidates as never,
    now: () => 1_700_000_000_000,
    createId: () => 'validation-target',
  });
  return { operations, runtime, discoverCandidates };
}

describe('createLocalAiPublicOperations', () => {
  it('lists non-retired targets through the authoritative repository', async () => {
    const h = harness();

    await expect(h.operations.list()).resolves.toEqual([target]);
    expect(h.runtime.targets.list).toHaveBeenCalledWith({ includeRetired: false });
  });

  it('discovers only bounded safe endpoint metadata without secret resolver fields', async () => {
    const h = harness();

    const result = await h.operations.discover();

    expect(result).toEqual([{
      identity: {
        location: { type: 'worker', nodeId: 'node-1' },
        provider: 'openai-compatible',
        endpointId: 'openai-compatible',
        baseUrl: 'http://100.64.0.2:1234/v1',
      },
      label: 'windows-pc • openai-compatible',
      models: ['qwen/qwen3.5-9b'],
      healthy: true,
    }]);
    expect(JSON.stringify(result)).not.toContain('SECRET_RESOLVER');
  });

  it('validates with an ephemeral target and sanitizes public probe messages', async () => {
    const h = harness();

    const result = await h.operations.validate(config);

    expect(h.runtime.probes.check).toHaveBeenCalledWith(
      expect.objectContaining({
        ...config,
        id: 'validation-target',
        label: 'Validation target',
      }),
      'functional',
    );
    expect(h.runtime.targets.create).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        targetId: 'validation-target',
        message: 'The Local AI health check reported a failure.',
      }),
    ]);
  });

  it('creates only schema-valid target configurations through the repository', async () => {
    const h = harness();

    await expect(h.operations.create(config)).resolves.toEqual(target);
    expect(h.runtime.targets.create).toHaveBeenCalledWith(config);
  });
});

