// src/main/context/__tests__/output-persistence.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app-data') },
}));

const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn();
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

import { OutputPersistenceManager, getOutputPersistenceManager } from '../output-persistence';

describe('OutputPersistenceManager', () => {
  beforeEach(() => {
    OutputPersistenceManager._resetForTesting();
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
    mockReadFile.mockClear();
    mockReaddir.mockClear();
    mockStat.mockClear();
    mockUnlink.mockClear();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = OutputPersistenceManager.getInstance();
      const b = OutputPersistenceManager.getInstance();
      expect(a).toBe(b);
    });

    it('getOutputPersistenceManager() convenience getter returns the singleton', () => {
      const manager = getOutputPersistenceManager();
      expect(manager).toBe(OutputPersistenceManager.getInstance());
    });
  });

  describe('maybeExternalize — small output (below threshold)', () => {
    it('returns content unchanged when below default threshold', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const small = 'x'.repeat(1000);
      const result = await manager.maybeExternalize('default', small);
      expect(result).toBe(small);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns content unchanged when below per-tool grep threshold (20K)', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const output = 'a'.repeat(19_999);
      const result = await manager.maybeExternalize('grep', output);
      expect(result).toBe(output);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('maybeExternalize — large output (exceeds threshold)', () => {
    it('writes full content to cache file when default threshold exceeded', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const large = 'z'.repeat(51_000);
      const result = await manager.maybeExternalize('default', large);

      expect(mockWriteFile).toHaveBeenCalledOnce();
      expect(result).toContain('[Full output saved:');
      expect(result).toContain('51000 chars');
    });

    it('truncated preview contains first 2K and last 1K of original content', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const prefix = 'START'.repeat(500);
      const middle = 'X'.repeat(50_000);
      const suffix = 'END'.repeat(400);
      const large = prefix + middle + suffix;

      const result = await manager.maybeExternalize('default', large);

      expect(result.startsWith(large.slice(0, 2000))).toBe(true);
      expect(result).toContain(large.slice(-1000));
    });

    it('exceeds grep threshold at 20K chars', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const output = 'b'.repeat(20_001);
      const result = await manager.maybeExternalize('grep', output);
      expect(mockWriteFile).toHaveBeenCalledOnce();
      expect(result).toContain('[Full output saved:');
    });

    it('exceeds web_fetch threshold at 100K chars', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const output = 'c'.repeat(100_001);
      const result = await manager.maybeExternalize('web_fetch', output);
      expect(mockWriteFile).toHaveBeenCalledOnce();
      expect(result).toContain('[Full output saved:');
    });

    it('uses sha256 hash as filename (64 hex chars)', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const large = 'd'.repeat(51_000);
      await manager.maybeExternalize('default', large);

      const writePath = mockWriteFile.mock.calls[0][0] as string;
      const filename = writePath.split('/').pop()!;
      expect(filename).toMatch(/^[0-9a-f]{64}\.txt$/);
    });

    it('identical content produces the same hash (dedup-friendly)', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const content = 'e'.repeat(51_000);
      await manager.maybeExternalize('default', content);
      await manager.maybeExternalize('default', content);
      const path1 = mockWriteFile.mock.calls[0][0] as string;
      const path2 = mockWriteFile.mock.calls[1][0] as string;
      expect(path1).toBe(path2);
    });
  });

  describe('retrieve', () => {
    it('returns full content for a known hash', async () => {
      mockReadFile.mockResolvedValueOnce('full content here');
      const manager = OutputPersistenceManager.getInstance();
      const content = await manager.retrieve('abc123');
      expect(content).toBe('full content here');
    });

    it('returns null when file does not exist', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockReadFile.mockRejectedValueOnce(err);
      const manager = OutputPersistenceManager.getInstance();
      const content = await manager.retrieve('nonexistent');
      expect(content).toBeNull();
    });

    it('returns null and logs on unexpected read error', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('disk error'));
      const manager = OutputPersistenceManager.getInstance();
      const content = await manager.retrieve('badhash');
      expect(content).toBeNull();
    });
  });

  describe('cleanup', () => {
    it('removes files older than 24 hours', async () => {
      const now = Date.now();
      const oldMtime = new Date(now - 25 * 60 * 60 * 1000);
      const newMtime = new Date(now - 1 * 60 * 60 * 1000);

      mockReaddir.mockResolvedValueOnce(['old.txt', 'new.txt']);
      mockStat
        .mockResolvedValueOnce({ mtime: oldMtime })
        .mockResolvedValueOnce({ mtime: newMtime });

      const manager = OutputPersistenceManager.getInstance();
      await manager.cleanup();

      expect(mockUnlink).toHaveBeenCalledOnce();
      expect(mockUnlink.mock.calls[0][0] as string).toContain('old.txt');
    });

    it('does not remove files younger than 24 hours', async () => {
      const recentMtime = new Date(Date.now() - 1 * 60 * 60 * 1000);
      mockReaddir.mockResolvedValueOnce(['recent.txt']);
      mockStat.mockResolvedValueOnce({ mtime: recentMtime });

      const manager = OutputPersistenceManager.getInstance();
      await manager.cleanup();

      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('tolerates stat errors on individual files during cleanup', async () => {
      mockReaddir.mockResolvedValueOnce(['broken.txt']);
      mockStat.mockRejectedValueOnce(new Error('stat failed'));

      const manager = OutputPersistenceManager.getInstance();
      await expect(manager.cleanup()).resolves.not.toThrow();
    });
  });

  describe('configureThreshold', () => {
    it('respects custom per-tool threshold set via configure()', async () => {
      const manager = OutputPersistenceManager.getInstance();
      manager.configure({ thresholds: { custom_tool: 5000 } });

      const small = 'f'.repeat(4999);
      const result = await manager.maybeExternalize('custom_tool', small);
      expect(result).toBe(small);
      expect(mockWriteFile).not.toHaveBeenCalled();

      mockWriteFile.mockClear();

      const large = 'f'.repeat(5001);
      const resultLarge = await manager.maybeExternalize('custom_tool', large);
      expect(resultLarge).toContain('[Full output saved:');
      expect(mockWriteFile).toHaveBeenCalledOnce();
    });
  });
});
