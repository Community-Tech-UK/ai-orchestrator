/**
 * File Watcher - Watch for external file changes (10.1)
 *
 * Monitors file system changes with gitignore awareness.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { getLogger } from '../../logging/logger';

const logger = getLogger('FileWatcher');

/**
 * File change event types
 */
export type FileChangeType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

/**
 * File change event
 */
export interface FileChangeEvent {
  type: FileChangeType;
  path: string;
  relativePath: string;
  timestamp: number;
  stats?: fs.Stats;
}

/**
 * Watch options
 */
export interface WatchOptions {
  ignored?: string[];           // Patterns to ignore
  useGitignore?: boolean;       // Respect .gitignore
  persistent?: boolean;         // Keep process running
  depth?: number;               // Directory depth to watch
  ignoreInitial?: boolean;      // Skip initial add events
  debounceMs?: number;          // Debounce file changes
  awaitWriteFinish?: boolean;   // Wait for writes to complete
}

/**
 * Watch session
 */
export interface WatchSession {
  id: string;
  directory: string;
  options: WatchOptions;
  watcher: chokidar.FSWatcher | null;
  eventBuffer: FileChangeEvent[];
  createdAt: number;
  active: boolean;
}

const DEFAULT_OPTIONS: WatchOptions = {
  ignored: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.cache/**',
    '**/coverage/**',
    '**/*.log',
    '**/.DS_Store',
    '**/Thumbs.db',
  ],
  useGitignore: true,
  persistent: true,
  depth: 10,
  ignoreInitial: true,
  debounceMs: 100,
  awaitWriteFinish: true,
};

/**
 * File Watcher Manager
 */
export class FileWatcherManager extends EventEmitter {
  private sessions: Map<string, WatchSession> = new Map();
  private maxEventBuffer: number = 1000;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Start watching a directory
   */
  async watch(
    directory: string,
    options: WatchOptions = {}
  ): Promise<WatchSession> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const sessionId = crypto.randomUUID();

    // Build ignored patterns
    const ignored = [...(opts.ignored || [])];

    // Add gitignore patterns if enabled
    if (opts.useGitignore) {
      const gitignorePatterns = await this.parseGitignore(directory);
      ignored.push(...gitignorePatterns);
    }

    const session: WatchSession = {
      id: sessionId,
      directory,
      options: opts,
      watcher: null,
      eventBuffer: [],
      createdAt: Date.now(),
      active: true,
    };

    // Create chokidar watcher
    const watcher = chokidar.watch(directory, {
      ignored,
      persistent: opts.persistent,
      depth: opts.depth,
      ignoreInitial: opts.ignoreInitial,
      awaitWriteFinish: opts.awaitWriteFinish ? {
        stabilityThreshold: 200,
        pollInterval: 100,
      } : false,
    });

    // Bind events
    watcher.on('add', (filePath, stats) => this.handleChange(sessionId, 'add', filePath, stats));
    watcher.on('change', (filePath, stats) => this.handleChange(sessionId, 'change', filePath, stats));
    watcher.on('unlink', (filePath) => this.handleChange(sessionId, 'unlink', filePath));
    watcher.on('addDir', (filePath, stats) => this.handleChange(sessionId, 'addDir', filePath, stats));
    watcher.on('unlinkDir', (filePath) => this.handleChange(sessionId, 'unlinkDir', filePath));
    watcher.on('error', (error) => this.emit('error', sessionId, error));
    watcher.on('ready', () => this.emit('ready', sessionId));

    session.watcher = watcher;
    this.sessions.set(sessionId, session);

    return session;
  }

  /**
   * Parse .gitignore file
   */
  private async parseGitignore(directory: string): Promise<string[]> {
    const patterns: string[] = [];
    const gitignorePath = path.join(directory, '.gitignore');

    try {
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          // Skip comments and empty lines
          if (!trimmed || trimmed.startsWith('#')) continue;

          // Convert gitignore patterns to glob patterns
          let pattern = trimmed;

          // Handle negation (we'll just skip these for simplicity)
          if (pattern.startsWith('!')) continue;

          // Add ** prefix for patterns without /
          if (!pattern.startsWith('/') && !pattern.includes('/')) {
            pattern = `**/${pattern}`;
          } else if (pattern.startsWith('/')) {
            pattern = pattern.slice(1);
          }

          // Handle directory patterns
          if (pattern.endsWith('/')) {
            pattern = `${pattern}**`;
          }

          patterns.push(pattern);
        }
      }
    } catch (error) {
      logger.error('Failed to parse .gitignore', error instanceof Error ? error : undefined);
    }

    return patterns;
  }

  /**
   * Handle file change event
   */
  private handleChange(
    sessionId: string,
    type: FileChangeType,
    filePath: string,
    stats?: fs.Stats
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) return;

    const event: FileChangeEvent = {
      type,
      path: filePath,
      relativePath: path.relative(session.directory, filePath),
      timestamp: Date.now(),
      stats,
    };

    // Debounce handling
    const debounceKey = `${sessionId}-${filePath}`;
    const existingTimer = this.debounceTimers.get(debounceKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(debounceKey);
      this.processChange(session, event);
    }, session.options.debounceMs || 100);

    this.debounceTimers.set(debounceKey, timer);
  }

  /**
   * Process a file change after debouncing
   */
  private processChange(session: WatchSession, event: FileChangeEvent): void {
    // Add to buffer
    session.eventBuffer.push(event);

    // Prune old events
    if (session.eventBuffer.length > this.maxEventBuffer) {
      session.eventBuffer = session.eventBuffer.slice(-this.maxEventBuffer);
    }

    // Emit events
    this.emit('change', session.id, event);
    this.emit(`change:${event.type}`, session.id, event);
  }

  /**
   * Stop watching a session
   */
  async unwatch(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.active = false;
    if (session.watcher) {
      await session.watcher.close();
      session.watcher = null;
    }

    this.sessions.delete(sessionId);
    this.emit('unwatched', sessionId);
  }

  /**
   * Stop all watchers
   */
  async unwatchAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.unwatch(id)));
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): WatchSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): WatchSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.active);
  }

  /**
   * Get recent changes for a session
   */
  getRecentChanges(sessionId: string, limit: number = 50): FileChangeEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.eventBuffer.slice(-limit);
  }

  /**
   * Clear event buffer for a session
   */
  clearEventBuffer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.eventBuffer = [];
    }
  }

  /**
   * Add a path to watch within an existing session
   */
  addPath(sessionId: string, pathToAdd: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.watcher) {
      session.watcher.add(pathToAdd);
    }
  }

  /**
   * Remove a path from watching
   */
  removePath(sessionId: string, pathToRemove: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.watcher) {
      session.watcher.unwatch(pathToRemove);
    }
  }

  /**
   * Get watched paths for a session
   */
  getWatchedPaths(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    if (!session?.watcher) return [];

    const watched = session.watcher.getWatched();
    const paths: string[] = [];

    for (const [dir, files] of Object.entries(watched)) {
      for (const file of files) {
        paths.push(path.join(dir, file));
      }
    }

    return paths;
  }
}

// Singleton instance
let fileWatcherInstance: FileWatcherManager | null = null;

export function getFileWatcherManager(): FileWatcherManager {
  if (!fileWatcherInstance) {
    fileWatcherInstance = new FileWatcherManager();
  }
  return fileWatcherInstance;
}
