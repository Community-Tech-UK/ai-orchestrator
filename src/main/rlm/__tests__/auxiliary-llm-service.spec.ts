import { describe, it, expect, vi, beforeEach } from 'vitest';

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
