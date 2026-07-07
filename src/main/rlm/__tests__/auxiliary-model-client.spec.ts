import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuxiliaryGenerateRequest } from '../auxiliary-model-client';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const BASE_GENERATE_REQUEST: AuxiliaryGenerateRequest = {
  systemPrompt: 'You are helpful.',
  userPrompt: 'Hello',
  model: 'llama3',
  temperature: 0.2,
  maxOutputTokens: 256,
  timeoutMs: 5000,
  requireJson: false,
};

// ─── Ollama tests ─────────────────────────────────────────────────────────────

describe('probeOllamaEndpoint', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when the endpoint responds with ok=true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ version: '0.1.0' }, true)));
    const { probeOllamaEndpoint } = await import('../auxiliary-model-client');
    const result = await probeOllamaEndpoint('http://127.0.0.1:11434', 5000);
    expect(result).toBe(true);
  });

  it('returns false when the endpoint responds with ok=false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({}, false, 404)));
    const { probeOllamaEndpoint } = await import('../auxiliary-model-client');
    const result = await probeOllamaEndpoint('http://127.0.0.1:11434', 5000);
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const { probeOllamaEndpoint } = await import('../auxiliary-model-client');
    const result = await probeOllamaEndpoint('http://127.0.0.1:11434', 5000);
    expect(result).toBe(false);
  });
});

describe('listOllamaModels', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps /api/tags response to AuxiliaryLlmModelInfo array', async () => {
    const apiResponse = {
      models: [
        {
          name: 'llama3:8b',
          parameter_size: '8B',
          quantization_level: 'Q4_K_M',
          modified_at: '2024-01-01T00:00:00Z',
        },
        {
          name: 'mistral:7b',
          parameter_size: '7B',
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(apiResponse, true)));
    const { listOllamaModels } = await import('../auxiliary-model-client');
    const models = await listOllamaModels('http://127.0.0.1:11434', 5000);

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('llama3:8b');
    expect(models[0].name).toBe('llama3:8b');
    expect(models[0].provider).toBe('ollama');
    expect(models[0].parameterSize).toBe('8B');
    expect(models[0].quantization).toBe('Q4_K_M');
    expect(models[0].modifiedAt).toBe('2024-01-01T00:00:00Z');
    expect(models[0].endpointId).toBeTruthy();
    expect(models[0].endpointId.length).toBeLessThanOrEqual(12);

    expect(models[1].id).toBe('mistral:7b');
    expect(models[1].provider).toBe('ollama');
  });

  it('returns empty array on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({}, false, 500)));
    const { listOllamaModels } = await import('../auxiliary-model-client');
    const models = await listOllamaModels('http://127.0.0.1:11434', 5000);
    expect(models).toHaveLength(0);
  });

  it('returns empty array on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const { listOllamaModels } = await import('../auxiliary-model-client');
    const models = await listOllamaModels('http://127.0.0.1:11434', 5000);
    expect(models).toHaveLength(0);
  });
});

describe('generateWithOllama', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends format:json when requireJson is true', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ response: 'ok' }, true));
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOllama } = await import('../auxiliary-model-client');
    await generateWithOllama('http://127.0.0.1:11434', { ...BASE_GENERATE_REQUEST, requireJson: true });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.format).toBe('json');
  });

  it('does not send format when requireJson is false', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ response: 'hello' }, true));
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOllama } = await import('../auxiliary-model-client');
    await generateWithOllama('http://127.0.0.1:11434', { ...BASE_GENERATE_REQUEST, requireJson: false });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.format).toBeUndefined();
  });

  it('returns response text on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ response: 'generated text' }, true)));
    const { generateWithOllama } = await import('../auxiliary-model-client');
    const result = await generateWithOllama('http://127.0.0.1:11434', BASE_GENERATE_REQUEST);
    expect(result).toBe('generated text');
  });

  it('sends a default keep_alive so the model stays resident', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ response: 'ok' }, true));
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOllama } = await import('../auxiliary-model-client');
    const { DEFAULT_OLLAMA_KEEP_ALIVE } = await import('../../../shared/types/auxiliary-llm.types');
    await generateWithOllama('http://127.0.0.1:11434', BASE_GENERATE_REQUEST);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.keep_alive).toBe(DEFAULT_OLLAMA_KEEP_ALIVE);
  });

  it('passes num_ctx into options so long prompts are not truncated to the default', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ response: 'ok' }, true));
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOllama } = await import('../auxiliary-model-client');
    await generateWithOllama('http://127.0.0.1:11434', { ...BASE_GENERATE_REQUEST, numCtx: 32768 });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.options.num_ctx).toBe(32768);
  });

  it('omits num_ctx when not provided (Ollama keeps its own default)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ response: 'ok' }, true));
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOllama } = await import('../auxiliary-model-client');
    await generateWithOllama('http://127.0.0.1:11434', BASE_GENERATE_REQUEST);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.options.num_ctx).toBeUndefined();
  });

  it('honours an explicit keepAlive override', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ response: 'ok' }, true));
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOllama } = await import('../auxiliary-model-client');
    await generateWithOllama('http://127.0.0.1:11434', { ...BASE_GENERATE_REQUEST, keepAlive: '2h' });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.keep_alive).toBe('2h');
  });

  it('sanitizes prompt parts before concatenating', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ response: 'ok' }, true));
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOllama } = await import('../auxiliary-model-client');
    await generateWithOllama('http://127.0.0.1:11434', {
      ...BASE_GENERATE_REQUEST,
      systemPrompt: 'sys\uD83D',
      userPrompt: '\uDE00user \uD83D\uDE00 zero\u200Bwidth',
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.prompt).toBe('sys\n\nuser \uD83D\uDE00 zerowidth');
  });

  it('throws with "timed out" on AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    const { generateWithOllama } = await import('../auxiliary-model-client');
    await expect(
      generateWithOllama('http://127.0.0.1:11434', { ...BASE_GENERATE_REQUEST, timeoutMs: 1 })
    ).rejects.toThrow('timed out');
  });

  it('throws on non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ error: 'model not found' }, false, 404)));
    const { generateWithOllama } = await import('../auxiliary-model-client');
    await expect(
      generateWithOllama('http://127.0.0.1:11434', BASE_GENERATE_REQUEST)
    ).rejects.toThrow('404');
  });
});

// ─── OpenAI-compatible tests ──────────────────────────────────────────────────

describe('listOpenAiCompatibleModels', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes Authorization header only when API key is provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ data: [] }, true));
    vi.stubGlobal('fetch', mockFetch);
    const { listOpenAiCompatibleModels } = await import('../auxiliary-model-client');

    // With API key
    await listOpenAiCompatibleModels('http://localhost:1234', 'sk-test-key', 5000);
    const [, optionsWithKey] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((optionsWithKey.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test-key');

    // Without API key
    await listOpenAiCompatibleModels('http://localhost:1234', undefined, 5000);
    const [, optionsNoKey] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect((optionsNoKey.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('maps data.data array to AuxiliaryLlmModelInfo', async () => {
    const apiResponse = {
      data: [
        { id: 'gpt-4o-mini', object: 'model' },
        { id: 'llama-3.1-8b', object: 'model' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(apiResponse, true)));
    const { listOpenAiCompatibleModels } = await import('../auxiliary-model-client');
    const models = await listOpenAiCompatibleModels('http://localhost:1234', undefined, 5000);

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('gpt-4o-mini');
    expect(models[0].provider).toBe('openai-compatible');
    expect(models[1].id).toBe('llama-3.1-8b');
  });
});

describe('generateWithOpenAiCompatible', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns choices[0].message.content', async () => {
    const apiResponse = {
      choices: [{ message: { role: 'assistant', content: 'Generated content' } }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(apiResponse, true)));
    const { generateWithOpenAiCompatible } = await import('../auxiliary-model-client');
    const result = await generateWithOpenAiCompatible('http://localhost:1234', undefined, BASE_GENERATE_REQUEST);
    expect(result).toBe('Generated content');
  });

  it('sends response_format json_object when requireJson is true', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({ choices: [{ message: { content: '{}' } }] }, true)
    );
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOpenAiCompatible } = await import('../auxiliary-model-client');
    await generateWithOpenAiCompatible('http://localhost:1234', undefined, {
      ...BASE_GENERATE_REQUEST,
      requireJson: true,
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('does not send response_format when requireJson is false', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({ choices: [{ message: { content: 'hello' } }] }, true)
    );
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOpenAiCompatible } = await import('../auxiliary-model-client');
    await generateWithOpenAiCompatible('http://localhost:1234', undefined, {
      ...BASE_GENERATE_REQUEST,
      requireJson: false,
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.response_format).toBeUndefined();
  });

  it('sanitizes OpenAI-compatible message content', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({ choices: [{ message: { content: 'hello' } }] }, true)
    );
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOpenAiCompatible } = await import('../auxiliary-model-client');
    await generateWithOpenAiCompatible('http://localhost:1234', undefined, {
      ...BASE_GENERATE_REQUEST,
      systemPrompt: 'sys\uD800 prompt \uD83D\uDE00 zero\u200Bwidth',
      userPrompt: 'user\uDC00 prompt \uD83D\uDE00 zero\u200Bwidth',
    });

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys prompt \uD83D\uDE00 zerowidth' },
      { role: 'user', content: 'user prompt \uD83D\uDE00 zerowidth' },
    ]);
  });

  it('throws with "timed out" on AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    const { generateWithOpenAiCompatible } = await import('../auxiliary-model-client');
    await expect(
      generateWithOpenAiCompatible('http://localhost:1234', undefined, {
        ...BASE_GENERATE_REQUEST,
        timeoutMs: 1,
      })
    ).rejects.toThrow('timed out');
  });

  it('retries without response_format when the server 400s on json_object (e.g. newer LM Studio)', async () => {
    // First call: server rejects response_format with a 400 (LM Studio only
    // accepts json_schema/text). Second call (retry without it): succeeds.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({ error: "'response_format.type' must be 'json_schema' or 'text'" }, false, 400)
      )
      .mockResolvedValueOnce(mockResponse({ choices: [{ message: { content: '{"ok":true}' } }] }, true));
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOpenAiCompatible } = await import('../auxiliary-model-client');

    const result = await generateWithOpenAiCompatible('http://localhost:1234', undefined, {
      ...BASE_GENERATE_REQUEST,
      requireJson: true,
    });

    expect(result).toBe('{"ok":true}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First attempt included response_format; retry dropped it.
    const firstBody = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    const retryBody = JSON.parse((mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(firstBody.response_format).toEqual({ type: 'json_object' });
    expect(retryBody.response_format).toBeUndefined();
  });

  it('does not retry and surfaces the body when a 400 is unrelated to response_format', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockResponse({ error: 'model not loaded' }, false, 400));
    vi.stubGlobal('fetch', mockFetch);
    const { generateWithOpenAiCompatible } = await import('../auxiliary-model-client');

    await expect(
      generateWithOpenAiCompatible('http://localhost:1234', undefined, {
        ...BASE_GENERATE_REQUEST,
        requireJson: true,
      })
    ).rejects.toThrow('model not loaded');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
