import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./worker-cli-versions', () => ({ readWorkerCliVersions: vi.fn().mockResolvedValue({ claude: '2.1.296' }) }));
// Capabilities are exercised without installed-provider discovery or account reads.
// Defaults: no account homes, no MiMo accounts, OpenCode version unreadable.
const accounts = vi.hoisted(() => ({
  homes: vi.fn((): Record<string, string[]> => ({})),
  openCode: vi.fn(async (): Promise<string[]> => []),
  openCodeMajor: vi.fn(async (): Promise<1 | 2 | undefined> => undefined),
}));
vi.mock('./worker-account-route', () => ({
  listWorkerAccountProfileIds: accounts.homes,
  listWorkerOpenCodeAccountProfileIds: accounts.openCode,
}));
const probes = vi.hoisted(() => ({
  ios: vi.fn(),
  host: vi.fn(),
  signIns: vi.fn(),
}));
vi.mock('./worker-sign-ins', () => ({ getCachedWorkerSignIns: probes.signIns }));
vi.mock('./ios/ios-readiness', () => ({ getCachedIosAutomation: probes.ios }));
vi.mock('./host-readiness', () => ({ getCachedHostReadiness: probes.host }));
vi.mock('./opencode-worker-capability', () => ({ readWorkerOpenCodeMajor: accounts.openCodeMajor }));
vi.mock('./browser-extension-folder', () => ({ workerBrowserExtensionFolder: () => '/repo/resources/browser-extension' }));

// Mock dependencies that are not available in the test environment.
// child_process: partial mock preserving the module shape but replacing execFileSync.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: string[]) => {
      // Simulate `which claude` succeeding, everything else failing
      if (Array.isArray(args) && args[0] === 'claude') {
        return Buffer.from('/usr/local/bin/claude');
      }
      throw new Error('not found');
    }),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    accessSync: vi.fn(() => { throw new Error('not found'); }),
    existsSync: vi.fn(() => false),
  };
});

vi.mock('../main/remote-node/project-discovery', () => ({
  ProjectDiscovery: vi.fn().mockImplementation(function () {
    return { scan: vi.fn().mockResolvedValue([]) };
  }),
}));

import { reportCapabilities, parseLmStudioLoadedModels } from './capability-reporter';
import { _resetHostHealthSamplerForTesting, startHostHealthSampling } from './host-health-sampler';
import { ProjectDiscovery } from '../main/remote-node/project-discovery';
import { LOCAL_AI_TARGET_NUMERIC_LIMITS } from '../shared/types/local-ai-guard.types';
import { NodeHeartbeatParamsSchema } from '../main/remote-node/rpc-schemas';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

describe('parseLmStudioLoadedModels', () => {
  it('keeps only loaded models with their context length', () => {
    expect(parseLmStudioLoadedModels({
      data: [
        { id: 'a', state: 'loaded', loaded_context_length: 32768 },
        { id: 'b', state: 'not-loaded' },
        { id: 'c', state: 'loaded', loaded_context_length: 4096 },
      ],
    })).toEqual([
      { id: 'a', contextLength: 32768 },
      { id: 'c', contextLength: 4096 },
    ]);
  });

  it('omits loaded models without a valid shared-bound context while keeping valid siblings', () => {
    const { min, max } = LOCAL_AI_TARGET_NUMERIC_LIMITS.minContextLength;

    expect(parseLmStudioLoadedModels({
      data: [
        { id: 'missing', state: 'loaded' },
        { id: 'zero', state: 'loaded', loaded_context_length: 0 },
        { id: 'fractional', state: 'loaded', loaded_context_length: min + 0.5 },
        { id: 'nan', state: 'loaded', loaded_context_length: Number.NaN },
        { id: 'infinite', state: 'loaded', loaded_context_length: Number.POSITIVE_INFINITY },
        { id: 'over-max', state: 'loaded', loaded_context_length: max + 1 },
        { id: 'valid-min', state: 'loaded', loaded_context_length: min },
        { id: 'valid-max', state: 'loaded', loaded_context_length: max },
      ],
    })).toEqual([
      { id: 'valid-min', contextLength: min },
      { id: 'valid-max', contextLength: max },
    ]);
  });

  it('tolerates malformed input', () => {
    expect(parseLmStudioLoadedModels(null)).toEqual([]);
    expect(parseLmStudioLoadedModels({})).toEqual([]);
  });
});

describe('capability-reporter', () => {
  const originalPlatform = process.platform;
  const originalHome = process.env['HOME'];
  const originalPath = process.env['PATH'];

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env['HOME'] = '/var/empty/aio-capability-reporter-test';
    process.env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args: string[]) => {
      if (Array.isArray(args) && args[0] === 'claude') {
        return Buffer.from('/usr/local/bin/claude');
      }
      throw new Error('not found');
    }) as unknown as typeof execFileSync);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    if (originalPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = originalPath;
    }
    vi.unstubAllGlobals();
  });

  /**
   * Build a URL-aware fetch mock. `detectLocalModelEndpoints` probes Ollama
   * (`/api/tags`) and LM Studio (`/v1/models`) independently, so tests route by
   * URL. A route set to `undefined` simulates a connection refusal for that
   * server.
   */
  function mockFetchByUrl(routes: {
    ollamaTags?: { ok: boolean; status?: number; json?: () => Promise<unknown> };
    lmStudioModels?: { ok: boolean; status?: number; json?: () => Promise<unknown> };
    lmStudioV0?: { ok: boolean; status?: number; json?: () => Promise<unknown> };
    sttModels?: { ok: boolean; status?: number; json?: () => Promise<unknown> };
    sttAudioRoute?: { ok: boolean; status?: number; json?: () => Promise<unknown> };
  }): void {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/api/tags')) {
        return routes.ollamaTags
          ? Promise.resolve(routes.ollamaTags)
          : Promise.reject(new Error('ECONNREFUSED'));
      }
      // Check the richer /api/v0/models route before /v1/models (the substrings
      // don't overlap, but keep load-state probing explicit).
      if (typeof url === 'string' && url.includes('/api/v0/models')) {
        return routes.lmStudioV0
          ? Promise.resolve(routes.lmStudioV0)
          : Promise.reject(new Error('ECONNREFUSED'));
      }
      if (typeof url === 'string' && url === 'http://127.0.0.1:8000/v1/models') {
        return routes.sttModels
          ? Promise.resolve(routes.sttModels)
          : Promise.reject(new Error('ECONNREFUSED'));
      }
      if (typeof url === 'string' && url === 'http://127.0.0.1:8000/v1/audio/transcriptions') {
        return routes.sttAudioRoute
          ? Promise.resolve(routes.sttAudioRoute)
          : Promise.reject(new Error('ECONNREFUSED'));
      }
      if (typeof url === 'string' && url.includes('/v1/models')) {
        return routes.lmStudioModels
          ? Promise.resolve(routes.lmStudioModels)
          : Promise.reject(new Error('ECONNREFUSED'));
      }
      return Promise.reject(new Error(`unexpected fetch url: ${String(url)}`));
    }));
  }

  it('includes non-secret worker agent build identity for rollout evidence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const caps = await reportCapabilities(['/workspace']);
    const workerAgent = caps.workerAgent;

    expect(workerAgent).toEqual({
      version: expect.any(String),
      startedAt: expect.any(Number),
      hostBootedAt: expect.any(Number),
    });
    expect(workerAgent?.version).not.toBe('');
    expect(workerAgent?.startedAt).toBeGreaterThan(0);
    // The host booted before this worker process started.
    expect(workerAgent?.hostBootedAt).toBeGreaterThan(0);
    expect(workerAgent?.hostBootedAt).toBeLessThanOrEqual(workerAgent?.startedAt ?? 0);
  });

  it('advertises preservation of persistent Codex policy through the actual heartbeat validator', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Synthetic unavailable endpoint')));
    const capabilities = await reportCapabilities(['/workspace']);
    const heartbeat = NodeHeartbeatParamsSchema.parse({ nodeId: 'worker-placeholder', capabilities, activeInstances: 0 });
    expect(heartbeat.capabilities.codexSpawnMetadata).toBe(1);
    const legacy = { ...capabilities }; delete legacy.codexSpawnMetadata;
    expect(NodeHeartbeatParamsSchema.parse({ nodeId: 'worker-placeholder', capabilities: legacy, activeInstances: 0 }).capabilities.codexSpawnMetadata).toBeUndefined();
    expect(NodeHeartbeatParamsSchema.parse({ nodeId: 'worker-placeholder', capabilities: { ...capabilities, codexSpawnMetadata: '1' }, activeInstances: 0 }).capabilities.codexSpawnMetadata).toBeUndefined();
  });

  it('advertises the Codex helper policy through the actual heartbeat validator, and reads a malformed value as absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Synthetic unavailable endpoint')));
    const capabilities = await reportCapabilities(['/workspace']);
    expect(NodeHeartbeatParamsSchema.parse({ nodeId: 'worker-placeholder', capabilities, activeInstances: 0 }).capabilities.codexHelperPolicy).toBe(1);
    expect(NodeHeartbeatParamsSchema.parse({ nodeId: 'worker-placeholder', capabilities: { ...capabilities, codexHelperPolicy: '1' }, activeInstances: 0 }).capabilities.codexHelperPolicy).toBeUndefined();
  });

  it('advertises the Plan Queue push guard through the actual heartbeat validator, and reads a malformed value as absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Synthetic unavailable endpoint')));
    const capabilities = await reportCapabilities(['/workspace']);
    const parse = (value: unknown) => NodeHeartbeatParamsSchema.parse({ nodeId: 'worker-placeholder', capabilities: { ...capabilities, queuePushGuard: value }, activeInstances: 0 }).capabilities.queuePushGuard;
    expect(capabilities.queuePushGuard).toBe(1);
    expect(parse(1)).toBe(1);
    expect(parse(undefined)).toBeUndefined();
    expect(parse('1')).toBeUndefined();
  });

  it('reports the latest host-health sample once the sampler has one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    _resetHostHealthSamplerForTesting();
    expect((await reportCapabilities(['/workspace'])).hostHealth).toBeUndefined();

    let fire: () => void = () => undefined;
    const stop = startHostHealthSampling({
      platform: 'win32',
      firstDelayMs: 0,
      now: () => 1_700_000_000_000,
      emit: vi.fn(),
      runCommand: async () => JSON.stringify({
        udp: 85, tcp: 283, topUdp: [], topHandles: [{ name: 'mtkbtsvc', pid: 6712, count: 127519 }],
      }),
      setTimeout: ((fn: () => void) => { fire = fn; return 0; }) as never,
      clearTimeout: vi.fn(),
    });
    fire();
    await vi.waitFor(async () => {
      expect((await reportCapabilities(['/workspace'])).hostHealth).toMatchObject({
        sampledAt: 1_700_000_000_000,
        udpEndpoints: 85,
        topHandleHolders: [{ name: 'mtkbtsvc', pid: 6712, count: 127519 }],
      });
    });
    stop();
    _resetHostHealthSamplerForTesting();
  });

  it('tells the main Harness where the unpacked Chrome extension is on this computer', async () => {
    const caps = await reportCapabilities(['/workspace'], 4, undefined, undefined, { enabled: true, running: true });

    expect(caps.extensionRelay?.extensionFolder).toBe('/repo/resources/browser-extension');
  });

  it('includes non-secret file transfer capability summaries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const caps = await reportCapabilities(
      ['/workspace'],
      10,
      undefined,
      undefined,
      undefined,
      {
        enabled: true,
        maxFileBytes: 50 * 1024 * 1024,
        roots: [
          {
            id: 'downloads',
            label: 'Downloads',
            path: '/home/user/Downloads',
            read: true,
            write: false,
          },
        ],
      },
    );

    expect((caps as {
      fileTransfer?: {
        enabled: boolean;
        maxFileBytes: number;
        roots: { id: string; label: string; path: string; read: boolean; write: boolean }[];
      };
    }).fileTransfer).toEqual({
      enabled: true,
      maxFileBytes: 50 * 1024 * 1024,
      roots: [
        {
          id: 'downloads',
          label: 'Downloads',
          path: '/home/user/Downloads',
          read: true,
          write: false,
        },
      ],
    });
  });

  describe('detectLocalModelEndpoints via reportCapabilities', () => {
    it('includes Ollama endpoint when /api/tags responds successfully', async () => {
      const mockModels = [{ name: 'llama3.2:3b' }, { name: 'mistral:7b' }];
      mockFetchByUrl({
        ollamaTags: { ok: true, json: () => Promise.resolve({ models: mockModels }) },
        // LM Studio not running
      });

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toBeDefined();
      expect(caps.localModelEndpoints).toHaveLength(1);
      const endpoint = caps.localModelEndpoints![0];
      expect(endpoint.provider).toBe('ollama');
      expect(endpoint.endpointId).toBe('ollama');
      expect(endpoint.baseUrl).toBe('http://127.0.0.1:11434');
      expect(endpoint.models).toEqual(['llama3.2:3b', 'mistral:7b']);
      expect(endpoint.healthy).toBe(true);
    });

    it('caps Ollama rows before materializing the worker heartbeat model array', async () => {
      let nameReads = 0;
      const rawModels = Array.from({ length: 1_500 }, (_, index) => ({
        get name() {
          nameReads += 1;
          return `ollama-${index}`;
        },
      }));
      mockFetchByUrl({
        ollamaTags: { ok: true, json: () => Promise.resolve({ models: rawModels }) },
      });

      const caps = await reportCapabilities(['/workspace']);
      const endpoint = caps.localModelEndpoints?.find(({ provider }) => provider === 'ollama');

      expect(endpoint?.models).toHaveLength(100);
      expect(endpoint?.models.at(-1)).toBe('ollama-99');
      expect(nameReads).toBe(100);
    });

    it('includes Ollama endpoint with empty models list when /api/tags returns no models field', async () => {
      mockFetchByUrl({
        ollamaTags: { ok: true, json: () => Promise.resolve({}) },
      });

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toBeDefined();
      expect(caps.localModelEndpoints).toHaveLength(1);
      expect(caps.localModelEndpoints![0].models).toEqual([]);
    });

    it('includes LM Studio (openai-compatible) endpoint when /v1/models responds successfully', async () => {
      mockFetchByUrl({
        // Ollama not running
        lmStudioModels: {
          ok: true,
          json: () => Promise.resolve({ data: [{ id: 'qwen2.5-coder-7b' }, { id: 'phi-4' }] }),
        },
      });

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toHaveLength(1);
      const endpoint = caps.localModelEndpoints![0];
      expect(endpoint.provider).toBe('openai-compatible');
      expect(endpoint.endpointId).toBe('openai-compatible');
      expect(endpoint.baseUrl).toBe('http://127.0.0.1:1234');
      expect(endpoint.models).toEqual(['qwen2.5-coder-7b', 'phi-4']);
      expect(endpoint.healthy).toBe(true);
    });

    it('caps OpenAI rows before materializing the worker heartbeat model array', async () => {
      let idReads = 0;
      const rawModels = Array.from({ length: 1_500 }, (_, index) => ({
        get id() {
          idReads += 1;
          return `openai-${index}`;
        },
      }));
      mockFetchByUrl({
        lmStudioModels: { ok: true, json: () => Promise.resolve({ data: rawModels }) },
      });

      const caps = await reportCapabilities(['/workspace']);
      const endpoint = caps.localModelEndpoints?.find(
        ({ provider }) => provider === 'openai-compatible',
      );

      expect(endpoint?.models).toHaveLength(100);
      expect(endpoint?.models.at(-1)).toBe('openai-99');
      expect(idReads).toBe(100);
    });

    it('reports LM Studio loaded models + context from /api/v0/models', async () => {
      mockFetchByUrl({
        lmStudioModels: {
          ok: true,
          json: () => Promise.resolve({ data: [{ id: 'gemma-31b' }, { id: 'qwen-35b' }, { id: 'nemotron-4b' }] }),
        },
        lmStudioV0: {
          ok: true,
          json: () => Promise.resolve({
            data: [
              { id: 'gemma-31b', state: 'loaded', loaded_context_length: 32768 },
              { id: 'qwen-35b', state: 'not-loaded' },
              { id: 'nemotron-4b', state: 'loaded', loaded_context_length: 16384 },
            ],
          }),
        },
      });

      const caps = await reportCapabilities(['/workspace']);
      const endpoint = caps.localModelEndpoints!.find((e) => e.provider === 'openai-compatible')!;

      expect(endpoint.models).toEqual(['gemma-31b', 'qwen-35b', 'nemotron-4b']);
      expect(endpoint.loadedModels).toEqual([
        { id: 'gemma-31b', contextLength: 32768 },
        { id: 'nemotron-4b', contextLength: 16384 },
      ]);
    });

    it('reports both Ollama and LM Studio endpoints when both are running', async () => {
      mockFetchByUrl({
        ollamaTags: { ok: true, json: () => Promise.resolve({ models: [{ name: 'llama3.2' }] }) },
        lmStudioModels: { ok: true, json: () => Promise.resolve({ data: [{ id: 'phi-4' }] }) },
      });

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toHaveLength(2);
      expect(caps.localModelEndpoints!.map((e) => e.provider)).toEqual([
        'ollama',
        'openai-compatible',
      ]);
    });

    it('omits LM Studio entry when /v1/models returns a non-ok status', async () => {
      mockFetchByUrl({
        ollamaTags: { ok: true, json: () => Promise.resolve({ models: [{ name: 'llama3.2' }] }) },
        lmStudioModels: { ok: false, status: 404 },
      });

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toHaveLength(1);
      expect(caps.localModelEndpoints![0].provider).toBe('ollama');
    });

    it('omits Ollama entry when /api/tags returns a non-ok status', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      }));

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toEqual([]);
    });

    it('omits Ollama entry when fetch throws (Ollama absent / ECONNREFUSED)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toEqual([]);
    });

    it('reports installed Windows LM Studio as unhealthy when the server is offline', async () => {
      const originalPlatform = process.platform;
      const originalLocalAppData = process.env['LOCALAPPDATA'];
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
      // LM Studio installed (exe present), Ollama absent. `lms` CLI not on PATH
      // (execFileSync mock throws for everything but `claude`).
      vi.mocked(fs.existsSync).mockImplementation(
        (path) => path === 'C:\\Users\\User\\AppData\\Local\\Programs\\lm-studio\\LM Studio.exe',
      );
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      try {
        const caps = await reportCapabilities(['/workspace']);

        expect(caps.localModelEndpoints).toEqual([
          {
            provider: 'openai-compatible',
            endpointId: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1234',
            models: [],
            healthy: false,
          },
        ]);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        if (originalLocalAppData === undefined) {
          delete process.env['LOCALAPPDATA'];
        } else {
          process.env['LOCALAPPDATA'] = originalLocalAppData;
        }
      }
    });

    it('reports installed macOS LM Studio as unhealthy when the server is offline', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      // LM Studio app bundle present, no live server. (The `lms` CLI check falls
      // through to this install-path probe.)
      vi.mocked(fs.existsSync).mockImplementation((path) => path === '/Applications/LM Studio.app');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      try {
        const caps = await reportCapabilities(['/workspace']);

        expect(caps.localModelEndpoints).toEqual([
          {
            provider: 'openai-compatible',
            endpointId: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1234',
            models: [],
            healthy: false,
          },
        ]);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('reports installed Windows Ollama as unhealthy when the server is offline', async () => {
      const originalPlatform = process.platform;
      const originalLocalAppData = process.env['LOCALAPPDATA'];
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env['LOCALAPPDATA'] = 'C:\\Users\\User\\AppData\\Local';
      vi.mocked(fs.existsSync).mockImplementation(
        (path) => path === 'C:\\Users\\User\\AppData\\Local\\Programs\\Ollama\\ollama.exe',
      );
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      try {
        const caps = await reportCapabilities(['/workspace']);

        expect(caps.localModelEndpoints).toEqual([
          {
            provider: 'ollama',
            endpointId: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            models: [],
            healthy: false,
          },
        ]);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        if (originalLocalAppData === undefined) {
          delete process.env['LOCALAPPDATA'];
        } else {
          process.env['LOCALAPPDATA'] = originalLocalAppData;
        }
      }
    });

    it('omits Ollama entry when fetch is aborted (2 s timeout)', async () => {
      const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toEqual([]);
    });
  });

  describe('detectLocalSttEndpoints via reportCapabilities', () => {
    it('advertises a healthy speaches endpoint separately from local LLM endpoints', async () => {
      mockFetchByUrl({
        sttModels: {
          ok: true,
          json: () => Promise.resolve({
            data: [{ id: 'distil-large-v3' }, { id: 'Systran/faster-whisper-large-v3' }],
          }),
        },
        sttAudioRoute: { ok: false, status: 405 },
      });

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toEqual([]);
      expect(caps.localSttEndpoints).toEqual([{
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8000',
        models: ['distil-large-v3', 'Systran/faster-whisper-large-v3'],
        healthy: true,
      }]);
    });

    it('does not advertise an OpenAI-compatible LLM server as STT without audio-route evidence', async () => {
      mockFetchByUrl({
        sttModels: {
          ok: true,
          json: () => Promise.resolve({ data: [{ id: 'qwen2.5-coder-7b' }] }),
        },
        sttAudioRoute: { ok: false, status: 404 },
      });

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localSttEndpoints).toEqual([]);
    });
  });

  describe('browser capabilities (hasBrowserRuntime / hasBrowserMcp)', () => {
    const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

    /** Make Chrome's macOS bundle path resolvable (or not) via fs.accessSync. */
    function chromeInstalled(installed: boolean): void {
      vi.mocked(fs.accessSync).mockImplementation((p: fs.PathLike) => {
        if (installed && p === MAC_CHROME) return;
        throw new Error('not found');
      });
    }

    beforeEach(() => {
      // Use darwin so Chrome detection is a pure fs.accessSync check (the fs
      // namespace mock is reliably applied to the module under test).
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    });

    it('reports hasBrowserRuntime from Chrome presence and hasBrowserMcp=false by default', async () => {
      chromeInstalled(true);
      const caps = await reportCapabilities(['/workspace']);
      expect(caps.hasBrowserRuntime).toBe(true);
      // Automation flag omitted → off, even though Chrome exists.
      expect(caps.hasBrowserMcp).toBe(false);
    });

    it('reports hasBrowserMcp=true only when enabled AND Chrome is present', async () => {
      chromeInstalled(true);
      const caps = await reportCapabilities(['/workspace'], 10, {
        enabled: true,
        headless: false,
        profileDir: '/tmp/auto-profile',
        running: false,
      });
      expect(caps.hasBrowserRuntime).toBe(true);
      expect(caps.hasBrowserMcp).toBe(true);
      // The non-secret summary is echoed into capabilities for the UI.
      expect(caps.browserAutomation).toEqual({
        enabled: true,
        headless: false,
        profileDir: '/tmp/auto-profile',
        running: false,
      });
    });

    it('reports hasBrowserMcp=false when a disabled summary is supplied', async () => {
      chromeInstalled(true);
      const caps = await reportCapabilities(['/workspace'], 10, {
        enabled: false,
        headless: false,
        profileDir: '/tmp/auto-profile',
        running: false,
      });
      expect(caps.hasBrowserRuntime).toBe(true);
      expect(caps.hasBrowserMcp).toBe(false);
      expect(caps.browserAutomation?.enabled).toBe(false);
    });

    it('reports hasBrowserMcp=false when enabled but Chrome is absent', async () => {
      chromeInstalled(false);
      const caps = await reportCapabilities(['/workspace'], 10, {
        enabled: true,
        headless: false,
        profileDir: '/tmp/auto-profile',
        running: false,
      });
      expect(caps.hasBrowserRuntime).toBe(false);
      expect(caps.hasBrowserMcp).toBe(false);
    });

    it('reports hasAndroidMcp=true only when Android automation is enabled and adb is available', async () => {
      chromeInstalled(false);
      const caps = await reportCapabilities(['/workspace'], 10, undefined, {
        enabled: true,
        sdkPath: '/android/sdk',
        adbVersion: 'Android Debug Bridge version 1.0.41',
        avds: ['aio-pixel7-api35'],
        connectedDevices: [],
        emulatorRunning: false,
        hasMaestro: false,
      });
      expect(caps.hasAndroidMcp).toBe(true);
      expect(caps.androidAutomation?.sdkPath).toBe('/android/sdk');

      const disabled = await reportCapabilities(['/workspace'], 10, undefined, {
        enabled: false,
        sdkPath: '/android/sdk',
        adbVersion: 'Android Debug Bridge version 1.0.41',
        avds: [],
        connectedDevices: [],
        emulatorRunning: false,
        hasMaestro: false,
      });
      expect(disabled.hasAndroidMcp).toBe(false);
    });

    it('reports the non-secret file transfer summary when supplied', async () => {
      chromeInstalled(false);
      const caps = await reportCapabilities(['/workspace'], 10, undefined, undefined, undefined, {
        enabled: true,
        maxFileBytes: 1024,
        roots: [
          {
            id: 'downloads',
            label: 'Downloads',
            path: '/home/james/Downloads',
            read: true,
            write: false,
          },
        ],
      });

      expect(caps.fileTransfer).toEqual({
        enabled: true,
        maxFileBytes: 1024,
        roots: [
          {
            id: 'downloads',
            label: 'Downloads',
            path: '/home/james/Downloads',
            read: true,
            write: false,
          },
        ],
      });
    });
  });

  describe('GPU detection still works with RTX-style nvidia-smi output', () => {
    it('parses RTX-style nvidia-smi CSV output and returns valid capability shape', async () => {
      const { execFileSync } = await import('child_process');
      const mockedExec = vi.mocked(execFileSync);

      mockedExec.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'nvidia-smi') {
          return Buffer.from('NVIDIA GeForce RTX 3090, 24576');
        }
        if (Array.isArray(args) && args[0] === 'claude') {
          return Buffer.from('/usr/local/bin/claude');
        }
        throw new Error('not found');
      }) as unknown as typeof execFileSync);

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      // Force linux so nvidia-smi path is taken
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      try {
        const caps = await reportCapabilities(['/workspace']);
        expect(caps.platform).toBe('linux');
        expect(typeof caps.cpuCores).toBe('number');
        expect(typeof caps.totalMemoryMB).toBe('number');
        expect(typeof caps.availableMemoryMB).toBe('number');
        // localModelEndpoints must still be present (empty) even when GPU detected
        expect(Array.isArray(caps.localModelEndpoints)).toBe(true);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });
});

describe('project discovery reuse across heartbeats', () => {
  it('reuses one ProjectDiscovery instead of building a fresh one per call', async () => {
    // reportCapabilities runs on every heartbeat (10s). ProjectDiscovery only
    // suppresses the repeat "Scan complete" log while it keeps its own
    // change-detection state, so a per-call instance silently reinstates the
    // ~8,600 lines/day of log spam that rotates the crash forensics away.
    const ctor = vi.mocked(ProjectDiscovery);
    const before = ctor.mock.calls.length;

    await reportCapabilities(['/tmp/one']);
    await reportCapabilities(['/tmp/one']);
    await reportCapabilities(['/tmp/one']);

    expect(ctor.mock.calls.length).toBe(before);
  });
});

describe('capability-reporter readiness extras', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probes.ios.mockReturnValue(undefined);
    probes.host.mockReturnValue(undefined);
    probes.signIns.mockReturnValue(undefined);
  });

  it('omits the new fields when nothing is cached or given', async () => {
    const caps = await reportCapabilities(['/tmp/one']);
    expect(caps).not.toHaveProperty('signIns');
    expect(caps).not.toHaveProperty('iosAutomation');
    expect(caps).not.toHaveProperty('hostReadiness');
    expect(caps).not.toHaveProperty('connectionNotice');
  });

  it('passes cached iOS and host readiness, the connection notice and the inputs through', async () => {
    const ios = { ready: true };
    const host = { checks: [], checkedAt: 1 };
    probes.ios.mockReturnValue(ios);
    probes.host.mockReturnValue(host);
    const caps = await reportCapabilities(['/tmp/one'], 4, undefined, undefined, undefined, undefined, {
      connectionNotice: 'macOS is blocking this computer from reaching Harness.',
      localNetwork: 'blocked',
      localNetworkBinaryName: 'node',
      configDir: '/cfg',
    });
    expect(caps.iosAutomation).toBe(ios);
    expect(caps.hostReadiness).toBe(host);
    expect(caps.connectionNotice).toBe('macOS is blocking this computer from reaching Harness.');
    expect(probes.ios).toHaveBeenCalledWith({ workingDirectories: ['/tmp/one'], configDir: '/cfg' });
    expect(probes.host).toHaveBeenCalledWith({ localNetwork: 'blocked', binaryName: 'node' });
  });

  it('finds the per-user Chrome install on Windows', async () => {
    const { resolveChromeExecutablePath } = await import('./capability-reporter');
    const originalPlatform = process.platform;
    const originalLocal = process.env['LOCALAPPDATA'];
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env['LOCALAPPDATA'] = 'C:\\Users\\a\\AppData\\Local';
    vi.mocked(fs.accessSync).mockImplementation((file) => {
      if (String(file).endsWith('chrome.exe') && String(file).includes('AppData')) return;
      throw new Error('not found');
    });
    try {
      expect(resolveChromeExecutablePath()).toContain('AppData');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      if (originalLocal === undefined) delete process.env['LOCALAPPDATA']; else process.env['LOCALAPPDATA'] = originalLocal;
      vi.mocked(fs.accessSync).mockImplementation(() => { throw new Error('not found'); });
    }
  });

  it('sends the last sign-in check, which the heartbeat validator keeps, and drops a malformed one', async () => {
    const signIns = [
      { provider: 'claude', profileId: 'legacy', state: 'signed-in', identity: 'person@example.invalid' },
      { provider: 'codex', profileId: 'legacy', state: 'signed-out' },
    ];
    probes.signIns.mockReturnValue(signIns);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Synthetic unavailable endpoint')));
    const capabilities = await reportCapabilities(['/tmp/one']).finally(() => vi.unstubAllGlobals());
    expect(probes.signIns).toHaveBeenCalledWith({ supportedClis: capabilities.supportedClis, accountProfileIds: {} });
    const parse = (value: unknown) => NodeHeartbeatParamsSchema.parse({
      nodeId: 'worker-placeholder', capabilities: { ...capabilities, signIns: value }, activeInstances: 0,
    }).capabilities.signIns;
    expect(parse(signIns)).toEqual(signIns);
    expect(parse([{ provider: 'claude', profileId: '../escape', state: 'signed-in' }])).toBeUndefined();
  });

  it('defaults Local Network to unknown', async () => {
    await reportCapabilities(['/tmp/one']);
    expect(probes.host).toHaveBeenCalledWith({ localNetwork: 'unknown' });
  });
});

describe('busyCoresSinceLastReport', () => {
  const cores = (...ticks: Array<[busy: number, idle: number]>) => () => ticks.map(([busy, idle]) => ({
    model: 'test', speed: 1, times: { user: busy, nice: 0, sys: 0, irq: 0, idle },
  }));

  it('counts cores in use since the previous report, and says nothing when it cannot compare', async () => {
    const { busyCoresSinceLastReport } = await import('./capability-reporter');
    busyCoresSinceLastReport(cores([0, 0], [0, 0]));
    // One core fully busy, the other a quarter busy: 1.25 cores, to one decimal place.
    expect(busyCoresSinceLastReport(cores([100, 0], [25, 75]))).toBe(1.3);
    expect(busyCoresSinceLastReport(cores([100, 0], [25, 75]))).toBeUndefined();
    expect(busyCoresSinceLastReport(cores([200, 0]))).toBeUndefined();
  });
});

// Moved from __tests__/capability-reporter.spec.ts, which reached the real `opencode auth list`
// and real local model/speech endpoints (a 5 s timeout in the 27 October full run:
// docs/plans/2026-10-27-browser-input-controls_evidence/round3/capability-timeout-investigation.json).
// This file mocks the account route; the endpoints are refused here as elsewhere in this file.
describe('capability-reporter basics', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // As in the original file: every command lookup succeeds, so every CLI counts as installed.
    vi.mocked(execFileSync).mockImplementation(() => Buffer.from(''));
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns valid capabilities with correct platform', async () => {
    const caps = await reportCapabilities([]);
    expect(caps.platform).toBe(process.platform);
    expect(caps.arch).toBe(process.arch);
    expect(caps.cpuCores).toBeGreaterThan(0);
    expect(caps.totalMemoryMB).toBeGreaterThan(0);
    expect(caps.availableMemoryMB).toBeGreaterThan(0);
    expect(caps.maxConcurrentInstances).toBe(10);
    expect(Array.isArray(caps.supportedClis)).toBe(true);
    expect(Array.isArray(caps.workingDirectories)).toBe(true);
  });

  it('includes provided working directories', async () => {
    const caps = await reportCapabilities(['/tmp/project']);
    expect(caps.workingDirectories).toContain('/tmp/project');
    // Without this the coordinator refuses every policy-bearing remote Claude
    // session (including plain run_on_node) on this worker.
    expect(caps.claudeSpawnPolicy).toBe(2);
  });
});

describe('capability-reporter OpenCode advertisement', () => {
  beforeEach(() => {
    // OpenCode and Claude are on PATH; nothing else is.
    vi.mocked(execFileSync).mockImplementation(((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && (args[0] === 'opencode' || args[0] === 'claude')) return Buffer.from('');
      throw new Error('not found');
    }) as unknown as typeof execFileSync);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('advertises the OpenCode major version an installed OpenCode reports', async () => {
    accounts.openCodeMajor.mockResolvedValueOnce(2);
    const caps = await reportCapabilities([]);
    expect(caps.supportedClis).toContain('opencode');
    expect(caps.openCodeMajor).toBe(2);
  });

  it('advertises no OpenCode major version when the installed version cannot be read', async () => {
    accounts.openCodeMajor.mockResolvedValueOnce(undefined);
    const caps = await reportCapabilities([]);
    expect(caps.supportedClis).toContain('opencode');
    expect(caps).not.toHaveProperty('openCodeMajor');
  });

  it('advertises MiMo account ids from the OpenCode key store beside the account homes', async () => {
    accounts.homes.mockReturnValueOnce({ claude: ['work'] });
    accounts.openCode.mockResolvedValueOnce(['legacy', 'mimo-b']);
    const caps = await reportCapabilities([]);
    expect(caps.accountProfileIds).toEqual({ claude: ['work'], opencode: ['legacy', 'mimo-b'] });
  });

  it('advertises no account ids when no account is set up on this node', async () => {
    accounts.homes.mockReturnValueOnce({});
    accounts.openCode.mockResolvedValueOnce([]);
    const caps = await reportCapabilities([]);
    expect(caps).not.toHaveProperty('accountProfileIds');
  });
});
