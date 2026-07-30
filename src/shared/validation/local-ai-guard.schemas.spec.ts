import { describe, expect, it } from 'vitest';
import {
  LocalAiProbeResultSchema,
  LocalAiRepairResultSchema,
  LocalAiGuardSnapshotSchema,
  LocalAiRevisionCursorSchema,
  LocalAiRoutingDecisionReasonSchema,
  LocalAiRoutingEventSchema,
  LocalAiTargetConfigSchema,
  LocalAiTargetCreateRequestSchema,
  LocalAiTargetLifecycleRequestSchema,
  LocalAiTargetSchema,
  LocalAiTargetUpdateRequestSchema,
  LocalAiTargetStatusSchema,
  LocalAiValidateRequestSchema,
} from './local-ai-guard.schemas';

const validSnapshot = {
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
  targetConfigs: [],
  incidents: [],
  recoveryAttempts: [],
  pendingFallbacks: [],
};

describe('LocalAiGuardSnapshotSchema', () => {
  it('requires a canonical bounded decimal-string revision cursor', () => {
    expect(LocalAiGuardSnapshotSchema.parse(validSnapshot).revision).toBe('0');
    expect(LocalAiGuardSnapshotSchema.parse({
      ...validSnapshot,
      revision: '9'.repeat(512),
    }).revision).toBe('9'.repeat(512));

    for (const revision of [
      undefined,
      -1,
      '00',
      '01',
      '+1',
      '-1',
      '1.0',
      '1e3',
      ' 1',
      '1 ',
      '9'.repeat(513),
    ]) {
      expect(() => LocalAiGuardSnapshotSchema.parse({
        ...validSnapshot,
        revision,
      })).toThrow();
    }
  });

  it('validates the cursor independently at IPC boundaries', () => {
    expect(LocalAiRevisionCursorSchema.parse('9007199254740992'))
      .toBe('9007199254740992');
    expect(() => LocalAiRevisionCursorSchema.parse('09007199254740992')).toThrow();
  });
});

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

  it('enforces unique expected models and canary membership across authoritative target contracts', () => {
    const duplicateModels = [
      validTargetConfig.expectedModels[0],
      { ...validTargetConfig.expectedModels[0], required: false },
    ];
    const missingCanary = {
      ...validTargetConfig.canary,
      model: 'not-expected',
    };
    const persisted = {
      ...validTargetConfig,
      id: 'target-1',
      label: 'Worker target',
      createdAt: 1,
      updatedAt: 1,
    };

    for (const invalid of [
      { ...validTargetConfig, expectedModels: duplicateModels },
      { ...validTargetConfig, canary: missingCanary },
    ]) {
      expect(LocalAiTargetConfigSchema.safeParse(invalid).success).toBe(false);
      expect(LocalAiTargetCreateRequestSchema.safeParse({ config: invalid }).success).toBe(false);
      expect(LocalAiValidateRequestSchema.safeParse({ config: invalid }).success).toBe(false);
      expect(LocalAiTargetSchema.safeParse({ ...persisted, ...invalid }).success).toBe(false);
    }

    expect(LocalAiTargetUpdateRequestSchema.safeParse({
      targetId: 'target-1',
      patch: {
        expectedModels: duplicateModels,
        canary: validTargetConfig.canary,
      },
    }).success).toBe(false);
    expect(LocalAiTargetUpdateRequestSchema.safeParse({
      targetId: 'target-1',
      patch: {
        expectedModels: validTargetConfig.expectedModels,
        canary: missingCanary,
      },
    }).success).toBe(false);
  });

  it('preserves distinct expected-model order and objects when the canary is a member', () => {
    const expectedModels = [
      validTargetConfig.expectedModels[0],
      { modelId: 'qwen3:8b', required: false, minContextLength: 8_192 },
    ];

    expect(LocalAiTargetConfigSchema.parse({
      ...validTargetConfig,
      expectedModels,
    }).expectedModels).toEqual(expectedModels);
  });

  it('accepts optional-model role ownership only within the target routing roles', () => {
    const scoped = {
      ...validTargetConfig,
      routingRoles: ['compression', 'titleGeneration'],
      expectedModels: [
        validTargetConfig.expectedModels[0],
        {
          modelId: 'qwen3:8b',
          required: false,
          routingRoles: ['titleGeneration'],
        },
      ],
    };

    expect(LocalAiTargetConfigSchema.parse(scoped).expectedModels[1])
      .toMatchObject({ routingRoles: ['titleGeneration'] });
    expect(LocalAiTargetConfigSchema.safeParse({
      ...scoped,
      expectedModels: [
        scoped.expectedModels[0],
        { ...scoped.expectedModels[1], routingRoles: ['webExtract'] },
      ],
    }).success).toBe(false);
  });

  it('rejects an enrolled target without any routing capability', () => {
    expect(() => LocalAiTargetConfigSchema.parse({
      ...validTargetConfig,
      routingRoles: [],
    })).toThrow();
  });

  it('accepts the exact trusted numeric boundaries through config, create, update, and validate schemas', () => {
    const minimum = {
      ...validTargetConfig,
      expectedModels: [{
        ...validTargetConfig.expectedModels[0],
        minContextLength: 1,
      }],
      canary: { ...validTargetConfig.canary, timeoutMs: 5_000, intervalMs: 120_000 },
      endpointCheckIntervalMs: 30_000,
      freshnessLimitMs: 30_000,
      warningLatencyMs: 100,
      confirmAboveInputTokens: 0,
      dailyFallbackBudgetUsd: 0,
      incidentFallbackBudgetUsd: 0,
      recovery: { ...validTargetConfig.recovery, maxAttempts: 1, cooldownMs: 60_000 },
    };
    const maximum = {
      ...validTargetConfig,
      expectedModels: [{
        ...validTargetConfig.expectedModels[0],
        minContextLength: 100_000_000,
      }],
      canary: { ...validTargetConfig.canary, timeoutMs: 120_000, intervalMs: 3_600_000 },
      endpointCheckIntervalMs: 900_000,
      freshnessLimitMs: 900_000,
      warningLatencyMs: 60_000,
      confirmAboveInputTokens: 100_000_000,
      dailyFallbackBudgetUsd: 1_000_000,
      incidentFallbackBudgetUsd: 1_000_000,
      recovery: { ...validTargetConfig.recovery, maxAttempts: 5, cooldownMs: 3_600_000 },
    };

    expect(LocalAiTargetConfigSchema.parse(minimum)).toMatchObject(minimum);
    expect(LocalAiTargetCreateRequestSchema.parse({ config: maximum }).config)
      .toMatchObject(maximum);
    expect(LocalAiValidateRequestSchema.parse({ config: minimum }).config)
      .toMatchObject(minimum);
    const {
      location: _location,
      provider: _provider,
      endpointId: _endpointId,
      ...maximumPatch
    } = maximum;
    expect(LocalAiTargetUpdateRequestSchema.parse({
      targetId: 'target-1',
      patch: maximumPatch,
    }).patch).toMatchObject(maximumPatch);
  });

  it.each([
    ['endpointCheckIntervalMs', (value: number) => ({
      ...validTargetConfig, endpointCheckIntervalMs: value,
    }), [1, 0, -1, Number.NaN, 1.5, 1_000_000_000]],
    ['canary.intervalMs', (value: number) => ({
      ...validTargetConfig, canary: { ...validTargetConfig.canary, intervalMs: value },
    }), [1, 0, -1, Number.NaN, 1.5, 1_000_000_000]],
    ['canary.timeoutMs', (value: number) => ({
      ...validTargetConfig, canary: { ...validTargetConfig.canary, timeoutMs: value },
    }), [1, 0, -1, Number.NaN, 1.5, 1_000_000_000]],
    ['freshnessLimitMs', (value: number) => ({
      ...validTargetConfig, freshnessLimitMs: value,
    }), [1, 0, -1, Number.NaN, 1.5, 1_000_000_000]],
    ['warningLatencyMs', (value: number) => ({
      ...validTargetConfig, warningLatencyMs: value,
    }), [1, 0, -1, Number.NaN, 1.5, 1_000_000_000]],
    ['recovery.maxAttempts', (value: number) => ({
      ...validTargetConfig, recovery: { ...validTargetConfig.recovery, maxAttempts: value },
    }), [0, -1, Number.NaN, 1.5, 1_000_000_000]],
    ['recovery.cooldownMs', (value: number) => ({
      ...validTargetConfig, recovery: { ...validTargetConfig.recovery, cooldownMs: value },
    }), [1, 0, -1, Number.NaN, 1.5, 1_000_000_000]],
    ['expectedModels.minContextLength', (value: number) => ({
      ...validTargetConfig,
      expectedModels: [{ ...validTargetConfig.expectedModels[0], minContextLength: value }],
    }), [0, -1, Number.NaN, 1.5, 1_000_000_000]],
    ['confirmAboveInputTokens', (value: number) => ({
      ...validTargetConfig, confirmAboveInputTokens: value,
    }), [-1, Number.NaN, 1.5, 1_000_000_000]],
    ['dailyFallbackBudgetUsd', (value: number) => ({
      ...validTargetConfig, dailyFallbackBudgetUsd: value,
    }), [-1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000]],
    ['incidentFallbackBudgetUsd', (value: number) => ({
      ...validTargetConfig, incidentFallbackBudgetUsd: value,
    }), [-1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000]],
  ] as const)('rejects hostile or out-of-policy %s values', (_field, build, invalidValues) => {
    for (const value of invalidValues) {
      expect(() => LocalAiTargetConfigSchema.parse(build(value))).toThrow();
    }
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

describe('LocalAiTargetLifecycleRequestSchema', () => {
  it('keeps an explicit pause deadline distinct from the lifecycle mutation timestamp', () => {
    expect(LocalAiTargetLifecycleRequestSchema.parse({
      targetId: 'target-1',
      lifecycle: 'paused',
      pausedUntil: 5_000,
    })).toEqual({
      targetId: 'target-1',
      lifecycle: 'paused',
      pausedUntil: 5_000,
    });
    expect(() => LocalAiTargetLifecycleRequestSchema.parse({
      targetId: 'target-1',
      lifecycle: 'paused',
      at: 5_000,
    })).toThrow();
  });

  it('allows indefinite pause but rejects pause deadlines on resume or retirement', () => {
    expect(LocalAiTargetLifecycleRequestSchema.parse({
      targetId: 'target-1',
      lifecycle: 'paused',
    })).toEqual({
      targetId: 'target-1',
      lifecycle: 'paused',
    });
    for (const lifecycle of ['enrolled', 'retired'] as const) {
      expect(() => LocalAiTargetLifecycleRequestSchema.parse({
        targetId: 'target-1',
        lifecycle,
        pausedUntil: 5_000,
      })).toThrow();
    }
  });
});

describe('LocalAiRepairResultSchema', () => {
  const base = {
    targetId: 'target-1',
    action: 'restart-ollama',
    message: 'Fixed safe result.',
    completedAt: 1_000,
  };
  const canonicalOutcomes = [
    { outcome: 'guided', supported: true, attempted: false, recovered: false },
    { outcome: 'unsupported', supported: false, attempted: false, recovered: false },
    { outcome: 'not-attempted', supported: true, attempted: false, recovered: false },
    { outcome: 'execution-failed', supported: true, attempted: true, recovered: false },
    { outcome: 'completed-not-recovered', supported: true, attempted: true, recovered: false },
    { outcome: 'recovered', supported: true, attempted: true, recovered: true },
  ] as const;

  it.each(canonicalOutcomes)('accepts the canonical $outcome outcome tuple', (result) => {
    expect(LocalAiRepairResultSchema.parse({
      ...base,
      ...result,
    })).toMatchObject(result);
  });

  it.each(canonicalOutcomes.flatMap((result) => [
    { ...result, supported: !result.supported },
    { ...result, attempted: !result.attempted },
    { ...result, recovered: !result.recovered },
  ]))('rejects an adjacent contradictory $outcome tuple', (result) => {
    expect(LocalAiRepairResultSchema.safeParse({
      ...base,
      ...result,
    }).success).toBe(false);
  });

  it('rejects missing, unknown, or boolean-incoherent outcomes', () => {
    for (const candidate of [
      { ...base, supported: true, attempted: true, recovered: true },
      {
        ...base,
        outcome: 'maybe-fixed',
        supported: true,
        attempted: true,
        recovered: true,
      },
      {
        ...base,
        outcome: 'recovered',
        supported: true,
        attempted: true,
        recovered: false,
      },
    ]) {
      expect(() => LocalAiRepairResultSchema.parse(candidate)).toThrow();
    }
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
