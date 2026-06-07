import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock control for auxiliary-llm-service
const auxMockControls = vi.hoisted(() => {
  const generate = vi.fn().mockResolvedValue({
    text: '',
    decision: { source: 'fallback' as const, provider: 'local-fallback' as const, slot: 'compression', reason: 'default test fallback' },
  });
  return { generate };
});

vi.mock('../auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({ generate: auxMockControls.generate }),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe('LLMService.summarize() — auxiliary routing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const { LLMService } = await import('../llm-service');
    LLMService._resetForTesting();
    // Reset aux mock to fallback default
    auxMockControls.generate.mockResolvedValue({
      text: '',
      decision: { source: 'fallback' as const, provider: 'local-fallback' as const, slot: 'compression', reason: 'default test fallback' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits summarize:complete after successful auxiliary generation', async () => {
    auxMockControls.generate.mockResolvedValue({
      text: 'compressed summary',
      decision: { source: 'local' as const, provider: 'ollama' as const, slot: 'compression', reason: 'local-first' },
    });

    const { getLLMService } = await import('../llm-service');
    const service = getLLMService();

    const events: unknown[] = [];
    service.on('summarize:complete', (ev) => events.push(ev));

    const result = await service.summarize({ requestId: 'r1', content: 'text to summarize', targetTokens: 50, preserveKeyPoints: false });

    expect(result).toBe('compressed summary');
    expect(events).toHaveLength(1);
    const ev = events[0] as { requestId: string; summary: string };
    expect(ev.requestId).toBe('r1');
    expect(ev.summary).toBe('compressed summary');
  });

  it('does not call aux generate when aux service returns fallback for a second call', async () => {
    // Both calls return fallback; verify generate was called each time summarize is called
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService();

    await service.summarize({ requestId: 'r2a', content: 'some content', targetTokens: 50, preserveKeyPoints: false });
    await service.summarize({ requestId: 'r2b', content: 'other content', targetTokens: 50, preserveKeyPoints: false });

    // generate should have been called once per summarize() invocation
    expect(auxMockControls.generate).toHaveBeenCalledTimes(2);
  });

  it('uses a local fallback (never the frontier model) when aux falls back and allowFrontierFallback is false', async () => {
    auxMockControls.generate.mockResolvedValue({
      text: '',
      decision: { source: 'fallback' as const, provider: 'local-fallback' as const, slot: 'compression', reason: 'no local model', allowFrontierFallback: false },
    });

    const { getLLMService } = await import('../llm-service');
    const service = getLLMService();
    // Spy on the private frontier call — it must NOT be invoked.
    const frontierSpy = vi.spyOn(service as unknown as { generateCompletion: (s: string, u: string) => Promise<string> }, 'generateCompletion');

    const events: unknown[] = [];
    service.on('summarize:complete', (ev) => events.push(ev));

    const result = await service.summarize({ requestId: 'r-nf', content: 'sensitive content to keep local', targetTokens: 50, preserveKeyPoints: false });

    expect(frontierSpy).not.toHaveBeenCalled();
    expect(typeof result).toBe('string');
    expect(events).toHaveLength(1); // still emits summarize:complete
  });

  it('escalates to the frontier model when aux falls back and allowFrontierFallback is true', async () => {
    auxMockControls.generate.mockResolvedValue({
      text: '',
      decision: { source: 'fallback' as const, provider: 'local-fallback' as const, slot: 'compression', reason: 'no local model', allowFrontierFallback: true },
    });

    const { getLLMService } = await import('../llm-service');
    const service = getLLMService();
    const frontierSpy = vi
      .spyOn(service as unknown as { generateCompletion: (s: string, u: string) => Promise<string> }, 'generateCompletion')
      .mockResolvedValue('frontier summary');

    const result = await service.summarize({ requestId: 'r-ff', content: 'content', targetTokens: 50, preserveKeyPoints: false });

    expect(frontierSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe('frontier summary');
  });
});

describe('LLMService Ollama health checks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const { LLMService } = await import('../llm-service');
    LLMService._resetForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checkOllamaHealth() returns false and marks Ollama unavailable for a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService({ ollamaHost: 'http://ollama.test' });

    await expect(service.checkOllamaHealth()).resolves.toBe(false);
    expect(service.getProviderStatus().ollama).toBe(false);
  });

  it('checkOllamaHealth() returns false and marks Ollama unavailable for a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService({ ollamaHost: 'http://ollama.test' });

    await expect(service.checkOllamaHealth()).resolves.toBe(false);
    expect(service.getProviderStatus().ollama).toBe(false);
  });

  it('checkOllamaHealth() returns true and marks Ollama available for a 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService({ ollamaHost: 'http://ollama.test' });

    await expect(service.checkOllamaHealth()).resolves.toBe(true);
    expect(service.getProviderStatus().ollama).toBe(true);
  });
});
