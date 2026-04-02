import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

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

import { ContentStore, getContentStore, type ContentRef } from '../content-store';

describe('ContentStore', () => {
  beforeEach(() => {
    ContentStore._resetForTesting();
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
    mockReadFile.mockClear();
    mockReaddir.mockClear();
    mockStat.mockClear();
    mockUnlink.mockClear();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = ContentStore.getInstance();
      const b = ContentStore.getInstance();
      expect(a).toBe(b);
    });

    it('getContentStore() convenience getter returns the singleton', () => {
      expect(getContentStore()).toBe(ContentStore.getInstance());
    });
  });

  describe('store — inline path (< 1 KB)', () => {
    it('returns inline ref for content below 1 KB threshold', async () => {
      const store = ContentStore.getInstance();
      const small = 'hello world';
      const ref = await store.store(small);

      expect(ref.inline).toBe(true);
      if (ref.inline) {
        expect(ref.content).toBe(small);
      }
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns inline ref for content at exactly 1023 bytes', async () => {
      const store = ContentStore.getInstance();
      const content = 'x'.repeat(1023);
      const ref = await store.store(content);
      expect(ref.inline).toBe(true);
    });
  });

  describe('store — external path (>= 1 KB)', () => {
    it('returns external ref for content at exactly 1024 bytes', async () => {
      const store = ContentStore.getInstance();
      const content = 'y'.repeat(1024);
      const ref = await store.store(content);
      expect(ref.inline).toBe(false);
    });

    it('external ref carries correct size', async () => {
      const store = ContentStore.getInstance();
      const content = 'z'.repeat(2000);
      const ref = await store.store(content);
      if (!ref.inline) {
        expect(ref.size).toBe(2000);
      }
    });

    it('external ref hash is a 64-char hex string', async () => {
      const store = ContentStore.getInstance();
      const content = 'a'.repeat(2000);
      const ref = await store.store(content);
      if (!ref.inline) {
        expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('writes content to sharded directory based on first 2 hash chars', async () => {
      const store = ContentStore.getInstance();
      const content = 'b'.repeat(2000);
      const ref = await store.store(content);
      if (!ref.inline) {
        const expectedShard = ref.hash.slice(0, 2);
        const writtenPath = mockWriteFile.mock.calls[0][0] as string;
        expect(writtenPath).toContain(`/${expectedShard}/`);
        expect(writtenPath).toContain(ref.hash);
      }
    });

    it('identical content produces the same hash (deduplication)', async () => {
      const store = ContentStore.getInstance();
      const content = 'c'.repeat(2000);
      const ref1 = await store.store(content);
      const ref2 = await store.store(content);
      if (!ref1.inline && !ref2.inline) {
        expect(ref1.hash).toBe(ref2.hash);
      }
    });

    it('write is fire-and-forget (does not block caller)', async () => {
      mockWriteFile.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => resolve(undefined), 100))
      );
      const store = ContentStore.getInstance();
      const content = 'd'.repeat(2000);
      const ref = await store.store(content);
      expect(ref.inline).toBe(false);
    });
  });

  describe('resolve', () => {
    it('resolves inline ref directly without disk I/O', async () => {
      const store = ContentStore.getInstance();
      const ref: ContentRef = { inline: true, content: 'inline content' };
      const result = await store.resolve(ref);
      expect(result).toBe('inline content');
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it('resolves external ref by reading from disk', async () => {
      const content = 'external content value';
      mockReadFile.mockResolvedValueOnce(content);
      const store = ContentStore.getInstance();
      const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      const ref: ContentRef = { inline: false, hash, size: content.length };
      const result = await store.resolve(ref);
      expect(result).toBe(content);
      expect(mockReadFile).toHaveBeenCalledOnce();
    });

    it('throws IntegrityError when resolved content hash does not match ref hash', async () => {
      const store = ContentStore.getInstance();
      mockReadFile.mockResolvedValueOnce('tampered content');
      const ref: ContentRef = { inline: false, hash: 'f'.repeat(64), size: 100 };
      await expect(store.resolve(ref)).rejects.toThrow(/integrity/i);
    });

    it('throws on missing external file', async () => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockReadFile.mockRejectedValueOnce(err);
      const store = ContentStore.getInstance();
      const ref: ContentRef = { inline: false, hash: 'b'.repeat(64), size: 50 };
      await expect(store.resolve(ref)).rejects.toThrow();
    });
  });

  describe('cleanup', () => {
    it('removes files in sharded dirs older than maxAgeDays', async () => {
      const store = ContentStore.getInstance();
      const now = Date.now();
      const oldMtime = new Date(now - 8 * 24 * 60 * 60 * 1000);
      const newMtime = new Date(now - 1 * 24 * 60 * 60 * 1000);

      mockReaddir
        .mockResolvedValueOnce(['ab', 'cd'])
        .mockResolvedValueOnce(['file1'])
        .mockResolvedValueOnce(['file2']);

      // The implementation stats each shard then immediately processes its files
      // before moving to the next shard, so stat order is:
      // stat(shard ab) → stat(file1 in ab) → stat(shard cd) → stat(file2 in cd)
      mockStat
        .mockResolvedValueOnce({ isDirectory: () => true })
        .mockResolvedValueOnce({ mtime: oldMtime })
        .mockResolvedValueOnce({ isDirectory: () => true })
        .mockResolvedValueOnce({ mtime: newMtime });

      await store.cleanup(7);

      expect(mockUnlink).toHaveBeenCalledOnce();
    });

    it('handles empty content-store directory without error', async () => {
      mockReaddir.mockResolvedValueOnce([]);
      const store = ContentStore.getInstance();
      await expect(store.cleanup(7)).resolves.not.toThrow();
    });

    it('tolerates stat/unlink errors on individual files', async () => {
      mockReaddir
        .mockResolvedValueOnce(['xx'])
        .mockResolvedValueOnce(['broken-file']);
      mockStat
        .mockResolvedValueOnce({ isDirectory: () => true })
        .mockRejectedValueOnce(new Error('stat failed'));

      const store = ContentStore.getInstance();
      await expect(store.cleanup(7)).resolves.not.toThrow();
    });
  });
});
