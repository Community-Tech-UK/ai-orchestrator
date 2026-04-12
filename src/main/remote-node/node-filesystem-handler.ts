import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SecurityFilter } from './security-filter';
import { ProjectDiscovery } from './project-discovery';
import { getLogger } from '../logging/logger';
import type {
  FsReadDirectoryParams,
  FsReadDirectoryResult,
  FsStatParams,
  FsStatResult,
  FsSearchParams,
  FsSearchResult,
  FsWatchParams,
  FsWatchResult,
  FsUnwatchParams,
  FsReadFileParams,
  FsReadFileResult,
  FsWriteFileParams,
  FsEntry,
  FsErrorCode
} from '../../shared/types/remote-fs.types';
import type { NodePlatform } from '../../shared/types/worker-node.types';

const logger = getLogger('NodeFilesystemHandler');

const DEFAULT_LIMIT = 500;
const DEFAULT_DEPTH = 1;
const MAX_READ_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/** Simple extension → MIME type mapping for common file types */
const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.csv': 'text/csv',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip'
};

// ---------------------------------------------------------------------------
// Custom RPC error
// ---------------------------------------------------------------------------

export class FsRpcError extends Error {
  readonly fsCode: FsErrorCode;
  readonly fsPath: string;
  readonly retryable: boolean;
  readonly suggestion?: string;

  constructor(
    fsCode: FsErrorCode,
    fsPath: string,
    message: string,
    retryable = false,
    suggestion?: string
  ) {
    super(message);
    this.name = 'FsRpcError';
    this.fsCode = fsCode;
    this.fsPath = fsPath;
    this.retryable = retryable;
    this.suggestion = suggestion;
  }
}

// ---------------------------------------------------------------------------
// Watcher state
// ---------------------------------------------------------------------------

interface WatcherEntry {
  watchId: string;
  targetPath: string;
  abort: AbortController;
}

// ---------------------------------------------------------------------------
// NodeFilesystemHandler
// ---------------------------------------------------------------------------

export class NodeFilesystemHandler {
  private readonly roots: string[];
  private readonly platform: NodePlatform;
  private readonly discovery: ProjectDiscovery;
  private readonly watchers = new Map<string, WatcherEntry>();
  private watchCounter = 0;

  constructor(browsableRoots: string[] = []) {
    this.roots = browsableRoots.length > 0 ? browsableRoots : [os.homedir()];
    this.platform = process.platform as NodePlatform;
    this.discovery = new ProjectDiscovery();
  }

  getDiscovery(): ProjectDiscovery {
    return this.discovery;
  }

  getRoots(): string[] {
    return this.roots;
  }

  // -------------------------------------------------------------------------
  // Path validation
  // -------------------------------------------------------------------------

  private async validatePath(targetPath: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await fs.realpath(targetPath);
    } catch {
      throw new FsRpcError(
        'ENOENT',
        targetPath,
        `ENOENT: no such file or directory, realpath '${targetPath}'`
      );
    }

    if (!SecurityFilter.isWithinRoot(resolved, this.roots)) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        resolved,
        `EOUTOFSCOPE: path '${resolved}' is outside browsable roots`,
        false,
        'Only paths within the configured browsable roots are accessible.'
      );
    }

    return resolved;
  }

  // -------------------------------------------------------------------------
  // readDirectory
  // -------------------------------------------------------------------------

  async readDirectory(
    params: FsReadDirectoryParams
  ): Promise<FsReadDirectoryResult> {
    const {
      depth = DEFAULT_DEPTH,
      includeHidden = false,
      limit = DEFAULT_LIMIT
    } = params;

    const resolvedPath = await this.validatePath(params.path);

    const allEntries = await this.readDirRecursive(
      resolvedPath,
      depth,
      includeHidden
    );

    // Pagination via cursor (cursor is a numeric string offset)
    const startIndex = params.cursor ? parseInt(params.cursor, 10) : 0;
    const page = allEntries.slice(startIndex, startIndex + limit);
    const truncated = startIndex + limit < allEntries.length;
    const nextCursor = truncated ? String(startIndex + limit) : undefined;

    logger.info('readDirectory', {
      path: resolvedPath,
      count: page.length,
      truncated
    });

    return { entries: page, cursor: nextCursor, truncated };
  }

  // -------------------------------------------------------------------------
  // stat
  // -------------------------------------------------------------------------

  async stat(params: FsStatParams): Promise<FsStatResult> {
    let resolved: string;
    try {
      resolved = await fs.realpath(params.path);
    } catch {
      return {
        exists: false,
        isDirectory: false,
        size: 0,
        modifiedAt: 0,
        platform: this.platform,
        withinBrowsableRoot: false
      };
    }

    const withinBrowsableRoot = SecurityFilter.isWithinRoot(
      resolved,
      this.roots
    );

    let statResult: import('node:fs').Stats;
    try {
      statResult = await fs.stat(resolved);
    } catch {
      return {
        exists: false,
        isDirectory: false,
        size: 0,
        modifiedAt: 0,
        platform: this.platform,
        withinBrowsableRoot
      };
    }

    return {
      exists: true,
      isDirectory: statResult.isDirectory(),
      size: statResult.size,
      modifiedAt: statResult.mtimeMs,
      platform: this.platform,
      withinBrowsableRoot
    };
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  async search(params: FsSearchParams): Promise<FsSearchResult> {
    const { query, maxResults = 20 } = params;
    const lower = query.toLowerCase();

    const projects = this.discovery.getCachedProjects();
    const results = projects
      .filter(
        (p) =>
          p.name.toLowerCase().includes(lower) ||
          p.path.toLowerCase().includes(lower)
      )
      .slice(0, maxResults)
      .map((p) => ({
        path: p.path,
        name: p.name,
        markers: p.markers,
        root: this.roots.find((r) => p.path.startsWith(r)) ?? ''
      }));

    return { results };
  }

  // -------------------------------------------------------------------------
  // watch / unwatch
  // -------------------------------------------------------------------------

  async watch(params: FsWatchParams): Promise<FsWatchResult> {
    const resolvedPath = await this.validatePath(params.path);

    this.watchCounter += 1;
    const watchId = `watch-${this.watchCounter}`;
    const abort = new AbortController();

    const entry: WatcherEntry = { watchId, targetPath: resolvedPath, abort };
    this.watchers.set(watchId, entry);

    // Start watching in background — errors are logged but do not surface
    (async () => {
      try {
        const watcher = fs.watch(resolvedPath, {
          recursive: params.recursive ?? false,
          signal: abort.signal
        });
        // Consume events (callers poll via events or RPC — this keeps the watcher alive)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of watcher) {
          // Future: emit events over RPC channel
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== 'AbortError') {
          logger.warn('Watcher error', { watchId, err: String(err) });
        }
      } finally {
        this.watchers.delete(watchId);
      }
    })();

    logger.info('Watching path', { watchId, path: resolvedPath });
    return { watchId };
  }

  async unwatch(params: FsUnwatchParams): Promise<void> {
    const entry = this.watchers.get(params.watchId);
    if (entry) {
      entry.abort.abort();
      this.watchers.delete(params.watchId);
      logger.info('Unwatched', { watchId: params.watchId });
    }
  }

  cleanupAllWatchers(): void {
    for (const entry of this.watchers.values()) {
      entry.abort.abort();
    }
    this.watchers.clear();
    logger.info('All watchers cleaned up');
  }

  // -------------------------------------------------------------------------
  // readFile
  // -------------------------------------------------------------------------

  async readFile(params: FsReadFileParams): Promise<FsReadFileResult> {
    const resolvedPath = await this.validatePath(params.path);

    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      throw new FsRpcError(
        'ENOTDIR',
        resolvedPath,
        `ENOTDIR: '${resolvedPath}' is a directory, not a file`
      );
    }
    if (stat.size > MAX_READ_FILE_SIZE) {
      throw new FsRpcError(
        'EACCES',
        resolvedPath,
        `File too large: ${stat.size} bytes exceeds ${MAX_READ_FILE_SIZE} byte limit`,
        false,
        'Use streaming transfer for files larger than 50 MB.'
      );
    }
    if (SecurityFilter.isRestricted(path.basename(resolvedPath))) {
      throw new FsRpcError(
        'EACCES',
        resolvedPath,
        `EACCES: '${path.basename(resolvedPath)}' is a restricted file`,
        false,
        'Restricted files (credentials, keys, secrets) cannot be read remotely.'
      );
    }

    const buffer = await fs.readFile(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';

    logger.info('readFile', {
      path: resolvedPath,
      size: buffer.length,
      mimeType
    });

    return {
      data: buffer.toString('base64'),
      size: buffer.length,
      mimeType
    };
  }

  // -------------------------------------------------------------------------
  // writeFile
  // -------------------------------------------------------------------------

  async writeFile(
    params: FsWriteFileParams
  ): Promise<{ ok: true; size: number }> {
    const targetPath = path.resolve(params.path);

    // Validate target is within allowed roots (use resolve instead of realpath
    // since the file may not exist yet)
    if (!SecurityFilter.isWithinRoot(targetPath, this.roots)) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        targetPath,
        `EOUTOFSCOPE: path '${targetPath}' is outside browsable roots`,
        false,
        'Only paths within the configured working directories are writable.'
      );
    }

    if (SecurityFilter.isRestricted(path.basename(targetPath))) {
      throw new FsRpcError(
        'EACCES',
        targetPath,
        `EACCES: cannot write to restricted filename '${path.basename(targetPath)}'`,
        false,
        'Restricted files (credentials, keys, secrets) cannot be written remotely.'
      );
    }

    const buffer = Buffer.from(params.data, 'base64');

    // Create parent directories if needed
    if (params.mkdirp !== false) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
    }

    await fs.writeFile(targetPath, buffer);

    logger.info('writeFile', { path: targetPath, size: buffer.length });

    return { ok: true, size: buffer.length };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async readDirRecursive(
    dirPath: string,
    depth: number,
    includeHidden: boolean
  ): Promise<FsEntry[]> {
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
      logger.warn('Failed to read directory', { dirPath, err: String(err) });
      return [];
    }

    // Filter hidden entries unless explicitly included
    const visible = includeHidden
      ? dirents
      : dirents.filter((d) => !d.name.startsWith('.'));

    const entries: FsEntry[] = [];

    for (const dirent of visible) {
      const fullPath = path.join(dirPath, dirent.name);
      const isDirectory = dirent.isDirectory();
      const isSymlink = dirent.isSymbolicLink();
      const ignored =
        isDirectory && SecurityFilter.shouldSkipDirectory(dirent.name);
      const restricted = SecurityFilter.isRestricted(dirent.name);

      let size = 0;
      let modifiedAt = 0;
      try {
        const s = await fs.stat(fullPath);
        size = s.size;
        modifiedAt = s.mtimeMs;
      } catch {
        // Stat failure is non-fatal — leave defaults
      }

      const extension = isDirectory
        ? undefined
        : path.extname(dirent.name) || undefined;

      const entry: FsEntry = {
        name: dirent.name,
        path: fullPath,
        isDirectory,
        isSymlink,
        size,
        modifiedAt,
        extension,
        ignored,
        restricted
      };

      // Recurse into non-ignored directories when depth allows
      if (isDirectory && !ignored && depth > 1) {
        entry.children = await this.readDirRecursive(
          fullPath,
          depth - 1,
          includeHidden
        );
      }

      entries.push(entry);
    }

    // Sort: directories first, then alphabetical by name
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return entries;
  }
}
