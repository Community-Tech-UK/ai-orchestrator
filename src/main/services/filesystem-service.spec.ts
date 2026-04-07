import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger to avoid Electron side-effects
vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises');

// Mock the remote-node module
vi.mock('../remote-node', () => ({
  getWorkerNodeConnectionServer: vi.fn(),
}));

import fs from 'node:fs/promises';
import { FilesystemService } from './filesystem-service';
import { getWorkerNodeConnectionServer } from '../remote-node';

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
    isFile: () => !(opts.isDirectory ?? false),
    isSymbolicLink: () => false,
    size: opts.size ?? 1024,
    mtimeMs: opts.mtimeMs ?? 1700000000000,
  } as unknown as import('node:fs').Stats;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FilesystemService', () => {
  const mockReaddir = vi.mocked(fs.readdir);
  const mockStat = vi.mocked(fs.stat);
  const mockGetConnectionServer = vi.mocked(getWorkerNodeConnectionServer);

  beforeEach(() => {
    FilesystemService._resetForTesting();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Routes local readDirectory to fs.readdir
  // -------------------------------------------------------------------------

  describe('readDirectory — local', () => {
    it('routes local readDirectory to fs.readdir and returns entries', async () => {
      mockReaddir.mockResolvedValue([
        makeDir('src'),
        makeFile('package.json'),
      ] as never);
      mockStat.mockResolvedValue(makeStat({ size: 512, mtimeMs: 1700000000000 }));

      const service = FilesystemService.getInstance();
      const result = await service.readDirectory('local', '/home/dev/project');

      expect(mockReaddir).toHaveBeenCalledWith('/home/dev/project', { withFileTypes: true });
      expect(result.entries).toHaveLength(2);
      expect(result.truncated).toBe(false);

      const srcEntry = result.entries.find(e => e.name === 'src');
      expect(srcEntry).toBeDefined();
      expect(srcEntry!.isDirectory).toBe(true);

      const pkgEntry = result.entries.find(e => e.name === 'package.json');
      expect(pkgEntry).toBeDefined();
      expect(pkgEntry!.isDirectory).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Routes remote readDirectory to RPC
  // -------------------------------------------------------------------------

  describe('readDirectory — remote', () => {
    it('routes remote readDirectory to sendRpc with correct nodeId and method', async () => {
      const mockSendRpc = vi.fn().mockResolvedValue({
        entries: [{ name: 'Projects', path: 'C:\\Projects', isDirectory: true, isSymlink: false, size: 0, modifiedAt: 0, ignored: false, restricted: false }],
        truncated: false,
      });
      mockGetConnectionServer.mockReturnValue({ sendRpc: mockSendRpc } as never);

      const service = FilesystemService.getInstance();
      const result = await service.readDirectory('node-123', 'C:\\Projects');

      expect(mockSendRpc).toHaveBeenCalledWith(
        'node-123',
        'fs.readDirectory',
        expect.objectContaining({ path: 'C:\\Projects' }),
      );
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('Projects');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Routes remote stat to RPC
  // -------------------------------------------------------------------------

  describe('stat — remote', () => {
    it('routes remote stat to sendRpc with correct nodeId and method', async () => {
      const mockSendRpc = vi.fn().mockResolvedValue({
        exists: true,
        isDirectory: true,
        size: 0,
        modifiedAt: 1700000000000,
        platform: 'win32',
        withinBrowsableRoot: true,
      });
      mockGetConnectionServer.mockReturnValue({ sendRpc: mockSendRpc } as never);

      const service = FilesystemService.getInstance();
      const result = await service.stat('node-123', 'C:\\Projects');

      expect(mockSendRpc).toHaveBeenCalledWith(
        'node-123',
        'fs.stat',
        expect.objectContaining({ path: 'C:\\Projects' }),
      );
      expect(result.exists).toBe(true);
      expect(result.platform).toBe('win32');
    });
  });
});
