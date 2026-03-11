/**
 * Recent Directories Types - Types for recently opened directories feature
 */

/**
 * A single entry in the recent directories list
 */
export interface RecentDirectoryEntry {
  /** Full path to the directory */
  path: string;
  /** Display name (folder name) for quick recognition */
  displayName: string;
  /** Timestamp of last access */
  lastAccessed: number;
  /** Number of times this directory has been accessed */
  accessCount: number;
  /** Whether this directory is pinned to the top */
  isPinned: boolean;
}

/**
 * Options for retrieving recent directories
 */
export interface RecentDirectoriesOptions {
  /** Maximum number of entries to return */
  limit?: number;
  /** Sort order for the results */
  sortBy?: 'lastAccessed' | 'frequency' | 'alphabetical' | 'manual';
  /** Include pinned directories (default: true) */
  includePinned?: boolean;
}

/**
 * Storage format for recent directories
 */
export interface RecentDirectoriesStore {
  /** Version for migration support */
  version: number;
  /** List of recent directory entries */
  entries: RecentDirectoryEntry[];
}

/**
 * Default configuration values
 */
export const RECENT_DIRECTORIES_DEFAULTS = {
  /** Maximum entries to keep */
  maxEntries: 15,
  /** Current storage version */
  storeVersion: 1,
  /** Default sort order */
  defaultSortBy: 'lastAccessed' as const,
};
