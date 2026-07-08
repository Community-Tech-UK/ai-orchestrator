import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SecurityFilter } from './security-filter';
import { ProjectDiscovery } from './project-discovery';
import { getLogger } from '../logging/logger';
import { readFilesystemDirectoryTree } from '../services/filesystem-directory-reader';
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
  FsErrorCode,
  FsChangeEvent,
  FsEventNotification
} from '../../shared/types/remote-fs.types';
import type { NodePlatform, WorkerNodeFileTransferRoot } from '../../shared/types/worker-node.types';

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

interface NodeFilesystemHandlerOptions {
  onFsEvent?: (event: FsEventNotification) => void;
}

// ---------------------------------------------------------------------------
// NodeFilesystemHandler
// ---------------------------------------------------------------------------

export class NodeFilesystemHandler {
  private readonly roots: string[];
  private readonly transferRoots: WorkerNodeFileTransferRoot[];
  private readonly platform: NodePlatform;
  private readonly discovery: ProjectDiscovery;
  private readonly watchers = new Map<string, WatcherEntry>();
  private watchCounter = 0;

  constructor(
    browsableRoots: string[] = [],
    private readonly options: NodeFilesystemHandlerOptions = {},
    transferRoots: WorkerNodeFileTransferRoot[] = [],
  ) {
    this.roots = browsableRoots.length > 0 ? browsableRoots : [os.homedir()];
    this.transferRoots = transferRoots;
    this.platform = process.platform as NodePlatform;
    this.discovery = new ProjectDiscovery();
  }

  getDiscovery(): ProjectDiscovery {
    return this.discovery;
  }

  getRoots(): string[] {
    return this.roots;
  }

  getTransferRoots(): WorkerNodeFileTransferRoot[] {
    return [...this.transferRoots];
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

    if (!SecurityFilter.isWithinRoot(resolved, this.readableRoots())) {
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

  private readableRoots(): string[] {
    return [
      ...this.roots,
      ...this.transferRoots
        .filter((root) => root.read)
        .map((root) => root.path),
    ];
  }

  private matchingTransferRoot(targetPath: string): WorkerNodeFileTransferRoot | undefined {
    return this.transferRoots
      .filter((root) => SecurityFilter.isWithinRoot(targetPath, [root.path]))
      .sort((left, right) => right.path.length - left.path.length)[0];
  }

  private isWritablePath(targetPath: string): boolean {
    const transferRoot = this.matchingTransferRoot(targetPath);
    if (transferRoot) {
      return transferRoot.write;
    }
    return SecurityFilter.isWithinRoot(targetPath, this.roots);
  }

  private writableRoots(): string[] {
    return [
      ...this.roots,
      ...this.transferRoots
        .filter((root) => root.write)
        .map((root) => root.path),
    ];
  }

  private async validateWritableParent(targetPath: string): Promise<void> {
    const parentPath = path.dirname(targetPath);
    const existingParent = await this.realpathClosestExisting(parentPath);
    if (!SecurityFilter.isWithinRoot(existingParent, this.writableRoots())) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        existingParent,
        `EOUTOFSCOPE: parent path '${existingParent}' is outside writable roots`,
        false,
        'Only paths within configured writable roots can be written.'
      );
    }
  }

  private async assertRealParentStillWritable(targetPath: string): Promise<void> {
    const parentPath = path.dirname(targetPath);
    const realParent = await fs.realpath(parentPath);
    if (!SecurityFilter.isWithinRoot(realParent, this.writableRoots())) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        realParent,
        `EOUTOFSCOPE: parent path '${realParent}' is outside writable roots`,
        false,
        'Only paths within configured writable roots can be written.'
      );
    }
  }

  private async realpathClosestExisting(targetPath: string): Promise<string> {
    let current = path.resolve(targetPath);
    while (true) {
      try {
        return await fs.realpath(current);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          throw new FsRpcError(
            'ENOENT',
            targetPath,
            `ENOENT: no existing parent for '${targetPath}'`
          );
        }
        current = parent;
      }
    }
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

    const allEntries = await readFilesystemDirectoryTree(
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
      this.readableRoots()
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
        for await (const event of watcher) {
          const change = await this.toChangeEvent(resolvedPath, event);
          this.options.onFsEvent?.({ watchId, events: [change] });
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

  private async toChangeEvent(
    rootPath: string,
    event: { eventType: string; filename: string | Buffer | null }
  ): Promise<FsChangeEvent> {
    const filename = event.filename?.toString();
    const targetPath = filename ? path.resolve(rootPath, filename) : rootPath;
    let exists = false;
    let isDirectory = false;

    try {
      const stat = await fs.stat(targetPath);
      exists = true;
      isDirectory = stat.isDirectory();
    } catch {
      exists = false;
    }

    return {
      type: event.eventType === 'change' ? 'change' : exists ? 'add' : 'delete',
      path: targetPath,
      isDirectory,
    };
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
    if (SecurityFilter.isRestrictedPath(resolvedPath)) {
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
    if (!this.isWritablePath(targetPath)) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        targetPath,
        `EOUTOFSCOPE: path '${targetPath}' is outside browsable roots`,
        false,
        'Only paths within the configured working directories are writable.'
      );
    }

    if (SecurityFilter.isRestrictedPath(targetPath)) {
      throw new FsRpcError(
        'EACCES',
        targetPath,
        `EACCES: cannot write to restricted filename '${path.basename(targetPath)}'`,
        false,
        'Restricted files (credentials, keys, secrets) cannot be written remotely.'
      );
    }

    const buffer = Buffer.from(params.data, 'base64');
    await this.validateWritableParent(targetPath);

    // Create parent directories if needed
    if (params.mkdirp !== false) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
    }
    await this.assertRealParentStillWritable(targetPath);
    const existingStat = await lstatOrNull(targetPath);
    if (existingStat?.isSymbolicLink()) {
      throw new FsRpcError(
        'EACCES',
        targetPath,
        `EACCES: cannot write through symbolic link '${path.basename(targetPath)}'`,
        false,
        'Symbolic link destinations are refused for remote file writes.'
      );
    }

    await fs.writeFile(targetPath, buffer);

    logger.info('writeFile', { path: targetPath, size: buffer.length });

    return { ok: true, size: buffer.length };
  }

}

async function lstatOrNull(filePath: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
