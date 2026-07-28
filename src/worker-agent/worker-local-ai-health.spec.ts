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
