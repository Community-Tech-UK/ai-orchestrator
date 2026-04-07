import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger to avoid Electron / filesystem side effects
vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock fs/promises before importing the module under test
vi.mock('node:fs/promises');

import fs from 'node:fs/promises';
import { NodeFilesystemHandler } from './node-filesystem-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockDirent {
  name: string;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  isFile: () => boolean;
}

function makeDir(name: string): MockDirent {
  return { name, isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false };
}

function makeFile(name: string): MockDirent {
  return { name, isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true };
}

function makeStat(opts: { isDirectory?: boolean; size?: number; mtimeMs?: number } = {}): import('node:fs').Stats {
  return {
    isDirectory: () => opts.isDirectory ?? false,
    isFile: () => !opts.isDirectory,
    isSymbolicLink: () => false,
    size: opts.size ?? 1024,
    mtimeMs: opts.mtimeMs ?? 1700000000000,
  } as unknown as import('node:fs').Stats;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeFilesystemHandler', () => {
  let handler: NodeFilesystemHandler;

  const ROOTS = ['/home/user'];

  const mockRealpath = vi.mocked(fs.realpath);
  const mockReaddir = vi.mocked(fs.readdir);
  const mockStat = vi.mocked(fs.stat);

  beforeEach(() => {
    handler = new NodeFilesystemHandler(ROOTS);
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // readDirectory tests
  // -------------------------------------------------------------------------

  describe('readDirectory', () => {
    it('returns entries with stat data', async () => {
      mockRealpath.mockResolvedValue('/home/user/projects' as never);
      mockReaddir.mockResolvedValue([
        makeDir('src'),
        makeFile('README.md'),
      ] as never);
      mockStat.mockImplementation(async (filePath: unknown) => {
        if (String(filePath).endsWith('src')) {
          return makeStat({ isDirectory: true, size: 0 });
        }
        return makeStat({ isDirectory: false, size: 512 });
      });

      const result = await handler.readDirectory({ path: '/home/user/projects' });

      expect(result.entries).toHaveLength(2);
      expect(result.truncated).toBe(false);

      const srcEntry = result.entries.find(e => e.name === 'src');
      expect(srcEntry).toBeDefined();
      expect(srcEntry!.isDirectory).toBe(true);

      const readmeEntry = result.entries.find(e => e.name === 'README.md');
      expect(readmeEntry).toBeDefined();
      expect(readmeEntry!.isDirectory).toBe(false);
      expect(readmeEntry!.size).toBe(512);
    });

    it('rejects paths outside browsable roots', async () => {
      mockRealpath.mockResolvedValue('/etc/passwd' as never);

      await expect(
        handler.readDirectory({ path: '/etc/passwd' })
      ).rejects.toThrow('EOUTOFSCOPE');
    });

    it('flags restricted files', async () => {
      mockRealpath.mockResolvedValue('/home/user/projects' as never);
      mockReaddir.mockResolvedValue([
        makeFile('.env'),
        makeFile('index.ts'),
      ] as never);
      mockStat.mockResolvedValue(makeStat({ isDirectory: false, size: 100 }));

      const result = await handler.readDirectory({ path: '/home/user/projects', includeHidden: true });

      const envEntry = result.entries.find(e => e.name === '.env');
      expect(envEntry).toBeDefined();
      expect(envEntry!.restricted).toBe(true);

      const indexEntry = result.entries.find(e => e.name === 'index.ts');
      expect(indexEntry).toBeDefined();
      expect(indexEntry!.restricted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // stat tests
  // -------------------------------------------------------------------------

  describe('stat', () => {
    it('returns stat for existing path', async () => {
      mockRealpath.mockResolvedValue('/home/user/projects' as never);
      mockStat.mockResolvedValue(makeStat({ isDirectory: true, size: 0 }));

      const result = await handler.stat({ path: '/home/user/projects' });

      expect(result.exists).toBe(true);
      expect(result.isDirectory).toBe(true);
      expect(result.withinBrowsableRoot).toBe(true);
    });

    it('returns exists=false for missing path', async () => {
      mockRealpath.mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

      const result = await handler.stat({ path: '/home/user/missing' });

      expect(result.exists).toBe(false);
    });
  });
});
