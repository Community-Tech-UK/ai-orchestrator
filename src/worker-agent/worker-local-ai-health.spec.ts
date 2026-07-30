import { describe, expect, it, vi } from 'vitest';
import {
  EXACT_TOKEN_CANARY_PROMPT,
  WorkerLocalAiHealth,
} from './worker-local-ai-health';

const baseParams = {
  provider: 'ollama' as const,
  endpointId: 'ollama',
  expectedModels: [
    { modelId: 'qwen3:8b', required: true },
    { modelId: 'nomic-embed-text', required: false },
  ],
  kind: 'functional' as const,
  canary: {
    contract: 'exact-token-v1' as const,
    model: 'qwen3:8b',
  },
  latencyThresholdMs: 1_000,
  timeoutMs: 500,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('WorkerLocalAiHealth', () => {
  it('returns endpoint metadata, expected-model state, and a bounded exact-token canary without caller content', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({
        models: [
          { name: 'qwen3:8b' },
          { name: 'nomic-embed-text' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({ response: '  AIO_HEALTH_OK\n' }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check(baseParams);

    expect(samples.map((sample) => [sample.layer, sample.ok, sample.failureCode])).toEqual([
      ['endpoint', true, undefined],
      ['model', true, undefined],
      ['inference', true, undefined],
    ]);
    expect(samples[0]?.evidence).toMatchObject({
      endpointReachable: true,
      endpointVersion: '0.12.1',
      endpointProtocol: 'ollama-api',
    });
    expect(samples[1]?.evidence).toMatchObject({
      advertisedModels: ['qwen3:8b', 'nomic-embed-text'],
      missingModels: [],
      requiredModelCount: 1,
    });
    expect(samples[2]?.evidence).toMatchObject({
      canaryOutputValid: true,
    });

    const [url, init] = fetchMock.mock.calls[2]!;
    expect(url).toBe('http://127.0.0.1:11434/api/generate');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'qwen3:8b',
      prompt: EXACT_TOKEN_CANARY_PROMPT,
      stream: false,
      options: {
        temperature: 0,
        num_predict: 8,
      },
    });
  });

  it('reports a missing required model and does not run the canary', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({
        models: [{ name: 'nomic-embed-text' }],
      }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check(baseParams);

    expect(samples).toHaveLength(2);
    expect(samples[1]).toMatchObject({
      layer: 'model',
      ok: false,
      required: true,
      failureCode: 'missing-required-model',
      evidence: {
        advertisedModels: ['nomic-embed-text'],
        missingModels: ['qwen3:8b'],
        requiredModelCount: 1,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a loaded model whose context is below its configured minimum', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({
        models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        models: [{ name: 'qwen3:8b', context_length: 4_096 }],
      }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check({
      ...baseParams,
      kind: 'lightweight',
      expectedModels: [
        { modelId: 'qwen3:8b', required: true, minContextLength: 8_192 },
        baseParams.expectedModels[1],
      ],
    });

    expect(fetchMock.mock.calls[2]?.[0]).toBe('http://127.0.0.1:11434/api/ps');
    expect(samples[1]).toMatchObject({
      layer: 'model',
      ok: false,
      required: true,
      failureCode: 'insufficient-context',
      evidence: {
        loadedModels: ['qwen3:8b'],
        availableContextLength: 4_096,
        insufficientContextModels: ['qwen3:8b'],
      },
    });
  });

  it('enforces LM Studio loaded context through its native model metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'qwen3:8b' }] }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          id: 'qwen3:8b',
          state: 'loaded',
          loaded_context_length: 4_096,
        }],
      }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check({
      ...baseParams,
      provider: 'openai-compatible',
      endpointId: 'openai-compatible',
      kind: 'lightweight',
      expectedModels: [{
        modelId: 'qwen3:8b',
        required: true,
        minContextLength: 8_192,
      }],
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:1234/v1/models',
      'http://127.0.0.1:1234/api/v0/models',
    ]);
    expect(samples[1]).toMatchObject({
      failureCode: 'insufficient-context',
      evidence: {
        loadedModels: ['qwen3:8b'],
        availableContextLength: 4_096,
      },
    });
  });

  it('keeps context checks compatible when an endpoint has no capacity metadata route', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({
        models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }],
      }))
      .mockResolvedValueOnce(jsonResponse({}, 404));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check({
      ...baseParams,
      kind: 'lightweight',
      expectedModels: [{
        modelId: 'qwen3:8b',
        required: true,
        minContextLength: 8_192,
      }],
    });

    expect(samples[1]).toMatchObject({ layer: 'model', ok: true });
    expect(samples[1]?.evidence).not.toHaveProperty('availableContextLength');
  });

  it.each([
    ['below', 4_096, false, 'insufficient-context'],
    ['equal to', 8_192, true, undefined],
    ['above', 16_384, true, undefined],
  ] as const)(
    'checks Ollama context after a canary loads a model %s the minimum',
    async (_relationship, contextLength, ok, failureCode) => {
      let loaded = false;
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/api/version')) return jsonResponse({ version: '0.12.1' });
        if (url.endsWith('/api/tags')) {
          return jsonResponse({ models: [{ name: 'qwen3:8b' }] });
        }
        if (url.endsWith('/api/generate')) {
          loaded = true;
          return jsonResponse({ response: 'AIO_HEALTH_OK' });
        }
        if (url.endsWith('/api/ps')) {
          return jsonResponse({
            models: loaded ? [{ name: 'qwen3:8b', context_length: contextLength }] : [],
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      const health = new WorkerLocalAiHealth({ fetch: fetchMock });

      const samples = await health.check({
        ...baseParams,
        expectedModels: [{
          modelId: 'qwen3:8b',
          required: true,
          minContextLength: 8_192,
        }],
      });

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'http://127.0.0.1:11434/api/version',
        'http://127.0.0.1:11434/api/tags',
        'http://127.0.0.1:11434/api/generate',
        'http://127.0.0.1:11434/api/ps',
      ]);
      expect(samples[1]).toMatchObject({
        layer: 'model',
        ok,
        ...(failureCode ? { failureCode } : {}),
        evidence: { availableContextLength: contextLength },
      });
    },
  );

  it('keeps functional validation compatible when post-canary capacity remains unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen3:8b' }] }))
      .mockResolvedValueOnce(jsonResponse({ response: 'AIO_HEALTH_OK' }))
      .mockResolvedValueOnce(jsonResponse({ models: [] }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check({
      ...baseParams,
      expectedModels: [{
        modelId: 'qwen3:8b',
        required: true,
        minContextLength: 8_192,
      }],
    });

    expect(samples.map((sample) => [sample.layer, sample.ok])).toEqual([
      ['endpoint', true],
      ['model', true],
      ['inference', true],
    ]);
    expect(samples[1]?.evidence).not.toHaveProperty('availableContextLength');
  });

  it('fails safely when post-canary capacity metadata is malformed', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen3:8b' }] }))
      .mockResolvedValueOnce(jsonResponse({ response: 'AIO_HEALTH_OK' }))
      .mockResolvedValueOnce(jsonResponse({ models: 'not-an-array' }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check({
      ...baseParams,
      expectedModels: [{
        modelId: 'qwen3:8b',
        required: true,
        minContextLength: 8_192,
      }],
    });

    expect(samples).toEqual([
      expect.objectContaining({
        layer: 'endpoint',
        ok: false,
        required: true,
        failureCode: 'monitor-error',
      }),
    ]);
  });

  it.each([
    ['fractional', 4_096.5],
    ['string', '4096'],
    ['below the supported minimum', 0],
    ['above the supported maximum', 100_000_001],
  ] as const)(
    'fails safely when Ollama reports a present but %s context length',
    async (_description, contextLength) => {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
        .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen3:8b' }] }))
        .mockResolvedValueOnce(jsonResponse({
          models: [{ name: 'qwen3:8b', context_length: contextLength }],
        }));
      const health = new WorkerLocalAiHealth({ fetch: fetchMock });

      const samples = await health.check({
        ...baseParams,
        kind: 'lightweight',
        expectedModels: [{
          modelId: 'qwen3:8b',
          required: true,
          minContextLength: 8_192,
        }],
      });

      expect(samples).toEqual([
        expect.objectContaining({
          layer: 'endpoint',
          ok: false,
          required: true,
          failureCode: 'monitor-error',
        }),
      ]);
    },
  );

  it('ignores malformed capacity fields belonging only to unrelated models', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen3:8b' }] }))
      .mockResolvedValueOnce(jsonResponse({
        models: [
          { name: 'qwen3:8b', context_length: 8_192 },
          { name: 'unrelated-model', context_length: 4_096.5 },
        ],
      }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check({
      ...baseParams,
      kind: 'lightweight',
      expectedModels: [{
        modelId: 'qwen3:8b',
        required: true,
        minContextLength: 8_192,
      }],
    });

    expect(samples[1]).toMatchObject({
      layer: 'model',
      ok: true,
      evidence: { availableContextLength: 8_192 },
    });
  });

  it.each([
    ['lower row first', [4_096, 16_384]],
    ['higher row first', [16_384, 4_096]],
  ] as const)(
    'uses the conservative context capacity for duplicate Ollama model rows with the %s',
    async (_description, contextLengths) => {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
        .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen3:8b' }] }))
        .mockResolvedValueOnce(jsonResponse({
          models: contextLengths.map((contextLength) => ({
            name: 'qwen3:8b',
            context_length: contextLength,
          })),
        }));
      const health = new WorkerLocalAiHealth({ fetch: fetchMock });

      const samples = await health.check({
        ...baseParams,
        kind: 'lightweight',
        expectedModels: [{
          modelId: 'qwen3:8b',
          required: true,
          minContextLength: 8_192,
        }],
      });

      expect(samples[1]).toMatchObject({
        layer: 'model',
        ok: false,
        required: true,
        failureCode: 'insufficient-context',
        evidence: {
          loadedModels: ['qwen3:8b'],
          availableContextLength: 4_096,
          insufficientContextModels: ['qwen3:8b'],
        },
      });
    },
  );

  it.each([
    ['fractional', 4_096.5],
    ['out-of-bounds', 100_000_001],
    ['wrongly typed', '4096'],
  ] as const)(
    'fails safely when LM Studio reports a %s preferred context field',
    async (_description, loadedContextLength) => {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'qwen3:8b' }] }))
        .mockResolvedValueOnce(jsonResponse({
          data: [{
            id: 'qwen3:8b',
            state: 'loaded',
            loaded_context_length: loadedContextLength,
            context_length: 16_384,
          }],
        }));
      const health = new WorkerLocalAiHealth({ fetch: fetchMock });

      const samples = await health.check({
        ...baseParams,
        provider: 'openai-compatible',
        endpointId: 'openai-compatible',
        kind: 'lightweight',
        expectedModels: [{
          modelId: 'qwen3:8b',
          required: true,
          minContextLength: 8_192,
        }],
      });

      expect(samples).toEqual([
        expect.objectContaining({
          layer: 'endpoint',
          ok: false,
          required: true,
          failureCode: 'monitor-error',
        }),
      ]);
    },
  );

  it.each([
    ['lower row first', [4_096, 16_384]],
    ['higher row first', [16_384, 4_096]],
  ] as const)(
    'uses the conservative context capacity for duplicate LM Studio model rows with the %s',
    async (_description, contextLengths) => {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'qwen3:8b' }] }))
        .mockResolvedValueOnce(jsonResponse({
          data: contextLengths.map((contextLength) => ({
            id: 'qwen3:8b',
            state: 'loaded',
            loaded_context_length: contextLength,
          })),
        }));
      const health = new WorkerLocalAiHealth({ fetch: fetchMock });

      const samples = await health.check({
        ...baseParams,
        provider: 'openai-compatible',
        endpointId: 'openai-compatible',
        kind: 'lightweight',
        expectedModels: [{
          modelId: 'qwen3:8b',
          required: true,
          minContextLength: 8_192,
        }],
      });

      expect(samples[1]).toMatchObject({
        layer: 'model',
        ok: false,
        required: true,
        failureCode: 'insufficient-context',
        evidence: {
          loadedModels: ['qwen3:8b'],
          availableContextLength: 4_096,
          insufficientContextModels: ['qwen3:8b'],
        },
      });
    },
  );

  it.each([
    ['Ollama', 'ollama', [4_096.5, 16_384]],
    ['Ollama reversed', 'ollama', [16_384, 4_096.5]],
    ['LM Studio', 'openai-compatible', [4_096.5, 16_384]],
    ['LM Studio reversed', 'openai-compatible', [16_384, 4_096.5]],
  ] as const)(
    'fails safely for %s duplicate rows when one context value is malformed',
    async (_description, provider, contextLengths) => {
      const fetchMock = vi.fn<typeof fetch>();
      if (provider === 'ollama') {
        fetchMock
          .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
          .mockResolvedValueOnce(jsonResponse({ models: [{ name: 'qwen3:8b' }] }))
          .mockResolvedValueOnce(jsonResponse({
            models: contextLengths.map((contextLength) => ({
              name: 'qwen3:8b',
              context_length: contextLength,
            })),
          }));
      } else {
        fetchMock
          .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'qwen3:8b' }] }))
          .mockResolvedValueOnce(jsonResponse({
            data: contextLengths.map((contextLength) => ({
              id: 'qwen3:8b',
              state: 'loaded',
              loaded_context_length: contextLength,
            })),
          }));
      }
      const health = new WorkerLocalAiHealth({ fetch: fetchMock });

      const samples = await health.check({
        ...baseParams,
        provider,
        endpointId: provider,
        kind: 'lightweight',
        expectedModels: [{
          modelId: 'qwen3:8b',
          required: true,
          minContextLength: 8_192,
        }],
      });

      expect(samples).toEqual([
        expect.objectContaining({
          layer: 'endpoint',
          ok: false,
          required: true,
          failureCode: 'monitor-error',
        }),
      ]);
    },
  );

  it('checks LM Studio capacity after a canary loads the required model', async () => {
    let loaded = false;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'qwen3:8b' }] });
      if (url.endsWith('/v1/chat/completions')) {
        loaded = true;
        return jsonResponse({ choices: [{ message: { content: 'AIO_HEALTH_OK' } }] });
      }
      if (url.endsWith('/api/v0/models')) {
        return jsonResponse({
          data: loaded
            ? [{ id: 'qwen3:8b', state: 'loaded', loaded_context_length: 4_096 }]
            : [{ id: 'qwen3:8b', state: 'not-loaded' }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check({
      ...baseParams,
      provider: 'openai-compatible',
      endpointId: 'openai-compatible',
      expectedModels: [{
        modelId: 'qwen3:8b',
        required: true,
        minContextLength: 8_192,
      }],
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:1234/v1/models',
      'http://127.0.0.1:1234/v1/chat/completions',
      'http://127.0.0.1:1234/api/v0/models',
    ]);
    expect(samples[1]).toMatchObject({
      failureCode: 'insufficient-context',
      required: true,
      evidence: { availableContextLength: 4_096 },
    });
  });

  it('preserves assigned role scope for a missing optional model', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({
        models: [{ name: 'qwen3:8b' }],
      }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check({
      ...baseParams,
      kind: 'lightweight',
      expectedModels: [
        baseParams.expectedModels[0],
        {
          modelId: 'nomic-embed-text',
          required: false,
          routingRoles: ['titleGeneration'],
        },
      ],
    });

    expect(samples[1]).toMatchObject({
      layer: 'model',
      ok: false,
      required: false,
      failureCode: 'missing-required-model',
      affectedRoles: ['titleGeneration'],
    });
  });

  it('classifies an aborted endpoint request as an endpoint timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    try {
      const pending = health.check({ ...baseParams, kind: 'lightweight', timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(25);

      await expect(pending).resolves.toEqual([
        expect.objectContaining({
          layer: 'endpoint',
          ok: false,
          failureCode: 'endpoint-timeout',
          evidence: expect.objectContaining({ endpointReachable: false }),
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not recommend an Ollama restart for an OpenAI-compatible endpoint failure', async () => {
    const health = new WorkerLocalAiHealth({
      fetch: vi.fn(async () => jsonResponse({}, 500)),
    });
    const { kind: _kind, ...diagnoseParams } = baseParams;

    const report = await health.diagnose({
      ...diagnoseParams,
      provider: 'openai-compatible',
      endpointId: 'openai-compatible',
    });

    expect(report.recommendedActions).toEqual(['deep-check']);
  });

  it('cancels a chunked endpoint response as soon as the HTTP body byte limit is crossed', async () => {
    let pullCount = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount++;
        if (pullCount > 100) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(8 * 1024).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    });
    const health = new WorkerLocalAiHealth({
      fetch: vi.fn(async () => new Response(body, { status: 200 })),
    });

    const samples = await health.check({ ...baseParams, kind: 'lightweight' });

    expect(samples).toEqual([
      expect.objectContaining({
        layer: 'endpoint',
        ok: false,
        failureCode: 'protocol-error',
        evidence: expect.objectContaining({ errorKind: 'response-too-large' }),
      }),
    ]);
    expect(cancelled).toBe(true);
    expect(pullCount).toBeLessThan(100);
  });

  it('rejects canary output that contains anything beyond the exact token without returning model output', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ version: '0.12.1' }))
      .mockResolvedValueOnce(jsonResponse({
        models: [
          { name: 'qwen3:8b' },
          { name: 'nomic-embed-text' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        response: 'AIO_HEALTH_OK plus untrusted model text',
      }));
    const health = new WorkerLocalAiHealth({ fetch: fetchMock });

    const samples = await health.check(baseParams);
    const inference = samples.at(-1);

    expect(inference).toMatchObject({
      layer: 'inference',
      ok: false,
      failureCode: 'malformed-inference-output',
      message: 'The canary response did not match the exact-token contract.',
      evidence: {
        canaryOutputValid: false,
      },
    });
    expect(JSON.stringify(inference)).not.toContain('untrusted model text');
  });

  it('uses fixed macOS Ollama restart commands after resolving a known installation', async () => {
    const execFile = vi.fn(async () => undefined);
    const health = new WorkerLocalAiHealth({
      platform: 'darwin',
      pathExists: (candidate) => candidate === '/Applications/Ollama.app',
      execFile,
    });

    const result = await health.repair({
      provider: 'ollama',
      endpointId: 'ollama',
      action: 'restart-ollama',
    });

    expect(result).toMatchObject({
      action: 'restart-ollama',
      outcome: 'completed-not-recovered',
      supported: true,
      attempted: true,
      recovered: false,
    });
    expect(execFile.mock.calls).toEqual([
      ['/usr/bin/osascript', ['-e', 'tell application "Ollama" to quit']],
      ['/usr/bin/open', ['-a', 'Ollama']],
    ]);
  });

  it('uses a fixed Windows taskkill target and only the resolved known-root Ollama executable', async () => {
    const notRunning = Object.assign(new Error('The process was not found.'), { code: 128 });
    const execFile = vi.fn(async () => {
      throw notRunning;
    });
    const launchDetached = vi.fn(async () => undefined);
    const executable = 'C:\\Users\\James\\AppData\\Local\\Programs\\Ollama\\ollama app.exe';
    const health = new WorkerLocalAiHealth({
      platform: 'win32',
      env: {
        LOCALAPPDATA: 'C:\\Users\\James\\AppData\\Local',
      },
      pathExists: (candidate) => candidate === executable,
      execFile,
      launchDetached,
    });

    const result = await health.repair({
      provider: 'ollama',
      endpointId: 'ollama',
      action: 'restart-ollama',
    });

    expect(result).toMatchObject({
      outcome: 'completed-not-recovered',
      supported: true,
      attempted: true,
      recovered: false,
    });
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/F', '/IM', 'ollama app.exe'],
    );
    expect(launchDetached).toHaveBeenCalledOnce();
    expect(launchDetached).toHaveBeenCalledWith(executable, []);
  });

  it('does not launch the Windows Ollama app after a non-not-found taskkill failure', async () => {
    const accessDenied = Object.assign(new Error('Access is denied.'), { code: 1 });
    const execFile = vi.fn(async () => {
      throw accessDenied;
    });
    const launchDetached = vi.fn(async () => undefined);
    const executable = 'C:\\Program Files\\Ollama\\ollama app.exe';
    const health = new WorkerLocalAiHealth({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      pathExists: (candidate) => candidate === executable,
      execFile,
      launchDetached,
    });

    const result = await health.repair({
      provider: 'ollama',
      endpointId: 'ollama',
      action: 'restart-ollama',
    });

    expect(result).toMatchObject({
      supported: true,
      attempted: true,
      recovered: false,
    });
    expect(launchDetached).not.toHaveBeenCalled();
  });

  it('uses only the resolved fixed systemctl path and fixed Ollama user service on Linux', async () => {
    const execFile = vi.fn(async () => undefined);
    const health = new WorkerLocalAiHealth({
      platform: 'linux',
      pathExists: (candidate) =>
        candidate === '/usr/bin/systemctl' || candidate === '/usr/local/bin/ollama',
      execFile,
    });

    const result = await health.repair({
      provider: 'ollama',
      endpointId: 'ollama',
      action: 'restart-ollama',
    });

    expect(result).toMatchObject({
      outcome: 'completed-not-recovered',
      supported: true,
      attempted: true,
      recovered: false,
    });
    expect(execFile.mock.calls).toEqual([
      ['/usr/bin/systemctl', ['--user', 'restart', 'ollama.service']],
    ]);
  });

  it('returns supported false without executing when Ollama installation cannot be resolved', async () => {
    const execFile = vi.fn(async () => undefined);
    const health = new WorkerLocalAiHealth({
      platform: 'linux',
      pathExists: () => false,
      execFile,
    });

    const result = await health.repair({
      provider: 'ollama',
      endpointId: 'ollama',
      action: 'restart-ollama',
    });

    expect(result).toMatchObject({
      supported: false,
      attempted: false,
      recovered: false,
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects an unrecognised repair action without executing a process', async () => {
    const execFile = vi.fn(async () => undefined);
    const health = new WorkerLocalAiHealth({ execFile });

    await expect(health.repair({
      provider: 'ollama',
      endpointId: 'ollama',
      action: 'run-command',
    } as never)).rejects.toThrow('RPC validation failed');
    expect(execFile).not.toHaveBeenCalled();
  });
});
