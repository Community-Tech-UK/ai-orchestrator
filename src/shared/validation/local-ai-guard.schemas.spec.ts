import { describe, expect, it } from 'vitest';
import {
  LocalAiProbeResultSchema,
  LocalAiRoutingDecisionReasonSchema,
  LocalAiRoutingEventSchema,
  LocalAiTargetConfigSchema,
  LocalAiTargetStatusSchema,
} from './local-ai-guard.schemas';

const validTargetConfig = {
  lifecycle: 'enrolled',
  location: { type: 'worker', nodeId: 'node-1' },
  provider: 'ollama',
  endpointId: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  expectedModels: [{ modelId: 'qwen3:14b', required: true, minContextLength: 16_384 }],
  canary: { model: 'qwen3:14b', timeoutMs: 30_000, intervalMs: 600_000 },
  endpointCheckIntervalMs: 60_000,
  freshnessLimitMs: 120_000,
  warningLatencyMs: 5_000,
  routingRoles: ['compression'],
  fallbackPolicy: 'notify-and-allow',
  slotFallbackPolicies: { titleGeneration: 'require-confirmation' },
  confirmAboveInputTokens: 4_000,
  dailyFallbackBudgetUsd: 10,
  incidentFallbackBudgetUsd: 2,
  recovery: { automatic: true, maxAttempts: 3, cooldownMs: 60_000 },
};

describe('LocalAiTargetConfigSchema', () => {
  it('accepts an enrolled target with its routing, budget, and recovery settings', () => {
    expect(LocalAiTargetConfigSchema.parse(validTargetConfig)).toMatchObject(validTargetConfig);
  });

  it('rejects an enrolled target without a canary model', () => {
    expect(() => LocalAiTargetConfigSchema.parse({
      ...validTargetConfig,
      canary: { ...validTargetConfig.canary, model: '' },
    })).toThrow();
  });

  it('rejects an enrolled target without any routing capability', () => {
    expect(() => LocalAiTargetConfigSchema.parse({
      ...validTargetConfig,
      routingRoles: [],
    })).toThrow();
  });

  it.each(['unmanaged', 'paused', 'retired'] as const)(
    'allows %s targets to carry zero routing roles while they are not actively enrolled',
    (lifecycle) => {
      expect(LocalAiTargetConfigSchema.parse({
        ...validTargetConfig,
        lifecycle,
        routingRoles: [],
      }).routingRoles).toEqual([]);
    },
  );

  it('accepts and canonicalizes a private endpoint URL without a trailing slash', () => {
    const target = LocalAiTargetConfigSchema.parse({
      ...validTargetConfig,
      baseUrl: 'http://100.100.100.100:11434/',
    });

    expect(target.baseUrl).toBe('http://100.100.100.100:11434');
  });

  it.each([
    'https://example.com/v1',
    'file:///tmp/local-ai.sock',
    'http://operator:password@127.0.0.1:11434',
    'http://127.0.0.1:11434/v1?api_key=secret',
    'http://100.128.0.1:11434',
  ])('rejects an unsafe endpoint URL: %s', (baseUrl) => {
    expect(() => LocalAiTargetConfigSchema.parse({ ...validTargetConfig, baseUrl })).toThrow();
  });

  it.each([
    ['http://localhost:11434/', 'http://localhost:11434'],
    ['https://127.0.0.1:11434/v1/', 'https://127.0.0.1:11434/v1'],
    ['http://[::1]:11434/', 'http://[::1]:11434'],
    ['http://10.0.0.0:11434/', 'http://10.0.0.0:11434'],
    ['http://10.255.255.255:11434/', 'http://10.255.255.255:11434'],
    ['http://172.16.0.0:11434/', 'http://172.16.0.0:11434'],
    ['http://172.31.255.255:11434/', 'http://172.31.255.255:11434'],
    ['http://192.168.0.0:11434/', 'http://192.168.0.0:11434'],
    ['http://192.168.255.255:11434/', 'http://192.168.255.255:11434'],
    ['http://100.64.0.0:11434/', 'http://100.64.0.0:11434'],
    ['http://100.127.255.255:11434/', 'http://100.127.255.255:11434'],
    ['http://127.0.0.1:11434/v1@stable/', 'http://127.0.0.1:11434/v1@stable'],
  ])('accepts and canonicalizes allowed Local AI endpoint URL %s', (baseUrl, expectedBaseUrl) => {
    expect(LocalAiTargetConfigSchema.parse({ ...validTargetConfig, baseUrl }).baseUrl).toBe(expectedBaseUrl);
  });

  it.each([
    'http://9.255.255.255:11434',
    'http://11.0.0.0:11434',
    'http://172.15.255.255:11434',
    'http://172.32.0.0:11434',
    'http://192.167.255.255:11434',
    'http://192.169.0.0:11434',
    'http://100.63.255.255:11434',
    'http://100.128.0.0:11434',
    'http://169.254.1.1:11434',
    'http://999.0.0.1:11434',
    'http://127.0.0.999:11434',
    'http://127.0.0.1.:11434',
    'http://127.0.0.1:invalid',
    'http://[2001:db8::1]:11434',
    'http://[fd00::1]:11434',
    'http://localhost.localdomain:11434',
    'http://localhost.evil:11434',
    'http://127.0.0.1.nip.io:11434',
    'http://worker.lan:11434',
    'http://worker.tailnet.ts.net:11434',
    'http://@127.0.0.1:11434',
    'http://user@127.0.0.1:11434',
    'http://127.0.0.1:11434/?',
    'http://127.0.0.1:11434/?token=value',
    'http://127.0.0.1:11434/#',
    'http://127.0.0.1:11434/#section',
  ])('rejects every disallowed Local AI endpoint URL %s', (baseUrl) => {
    expect(() => LocalAiTargetConfigSchema.parse({ ...validTargetConfig, baseUrl })).toThrow();
  });
});

describe('LocalAiProbeResultSchema', () => {
  const validProbe = {
    targetId: 'target-1',
    layer: 'endpoint',
    checkType: 'lightweight',
    ok: true,
    required: true,
    affectedRoles: ['compression'],
    checkedAt: 1,
    durationMs: 20,
    evidence: { httpStatus: 200, advertisedModels: ['qwen3:14b'] },
  };

  it('accepts bounded allow-listed operational evidence', () => {
    expect(LocalAiProbeResultSchema.parse(validProbe).evidence).toEqual(validProbe.evidence);
  });

  it.each([
    { apiKey: 'not-for-storage' },
    { modelResponse: 'do not persist inference output' },
    { endpointVersion: 'x'.repeat(513) },
    { advertisedModels: Array.from({ length: 21 }, () => 'qwen3:14b') },
  ])('rejects secret-like or oversized evidence: %o', (evidence) => {
    expect(() => LocalAiProbeResultSchema.parse({ ...validProbe, evidence })).toThrow();
  });

  it('rejects evidence whose serialized payload exceeds the operational storage limit', () => {
    expect(() => LocalAiProbeResultSchema.parse({
      ...validProbe,
      evidence: {
        endpointVersion: 'a'.repeat(512),
        errorKind: 'b'.repeat(512),
        endpointProtocol: 'c'.repeat(512),
        deferredReason: 'd'.repeat(512),
        advertisedModels: Array.from({ length: 20 }, () => 'e'.repeat(256)),
      },
    })).toThrow();
  });
});

describe('LocalAiTargetStatusSchema', () => {
  const validStatus = {
    targetId: 'target-1',
    state: 'healthy',
    routableRoles: ['compression'],
    layers: {},
    consecutiveFailures: 0,
    consecutiveSuccesses: 1,
    flapping: false,
    checkedAt: 1,
  };

  it('preserves backwards compatibility when transition evidence is absent', () => {
    expect(LocalAiTargetStatusSchema.parse(validStatus)).toEqual(validStatus);
  });

  it('accepts additive lifecycle evidence while preserving legacy statuses without it', () => {
    expect(LocalAiTargetStatusSchema.parse({
      ...validStatus,
      lifecycle: 'enrolled',
    }).lifecycle).toBe('enrolled');
    expect(LocalAiTargetStatusSchema.parse(validStatus)).not.toHaveProperty('lifecycle');
  });

  it('accepts bounded optional recovery and incident context while preserving legacy statuses', () => {
    expect(LocalAiTargetStatusSchema.parse({
      ...validStatus,
      recoveryState: 'unavailable',
      incidentOpen: true,
    })).toMatchObject({
      recoveryState: 'unavailable',
      incidentOpen: true,
    });
    expect(LocalAiTargetStatusSchema.parse(validStatus)).not.toHaveProperty('recoveryState');
    expect(LocalAiTargetStatusSchema.parse(validStatus)).not.toHaveProperty('incidentOpen');
  });

  it('accepts at most eight bounded state-transition records', () => {
    const stateTransitions = Array.from({ length: 8 }, (_, index) => ({
      state: index % 2 === 0 ? 'healthy' : 'unavailable',
      at: index + 1,
    }));

    expect(LocalAiTargetStatusSchema.parse({ ...validStatus, stateTransitions }).stateTransitions)
      .toEqual(stateTransitions);
    expect(() => LocalAiTargetStatusSchema.parse({
      ...validStatus,
      stateTransitions: [...stateTransitions, { state: 'healthy', at: 9 }],
    })).toThrow();
  });
});

describe('LocalAiRoutingEventSchema', () => {
  it.each([
    'health',
    'policy',
    'daily-budget',
    'incident-budget',
    'confirmation',
  ])('accepts the explicit persisted routing decision reason %s', (decisionReason) => {
    expect(LocalAiRoutingDecisionReasonSchema.parse(decisionReason)).toBe(decisionReason);
  });

  it('rejects missing or unrecognized routing decision reasons', () => {
    expect(() => LocalAiRoutingDecisionReasonSchema.parse('block-paid-fallback')).toThrow();
    expect(() => LocalAiRoutingEventSchema.parse({
      id: 'event-missing-reason',
      slot: 'compression',
      intendedRoute: 'local',
      actualRoute: 'blocked',
      policy: 'block-paid-fallback',
      disposition: 'blocked',
      inputTokens: 0,
      outputTokens: 0,
      createdAt: 1,
    })).toThrow();
  });

  it('preserves known and estimated fallback costs as independent values', () => {
    const event = LocalAiRoutingEventSchema.parse({
      id: 'event-1',
      targetId: 'target-1',
      incidentId: 'incident-1',
      slot: 'compression',
      intendedRoute: 'local',
      actualRoute: 'frontier',
      policy: 'notify-and-allow',
      disposition: 'allowed',
      decisionReason: 'confirmation',
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 1_200,
      outputTokens: 300,
      knownCostUsd: 0.018,
      estimatedCostUsd: 0.02,
      createdAt: 1,
      completedAt: 2,
    });

    expect(event.knownCostUsd).toBe(0.018);
    expect(event.estimatedCostUsd).toBe(0.02);
    expect(event.decisionReason).toBe('confirmation');
  });
});
