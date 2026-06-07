import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  ProjectDiscovery: vi.fn().mockImplementation(() => ({
    scan: vi.fn().mockResolvedValue([]),
  })),
}));

import { reportCapabilities } from './capability-reporter';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

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
    vi.mocked(execFileSync).mockImplementation((cmd: string, args: string[]) => {
      if (Array.isArray(args) && args[0] === 'claude') {
        return Buffer.from('/usr/local/bin/claude');
      }
      throw new Error('not found');
    });
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
  }): void {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/api/tags')) {
        return routes.ollamaTags
          ? Promise.resolve(routes.ollamaTags)
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
      expect(endpoint.baseUrl).toBe('http://127.0.0.1:11434');
      expect(endpoint.models).toEqual(['llama3.2:3b', 'mistral:7b']);
      expect(endpoint.healthy).toBe(true);
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
      expect(endpoint.baseUrl).toBe('http://127.0.0.1:1234');
      expect(endpoint.models).toEqual(['qwen2.5-coder-7b', 'phi-4']);
      expect(endpoint.healthy).toBe(true);
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

  describe('GPU detection still works with RTX-style nvidia-smi output', () => {
    it('parses RTX-style nvidia-smi CSV output and returns valid capability shape', async () => {
      const { execFileSync } = await import('child_process');
      const mockedExec = vi.mocked(execFileSync);

      mockedExec.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'nvidia-smi') {
          return Buffer.from('NVIDIA GeForce RTX 3090, 24576');
        }
        if (Array.isArray(args) && args[0] === 'claude') {
          return Buffer.from('/usr/local/bin/claude');
        }
        throw new Error('not found');
      });

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
