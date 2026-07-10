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
  const mockReadFile = vi.mocked(fs.readFile);
  const mockWriteFile = vi.mocked(fs.writeFile);
  const mockMkdir = vi.mocked(fs.mkdir);
  const mockLstat = vi.mocked(fs.lstat);

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

  describe('file transfer roots', () => {
    it('allows readFile from a configured readable transfer root outside working directories', async () => {
      handler = new NodeFilesystemHandler(
        ROOTS,
        {},
        [
          {
            id: 'downloads',
            label: 'Downloads',
            path: '/home/user/Downloads',
            read: true,
            write: false,
          },
        ],
      );
      mockRealpath.mockResolvedValue('/home/user/Downloads/file.pdf' as never);
      mockStat.mockResolvedValue(makeStat({ isDirectory: false, size: 7 }));
      mockReadFile.mockResolvedValue(Buffer.from('content') as never);

      const result = await handler.readFile({ path: '/home/user/Downloads/file.pdf' });

      expect(result).toMatchObject({
        size: 7,
        mimeType: 'application/pdf',
      });
      expect(Buffer.from(result.data, 'base64').toString('utf8')).toBe('content');
    });

    it('refuses writeFile to a read-only transfer root', async () => {
      handler = new NodeFilesystemHandler(
        ROOTS,
        {},
        [
          {
            id: 'downloads',
            label: 'Downloads',
            path: '/home/user/Downloads',
            read: true,
            write: false,
          },
        ],
      );

      await expect(
        handler.writeFile({
          path: '/home/user/Downloads/file.txt',
          data: Buffer.from('content').toString('base64'),
        }),
      ).rejects.toThrow('EOUTOFSCOPE');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('allows writeFile to a writable scratch transfer root outside working directories', async () => {
      handler = new NodeFilesystemHandler(
        ROOTS,
        {},
        [
          {
            id: 'scratch',
            label: 'AIO Scratch',
            path: '/home/user/.orchestrator/_scratch/aio-transfers',
            read: true,
            write: true,
          },
        ],
      );
      mockRealpath.mockImplementation(async (filePath: unknown) => String(filePath) as never);
      mockMkdir.mockResolvedValue(undefined as never);
      mockLstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      mockWriteFile.mockResolvedValue(undefined as never);

      const result = await handler.writeFile({
        path: '/home/user/.orchestrator/_scratch/aio-transfers/file.txt',
        data: Buffer.from('content').toString('base64'),
      });

      expect(result).toEqual({ ok: true, size: 7 });
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/home/user/.orchestrator/_scratch/aio-transfers/file.txt',
        Buffer.from('content'),
      );
    });

    it('allows writeFile inside a working directory nested under a read-only transfer root', async () => {
      // Regression: a read-only "Documents" transfer root that is an ANCESTOR of
      // the working directory must not shadow it. Remote browser-upload staging
      // writes into <workingDir>/_scratch/aio-browser-uploads; when the working
      // dir lives under a read-only transfer root, that write must still be
      // allowed by virtue of the more-specific working-directory scope.
      handler = new NodeFilesystemHandler(
        ['/home/user/Documents/Work'],
        {},
        [
          {
            id: 'documents',
            label: 'Documents',
            path: '/home/user/Documents',
            read: true,
            write: false,
          },
        ],
      );
      mockRealpath.mockImplementation(async (filePath: unknown) => String(filePath) as never);
      mockMkdir.mockResolvedValue(undefined as never);
      mockLstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      mockWriteFile.mockResolvedValue(undefined as never);

      const target = '/home/user/Documents/Work/_scratch/aio-browser-uploads/photo.jpg';
      const result = await handler.writeFile({
        path: target,
        data: Buffer.from('content').toString('base64'),
      });

      expect(result).toEqual({ ok: true, size: 7 });
      expect(mockWriteFile).toHaveBeenCalledWith(target, Buffer.from('content'));
    });

    it('still refuses writeFile to a read-only transfer root nested inside a working directory', async () => {
      // Counterpart to the ancestor case: a read-only transfer root nested
      // INSIDE a working directory is the more specific scope and still wins,
      // so writes into it remain denied.
      handler = new NodeFilesystemHandler(
        ['/home/user'],
        {},
        [
          {
            id: 'downloads',
            label: 'Downloads',
            path: '/home/user/Downloads',
            read: true,
            write: false,
          },
        ],
      );

      await expect(
        handler.writeFile({
          path: '/home/user/Downloads/nested/file.txt',
          data: Buffer.from('content').toString('base64'),
        }),
      ).rejects.toThrow('EOUTOFSCOPE');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('refuses writeFile when an existing destination is a symbolic link', async () => {
      handler = new NodeFilesystemHandler(
        ROOTS,
        {},
        [
          {
            id: 'scratch',
            label: 'AIO Scratch',
            path: '/home/user/.orchestrator/_scratch/aio-transfers',
            read: true,
            write: true,
          },
        ],
      );
      mockRealpath.mockImplementation(async (filePath: unknown) => String(filePath) as never);
      mockMkdir.mockResolvedValue(undefined as never);
      mockLstat.mockResolvedValue({
        isSymbolicLink: () => true,
      } as never);

      await expect(
        handler.writeFile({
          path: '/home/user/.orchestrator/_scratch/aio-transfers/link.txt',
          data: Buffer.from('content').toString('base64'),
        }),
      ).rejects.toThrow('symbolic link');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('refuses writeFile when an existing parent symlink escapes writable roots', async () => {
      handler = new NodeFilesystemHandler(
        ROOTS,
        {},
        [
          {
            id: 'scratch',
            label: 'AIO Scratch',
            path: '/home/user/.orchestrator/_scratch/aio-transfers',
            read: true,
            write: true,
          },
        ],
      );
      mockRealpath.mockImplementation(async (filePath: unknown) => {
        const value = String(filePath);
        if (value.endsWith('/escape')) {
          return '/tmp/outside' as never;
        }
        return value as never;
      });

      await expect(
        handler.writeFile({
          path: '/home/user/.orchestrator/_scratch/aio-transfers/escape/file.txt',
          data: Buffer.from('content').toString('base64'),
        }),
      ).rejects.toThrow('outside writable roots');
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});
