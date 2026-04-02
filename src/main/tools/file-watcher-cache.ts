/**
 * File-Watcher-Based Cache
 *
 * Replaces TTL-based polling with fs.watch-based invalidation.
 * Cache entries are invalidated when watched directories change.
 *
 * Inspired by Claude Code's settingsChangeDetector and skillChangeDetector
 * which use file watchers to invalidate memoized caches.
 */

import * as fs from 'fs';
import { getLogger } from '../logging/logger';

const logger = getLogger('FileWatcherCache');

/** Debounce file system events (ms) */
const DEBOUNCE_MS = 200;

interface CacheEntry<T> {
  value: T;
  loadedAt: number;
}

export class FileWatcherCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private watchers = new Map<string, fs.FSWatcher>();
  private invalidatedKeys = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  /**
   * Get a cached value, loading it if not present or invalidated.
   * @param key Cache key
   * @param watchDir Directory to watch for changes
   * @param loader Function to load the value
   */
  async get(key: string, watchDir: string, loader: () => Promise<T>): Promise<T> {
    // Start watching the directory if not already
    this.ensureWatching(key, watchDir);

    const cached = this.cache.get(key);
    if (cached && !this.invalidatedKeys.has(key)) {
      return cached.value;
    }

    // Load fresh value
    const value = await loader();
    this.cache.set(key, { value, loadedAt: Date.now() });
    this.invalidatedKeys.delete(key);
    return value;
  }

  /**
   * Manually invalidate a cache entry.
   */
  invalidate(key: string): void {
    this.invalidatedKeys.add(key);
  }

  /**
   * Invalidate all entries.
   */
  invalidateAll(): void {
    for (const key of this.cache.keys()) {
      this.invalidatedKeys.add(key);
    }
  }

  /**
   * Dispose all watchers and clear cache.
   */
  dispose(): void {
    this.disposed = true;
    for (const [, watcher] of this.watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    this.watchers.clear();
    this.cache.clear();
    this.invalidatedKeys.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private ensureWatching(key: string, watchDir: string): void {
    if (this.disposed) return;
    if (this.watchers.has(key)) return;

    try {
      // Check directory exists before watching
      if (!fs.existsSync(watchDir)) return;

      const watcher = fs.watch(watchDir, { recursive: true }, (_eventType, _filename) => {
        // Debounce rapid changes
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(key, setTimeout(() => {
          this.invalidatedKeys.add(key);
          this.debounceTimers.delete(key);
          logger.debug('Cache invalidated by file change', { key, watchDir });
        }, DEBOUNCE_MS));
      });

      watcher.on('error', (err) => {
        logger.warn('File watcher error', { key, error: err.message });
        // Don't crash — just invalidate and remove watcher
        this.invalidatedKeys.add(key);
        this.watchers.delete(key);
      });

      this.watchers.set(key, watcher);
    } catch (err) {
      logger.warn('Failed to start file watcher', {
        key,
        watchDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
