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

function mockJsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

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

describe('LLMService.subQueryViaAux() — auxiliary routing', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const { LLMService } = await import('../llm-service');
    LLMService._resetForTesting();
    auxMockControls.generate.mockResolvedValue({
      text: '',
      decision: { source: 'fallback' as const, provider: 'local-fallback' as const, slot: 'subQueryExecution', reason: 'default test fallback', allowFrontierFallback: true },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const req = { requestId: 'sq', prompt: 'where is backoff?', context: 'retry.ts has backoff', depth: 0 };

  it('returns the aux result and never calls the frontier path on a real aux result', async () => {
    auxMockControls.generate.mockResolvedValue({
      text: 'backoff lives in retry.ts',
      decision: { source: 'local' as const, provider: 'ollama' as const, slot: 'subQueryExecution', reason: 'local-first', allowFrontierFallback: false },
    });
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService();
    const subSpy = vi.spyOn(service, 'subQuery');

    const out = await service.subQueryViaAux('subQueryExecution', req);

    expect(out).toBe('backoff lives in retry.ts');
    expect(subSpy).not.toHaveBeenCalled();
    expect(auxMockControls.generate).toHaveBeenCalledWith('subQueryExecution', expect.any(String), expect.any(String));
  });

  it('falls through to the preserved subQuery() path when aux falls back and frontier is allowed', async () => {
    auxMockControls.generate.mockResolvedValue({
      text: '',
      decision: { source: 'fallback' as const, provider: 'local-fallback' as const, slot: 'subQueryExecution', reason: 'no local model', allowFrontierFallback: true },
    });
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService();
    const subSpy = vi.spyOn(service, 'subQuery').mockResolvedValue('frontier answer');

    const out = await service.subQueryViaAux('subQueryExecution', req);

    expect(subSpy).toHaveBeenCalledTimes(1);
    expect(out).toBe('frontier answer');
  });

  it('returns the deterministic local-unavailable sentinel when frontier fallback is disallowed', async () => {
    auxMockControls.generate.mockResolvedValue({
      text: '',
      decision: { source: 'fallback' as const, provider: 'local-fallback' as const, slot: 'loopScoring', reason: 'no local model', allowFrontierFallback: false },
    });
    const { getLLMService } = await import('../llm-service');
    const { LLM_UNAVAILABLE_TEXT } = await import('../llm-service.constants');
    const service = getLLMService();
    const subSpy = vi.spyOn(service, 'subQuery');

    const out = await service.subQueryViaAux('loopScoring', req);

    expect(out).toBe(LLM_UNAVAILABLE_TEXT);
    expect(subSpy).not.toHaveBeenCalled();
  });

  it('does not consume an empty non-fallback aux result — falls through to subQuery()', async () => {
    auxMockControls.generate.mockResolvedValue({
      text: '   ',
      decision: { source: 'local' as const, provider: 'ollama' as const, slot: 'branchScoring', reason: 'local-first', allowFrontierFallback: true },
    });
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService();
    const subSpy = vi.spyOn(service, 'subQuery').mockResolvedValue('frontier answer');

    const out = await service.subQueryViaAux('branchScoring', req);

    expect(subSpy).toHaveBeenCalledTimes(1);
    expect(out).toBe('frontier answer');
  });

  it('preserves old behavior (calls subQuery) when the aux service throws', async () => {
    auxMockControls.generate.mockRejectedValue(new Error('aux boom'));
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService();
    const subSpy = vi.spyOn(service, 'subQuery').mockResolvedValue('frontier answer');

    const out = await service.subQueryViaAux('subQueryExecution', req);

    expect(subSpy).toHaveBeenCalledTimes(1);
    expect(out).toBe('frontier answer');
  });
});

describe('LLMService direct provider request sanitization', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    const { LLMService } = await import('../llm-service');
    LLMService._resetForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('strips lone surrogates from Anthropic request bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ content: [{ type: 'text', text: 'ok' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService({ provider: 'anthropic', anthropicApiKey: 'sk-test' });

    await (service as unknown as {
      generateWithAnthropic: (systemPrompt: string, userPrompt: string) => Promise<string>;
    }).generateWithAnthropic(
      'sys\uD800 prompt \uD83D\uDE00 zero\u200Bwidth',
      'user\uDC00 prompt \uD83D\uDE00 zero\u200Bwidth',
    );

    const anthropicCall = fetchMock.mock.calls.find(([url]) => url === 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse((anthropicCall?.[1] as RequestInit).body as string);
    expect(body.system).toBe('sys prompt \uD83D\uDE00 zero\u200Bwidth');
    expect(body.messages).toEqual([
      { role: 'user', content: 'user prompt \uD83D\uDE00 zero\u200Bwidth' },
    ]);
  });

  it('strips lone surrogates from Ollama prompt parts before concatenating', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ response: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService({ provider: 'ollama', ollamaHost: 'http://ollama.test' });

    await (service as unknown as {
      generateWithOllama: (systemPrompt: string, userPrompt: string) => Promise<string>;
    }).generateWithOllama('sys\uD83D', '\uDE00user \uD83D\uDE00 zero\u200Bwidth');

    const generateCall = fetchMock.mock.calls.find(([url]) => url === 'http://ollama.test/api/generate');
    const body = JSON.parse((generateCall?.[1] as RequestInit).body as string);
    expect(body.prompt).toBe('sys\n\nUser: user \uD83D\uDE00 zero\u200Bwidth');
  });

  it('strips lone surrogates from OpenAI request bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { getLLMService } = await import('../llm-service');
    const service = getLLMService({ provider: 'openai', openaiApiKey: 'sk-test' });

    await (service as unknown as {
      generateWithOpenAI: (systemPrompt: string, userPrompt: string) => Promise<string>;
    }).generateWithOpenAI(
      'sys\uD800 prompt \uD83D\uDE00 zero\u200Bwidth',
      'user\uDC00 prompt \uD83D\uDE00 zero\u200Bwidth',
    );

    const openAiCall = fetchMock.mock.calls.find(([url]) => url === 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse((openAiCall?.[1] as RequestInit).body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys prompt \uD83D\uDE00 zero\u200Bwidth' },
      { role: 'user', content: 'user prompt \uD83D\uDE00 zero\u200Bwidth' },
    ]);
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
