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
  };
});

vi.mock('../main/remote-node/project-discovery', () => ({
  ProjectDiscovery: vi.fn().mockImplementation(() => ({
    scan: vi.fn().mockResolvedValue([]),
  })),
}));

import { reportCapabilities } from './capability-reporter';

describe('capability-reporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('detectLocalModelEndpoints via reportCapabilities', () => {
    it('includes Ollama endpoint when /api/tags responds successfully', async () => {
      const mockModels = [{ name: 'llama3.2:3b' }, { name: 'mistral:7b' }];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ models: mockModels }),
      }));

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
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      }));

      const caps = await reportCapabilities(['/workspace']);

      expect(caps.localModelEndpoints).toBeDefined();
      expect(caps.localModelEndpoints).toHaveLength(1);
      expect(caps.localModelEndpoints![0].models).toEqual([]);
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
