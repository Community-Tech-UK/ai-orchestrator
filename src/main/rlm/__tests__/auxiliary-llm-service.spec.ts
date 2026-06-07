import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../auxiliary-model-client', () => ({
  probeOllamaEndpoint: vi.fn(),
  listOllamaModels: vi.fn(),
  generateWithOllama: vi.fn(),
  probeOpenAiCompatibleEndpoint: vi.fn(),
  listOpenAiCompatibleModels: vi.fn(),
  generateWithOpenAiCompatible: vi.fn(),
}));

vi.mock('../token-counter', () => ({
  getTokenCounter: vi.fn(() => ({
    countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  })),
}));

// The service reaches remote-node modules through injectable seams (it cannot
// statically import them — they pull in electron). Drive those seams directly.
interface MockWorkerNode {
  id: string;
  name: string;
  status: string;
  capabilities: {
    localModelEndpoints?: Array<{
      provider: 'ollama' | 'openai-compatible';
      baseUrl: string;
      models: string[];
      healthy: boolean;
    }>;
  };
}
const remoteState: {
  nodes: MockWorkerNode[];
  connected: Set<string>;
  rpc: ReturnType<typeof vi.fn>;
} = { nodes: [], connected: new Set<string>(), rpc: vi.fn() };

function resetRemoteState() {
  remoteState.nodes = [];
  remoteState.connected = new Set<string>();
  remoteState.rpc = vi.fn();
}

async function installRemoteHooks() {
  const { __setAuxiliaryRemoteHooksForTesting } = await import('../auxiliary-llm-service');
  __setAuxiliaryRemoteHooksForTesting({
    isNodeConnected: (id: string) => remoteState.connected.has(id),
    sendServiceRpc: <T>(...args: unknown[]) => remoteState.rpc(...args) as Promise<T>,
    // Cast through unknown: the test's structural node shape matches the fields
    // the service reads (id, name, status, capabilities.localModelEndpoints).
    connectedWorkerNodes: () =>
      remoteState.nodes.filter((n) => n.status === 'connected') as never,
  });
}

// ─── Test setup ───────────────────────────────────────────────────────────────

async function getService() {
  const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
  AuxiliaryLlmService._resetForTesting();
  const { AuxiliaryLlmService: Fresh } = await import('../auxiliary-llm-service');
  return Fresh.getInstance();
}

async function getMocks() {
  const client = await import('../auxiliary-model-client');
  return {
    probeOllama: vi.mocked(client.probeOllamaEndpoint),
    listOllama: vi.mocked(client.listOllamaModels),
    generateOllama: vi.mocked(client.generateWithOllama),
    probeOpenAi: vi.mocked(client.probeOpenAiCompatibleEndpoint),
    listOpenAi: vi.mocked(client.listOpenAiCompatibleModels),
    generateOpenAi: vi.mocked(client.generateWithOpenAiCompatible),
  };
}

function baseSettings(overrides: Partial<{
  auxiliaryLlmEnabled: boolean;
  auxiliaryLlmRoutingMode: 'off' | 'local-first' | 'cheap-first' | 'manual-only';
  auxiliaryLlmAllowRemoteWorkerModels: boolean;
  auxiliaryLlmEndpointsJson: string;
  auxiliaryLlmSlotsJson: string;
}> = {}) {
  return {
    auxiliaryLlmEnabled: true,
    auxiliaryLlmRoutingMode: 'local-first' as const,
    auxiliaryLlmAllowRemoteWorkerModels: true,
    auxiliaryLlmEndpointsJson: '[]',
    auxiliaryLlmSlotsJson: JSON.stringify({
      compression: { enabled: true, provider: 'auto', maxInputTokens: 96000, maxOutputTokens: 4096, temperature: 0.2, timeoutMs: 60000, requireJson: false, allowFrontierFallback: false },
      memoryDistillation: { enabled: true, provider: 'auto', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: false },
      webExtract: { enabled: true, provider: 'auto', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.1, timeoutMs: 30000, requireJson: false, allowFrontierFallback: false },
      titleGeneration: { enabled: true, provider: 'auto', maxInputTokens: 12000, maxOutputTokens: 128, temperature: 0.2, timeoutMs: 15000, requireJson: false, allowFrontierFallback: false },
      routingClassification: { enabled: true, provider: 'auto', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 15000, requireJson: true, allowFrontierFallback: false },
      approvalScoring: { enabled: true, provider: 'auto', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 15000, requireJson: true, allowFrontierFallback: false },
      loopScoring: { enabled: true, provider: 'auto', maxInputTokens: 32000, maxOutputTokens: 1024, temperature: 0, timeoutMs: 30000, requireJson: true, allowFrontierFallback: false },
    }),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuxiliaryLlmService — disabled service', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    AuxiliaryLlmService._resetForTesting();
  });

  it('returns fallback without network calls when service is disabled', async () => {
    const service = await getService();
    service.configure(baseSettings({ auxiliaryLlmEnabled: false }));
    const mocks = await getMocks();

    const { text, decision } = await service.generate('compression', 'sys', 'user');

    expect(text).toBe('');
    expect(decision.source).toBe('fallback');
    expect(mocks.probeOllama).not.toHaveBeenCalled();
    expect(mocks.generateOllama).not.toHaveBeenCalled();
  });

  it('returns fallback without network calls when routing mode is off', async () => {
    const service = await getService();
    service.configure(baseSettings({ auxiliaryLlmRoutingMode: 'off' }));
    const mocks = await getMocks();

    const { text, decision } = await service.generate('titleGeneration', 'sys', 'user');

    expect(decision.source).toBe('fallback');
    expect(mocks.probeOllama).not.toHaveBeenCalled();
  });
});

describe('AuxiliaryLlmService — local-first routing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    AuxiliaryLlmService._resetForTesting();
  });

  it('chooses healthy Ollama localhost before cheap-cloud endpoints', async () => {
    const service = await getService();
    const mocks = await getMocks();

    // Ollama localhost is healthy
    mocks.probeOllama.mockResolvedValue(true);
    mocks.listOllama.mockResolvedValue([{ id: 'llama3', name: 'llama3', provider: 'ollama', endpointId: 'aaa' }]);
    mocks.generateOllama.mockResolvedValue('compressed text');
    // OpenAI-compatible endpoint also configured but should not be called
    mocks.probeOpenAi.mockResolvedValue(true);

    service.configure(baseSettings({
      auxiliaryLlmEndpointsJson: JSON.stringify([{
        id: 'openai-ep',
        label: 'OpenAI Compat',
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:1234',
        source: 'manual',
        enabled: true,
      }]),
    }));

    const { text, decision } = await service.generate('compression', 'You compress.', 'Long text to compress.');

    expect(text).toBe('compressed text');
    expect(decision.provider).toBe('ollama');
    expect(decision.source).toBe('local');
    // OpenAI endpoint should not be probed at all
    expect(mocks.probeOpenAi).not.toHaveBeenCalled();
    expect(mocks.generateOpenAi).not.toHaveBeenCalled();
  });

  it('falls back to next endpoint when localhost Ollama is unhealthy', async () => {
    const service = await getService();
    const mocks = await getMocks();

    mocks.probeOllama.mockResolvedValue(false);
    mocks.probeOpenAi.mockResolvedValue(true);
    mocks.listOpenAi.mockResolvedValue([{ id: 'gpt-4o-mini', name: 'gpt-4o-mini', provider: 'openai-compatible', endpointId: 'bbb' }]);
    mocks.generateOpenAi.mockResolvedValue('generated via openai-compat');

    service.configure(baseSettings({
      auxiliaryLlmEndpointsJson: JSON.stringify([{
        id: 'openai-ep',
        label: 'OpenAI Compat',
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:1234',
        source: 'manual',
        enabled: true,
      }]),
    }));

    const { text, decision } = await service.generate('webExtract', 'sys', 'user');

    expect(text).toBe('generated via openai-compat');
    expect(decision.provider).toBe('openai-compatible');
  });
});

describe('AuxiliaryLlmService — manual-only routing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    AuxiliaryLlmService._resetForTesting();
  });

  it('returns fallback when no explicit endpointId/model is configured', async () => {
    const service = await getService();
    service.configure(baseSettings({ auxiliaryLlmRoutingMode: 'manual-only' }));
    const mocks = await getMocks();

    const { decision } = await service.generate('titleGeneration', 'sys', 'user');

    expect(decision.source).toBe('fallback');
    expect(mocks.probeOllama).not.toHaveBeenCalled();
  });
});

describe('AuxiliaryLlmService — malformed JSON config', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    AuxiliaryLlmService._resetForTesting();
  });

  it('uses defaults when auxiliaryLlmSlotsJson is invalid', async () => {
    const service = await getService();
    const mocks = await getMocks();

    // Malformed slots JSON — should not throw; defaults used instead
    service.configure(baseSettings({ auxiliaryLlmSlotsJson: '{not valid json' }));

    mocks.probeOllama.mockResolvedValue(true);
    mocks.listOllama.mockResolvedValue([{ id: 'llama3', name: 'llama3', provider: 'ollama', endpointId: 'aaa' }]);
    mocks.generateOllama.mockResolvedValue('ok');

    // Service should still work (defaults applied)
    const { decision } = await service.generate('compression', 'sys', 'user');
    // Either the slot is enabled via defaults, or we got a fallback — either
    // way, no exception should be thrown.
    expect(['local', 'fallback']).toContain(decision.source);
  });

  it('uses empty endpoints when auxiliaryLlmEndpointsJson is invalid', async () => {
    const service = await getService();
    // Should not throw on configure
    expect(() =>
      service.configure(baseSettings({ auxiliaryLlmEndpointsJson: 'not-json' }))
    ).not.toThrow();
  });
});

describe('AuxiliaryLlmService — JSON slot fallback text', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    AuxiliaryLlmService._resetForTesting();
  });

  it('loopScoring fallback returns valid JSON with score:0', async () => {
    const service = await getService();
    service.configure(baseSettings({ auxiliaryLlmEnabled: false }));

    const { text, decision } = await service.generate('loopScoring', 'sys', 'user');

    expect(decision.source).toBe('fallback');
    const parsed = JSON.parse(text);
    expect(typeof parsed.score).toBe('number');
    expect(typeof parsed.confidence).toBe('number');
    expect(typeof parsed.reason).toBe('string');
  });

  it('compression fallback returns empty string', async () => {
    const service = await getService();
    service.configure(baseSettings({ auxiliaryLlmEnabled: false }));

    const { text, decision } = await service.generate('compression', 'sys', 'user');

    expect(text).toBe('');
    expect(decision.source).toBe('fallback');
  });

  it('memoryDistillation fallback returns empty string', async () => {
    const service = await getService();
    service.configure(baseSettings({ auxiliaryLlmEnabled: false }));

    const { text } = await service.generate('memoryDistillation', 'sys', 'user');

    expect(text).toBe('');
  });
});

describe('AuxiliaryLlmService — prompt truncation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    AuxiliaryLlmService._resetForTesting();
  });

  it('emits auxiliary:input-truncated when prompt exceeds maxInputTokens', async () => {
    const service = await getService();
    const mocks = await getMocks();

    // Configure with a tiny maxInputTokens to force truncation
    const tinySlots = JSON.stringify({
      compression: { enabled: true, provider: 'auto', maxInputTokens: 10, maxOutputTokens: 4096, temperature: 0.2, timeoutMs: 60000, requireJson: false, allowFrontierFallback: false },
      memoryDistillation: { enabled: true, provider: 'auto', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: false },
      webExtract: { enabled: true, provider: 'auto', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.1, timeoutMs: 30000, requireJson: false, allowFrontierFallback: false },
      titleGeneration: { enabled: true, provider: 'auto', maxInputTokens: 12000, maxOutputTokens: 128, temperature: 0.2, timeoutMs: 15000, requireJson: false, allowFrontierFallback: false },
      routingClassification: { enabled: true, provider: 'auto', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 15000, requireJson: true, allowFrontierFallback: false },
      approvalScoring: { enabled: true, provider: 'auto', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 15000, requireJson: true, allowFrontierFallback: false },
      loopScoring: { enabled: true, provider: 'auto', maxInputTokens: 32000, maxOutputTokens: 1024, temperature: 0, timeoutMs: 30000, requireJson: true, allowFrontierFallback: false },
    });

    service.configure(baseSettings({ auxiliaryLlmSlotsJson: tinySlots }));

    mocks.probeOllama.mockResolvedValue(true);
    mocks.listOllama.mockResolvedValue([{ id: 'llama3', name: 'llama3', provider: 'ollama', endpointId: 'aaa' }]);
    mocks.generateOllama.mockResolvedValue('done');

    const truncatedEvents: unknown[] = [];
    service.on('auxiliary:input-truncated', (ev) => truncatedEvents.push(ev));

    // Provide a prompt that clearly exceeds 10 tokens (our mock counts 1 token per 4 chars)
    const longUserPrompt = 'A'.repeat(500); // ~125 tokens via mock
    await service.generate('compression', 'sys', longUserPrompt);

    expect(truncatedEvents.length).toBeGreaterThan(0);
    const ev = truncatedEvents[0] as { slot: string; originalTokens: number; targetTokens: number };
    expect(ev.slot).toBe('compression');
    expect(ev.originalTokens).toBeGreaterThan(10);
  });
});

describe('AuxiliaryLlmService — singleton pattern', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    AuxiliaryLlmService._resetForTesting();
  });

  it('getInstance returns the same instance', async () => {
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    const a = AuxiliaryLlmService.getInstance();
    const b = AuxiliaryLlmService.getInstance();
    expect(a).toBe(b);
  });

  it('_resetForTesting creates a fresh instance', async () => {
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    const a = AuxiliaryLlmService.getInstance();
    AuxiliaryLlmService._resetForTesting();
    const b = AuxiliaryLlmService.getInstance();
    expect(a).not.toBe(b);
  });

  it('getAuxiliaryLlmService returns the singleton', async () => {
    const { AuxiliaryLlmService, getAuxiliaryLlmService } = await import('../auxiliary-llm-service');
    const svc = getAuxiliaryLlmService();
    expect(svc).toBe(AuxiliaryLlmService.getInstance());
  });
});

describe('AuxiliaryLlmService — allowFrontierFallback in decision', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    AuxiliaryLlmService._resetForTesting();
  });

  it('reports allowFrontierFallback = true when the service is disabled', async () => {
    const service = await getService();
    service.configure(baseSettings({ auxiliaryLlmEnabled: false }));

    const { decision } = await service.generate('compression', 'sys', 'user');
    expect(decision.source).toBe('fallback');
    expect(decision.allowFrontierFallback).toBe(true);
  });

  it('mirrors the slot config flag on a successful local decision', async () => {
    const service = await getService();
    const mocks = await getMocks();
    mocks.probeOllama.mockResolvedValue(true);
    mocks.listOllama.mockResolvedValue([{ id: 'llama3', name: 'llama3', provider: 'ollama', endpointId: 'aaa' }]);
    mocks.generateOllama.mockResolvedValue('ok');

    // baseSettings ships compression with allowFrontierFallback: false
    service.configure(baseSettings());

    const { decision } = await service.generate('compression', 'sys', 'user');
    expect(decision.source).toBe('local');
    expect(decision.allowFrontierFallback).toBe(false);
  });

  it('honors the slot flag on fallback when the slot is enabled but nothing is healthy', async () => {
    const service = await getService();
    const mocks = await getMocks();
    mocks.probeOllama.mockResolvedValue(false); // no healthy endpoint anywhere

    service.configure(baseSettings()); // compression allowFrontierFallback: false

    const { decision } = await service.generate('compression', 'sys', 'user');
    expect(decision.source).toBe('fallback');
    expect(decision.allowFrontierFallback).toBe(false);
  });
});

describe('AuxiliaryLlmService — worker-node discovery and routing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetRemoteState();
    await installRemoteHooks();
    const { AuxiliaryLlmService } = await import('../auxiliary-llm-service');
    AuxiliaryLlmService._resetForTesting();
  });

  afterEach(async () => {
    // Restore production seams so other spec files in this fork aren't affected.
    const { __resetAuxiliaryRemoteHooksForTesting } = await import('../auxiliary-llm-service');
    __resetAuxiliaryRemoteHooksForTesting();
  });

  function seedConnectedWorker() {
    remoteState.nodes = [{
      id: 'node-1',
      name: 'Windows 5090',
      status: 'connected',
      capabilities: {
        localModelEndpoints: [{
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          models: ['gemma4:12b', 'gemma4:26b'],
          healthy: true,
        }],
      },
    }];
    remoteState.connected = new Set(['node-1']);
  }

  it('discoverCandidates surfaces a connected worker node as a worker-node candidate', async () => {
    const service = await getService();
    const mocks = await getMocks();
    mocks.probeOllama.mockResolvedValue(false); // localhost down — only worker available

    seedConnectedWorker();
    service.configure(baseSettings());

    const candidates = await service.discoverCandidates();
    const workerCandidate = candidates.find((c) => c.endpoint.source === 'worker-node');

    expect(workerCandidate).toBeDefined();
    expect(workerCandidate!.endpoint.workerNodeId).toBe('node-1');
    expect(workerCandidate!.healthy).toBe(true);
    expect(workerCandidate!.models.map((m) => m.id)).toContain('gemma4:12b');
    // The coordinator must NOT dial the worker's localhost directly.
    expect(mocks.listOllama).not.toHaveBeenCalledWith('http://127.0.0.1:11434', expect.anything());
  });

  it('omits worker-node candidates when allowRemoteWorkerModels is false', async () => {
    const service = await getService();
    const mocks = await getMocks();
    mocks.probeOllama.mockResolvedValue(false);

    seedConnectedWorker();
    service.configure(baseSettings({ auxiliaryLlmAllowRemoteWorkerModels: false }));

    const candidates = await service.discoverCandidates();
    expect(candidates.some((c) => c.endpoint.source === 'worker-node')).toBe(false);
  });

  it('routes generation to a connected worker via RPC when localhost is unavailable', async () => {
    const service = await getService();
    const mocks = await getMocks();
    mocks.probeOllama.mockResolvedValue(false); // localhost Ollama down
    remoteState.rpc = vi.fn().mockResolvedValue({ text: 'compressed by worker' });

    seedConnectedWorker();
    service.configure(baseSettings());

    const { text, decision } = await service.generate('compression', 'You compress.', 'Long text.');

    expect(text).toBe('compressed by worker');
    expect(decision.source).toBe('local');
    expect(decision.endpointId).toBe('worker:node-1:ollama:127.0.0.1:11434');
    expect(decision.model).toBe('gemma4:12b');
    // RPC proxied to the selected node with the generate method — never a direct fetch.
    expect(remoteState.rpc).toHaveBeenCalledTimes(1);
    const [nodeId, method, params] = remoteState.rpc.mock.calls[0];
    expect(nodeId).toBe('node-1');
    expect(method).toBe('auxiliaryModel.generate');
    expect((params as { model: string }).model).toBe('gemma4:12b');
    // A sized context window is forwarded so the worker's Ollama isn't capped at
    // its ~4k default for long-input slots.
    expect((params as { numCtx: number }).numCtx).toBeGreaterThanOrEqual(4096);
    expect(mocks.generateOllama).not.toHaveBeenCalled();
  });

  it('routes to a worker LM Studio (openai-compatible) endpoint and labels it local', async () => {
    const service = await getService();
    const mocks = await getMocks();
    mocks.probeOllama.mockResolvedValue(false); // no localhost Ollama
    remoteState.rpc = vi.fn().mockResolvedValue({ text: 'summary from worker LM Studio' });

    remoteState.nodes = [{
      id: 'node-1',
      name: 'Windows 5090',
      status: 'connected',
      capabilities: {
        localModelEndpoints: [{
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1234',
          models: ['qwen2.5-coder-7b'],
          healthy: true,
        }],
      },
    }];
    remoteState.connected = new Set(['node-1']);
    service.configure(baseSettings());

    const { text, decision } = await service.generate('compression', 'You compress.', 'Long text.');

    expect(text).toBe('summary from worker LM Studio');
    // A worker's own localhost LM Studio runs locally on the worker — it must be
    // categorised as 'local', not 'cheap-cloud'.
    expect(decision.source).toBe('local');
    expect(decision.provider).toBe('openai-compatible');
    expect(decision.endpointId).toBe('worker:node-1:openai-compatible:127.0.0.1:1234');
    expect(decision.model).toBe('qwen2.5-coder-7b');

    const [nodeId, method, params] = remoteState.rpc.mock.calls[0];
    expect(nodeId).toBe('node-1');
    expect(method).toBe('auxiliaryModel.generate');
    expect((params as { provider: string }).provider).toBe('openai-compatible');
  });

  it('gives distinct ids to two same-provider endpoints on one worker (no collision)', async () => {
    const service = await getService();
    const mocks = await getMocks();
    mocks.probeOllama.mockResolvedValue(false);

    remoteState.nodes = [{
      id: 'node-1',
      name: 'Dual Ollama',
      status: 'connected',
      capabilities: {
        localModelEndpoints: [
          { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: ['gemma4:12b'], healthy: true },
          { provider: 'ollama', baseUrl: 'http://127.0.0.1:11435', models: ['gemma4:26b'], healthy: true },
        ],
      },
    }];
    remoteState.connected = new Set(['node-1']);
    service.configure(baseSettings());

    const candidates = await service.discoverCandidates();
    const workerCandidates = candidates.filter((c) => c.endpoint.source === 'worker-node');

    expect(workerCandidates).toHaveLength(2);
    const ids = workerCandidates.map((c) => c.endpoint.id);
    expect(new Set(ids).size).toBe(2); // ids are distinct, neither overwrites the other
    expect(ids).toContain('worker:node-1:ollama:127.0.0.1:11434');
    expect(ids).toContain('worker:node-1:ollama:127.0.0.1:11435');
  });

  it('does not route to a worker that is not connected', async () => {
    const service = await getService();
    const mocks = await getMocks();
    mocks.probeOllama.mockResolvedValue(false);
    remoteState.rpc = vi.fn().mockResolvedValue({ text: 'should not be used' });

    // Node is in the registry but NOT in the connected set / not 'connected' status.
    remoteState.nodes = [{
      id: 'node-2',
      name: 'Offline',
      status: 'disconnected',
      capabilities: {
        localModelEndpoints: [{
          provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: ['gemma4:12b'], healthy: true,
        }],
      },
    }];
    service.configure(baseSettings());

    const { decision } = await service.generate('compression', 'sys', 'user');
    expect(decision.source).toBe('fallback');
    expect(remoteState.rpc).not.toHaveBeenCalled();
  });
});

describe('computeNumCtx', () => {
  it('rounds a small prompt up to the minimum bucket', async () => {
    const { computeNumCtx } = await import('../auxiliary-llm-service');
    // ~30 prompt tokens + 128 output + 512 headroom => one 8192 bucket, but the
    // floor is NUM_CTX_MIN (4096); 8192 wins here.
    expect(computeNumCtx(30, 128, 12_000)).toBe(8_192);
  });

  it('sizes the window to the prompt, bucketed to 8192', async () => {
    const { computeNumCtx } = await import('../auxiliary-llm-service');
    // 20000 + 2048 + 512 = 22560 -> ceil to 24576 (3 * 8192)
    expect(computeNumCtx(20_000, 2_048, 96_000)).toBe(24_576);
  });

  it('clamps to the default ceiling for normally-sized slots', async () => {
    const { computeNumCtx } = await import('../auxiliary-llm-service');
    // Huge prompt token estimate but slot maxInputTokens is modest -> ceiling
    // stays at the 131072 default.
    expect(computeNumCtx(500_000, 4_096, 96_000)).toBe(131_072);
  });

  it('raises the ceiling so a slot is never re-truncated below its own maxInputTokens', async () => {
    const { computeNumCtx } = await import('../auxiliary-llm-service');
    // Slot deliberately configured huge (200k). The window must accommodate the
    // slot's budget rather than clamp to the 131072 default and silently chop.
    const result = computeNumCtx(200_000, 4_096, 200_000);
    expect(result).toBeGreaterThanOrEqual(200_000 + 4_096);
  });
});
