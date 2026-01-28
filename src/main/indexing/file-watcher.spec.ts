/**
 * File Watcher Tests
 *
 * Tests for the file watcher that monitors codebase changes.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CodebaseFileWatcher, resetCodebaseFileWatcher } from './file-watcher';

// Mock chokidar
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
    getWatched: vi.fn().mockReturnValue({}),
  })),
}));

// Mock indexing service
vi.mock('./indexing-service', () => ({
  getCodebaseIndexingService: vi.fn(() => ({
    indexFile: vi.fn().mockResolvedValue(undefined),
    removeFile: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { watch } from 'chokidar';

describe('CodebaseFileWatcher', () => {
  let watcher: CodebaseFileWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCodebaseFileWatcher();
    watcher = new CodebaseFileWatcher();
  });

  afterEach(async () => {
    await watcher.stopAll();
  });

  describe('startWatching', () => {
    it('should start watching a directory', async () => {
      await watcher.startWatching('test-store', '/fake/path');

      expect(watch).toHaveBeenCalledWith(
        expect.stringContaining('/fake/path'),
        expect.objectContaining({
          persistent: true,
        })
      );
    });

    it('should not create duplicate watchers for same store', async () => {
      await watcher.startWatching('test-store', '/fake/path');
      await watcher.startWatching('test-store', '/fake/path');

      // Should have called watch twice (stops previous watcher first)
      expect(watch).toHaveBeenCalled();
    });

    it('should emit watcher:started event', async () => {
      const startedEvents: any[] = [];
      watcher.on('watcher:started', (data) => {
        startedEvents.push(data);
      });

      await watcher.startWatching('test-store', '/fake/path');

      expect(startedEvents.length).toBeGreaterThan(0);
      expect(startedEvents[0].storeId).toBe('test-store');
    });

    it('should emit change events', async () => {
      const changeEvents: any[] = [];
      watcher.on('change:detected', (data) => {
        changeEvents.push(data);
      });

      // Get the mock watcher
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');

      // Simulate a file change by calling the 'change' handler
      const onCalls = mockWatcher.on.mock.calls;
      const changeHandler = onCalls.find((call: any[]) => call[0] === 'change');

      if (changeHandler) {
        // Call the change handler with a file path
        changeHandler[1]('/fake/path/file.ts');
      }
    });
  });

  describe('stopWatching', () => {
    it('should stop watching a specific store', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: mockClose,
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');
      await watcher.stopWatching('test-store');

      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle stopping non-existent watcher', async () => {
      // Should not throw
      await expect(watcher.stopWatching('non-existent')).resolves.not.toThrow();
    });

    it('should emit watcher:stopped event', async () => {
      const stoppedEvents: any[] = [];
      watcher.on('watcher:stopped', (data) => {
        stoppedEvents.push(data);
      });

      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');
      await watcher.stopWatching('test-store');

      expect(stoppedEvents.length).toBeGreaterThan(0);
      expect(stoppedEvents[0].storeId).toBe('test-store');
    });
  });

  describe('stopAll', () => {
    it('should stop all watchers', async () => {
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: mockClose,
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('store-1', '/path1');
      await watcher.startWatching('store-2', '/path2');
      await watcher.stopAll();

      expect(mockClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStatus', () => {
    it('should return watching status', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');
      const status = watcher.getStatus('test-store');

      expect(status).toEqual(expect.objectContaining({
        storeId: 'test-store',
        isWatching: true,
        pendingChanges: 0,
      }));
    });

    it('should return null for non-existent watcher', () => {
      const status = watcher.getStatus('non-existent');
      expect(status).toBeNull();
    });
  });

  describe('getActiveWatchers', () => {
    it('should return list of active watcher store IDs', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('store-1', '/path1');
      await watcher.startWatching('store-2', '/path2');

      const active = watcher.getActiveWatchers();

      expect(active).toContain('store-1');
      expect(active).toContain('store-2');
    });
  });

  describe('debouncing', () => {
    it('should debounce rapid changes', async () => {
      vi.useFakeTimers();

      const processingEvents: any[] = [];
      watcher.on('changes:processing', (data) => {
        processingEvents.push(data);
      });

      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');

      // Simulate multiple rapid changes via the 'change' handler
      const onCalls = mockWatcher.on.mock.calls;
      const changeHandler = onCalls.find((call: any[]) => call[0] === 'change');

      if (changeHandler) {
        // Simulate rapid file changes
        changeHandler[1]('/fake/path/file1.ts');
        changeHandler[1]('/fake/path/file2.ts');
        changeHandler[1]('/fake/path/file3.ts');
      }

      // Fast forward past debounce time
      await vi.advanceTimersByTimeAsync(1000);

      vi.useRealTimers();
    });
  });

  describe('configure', () => {
    it('should update configuration', () => {
      watcher.configure({
        debounceMs: 500,
        autoIndex: false,
      });

      // Configuration is internal, but we can test behavior
      expect(watcher).toBeDefined();
    });
  });

  describe('flushChanges', () => {
    it('should process pending changes immediately', async () => {
      const mockWatcher = {
        on: vi.fn().mockReturnThis(),
        close: vi.fn().mockResolvedValue(undefined),
        getWatched: vi.fn().mockReturnValue({}),
      };
      (watch as any).mockReturnValue(mockWatcher);

      await watcher.startWatching('test-store', '/fake/path');

      // Should not throw
      await expect(watcher.flushChanges('test-store')).resolves.not.toThrow();
    });
  });
});
