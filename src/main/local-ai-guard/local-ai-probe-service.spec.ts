import { describe, expect, it, vi } from 'vitest';
import type {
  LocalAiProbeResult,
  LocalAiTarget,
} from '../../shared/types/local-ai-guard.types';
import { WorkerLocalAiHealth } from '../../worker-agent/worker-local-ai-health';
import { LocalAiProbeService } from './local-ai-probe-service';

function target(
  location: LocalAiTarget['location'],
  overrides: Partial<LocalAiTarget> = {},
): LocalAiTarget {
  return {
    id: 'target-1',
    label: 'Primary local AI',
    lifecycle: 'enrolled',
    location,
    provider: 'ollama',
    endpointId: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:8b', required: true }],
    canary: { model: 'qwen3:8b', timeoutMs: 1_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 1, cooldownMs: 60_000 },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function workerSample(overrides: Partial<LocalAiProbeResult> = {}): LocalAiProbeResult {
  return {
    targetId: 'ollama',
    layer: 'endpoint',
    checkType: 'lightweight',
    ok: true,
    required: true,
    affectedRoles: [],
    checkedAt: 1_700_000_000_000,
    durationMs: 4,
    evidence: {
      endpointReachable: true,
      endpointProtocol: 'ollama-api',
    },
    ...overrides,
  };
}

describe('LocalAiProbeService', () => {
  it('checks coordinator-local endpoint, model, and canary layers with the target identity and roles', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen3:8b' }] }))
      .mockResolvedValueOnce(jsonResponse({ response: 'AIO_HEALTH_OK' }));
    const service = new LocalAiProbeService({ fetch: fetchMock });

    const samples = await service.check(target({ type: 'coordinator' }), 'functional');

    expect(samples.map((sample) => sample.layer)).toEqual([
      'worker',
      'endpoint',
      'model',
      'inference',
    ]);
    expect(samples.every((sample) => sample.targetId === 'target-1')).toBe(true);
    expect(samples.every((sample) => sample.affectedRoles[0] === 'compression')).toBe(true);
    expect(samples.every((sample) => sample.ok)).toBe(true);
  });

  it('uses bounded service RPC params and accepts only bounded metadata results for a worker target', async () => {
    const sendServiceRpc = vi.fn(async () => [
      workerSample(),
      workerSample({
        layer: 'model',
        evidence: {
          advertisedModels: ['qwen3:8b'],
          missingModels: [],
          requiredModelCount: 1,
        },
      }),
    ]);
    const service = new LocalAiProbeService({ sendServiceRpc });

    const samples = await service.check(target({ type: 'worker', nodeId: 'worker-7' }), 'lightweight');

    expect(sendServiceRpc).toHaveBeenCalledWith(
      'worker-7',
      'localAi.health.check',
      {
        provider: 'ollama',
        endpointId: 'ollama',
        expectedModels: [{ modelId: 'qwen3:8b', required: true }],
        kind: 'lightweight',
        canary: {
          contract: 'exact-token-v1',
          model: 'qwen3:8b',
        },
        latencyThresholdMs: 2_000,
        timeoutMs: 1_000,
      },
      3_000,
    );
    expect(samples.map((sample) => sample.layer)).toEqual(['worker', 'endpoint', 'model']);
    expect(samples.every((sample) => sample.targetId === 'target-1')).toBe(true);
    expect(samples.every((sample) => sample.affectedRoles[0] === 'compression')).toBe(true);
  });

  it('preserves optional model role scope instead of quarantining every target role', async () => {
    const sendServiceRpc = vi.fn(async () => [
      workerSample(),
      workerSample({
        layer: 'model',
        ok: false,
        required: false,
        affectedRoles: ['titleGeneration'],
        failureCode: 'missing-required-model',
        evidence: {
          advertisedModels: ['qwen3:8b'],
          missingModels: ['nomic-embed-text'],
          requiredModelCount: 1,
        },
      }),
    ]);
    const service = new LocalAiProbeService({ sendServiceRpc });

    const samples = await service.check(target(
      { type: 'worker', nodeId: 'worker-7' },
      { routingRoles: ['compression', 'titleGeneration'] },
    ), 'lightweight');

    expect(samples[2]).toMatchObject({
      layer: 'model',
      required: false,
      affectedRoles: ['titleGeneration'],
    });
  });

  it('maps a worker disconnect to worker-offline', async () => {
    const service = new LocalAiProbeService({
      sendServiceRpc: vi.fn(async () => {
        throw new Error('Node not connected: worker-7');
      }),
    });

    await expect(
      service.check(target({ type: 'worker', nodeId: 'worker-7' }), 'lightweight'),
    ).resolves.toEqual([
      expect.objectContaining({
        targetId: 'target-1',
        layer: 'worker',
        ok: false,
        failureCode: 'worker-offline',
        evidence: expect.objectContaining({
          workerConnected: false,
          rpcReachable: false,
        }),
      }),
    ]);
  });

  it('maps a bounded worker RPC timeout to rpc-unavailable', async () => {
    const service = new LocalAiProbeService({
      sendServiceRpc: vi.fn(async () => {
        throw new Error('RPC timeout after 1000ms: localAi.health.check');
      }),
    });

    const samples = await service.check(
      target({ type: 'worker', nodeId: 'worker-7' }),
      'functional',
    );

    expect(samples[0]).toMatchObject({
      layer: 'worker',
      ok: false,
      failureCode: 'rpc-unavailable',
      evidence: {
        workerConnected: true,
        rpcReachable: false,
        errorKind: 'rpc-timeout',
      },
    });
  });

  it('does not recommend an Ollama restart for a coordinator OpenAI-compatible failure', async () => {
    const service = new LocalAiProbeService({
      fetch: vi.fn(async () => new Response('{}', { status: 500 })),
      now: () => 1_700_000_000_000,
    });

    const report = await service.diagnose(target(
      { type: 'coordinator' },
      {
        provider: 'openai-compatible',
        endpointId: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234',
      },
    ));

    expect(report.recommendedActions).toEqual(['deep-check']);
  });

  it('preserves a worker inference-timeout result by budgeting the full functional RPC sequence', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen3:8b' }] }))
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      }));
    const workerHealth = new WorkerLocalAiHealth({ fetch: fetchMock });
    const sendServiceRpc = vi.fn((
      _nodeId: string,
      _method: string,
      params: unknown,
      rpcTimeoutMs = 0,
    ) => new Promise<unknown>((resolve, reject) => {
      const rpcTimeout = setTimeout(
        () => reject(new Error(`RPC timeout after ${rpcTimeoutMs}ms`)),
        rpcTimeoutMs,
      );
      workerHealth.check(params).then(
        (result) => {
          clearTimeout(rpcTimeout);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(rpcTimeout);
          reject(error);
        },
      );
    }));
    const service = new LocalAiProbeService({ sendServiceRpc });

    try {
      const pending = service.check(target(
        { type: 'worker', nodeId: 'worker-7' },
        { canary: { model: 'qwen3:8b', timeoutMs: 25, intervalMs: 600_000 } },
      ), 'functional');
      await vi.advanceTimersByTimeAsync(25);
      const samples = await pending;

      expect(sendServiceRpc.mock.calls[0]?.[3]).toBeGreaterThan(25);
      expect(samples.at(-1)).toMatchObject({
        layer: 'inference',
        ok: false,
        failureCode: 'inference-timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an oversized worker response as a protocol error without retaining its content', async () => {
    const oversized = Array.from({ length: 3 }, (_, index) => workerSample({
      layer: index === 0 ? 'endpoint' : 'model',
      message: 'x'.repeat(4_000),
      evidence: {
        advertisedModels: Array.from({ length: 7 }, (_unused, modelIndex) =>
          `${modelIndex}-${'m'.repeat(500)}`),
      },
    }));
    expect(oversized.every((sample) =>
      Buffer.byteLength(JSON.stringify(sample.evidence), 'utf8') < 4 * 1024)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(oversized), 'utf8')).toBeGreaterThan(16 * 1024);
    const service = new LocalAiProbeService({
      sendServiceRpc: vi.fn(async () => oversized),
    });

    const samples = await service.check(
      target({ type: 'worker', nodeId: 'worker-7' }),
      'lightweight',
    );

    expect(samples).toEqual([
      expect.objectContaining({
        layer: 'worker',
        ok: false,
        failureCode: 'protocol-error',
        message: 'The worker returned an invalid or oversized health response.',
      }),
    ]);
    expect(JSON.stringify(samples)).not.toContain('x'.repeat(100));
  });

  it('uses a dedicated repair RPC budget that outlives the bounded worker command sequence', async () => {
    const sendServiceRpc = vi.fn(async (
      _nodeId: string,
      _method: string,
      _params?: unknown,
      _timeoutMs?: number,
    ) => ({
      targetId: 'ollama',
      action: 'restart-ollama',
      outcome: 'recovered',
      supported: true,
      attempted: true,
      recovered: true,
      message: 'The fixed Ollama restart operation completed.',
      completedAt: 1_700_000_000_100,
    }));
    const service = new LocalAiProbeService({ sendServiceRpc });

    const result = await service.repair(target(
      { type: 'worker', nodeId: 'worker-7' },
      { canary: { model: 'qwen3:8b', timeoutMs: 1, intervalMs: 600_000 } },
    ), 'restart-ollama');

    expect(result).toMatchObject({
      targetId: 'target-1',
      attempted: true,
      recovered: true,
    });
    expect(sendServiceRpc.mock.calls[0]?.[3]).toBeGreaterThan(60_000);
  });
});
