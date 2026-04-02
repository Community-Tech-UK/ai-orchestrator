import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';

vi.mock('fs/promises');
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { BufferedWriter } from '../buffered-writer';

describe('BufferedWriter', () => {
  let writer: BufferedWriter;
  const mockWriteFile = vi.mocked(fs.writeFile);
  const mockAppendFile = vi.mocked(fs.appendFile);
  const mockMkdir = vi.mocked(fs.mkdir);

  beforeEach(() => {
    vi.useFakeTimers();
    mockWriteFile.mockResolvedValue();
    mockAppendFile.mockResolvedValue();
    mockMkdir.mockResolvedValue(undefined);
    writer = new BufferedWriter({ flushIntervalMs: 1000, maxBufferSize: 10, maxBufferBytes: 1024 * 1024 });
  });

  afterEach(async () => {
    await writer.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('write()', () => {
    it('buffers a write without immediately flushing', async () => {
      writer.write('/tmp/test.txt', 'hello');
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('flushes on timer tick', async () => {
      writer.write('/tmp/test.txt', 'hello');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/test.txt', 'hello', 'utf-8');
    });

    it('deduplicates writes to the same path (keeps latest)', async () => {
      writer.write('/tmp/test.txt', 'first');
      writer.write('/tmp/test.txt', 'second');
      writer.write('/tmp/test.txt', 'third');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/test.txt', 'third', 'utf-8');
    });

    it('writes to different paths are independent', async () => {
      writer.write('/tmp/a.txt', 'alpha');
      writer.write('/tmp/b.txt', 'beta');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockWriteFile).toHaveBeenCalledTimes(2);
      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/a.txt', 'alpha', 'utf-8');
      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/b.txt', 'beta', 'utf-8');
    });

    it('creates parent directories before writing', async () => {
      writer.write('/tmp/deep/nested/file.txt', 'content');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockMkdir).toHaveBeenCalledWith('/tmp/deep/nested', { recursive: true });
    });
  });

  describe('append()', () => {
    it('coalesces multiple appends to the same path', async () => {
      writer.append('/tmp/log.txt', 'line1\n');
      writer.append('/tmp/log.txt', 'line2\n');
      writer.append('/tmp/log.txt', 'line3\n');

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockAppendFile).toHaveBeenCalledTimes(1);
      expect(mockAppendFile).toHaveBeenCalledWith('/tmp/log.txt', 'line1\nline2\nline3\n', 'utf-8');
    });
  });

  describe('flush()', () => {
    it('immediately flushes all pending writes', async () => {
      writer.write('/tmp/test.txt', 'urgent');

      await writer.flush();

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/test.txt', 'urgent', 'utf-8');
    });

    it('is a no-op when buffer is empty', async () => {
      await writer.flush();

      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockAppendFile).not.toHaveBeenCalled();
    });
  });

  describe('overflow protection', () => {
    it('auto-flushes when buffer reaches maxBufferSize', async () => {
      for (let i = 0; i < 10; i++) {
        writer.write(`/tmp/file-${i}.txt`, `content-${i}`);
      }

      await vi.advanceTimersByTimeAsync(0);

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('shutdown()', () => {
    it('flushes remaining writes and stops timer', async () => {
      writer.write('/tmp/final.txt', 'last write');

      await writer.shutdown();

      expect(mockWriteFile).toHaveBeenCalledWith('/tmp/final.txt', 'last write', 'utf-8');
    });

    it('is safe to call multiple times', async () => {
      writer.write('/tmp/test.txt', 'data');

      await writer.shutdown();
      await writer.shutdown();

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('logs errors without crashing', async () => {
      mockWriteFile.mockRejectedValueOnce(new Error('disk full'));

      writer.write('/tmp/fail.txt', 'data');
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('stats()', () => {
    it('returns buffer statistics', () => {
      writer.write('/tmp/a.txt', 'hello');
      writer.append('/tmp/b.txt', 'world');

      const stats = writer.stats();
      expect(stats.pendingWrites).toBe(1);
      expect(stats.pendingAppends).toBe(1);
      expect(stats.totalBufferedBytes).toBeGreaterThan(0);
    });
  });
});
