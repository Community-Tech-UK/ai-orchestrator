/**
 * Recent Directories Manager - Manages recently opened directories with persistence
 */

import ElectronStore from 'electron-store';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { app } from 'electron';
import type {
  RecentDirectoryEntry,
  RecentDirectoriesOptions,
  RecentDirectoriesStore
} from '../../../shared/types/recent-directories.types';
import { RECENT_DIRECTORIES_DEFAULTS } from '../../../shared/types/recent-directories.types';

// Type for the internal store with the methods we need
interface Store<T> {
  store: T;
  path: string;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
  set(object: Partial<T>): void;
  clear(): void;
}

const DEFAULT_STORE: RecentDirectoriesStore = {
  version: RECENT_DIRECTORIES_DEFAULTS.storeVersion,
  entries: []
};

export class RecentDirectoriesManager extends EventEmitter {
  private store: Store<RecentDirectoriesStore>;
  private maxEntries: number;

  constructor(maxEntries?: number) {
    super();
    this.maxEntries = maxEntries ?? RECENT_DIRECTORIES_DEFAULTS.maxEntries;

    // Cast to our Store interface to work around ESM type resolution issues
    this.store = new ElectronStore<RecentDirectoriesStore>({
      name: 'recent-directories',
      defaults: DEFAULT_STORE
    }) as unknown as Store<RecentDirectoriesStore>;

    // Migrate if needed
    this.migrateIfNeeded();
  }

  /**
   * Handle storage version migrations
   */
  private migrateIfNeeded(): void {
    const version = this.store.get('version');
    if (version < RECENT_DIRECTORIES_DEFAULTS.storeVersion) {
      // Future migrations would go here
      this.store.set('version', RECENT_DIRECTORIES_DEFAULTS.storeVersion);
    }
  }

  /**
   * Add a directory to the recent list
   * If it already exists, update lastAccessed and increment accessCount
   */
  addDirectory(dirPath: string): RecentDirectoryEntry {
    const normalizedPath = this.normalizePath(dirPath);
    const displayName = path.basename(normalizedPath) || normalizedPath;
    const entries = this.store.get('entries');

    // Check if directory exists (skip if it doesn't)
    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Directory does not exist: ${normalizedPath}`);
    }

    // Check if already in list
    const existingIndex = entries.findIndex(
      (e) => this.normalizePath(e.path) === normalizedPath
    );

    let entry: RecentDirectoryEntry;

    if (existingIndex !== -1) {
      // Update existing entry
      entry = {
        ...entries[existingIndex],
        displayName,
        lastAccessed: Date.now(),
        accessCount: entries[existingIndex].accessCount + 1
      };
      entries.splice(existingIndex, 1, entry);
    } else {
      // Create new entry
      entry = {
        path: normalizedPath,
        displayName,
        lastAccessed: Date.now(),
        accessCount: 1,
        isPinned: false
      };
      entries.unshift(entry);
    }

    // Prune if over limit (but keep pinned entries)
    this.pruneEntries(entries);

    this.store.set('entries', entries);
    this.emit('directory-added', entry);
    this.emit('directories-changed', entries);

    // Add to OS recent documents (macOS/Windows)
    try {
      if (process.platform === 'darwin' || process.platform === 'win32') {
        app.addRecentDocument(normalizedPath);
      }
    } catch {
      // Ignore errors from OS integration
    }

    return entry;
  }

  /**
   * Get recent directories (async — avoids blocking the main process).
   *
   * Previously this was synchronous and called `fs.existsSync()` on every
   * entry, which blocks the event loop when paths point to sleeping external
   * drives, unreachable network shares, or macOS-protected directories.
   */
  async getDirectories(options?: RecentDirectoriesOptions): Promise<RecentDirectoryEntry[]> {
    const entries = [...this.store.get('entries')];
    const sortBy = options?.sortBy ?? RECENT_DIRECTORIES_DEFAULTS.defaultSortBy;
    const includePinned = options?.includePinned !== false;

    // Filter out non-existent directories using async fs.access with a
    // per-path timeout so a single slow mount point can't hang everything.
    const PATH_CHECK_TIMEOUT_MS = 500;

    const checks = entries.map(async (e): Promise<RecentDirectoryEntry | null> => {
      if (!includePinned && e.isPinned) return null;
      try {
        await Promise.race([
          fsp.access(e.path),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), PATH_CHECK_TIMEOUT_MS)
          ),
        ]);
        return e;
      } catch {
        return null;
      }
    });

    const validEntries = (await Promise.all(checks)).filter(
      (e): e is RecentDirectoryEntry => e !== null
    );

    // Sort based on preference
    if (sortBy === 'manual') {
      const pinned = validEntries.filter((entry) => entry.isPinned);
      const unpinned = validEntries.filter((entry) => !entry.isPinned);
      validEntries.splice(0, validEntries.length, ...pinned, ...unpinned);
    } else if (sortBy === 'lastAccessed') {
      // Pinned first, then by lastAccessed
      validEntries.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return b.lastAccessed - a.lastAccessed;
      });
    } else if (sortBy === 'frequency') {
      // Pinned first, then by accessCount
      validEntries.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return b.accessCount - a.accessCount;
      });
    } else if (sortBy === 'alphabetical') {
      // Pinned first, then alphabetically
      validEntries.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return a.displayName.localeCompare(b.displayName);
      });
    }

    // Apply limit
    if (options?.limit) {
      return validEntries.slice(0, options.limit);
    }

    return validEntries;
  }

  /**
   * Remove a directory from the list
   */
  removeDirectory(dirPath: string): boolean {
    const normalizedPath = this.normalizePath(dirPath);
    const entries = this.store.get('entries');
    const index = entries.findIndex(
      (e) => this.normalizePath(e.path) === normalizedPath
    );

    if (index === -1) return false;

    entries.splice(index, 1);
    this.store.set('entries', entries);
    this.emit('directory-removed', normalizedPath);
    this.emit('directories-changed', entries);

    return true;
  }

  /**
   * Persist a manual order for directories.
   * Pinned and unpinned directories retain separate segments.
   */
  reorderDirectories(dirPaths: string[]): boolean {
    const normalizedOrder = this.dedupeNormalizedPaths(dirPaths);
    if (normalizedOrder.length === 0) {
      return false;
    }

    const entries = this.store.get('entries');
    const entriesByPath = new Map(
      entries.map((entry) => [this.normalizePath(entry.path), entry] as const)
    );
    const orderedPaths = normalizedOrder.filter((dirPath) => entriesByPath.has(dirPath));
    if (orderedPaths.length === 0) {
      return false;
    }

    const orderedPathSet = new Set(orderedPaths);
    const reorderSegment = (segmentEntries: RecentDirectoryEntry[], pinned: boolean) => {
      const orderedEntries = orderedPaths
        .map((dirPath) => entriesByPath.get(dirPath))
        .filter(
          (entry): entry is RecentDirectoryEntry => entry !== undefined && entry.isPinned === pinned
        );
      const remainingEntries = segmentEntries.filter(
        (entry) => !orderedPathSet.has(this.normalizePath(entry.path))
      );
      return [...orderedEntries, ...remainingEntries];
    };

    const reorderedEntries = [
      ...reorderSegment(entries.filter((entry) => entry.isPinned), true),
      ...reorderSegment(entries.filter((entry) => !entry.isPinned), false),
    ];

    if (
      reorderedEntries.length === entries.length &&
      reorderedEntries.every((entry, index) => entry.path === entries[index]?.path)
    ) {
      return true;
    }

    this.store.set('entries', reorderedEntries);
    this.emit('directories-changed', reorderedEntries);
    this.emit('directories-reordered', reorderedEntries);
    return true;
  }

  /**
   * Pin or unpin a directory
   */
  pinDirectory(dirPath: string, pinned: boolean): boolean {
    const normalizedPath = this.normalizePath(dirPath);
    const entries = this.store.get('entries');
    const index = entries.findIndex(
      (e) => this.normalizePath(e.path) === normalizedPath
    );

    if (index === -1) return false;

    entries[index] = { ...entries[index], isPinned: pinned };
    this.store.set('entries', entries);
    this.emit('directory-pinned', { path: normalizedPath, pinned });
    this.emit('directories-changed', entries);

    return true;
  }

  /**
   * Clear all recent directories (optionally keep pinned)
   */
  clearAll(keepPinned = true): void {
    if (keepPinned) {
      const entries = this.store.get('entries');
      const pinned = entries.filter((e) => e.isPinned);
      this.store.set('entries', pinned);
      this.emit('directories-changed', pinned);
    } else {
      this.store.set('entries', []);
      this.emit('directories-changed', []);
    }
    this.emit('directories-cleared', { keepPinned });
  }

  /**
   * Get the storage file path (useful for debugging)
   */
  getPath(): string {
    return this.store.path;
  }

  /**
   * Set maximum entries (for settings integration)
   */
  setMaxEntries(max: number): void {
    this.maxEntries = max;
    const entries = this.store.get('entries');
    this.pruneEntries(entries);
    this.store.set('entries', entries);
  }

  /**
   * Seed with default working directory from settings
   * Called during initialization to migrate existing settings
   */
  seedFromDefaultDirectory(defaultDir: string): void {
    if (!defaultDir) return;
    if (!fs.existsSync(defaultDir)) return;

    const entries = this.store.get('entries');
    const normalizedPath = this.normalizePath(defaultDir);
    const exists = entries.some(
      (e) => this.normalizePath(e.path) === normalizedPath
    );

    if (!exists) {
      this.addDirectory(defaultDir);
    }
  }

  /**
   * Normalize path for comparison
   */
  private normalizePath(dirPath: string): string {
    // Expand ~ to home directory
    if (dirPath.startsWith('~')) {
      dirPath = path.join(app.getPath('home'), dirPath.slice(1));
    }
    return path.resolve(dirPath);
  }

  private dedupeNormalizedPaths(dirPaths: string[]): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];

    for (const dirPath of dirPaths) {
      const normalizedPath = this.normalizePath(dirPath);
      if (seen.has(normalizedPath)) {
        continue;
      }
      seen.add(normalizedPath);
      deduped.push(normalizedPath);
    }

    return deduped;
  }

  /**
   * Prune entries to stay within limit
   * Keeps all pinned entries regardless of limit
   */
  private pruneEntries(entries: RecentDirectoryEntry[]): void {
    const pinned = entries.filter((e) => e.isPinned);
    const unpinned = entries.filter((e) => !e.isPinned);

    // If unpinned count exceeds what's left after pinned, trim from end
    const unpinnedLimit = Math.max(0, this.maxEntries - pinned.length);
    if (unpinned.length > unpinnedLimit) {
      // Remove oldest unpinned entries
      const toRemove = unpinned.slice(unpinnedLimit);
      for (const entry of toRemove) {
        const idx = entries.findIndex((e) => e.path === entry.path);
        if (idx !== -1) {
          entries.splice(idx, 1);
        }
      }
    }
  }
}

// Singleton instance
let recentDirectoriesManager: RecentDirectoriesManager | null = null;

export function getRecentDirectoriesManager(): RecentDirectoriesManager {
  if (!recentDirectoriesManager) {
    recentDirectoriesManager = new RecentDirectoriesManager();
  }
  return recentDirectoriesManager;
}
