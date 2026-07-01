import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/types/settings.types';
import type { WorkerNodeInfo } from '../../../../shared/types/worker-node.types';
import {
  __resetLocalWhisperRemoteHooksForTesting,
  __setLocalWhisperRemoteHooksForTesting,
  LocalWhisperTranscriptionProvider,
} from './local-whisper-transcription-provider';

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sttWorkerNode(overrides: Partial<WorkerNodeInfo> = {}): WorkerNodeInfo {
  return {
    id: 'win-stt',
    name: 'Windows STT',
    address: 'worker.local',
    status: 'connected',
    activeInstances: 0,
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      cpuCores: 16,
      totalMemoryMB: 196_000,
      availableMemoryMB: 128_000,
      supportedClis: [],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      hasDocker: true,
      maxConcurrentInstances: 10,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
      localSttEndpoints: [{
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8000',
        models: ['distil-large-v3'],
        healthy: true,
      }],
    },
    ...overrides,
  };
}

describe('LocalWhisperTranscriptionProvider', () => {
  afterEach(() => {
    __resetLocalWhisperRemoteHooksForTesting();
    vi.restoreAllMocks();
  });

  it('marks a this-device endpoint available only after an STT-disambiguated probe succeeds', async () => {
    let now = 1_000;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'http://127.0.0.1:9090/v1/models') {
        return jsonResponse({ data: [{ id: 'private-whisper-large-v3' }] });
      }
      if (href === 'http://127.0.0.1:9090/v1/audio/transcriptions') {
        return new Response('', { status: 405 });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const provider = new LocalWhisperTranscriptionProvider({
      fetchImpl,
      now: () => now,
    });
    provider.configure(settings({
      voiceThisDeviceSttEndpointUrl: 'http://127.0.0.1:9090',
    }));

    expect(provider.getStatus()).toMatchObject({
      id: 'local-whisper',
      available: false,
      configured: true,
      latencyClass: 'near-realtime',
    });

    await provider.refreshHealth();

    expect(provider.getStatus()).toMatchObject({
      available: true,
      configured: true,
      location: 'this-device',
      privacy: 'local',
    });
    await expect(provider.createSession({ model: 'gpt-4o-transcribe', language: 'en' }))
      .resolves.toMatchObject({
        transport: 'local-segmented',
        model: 'private-whisper-large-v3',
        providerId: 'local-whisper',
        sampleRate: 16000,
        maxSegmentMs: DEFAULT_SETTINGS.voiceLocalSttMaxSegmentMs,
        language: 'en',
        task: 'transcribe',
      });

    now += 10_000;
    await provider.refreshHealth();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += 60_001;
    await provider.refreshHealth();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not route to an OpenAI-compatible LLM server that lacks STT evidence', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'http://127.0.0.1:1234/v1/models') {
        return jsonResponse({ data: [{ id: 'qwen2.5-coder-7b' }] });
      }
      if (href === 'http://127.0.0.1:1234/v1/audio/transcriptions') {
        return new Response('', { status: 404 });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const provider = new LocalWhisperTranscriptionProvider({ fetchImpl });
    provider.configure(settings({
      voiceThisDeviceSttEndpointUrl: 'http://127.0.0.1:1234',
    }));

    await provider.refreshHealth();

    expect(provider.getStatus()).toMatchObject({
      available: false,
      configured: true,
      location: 'this-device',
      reason: expect.stringContaining('does not expose an STT endpoint'),
    });
  });

  it('rejects non-loopback this-device URLs instead of falling through to defaults', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{ id: 'default-whisper-that-must-not-be-probed' }],
    }));
    const provider = new LocalWhisperTranscriptionProvider({ fetchImpl });
    provider.configure(settings({
      voiceThisDeviceSttEndpointUrl: 'http://192.168.50.20:8080',
    }));

    await provider.refreshHealth();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(provider.getStatus()).toMatchObject({
      available: false,
      configured: true,
      location: 'this-device',
      reason: expect.stringContaining('loopback'),
    });
  });

  it('ignores stale this-device probe results after settings change clears the cache', async () => {
    let releaseOldModels: ((response: Response) => void) | null = null;
    const oldModels = new Promise<Response>((resolve) => {
      releaseOldModels = resolve;
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'http://127.0.0.1:9001/v1/models') return oldModels;
      if (href === 'http://127.0.0.1:9001/v1/audio/transcriptions') {
        return new Response('', { status: 405 });
      }
      if (href === 'http://127.0.0.1:9002/v1/models') {
        return jsonResponse({ data: [{ id: 'fresh-whisper' }] });
      }
      if (href === 'http://127.0.0.1:9002/v1/audio/transcriptions') {
        return new Response('', { status: 405 });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const provider = new LocalWhisperTranscriptionProvider({ fetchImpl });
    provider.configure(settings({ voiceThisDeviceSttEndpointUrl: 'http://127.0.0.1:9001' }));
    const staleRefresh = provider.refreshHealth();

    provider.configure(settings({ voiceThisDeviceSttEndpointUrl: 'http://127.0.0.1:9002' }));
    await provider.refreshHealth();
    releaseOldModels?.(jsonResponse({ data: [{ id: 'stale-whisper' }] }));
    await staleRefresh;

    await expect(provider.createSession({ model: 'gpt-4o-transcribe' }))
      .resolves.toMatchObject({
        model: 'fresh-whisper',
      });
  });

  it('surfaces healthy worker-node STT from heartbeat capabilities and creates local segmented sessions', async () => {
    __setLocalWhisperRemoteHooksForTesting({
      connectedWorkerNodes: () => [sttWorkerNode()],
    });
    const provider = new LocalWhisperTranscriptionProvider();
    provider.configure(settings({
      voiceSttRoutingMode: 'worker-node',
      voiceLocalSttMaxSegmentMs: 3200,
    }));

    expect(provider.getStatus()).toMatchObject({
      available: true,
      configured: true,
      location: 'worker-node',
      latencyClass: 'near-realtime',
    });
    await expect(provider.createSession({ model: 'gpt-4o-transcribe' }))
      .resolves.toMatchObject({
        transport: 'local-segmented',
        model: 'distil-large-v3',
        providerId: 'local-whisper',
        sampleRate: 16000,
        maxSegmentMs: 3200,
        language: 'en',
        task: 'transcribe',
      });
  });

  it('proxies worker-node segments through audio.transcribe RPC without dialing worker localhost', async () => {
    const sendServiceRpc = vi.fn(async () => ({ text: 'hello from the worker gpu' }));
    __setLocalWhisperRemoteHooksForTesting({
      connectedWorkerNodes: () => [sttWorkerNode()],
      sendServiceRpc,
    });
    const provider = new LocalWhisperTranscriptionProvider();
    provider.configure(settings({
      voiceSttRoutingMode: 'worker-node',
      voiceLocalSttMaxSegmentMs: 3200,
    }));
    const session = await provider.createSession({ model: 'gpt-4o-transcribe' });

    await expect(provider.pushSegment({
      sessionId: session.sessionId,
      seq: 7,
      wavBase64: Buffer.from('wav-bytes').toString('base64'),
      last: true,
    })).resolves.toEqual({
      sessionId: session.sessionId,
      kind: 'final',
      text: 'hello from the worker gpu',
      segmentId: 7,
    });

    expect(sendServiceRpc).toHaveBeenCalledWith(
      'win-stt',
      'audio.transcribe',
      {
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8000',
        model: 'distil-large-v3',
        language: 'en',
        task: 'transcribe',
        audioBase64: Buffer.from('wav-bytes').toString('base64'),
        sampleRate: 16000,
        timeoutMs: 30_000,
      },
      31_000
    );
  });

  it('transcribes this-device segments through an OpenAI-compatible HTTP endpoint', async () => {
    process.env['AIO_TEST_LOCAL_STT_KEY'] = 'local-test-key';
    try {
      const wavBytes = Buffer.from('local-http-wav');
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href === 'http://127.0.0.1:9090/v1/models') {
          expect(init?.headers).toEqual({ Authorization: 'Bearer local-test-key' });
          return jsonResponse({ data: [{ id: 'private-whisper-metal' }] });
        }
        if (href === 'http://127.0.0.1:9090/v1/audio/transcriptions' && init?.method === 'GET') {
          expect(init?.headers).toEqual({ Authorization: 'Bearer local-test-key' });
          return new Response('', { status: 405 });
        }
        if (href === 'http://127.0.0.1:9090/v1/audio/transcriptions' && init?.method === 'POST') {
          expect(init?.headers).toEqual({ Authorization: 'Bearer local-test-key' });
          expect(init.signal).toBeInstanceOf(AbortSignal);
          const body = init.body as FormData;
          expect(body.get('model')).toBe('private-whisper-metal');
          expect(body.get('language')).toBe('en');
          expect(body.get('task')).toBe('transcribe');
          expect(body.get('response_format')).toBe('json');
          const file = body.get('file');
          expect(file).toBeInstanceOf(Blob);
          expect((file as Blob).size).toBe(wavBytes.length);
          expect((file as Blob).type).toBe('audio/wav');
          return jsonResponse({ text: 'hello from this mac' });
        }
        throw new Error(`unexpected URL ${href}`);
      });
      const provider = new LocalWhisperTranscriptionProvider({ fetchImpl });
      provider.configure(settings({
        voiceSttRoutingMode: 'this-device',
        voiceThisDeviceSttEndpointUrl: 'http://127.0.0.1:9090',
        voiceThisDeviceSttApiKeyEnv: 'AIO_TEST_LOCAL_STT_KEY',
      }));

      await provider.refreshHealth();
      const session = await provider.createSession({ model: 'gpt-4o-transcribe' });

      await expect(provider.pushSegment({
        sessionId: session.sessionId,
        seq: 3,
        wavBase64: wavBytes.toString('base64'),
        last: true,
      })).resolves.toEqual({
        sessionId: session.sessionId,
        kind: 'final',
        text: 'hello from this mac',
        segmentId: 3,
      });
    } finally {
      delete process.env['AIO_TEST_LOCAL_STT_KEY'];
    }
  });

  it('falls back to whisper-cli using a temp WAV file without shell invocation', async () => {
    const wavBytes = Buffer.from('local-cli-wav');
    let observedWavPath = '';
    const execFile = vi.fn(async (
      file: string,
      args: string[],
      opts: { timeoutMs?: number; shell?: boolean }
    ) => {
      expect(file).toBe('whisper-cli');
      expect(opts.timeoutMs).toBe(30_000);
      expect(opts.shell).toBeUndefined();
      const fileArgIndex = args.indexOf('-f');
      expect(fileArgIndex).toBeGreaterThanOrEqual(0);
      observedWavPath = args[fileArgIndex + 1] ?? '';
      expect(await readFile(observedWavPath)).toEqual(wavBytes);
      expect(args).toEqual(expect.arrayContaining([
        '-m',
        '/models/ggml-distil-large-v3.bin',
        '-l',
        'en',
        '-oj',
      ]));
      return { stdout: JSON.stringify({ text: 'hello from cli' }), stderr: '', exitCode: 0 };
    });
    const provider = new LocalWhisperTranscriptionProvider({
      commandExists: (command: string) => command === 'whisper-cli',
      execFile,
    });
    provider.configure(settings({
      voiceSttRoutingMode: 'this-device',
      voiceLocalSttModel: '/models/ggml-distil-large-v3.bin',
    }));

    expect(provider.getStatus()).toMatchObject({
      available: true,
      configured: true,
      location: 'this-device',
    });
    const session = await provider.createSession({ model: 'gpt-4o-transcribe' });

    await expect(provider.pushSegment({
      sessionId: session.sessionId,
      seq: 8,
      wavBase64: wavBytes.toString('base64'),
      last: true,
    })).resolves.toEqual({
      sessionId: session.sessionId,
      kind: 'final',
      text: 'hello from cli',
      segmentId: 8,
    });
    await expect(access(observedWavPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('wraps whisper-cli failures and still removes the temp WAV file', async () => {
    let observedWavPath = '';
    const execFile = vi.fn(async (
      _file: string,
      args: string[]
    ) => {
      observedWavPath = args[args.indexOf('-f') + 1] ?? '';
      throw new Error('spawn whisper-cli ENOENT');
    });
    const provider = new LocalWhisperTranscriptionProvider({
      commandExists: (command: string) => command === 'whisper-cli',
      execFile,
    });
    provider.configure(settings({
      voiceSttRoutingMode: 'this-device',
      voiceLocalSttModel: '/models/ggml-distil-large-v3.bin',
    }));
    const session = await provider.createSession({ model: 'gpt-4o-transcribe' });

    await expect(provider.pushSegment({
      sessionId: session.sessionId,
      seq: 9,
      wavBase64: Buffer.from('local-cli-wav').toString('base64'),
      last: true,
    })).rejects.toMatchObject({
      code: 'local-stt-transcription-failed',
      message: expect.stringContaining('whisper-cli failed'),
    });
    await expect(access(observedWavPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors a pinned worker id instead of using another healthy worker', () => {
    __setLocalWhisperRemoteHooksForTesting({
      connectedWorkerNodes: () => [sttWorkerNode({ id: 'other-worker' })],
    });
    const provider = new LocalWhisperTranscriptionProvider();
    provider.configure(settings({
      voiceSttRoutingMode: 'worker-node',
      voiceLocalSttWorkerNodeId: 'win-stt',
    }));

    expect(provider.getStatus()).toMatchObject({
      available: false,
      configured: true,
      location: 'worker-node',
      reason: expect.stringContaining('Pinned worker'),
    });
  });
});
